"use strict";
/**
 * checkin — 通用 HTTP 客户端（零依赖）。
 * 支持 JSON/文本请求、Cookie 会话保持、跟随重定向、超时。
 * 供三个站点 adapter 共用。
 */
const http = require("http");
const https = require("https");
const { URL } = require("url");

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

class Session {
  constructor() {
    this.cookies = {}; // name -> value（按域简化为全局；自用签到站点单一域名，够用）
  }

  /** 从 set-cookie 头合并 cookie */
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
    const { headers = {}, data = null, timeout = 15000, followRedirect = true, maxRedirects = 5 } = opts;
    const u = new URL(url);
    const isHttps = u.protocol === "https:";
    const mod = isHttps ? https : http;
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

    return new Promise((resolve, reject) => {
      const req = mod.request(
        u,
        { method, headers: allHeaders, timeout },
        (res) => {
          this._absorb(res);
          // 重定向
          if (followRedirect && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            if (maxRedirects <= 0) {
              reject(new Error("重定向次数过多"));
              return;
            }
            const next = new URL(res.headers.location, u).toString();
            this._request(method, next, { ...opts, maxRedirects: maxRedirects - 1 }).then(resolve, reject);
            return;
          }
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const buf = Buffer.concat(chunks);
            resolve({
              status: res.statusCode,
              headers: res.headers,
              text: buf.toString("utf8"),
              buffer: buf,
            });
          });
        }
      );
      req.on("timeout", () => req.destroy(new Error("请求超时")));
      req.on("error", reject);
      if (data != null) req.write(typeof data === "string" ? data : JSON.stringify(data));
      req.end();
    });
  }

  /** GET 返回文本（解码按 utf8；站点 GBK 由调用方用 iconv 思路处理，自用站点均为 utf8） */
  async getText(url, opts = {}) {
    const r = await this._request("GET", url, opts);
    return r.text;
  }

  /** POST 表单 */
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

  /** POST JSON */
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

  /** POST 原文（body 已编码） */
  async postRaw(url, body, opts = {}) {
    return this._request("POST", url, { ...opts, data: body });
  }

  async get(url, opts = {}) {
    return this._request("GET", url, opts);
  }
}

/** 一次性请求（无会话）：GET JSON */
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

/** 清理 HTML 标签与空白 */
function cleanText(text) {
  return String(text || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 提取 formhash（Discuz 系） */
function extractFormhash(text) {
  if (!text) return null;
  let m = text.match(/name="formhash"\s+value="([^"]+)"/);
  if (m) return m[1];
  m = text.match(/formhash=([0-9a-zA-Z]+)/);
  return m ? m[1] : null;
}

module.exports = { Session, getJson, parseJson, cleanText, extractFormhash, DEFAULT_UA };
