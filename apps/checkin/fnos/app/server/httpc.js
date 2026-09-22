"use strict";
/**
 * checkin — 通用 HTTP 客户端（零依赖）。
 * 支持 JSON/文本请求、Cookie 会话保持、跟随重定向、超时、HTTP 代理（use_proxy）。
 * 供三个站点 adapter 共用。
 */
const http = require("http");
const https = require("https");
const net = require("net");
const tls = require("tls");
const { URL } = require("url");

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// 全局代理配置（运行设置页的 proxy_enabled + proxy_url）：模块级单例，
// 由 store 在启动加载与保存配置时通过 setGlobalProxy 注入，避免把配置层层透传。
let _globalProxy = { enabled: false, url: "" };

/** 注入全局代理配置（运行配置：proxy_enabled + proxy_url）。url 已在 store 做格式校验 */
function setGlobalProxy(enabled, url) {
  _globalProxy = { enabled: !!enabled, url: String(url || "").trim() };
}

/**
 * 站点 use_proxy=true 时选择代理地址；use_proxy=false 直连（返回 null）。
 * 优先级：全局代理配置（proxy_enabled && proxy_url）> 环境变量（https_proxy 等，fallback）> null（直连）。
 */
function proxyFromEnv(useProxy) {
  if (!useProxy) return null;
  if (_globalProxy.enabled && _globalProxy.url) return _globalProxy.url;
  return (
    process.env.https_proxy || process.env.HTTPS_PROXY ||
    process.env.http_proxy || process.env.HTTP_PROXY ||
    process.env.all_proxy || process.env.ALL_PROXY || null
  );
}

/** 代理地址脱敏展示：仅 scheme://host:port，不含 userinfo 凭据 */
function proxyDesc(proxyUrl) {
  try {
    const p = new URL(proxyUrl);
    return `${p.protocol.replace(/:$/, "")}://${p.host}`;
  } catch {
    return "(无效代理地址)";
  }
}

/** 通过 HTTP 代理建立 HTTPS CONNECT 隧道，返回已连接的 socket；任何失败一律 reject（业务错误） */
function connectViaProxy(proxyUrl, targetHost, targetPort, timeout) {
  return new Promise((resolve, reject) => {
    let p;
    try {
      p = new URL(proxyUrl);
    } catch {
      reject(new Error(`代理地址无法解析：${proxyDesc(proxyUrl)}`));
      return;
    }
    // 仅支持 http/https 代理的 CONNECT 隧道；SOCKS 代理暂不实现（如实报告，避免静默直连）
    if (!/^https?:$/i.test(p.protocol)) {
      reject(new Error(`暂不支持 ${p.protocol.replace(/:$/, "")} 代理的 HTTPS 隧道，请改用 http:// 或 https:// 代理`));
      return;
    }
    const label = `${proxyDesc(proxyUrl)} → ${targetHost}:${targetPort}`;
    let socket;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      if (socket) socket.destroy();
      reject(new Error(`${err.message}（${label}）`));
    };
    socket = net.connect(Number(p.port) || 8080, p.hostname, () => {
      if (settled) return;
      const hostPort = `${targetHost}:${targetPort}`;
      let connectReq = `CONNECT ${hostPort} HTTP/1.1\r\nHost: ${hostPort}\r\n`;
      if (p.username) {
        const auth = Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password || "")}`).toString("base64");
        connectReq += `Proxy-Authorization: Basic ${auth}\r\n`;
      }
      connectReq += "\r\n";
      socket.write(connectReq);
    });
    socket.on("error", (err) => fail(new Error(`代理连接失败：${err.code || err.message}`)));
    socket.on("close", () => {
      // 未完成 CONNECT 时底层关闭（重置/半关闭），视为代理连接失败
      if (!settled) fail(new Error("代理连接被关闭"));
    });
    socket.setTimeout(timeout || 15000, () => socket.destroy(new Error("代理连接超时")));
    let buf = "";
    socket.on("data", (chunk) => {
      if (settled) return;
      buf += chunk.toString("latin1");
      const headEnd = buf.indexOf("\r\n\r\n");
      if (headEnd < 0) return;
      const statusLine = buf.slice(0, buf.indexOf("\r\n"));
      socket.setTimeout(0);
      if (/^HTTP\/1\.[01] 200/i.test(statusLine)) {
        settled = true;
        resolve(socket);
      } else {
        fail(new Error(`代理 CONNECT 被拒绝：${statusLine}`));
      }
    });
  });
}

class Session {
  constructor() {
    this.cookies = {};
  }

  _absorb(res) {
    const sc = res.headers["set-cookie"];
    if (!sc) return;
    for (const line of sc) {
      const pair = line.split(";")[0];
      const idx = pair.indexOf("=");
      if (idx < 0) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (value === "" || value.toLowerCase() === "deleted") delete this.cookies[name];
      else this.cookies[name] = value;
    }
  }

  cookieHeader() {
    return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  }

  _request(method, url, opts = {}) {
    const { headers = {}, data = null, timeout = 15000, followRedirect = true, maxRedirects = 5, useProxy = false } = opts;
    let u;
    try {
      u = new URL(url);
    } catch {
      return Promise.reject(new Error("站点地址无效"));
    }
    const isHttps = u.protocol === "https:";
    const proxyUrl = proxyFromEnv(useProxy);
    const allHeaders = {
      "User-Agent": DEFAULT_UA,
      Accept: "*/*",
      ...headers,
    };
    const cookie = this.cookieHeader();
    if (cookie) allHeaders.Cookie = cookie;
    if (data != null && !allHeaders["Content-Type"]) {
      allHeaders["Content-Type"] = "application/x-www-form-urlencoded";
    }
    const site = u.host;

    return new Promise((resolve, reject) => {
      let settled = false;
      // 所有网络异常统一在此收敛为业务错误 reject，绝不外泄成 uncaughtException
      const fail = (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      };
      let activeSocket = null; // 代理隧道的 TLS socket，响应结束后主动关闭，避免隧道泄漏

      const finish = (res) => {
        // 响应体读取期间连接中断：IncomingMessage 同样会 emit 'error'，必须监听消化
        res.on("error", (err) => fail(new Error(`响应读取失败（${site}）：${err.code || err.message}`)));
        this._absorb(res);
        if (followRedirect && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (activeSocket) activeSocket.destroy();
          if (maxRedirects <= 0) {
            fail(new Error("重定向次数过多"));
            return;
          }
          let next;
          try {
            next = new URL(res.headers.location, u).toString();
          } catch {
            fail(new Error(`重定向地址无效（${site}）`));
            return;
          }
          this._request(method, next, { ...opts, maxRedirects: maxRedirects - 1 }).then(resolve, fail);
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          if (activeSocket) activeSocket.destroy(); // 响应读完即关闭隧道，避免连接残留
          const buf = Buffer.concat(chunks);
          resolve({ status: res.statusCode, headers: res.headers, text: buf.toString("utf8"), buffer: buf });
        });
      };

      const doRequest = (socket) => {
        try {
          const mod = isHttps ? https : http;
          const reqOpts = {
            method,
            headers: allHeaders,
            timeout,
            protocol: u.protocol,
            hostname: u.hostname,
            port: u.port || (isHttps ? 443 : 80),
            path: u.pathname + u.search,
          };
          if (socket) {
            activeSocket = socket;
            // 提供 createConnection 时 Node 不使用 agent（不查 DNS、不入连接池），
            // 由本请求独占该隧道 socket，响应结束后主动关闭
            reqOpts.createConnection = () => socket;
          }
          const req = mod.request(reqOpts, finish);
          req.on("timeout", () => req.destroy(new Error("请求超时")));
          req.on("error", (err) => fail(new Error(`请求失败（${site}）：${err.code || err.message}`)));
          if (data != null) req.write(typeof data === "string" ? data : JSON.stringify(data));
          req.end();
        } catch (err) {
          fail(new Error(`请求发起失败（${site}）：${err.code || err.message}`));
        }
      };

      if (isHttps && proxyUrl) {
        const proxyLabel = proxyDesc(proxyUrl);
        connectViaProxy(proxyUrl, u.hostname, u.port || 443, timeout)
          .then((tunnel) => {
            const tlsSock = tls.connect({ socket: tunnel, servername: u.hostname }, () => {
              tlsSock.setTimeout(0); // 握手完成，超时改由请求层接管
              doRequest(tlsSock);
            });
            // 关键修复：TLS 握手失败/中途断开必须在此消化，否则 TLSSocket 'error' 未捕获直接崩进程
            tlsSock.on("error", (err) => {
              try {
                tunnel.destroy();
              } catch {}
              fail(new Error(`代理连接失败（${proxyLabel} → ${site}）：${err.code || err.message}`));
            });
            tlsSock.setTimeout(timeout || 15000, () => tlsSock.destroy(new Error("代理 TLS 握手超时")));
          })
          .catch(fail);
      } else {
        doRequest(null);
      }
    });
  }

  async getText(url, opts = {}) {
    const r = await this._request("GET", url, opts);
    return r.text;
  }

  async postForm(url, form, opts = {}) {
    const body = new URLSearchParams(form).toString();
    const r = await this._request("POST", url, {
      ...opts,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        ...(opts.headers || {}),
      },
      data: body,
    });
    return r;
  }

  async postJson(url, obj, opts = {}) {
    const r = await this._request("POST", url, {
      ...opts,
      headers: {
        "Content-Type": "application/json",
        ...(opts.headers || {}),
      },
      data: JSON.stringify(obj),
    });
    return r;
  }

  async postRaw(url, body, opts = {}) {
    return this._request("POST", url, { ...opts, data: body });
  }

  async get(url, opts = {}) {
    return this._request("GET", url, opts);
  }
}

async function getJson(url, headers = {}, timeout = 15000) {
  const s = new Session();
  const r = await s._request("GET", url, { headers, timeout });
  return parseJson(r.text);
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function cleanText(text) {
  return String(text || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractFormhash(text) {
  if (!text) return null;
  let m = text.match(/name="formhash"\s+value="([^"]+)"/);
  if (m) return m[1];
  m = text.match(/formhash=([0-9a-zA-Z]+)/);
  return m ? m[1] : null;
}

module.exports = { Session, getJson, parseJson, cleanText, extractFormhash, DEFAULT_UA, proxyFromEnv, setGlobalProxy };
