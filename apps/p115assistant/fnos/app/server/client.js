"use strict";

/**
 * 115网盘助手 FPK —— 独立的 115 客户端（Node.js 版）。
 *
 * 覆盖本插件需要的登录、浏览、上传、签到和取链能力，算法与
 * MoviePilot-Plugins p115liteassistant/client.py 一致，全部用 Node 内置
 * 模块（node:https / node:http / node:crypto / node:fs）实现，零第三方依赖。
 *
 * 单线程事件循环串行执行所有请求：限流（limiter.js）、共享访问上限状态、
 * Open 授权刷新、上传扫描都在同一个 async 事务模型里进行。
 */

const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");

const { rsa_encrypt, rsa_decrypt, toId } = require("./crypto");
const { RequestPacer, getRateLimitProfile } = require("./limiter");

class U115AuthError extends Error {}
class U115ApiError extends Error {}
class U115AccessLimitError extends U115ApiError {}
class _U115OpenAuthError extends U115ApiError {}

class UploadResult {
  constructor(success, reused, fileItem, message) {
    this.success = Boolean(success);
    this.reused = Boolean(reused);
    this.fileItem = fileItem || null;
    this.message = String(message || "");
  }
}

class PlaybackCopy {
  constructor(fileId, pickcode, authMode) {
    this.fileId = fileId;
    this.pickcode = pickcode;
    this.authMode = authMode || "";
  }
}

// ───── HTTP 请求工具 ─────
const DEFAULT_TIMEOUT = 20 * 1000;

/**
 * 发起 HTTP(S) 请求。返回 { status, headers, body, data }：
 * data 为解析后的 JSON（若是 JSON），否则为原始文本。
 * 网络错误、非 2xx 一律抛 httpRequestError。
 */
function httpRequest(method, url, options) {
  options = options || {};
  const headers = Object.assign({}, options.headers || {});
  let body = options.body;
  if (body === undefined || body === null) body = "";
  if (typeof body === "string") {
    headers["Content-Length"] = Buffer.byteLength(body);
  } else if (Buffer.isBuffer(body)) {
    headers["Content-Length"] = body.length;
  }
  const timeoutMs = options.timeout || DEFAULT_TIMEOUT;
  const timeout = options.timeout === undefined ? DEFAULT_TIMEOUT : timeoutMs;
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (err) {
      reject(err);
      return;
    }
    const mod = target.protocol === "https:" ? https : http;
    const reqOptions = {
      hostname: target.hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      path: target.pathname + target.search,
      method: method,
      headers: headers,
    };
    let settled = false;
    const settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };
    // 长轮询（扫码状态等）用 destroy 强制超时，socket 空闲超时对持续流不生效。
    // 只有这里的 timer 触发才叫「请求超时」；req 层错误保留原始 err.code/message。
    const timer = setTimeout(() => {
      try { req.destroy(new Error("请求超时")); } catch (_e) {}
      const err = new Error("请求超时");
      err.name = "RequestTimeoutError";
      settle(reject, err);
    }, timeout);
    const req = mod.request(reqOptions, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks);
        const text = raw.toString("utf8");
        let data = null;
        const contentType = String(res.headers["content-type"] || "").toLowerCase();
        if (contentType.includes("json")) {
          try {
            data = JSON.parse(text);
          } catch {
            data = text;
          }
        } else if (text) {
          try {
            data = JSON.parse(text);
          } catch {
            data = text;
          }
        }
        const result = { status: res.statusCode, headers: res.headers, body: raw, data };
        if (res.statusCode >= 200 && res.statusCode < 300) {
          settle(resolve, result);
        } else {
          const err = httpRequestError(method, url, res.statusCode, result);
          settle(reject, err);
        }
      });
    });
    req.on("error", (err) => {
      // 保留原始网络错误（DNS/拒连/TLS/重置），不再一律伪装成「请求超时」。
      const wrapped = new Error(`请求失败: ${err.code || err.message}`);
      wrapped.name = "NetworkError";
      wrapped.code = err.code;
      wrapped.cause = err;
      settle(reject, wrapped);
    });
    if (body && body.length > 0) req.write(body);
    req.end();
  });
}

function httpRequestError(method, url, status, response) {
  // 附加响应体摘要（OSS XML 的 <Code>/<Message> 等），否则 403 只能靠猜。
  const snippet = responseSnippet(response);
  const err = new Error(`HTTP ${status}: ${method} ${url}${snippet ? ` | ${snippet}` : ""}`);
  err.name = "HttpStatusError";
  err.status = status;
  err.statusCode = status;
  err.response = response || null;
  return err;
}

function responseSnippet(response) {
  if (!response) return "";
  try {
    let text = "";
    if (typeof response.data === "string") text = response.data;
    else if (response.body) text = Buffer.isBuffer(response.body) ? response.body.toString("utf8") : String(response.body);
    if (!text) return "";
    const trimmed = text.trim();
    // OSS 错误体是 XML：提取 <Code> 与 <Message>。
    const code = (trimmed.match(/<Code>([^<]*)<\/Code>/) || [])[1];
    const message = (trimmed.match(/<Message>([^<]*)<\/Message>/) || [])[1];
    if (code || message) return `OSS <Code>${code || "?"}</Code> <Message>${(message || "").slice(0, 160)}</Message>`;
    return trimmed.slice(0, 200);
  } catch {
    return "";
  }
}

function isHttpStatusError(err) {
  return err && err.name === "HttpStatusError";
}

// ───── 工具函数 ─────
function b64encodeAsString(data) {
  return Buffer.from(String(data)).toString("base64");
}

function httpDate() {
  return new Date().toUTCString();
}

function determinePartSize(totalSize, preferredSize) {
  const defaultsPartSize = 10 * 1024 * 1024;
  const minPartSize = 100 * 1024;
  const maxPartCount = 10000;
  if (!preferredSize) preferredSize = defaultsPartSize;
  let size = preferredSize;
  if (totalSize < size) return totalSize;
  while (size * maxPartCount < totalSize || size < minPartSize) {
    size *= 2;
  }
  return size;
}

function sleep(seconds) {
  return new Promise((resolve) => {
    const ms = Math.max(1, Math.ceil(Number(seconds || 0) * 1000));
    setTimeout(resolve, ms);
  });
}

// ───── OSS 签名规范化（对齐官方 oss2 _subresource_key_set）─────
const OSS_SUBRESOURCE_KEYS = new Set([
  "acl", "uploads", "location", "cors", "logging", "website", "referer",
  "lifecycle", "delete", "append", "tagging", "objectMeta", "uploadId",
  "partNumber", "security-token", "position", "img", "style", "styleName",
  "replication", "versions", "versionId", "requestPayment", "x-oss-process",
  "sequential", "symlink", "restore", "callback", "callback-var", "qos",
  "bucketInfo", "comp", "vod", "startTime", "endTime", "x-oss-env-tags",
  "continuation-token", "response-cache-control", "response-content-disposition",
  "response-content-encoding", "response-content-language", "response-content-type",
  "response-expires",
]);

/**
 * 构造 OSS CanonicalizedResource：
 *   /bucket/object?<白名单子资源按 key 字典序>&<空值写裸键>
 * 非白名单参数（如 encoding-type）不进入签名串。
 */
function canonicalizeOssResource(objectPath, subResources) {
  let resource = String(objectPath || "");
  if (subResources && typeof subResources === "object") {
    const pairs = [];
    for (const [key, value] of Object.entries(subResources)) {
      if (!OSS_SUBRESOURCE_KEYS.has(key)) continue;
      const v = value === undefined || value === null ? "" : String(value);
      pairs.push(v === "" ? key : `${key}=${v}`);
    }
    pairs.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (pairs.length) resource += `?${pairs.join("&")}`;
  }
  return resource;
}

// ───── U115Client ─────
class U115Client {
  constructor(options) {
    options = options || {};
    this.baseUrl = "https://proapi.115.com";
    this.passportUrl = "https://passportapi.115.com";
    this.qrcodeStatusUrl = "https://qrcodeapi.115.com/get/status/";
    this.qrcodeBaseUrl = "https://qrcodeapi.115.com";
    this.pointsSignUrl = "https://proapi.115.com/android/2.0/user/points_sign";
    this.pointsSignHeaders = {
      "User-Agent": "Mozilla/5.0",
      Referer: "https://proapi.115.com",
    };
    this.webCopyUrl = "https://webapi.115.com/files/copy";
    this.webDeleteUrl = "https://webapi.115.com/rb/delete";
    this.lifeCalendarUrl = "https://life.115.com/api/1.0/web/1.0/calendar/setoption";
    this.lifeBehaviorIosUrl = "https://proapi.115.com/ios/behavior/detail";
    this.lifeBehaviorWebUrl = "https://webapi.115.com/behavior/detail";
    this.cookieDownloadUrl = "https://proapi.115.com/android/2.0/ufile/download";
    this.iosUserAgent =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) " +
      "AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/20D502 UDown/38.0.2";
    this.qrcodeClientTypes = new Set([
      "alipaymini",
      "wechatmini",
      "115android",
      "115ios",
      "web",
      "115ipad",
      "tv",
    ]);

    // 限流方案严格对齐 DDSRem-Dev/MoviePilot-Plugins 的 p115strmhelper。
    this.readRetryAttempts = 6;
    this.readRetryDelay = 2.0;
    this.transientHttpStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);
    this.rateLimitDefaultDelay = 60.0;
    this.rateLimitDelayPadding = 5.0;
    this.openAccessLimitAttempts = 6;
    this.openAccessLimitDelay = 70.0;
    this.uploadRequestTimeout = 120.0;
    this.uploadPartAttempts = 3;
    this.uploadPartRetryDelay = 1.0;
    this.downloadEndpoint = "/open/ufile/downurl";
    this.downloadRequestInterval = 1.0;
    this.directoryRequestInterval = 1 / 5;
    this.directoryScanWorkers = 6;
    this.directoryScanPrefetch = 12;
    this.deleteBatchSize = 200;
    this.playbackCopyDiscoveryDelays = [0.0, 0.5, 1.0, 2.0];
    this.playbackCopyDirectory = "多端播放";

    this.cookie = String(options.cookie || "").trim();
    this.tokens = Object.assign({}, options.tokens || {});
    const rawClientType = String(options.client_type || "").trim();
    this.clientType = this.qrcodeClientTypes.has(rawClientType) ? rawClientType : "";
    this._authState = null;
    this._openAuthBusy = false;
    this._openAuthInflight = null;
    this.rateLimitProfile = String(options.rate_limit_profile || "balanced")
      .trim()
      .toLowerCase();
    const profile = getRateLimitProfile(this.rateLimitProfile);
    this._pacer = new RequestPacer(profile);
    // 共享访问上限状态：{ event: bool, message }，见 runWithAccessLimitState。
    this._limitState = null;
    this._remoteDirCache = {
      "/": { fileid: "0", path: "/", name: "", type: "dir" },
    };
    this._playbackDirId = "";
    this._tokenSaver = options.tokenSaver || options.token_saver || null;

    // 静态工具方法同时以实例方法形式可用（Python 的 @staticmethod 在类外也能
    // 以 self.xxx 调用；Node 的 static 只能通过类名调用，这里补实例别名）。
    const staticHelpers = [
      "_payloadMessage",
      "_isResponseSuccess",
      "_isAccessLimitMessage",
      "_isCookieAuthError",
      "_isExistingDirectoryResponse",
      "_isUploadCallbackSuccess",
      "_responseData",
      "_isDirectory",
      "_itemName",
      "_itemId",
      "_itemMtime",
      "_itemSize",
      "_normalizeCloudPath",
      "_itemFromInfo",
      "_openClientId",
      "_isOpenAuthError",
      "_isOpenAuthPayload",
      "_uploadFileItem",
      "_mergeUploadInitResults",
      "_extractDownloadUrl",
      "_pickcodeToFileId",
      "_playbackCopyFileId",
      "_playbackCopyFromItem",
      "_normalizeDeleteIds",
    ];
    for (const name of staticHelpers) {
      this[name] = (...args) => U115Client[name](...args);
    }
  }
  exportTokens() {
    return Object.assign({}, this.tokens);
  }

  _persistTokens(tokens) {
    const next = Object.assign({}, tokens);
    if (this._tokenSaver) this._tokenSaver(Object.assign({}, next));
    this.tokens = next;
  }

  isAuthenticated() {
    return Boolean(
      this.cookie ||
        this.tokens.access_token ||
        this.tokens.refresh_token
    );
  }

  // ───── 二维码登录 ─────
  async generateQrcode(clientType) {
    clientType = this.qrcodeClientTypes.has(clientType) ? clientType : "alipaymini";
    // TOP6：data 在下方回退分支 `data = legacy.data` 会被重赋值，必须用 let；
    // 原先 const 在「主接口参数不完整 + 回退成功」路径上抛 Assignment to constant variable。
    let { data, fallbackMsg } = await this._fetchQrcodeToken(false);
    let uid = String(data.uid || "");
    let timestamp = String(data.time || "");
    let sign = String(data.sign || "");
    if (!uid || !timestamp || !sign) {
      const legacy = await this._fetchQrcodeToken(true);
      uid = uid || String(legacy.data.uid || "");
      timestamp = timestamp || String(legacy.data.time || "");
      sign = sign || String(legacy.data.sign || "");
      if (uid && timestamp && sign) data = legacy.data;
    }
    if (!uid || !timestamp || !sign) {
      return { success: false, message: fallbackMsg || "115 返回的二维码参数不完整" };
    }
    this._authState = {
      mode: "qrcode",
      uid,
      time: timestamp,
      sign,
      clientType,
      deviceId: crypto.randomUUID(),
    };
    return {
      success: true,
      data: {
        code_content: data.qrcode || `https://115.com/scan/dg-${uid}`,
        client_type: clientType,
      },
    };
  }

  async _fetchQrcodeToken(legacy) {
    const url = legacy
      ? `${this.qrcodeBaseUrl}/get/token`
      : `${this.qrcodeBaseUrl}/api/1.0/web/1.0/token/`;
    let payload;
    try {
      payload = await this._requestUrl(
        "GET",
        url,
        { requireAuth: false, noError: true, headers: this.qrcodeRequestHeaders() }
      );
    } catch (err) {
      return { data: {}, fallbackMsg: String(err.message || err) };
    }
    if (!payload || typeof payload !== "object") {
      return { data: {}, fallbackMsg: "115 二维码接口返回了无效响应" };
    }
    const message = this._payloadMessage(payload);
    const data = payload.data;
    return {
      data: data && typeof data === "object" ? data : {},
      fallbackMsg: message,
    };
  }

  qrcodeRequestHeaders() {
    return {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      Referer: "https://115.com/",
    };
  }

  async checkLogin() {
    if (!this._authState) {
      // 二维码轮询间登录已完成的兜底：_authState 已被清空，
      // 但 cookie/token 已持久化 → 直接返回已登录，前端据此关闭弹窗。
      if (this.isAuthenticated()) {
        return { success: true, data: { status: 2, tip: "已登录" } };
      }
      return { success: false, message: "请先生成二维码" };
    }
    if (this._authState.mode === "qrcode") return this._checkQrcodeLogin();
    const payload = await this._requestUrl(
      "GET",
      this.qrcodeStatusUrl,
      { requireAuth: false, noRetry: true, timeout: 20000, headers: this.qrcodeRequestHeaders(), params: { uid: this._authState.uid, time: this._authState.time, sign: this._authState.sign } }
    );
    if (payload.code != 0 || !payload.data) {
      return { success: false, message: payload.message || "检查登录状态失败" };
    }
    const data = payload.data;
    if (data.status == 2) {
      const tokenPayload = await this._request(
        "POST",
        "/open/deviceCodeToToken",
        { baseUrl: this.passportUrl, requireAuth: false, form: true, data: { uid: this._authState.uid, code_verifier: this._authState.codeVerifier } }
      );
      if (tokenPayload.code != 0) {
        return { success: false, message: tokenPayload.message || "获取访问令牌失败" };
      }
      this._persistTokens(Object.assign({}, tokenPayload.data || {}, { refresh_time: Math.floor(Date.now() / 1000) }));
      this._authState = null;
    }
    return { success: true, data: { status: data.status, tip: data.msg || "" } };
  }

  async _checkQrcodeLogin() {
    const clientType = String(this._authState.clientType || "alipaymini");
    const uid = String(this._authState.uid || "");
    if (!uid) return { success: false, message: "请先生成二维码" };
    // 115 扫码确认接口：POST form（account=uid&passwd=uid…）。
    // 未扫码时秒回"老乡验证失败"（code 40101017），扫码确认后返回 cookie。
    // 实测所有渠道端点行为一致；用户扫码确认记录可能绑定到任意渠道，
    // 因此优先尝试当前渠道，未成功再遍历其余渠道（任一带 cookie 即成功）。
    const channels = [clientType, ...this.qrcodeClientTypes].filter(
      (v, i, a) => v && a.indexOf(v) === i
    );
    let lastMessage = "";
    for (const channel of channels) {
      const result = await this._requestUrl(
        "POST",
        `${this.qrcodeBaseUrl}/app/1.0/${channel}/1.0/login/qrcode/`,
        {
          requireAuth: false,
          noRetry: true,
          noError: true,
          timeout: 10000,
          form: true,
          data: {
            account: uid,
            passwd: uid,
            country: "CN",
            device: "Web Browser",
            device_id: this._authState.deviceId || crypto.randomUUID(),
            os: "10.0",
            version: "1.0",
            app: "web",
          },
        }
      );
      // 老乡验证失败（40101017）= 用户尚未扫码确认 → 等待扫码
      const code = Number(result.code);
      if (code === 40101017) {
        lastMessage = "等待扫码";
        continue;
      }
      if (result.state !== 1 && code !== 0) {
        lastMessage = result.message || result.error || "检查登录状态失败";
        continue;
      }
      const cookieData = (result.data || {}).cookie;
      if (!cookieData || typeof cookieData !== "object") {
        lastMessage = result.message || "115 未返回登录 Cookie";
        continue;
      }
      const parts = [];
      for (const [key, value] of Object.entries(cookieData)) {
        if (key && value) parts.push(`${key}=${value}`);
      }
      const cookie = parts.join("; ");
      if (!cookie) {
        lastMessage = "115 未返回有效登录 Cookie";
        continue;
      }
      this.cookie = cookie;
      this.tokens = {};
      this.clientType = channel;
      this._authState = null;
      return { success: true, data: { status: 2, tip: "登录成功" } };
    }
    // 全部渠道均未确认扫码 → 返回等待状态（区别于失败）
    return { success: true, data: { status: 0, tip: lastMessage || "等待扫码" } };
  }

  // ───── Open 授权 ─────
  // 授权流程 single-flight：同一时刻只允许一个 refresh/设备码交换在进行，
  // 并发调用方共享同一个 in-flight Promise，等待其完成后再校验 token 是否可用。
  _runOpenAuthSingleFlight(operation) {
    if (this._openAuthInflight) return this._openAuthInflight;
    this._openAuthBusy = true;
    this._openAuthInflight = (async () => {
      try {
        return await operation();
      } finally {
        this._openAuthInflight = null;
        this._openAuthBusy = false;
      }
    })();
    return this._openAuthInflight;
  }

  async _awaitOpenAuthInflight() {
    if (!this._openAuthInflight) return;
    try {
      await this._openAuthInflight;
    } catch (_e) {
      // 等待者不重复抛出；发起方负责抛错。
    }
  }

  async refreshAccessToken() {
    if (this._openAuthInflight) {
      await this._awaitOpenAuthInflight();
      return !this._openTokenExpired();
    }
    const ok = await this._runOpenAuthSingleFlight(async () => {
      const refreshToken = this.tokens.refresh_token;
      if (!refreshToken) return false;
      let payload;
      try {
        payload = await this._request(
          "POST",
          "/open/refreshToken",
          { baseUrl: this.passportUrl, rateLimitRoute: "auth", requireAuth: false, noError: true, form: true, data: { refresh_token: refreshToken } }
        );
      } catch (err) {
        if (err instanceof U115AccessLimitError) throw err;
        return false;
      }
      const message = String(payload.message || payload.error || "");
      if (this._isAccessLimitMessage(message)) throw new U115AccessLimitError(message);
      const data = payload.data || {};
      if (payload.code != 0 || typeof data !== "object" || !data.access_token) return false;
      this._persistTokens(Object.assign({}, data, { refresh_time: Math.floor(Date.now() / 1000) }));
      return true;
    });
    return Boolean(ok);
  }

  static _openClientId() {
    return "100197847";
  }

  async _authorizeOpenFromCookie() {
    this._ensureCookieAuth();
    if (this._openAuthInflight) {
      // 已有授权流程在进行：等它完成，再校验 token 是否真正可用，
      // 不能把「正在授权」当成「授权成功」返回。
      await this._awaitOpenAuthInflight();
      if (this._openTokenExpired()) {
        throw new U115AuthError("115 Open 授权未完成，请重新扫码登录");
      }
      return;
    }
    await this._runOpenAuthSingleFlight(async () => {
      const codeVerifier = randomBase64Url(96).slice(0, 128);
      const codeChallenge = Buffer.from(
        crypto.createHash("sha256").update(codeVerifier).digest()
      ).toString("base64");
      const devicePayload = await this._requestUrl(
        "POST",
        `${this.passportUrl}/open/authDeviceCode`,
        { requireAuth: false, rateLimitRoute: "auth", form: true, data: { client_id: this._openClientId(), code_challenge: codeChallenge, code_challenge_method: "sha256" } }
      );
      const deviceData = devicePayload.data || {};
      const uid = String(deviceData.uid || "") || "";
      if (!uid) throw new U115AuthError("115 未返回 Open 授权设备码");
      await this._requestUrl("GET", `${this.qrcodeBaseUrl}/api/2.0/prompt.php`, { params: { uid } });
      await this._requestUrl("GET", `${this.qrcodeBaseUrl}/api/2.0/slogin.php`, { params: { key: uid, uid, client: 0 } });
      const tokenPayload = await this._requestUrl(
        "POST",
        `${this.passportUrl}/open/deviceCodeToToken`,
        { requireAuth: false, rateLimitRoute: "auth", form: true, data: { uid, code_verifier: codeVerifier } }
      );
      const tokenData = tokenPayload.data || {};
      if (typeof tokenData !== "object" || !tokenData.access_token) {
        throw new U115AuthError("115 未返回有效 Open 访问令牌");
      }
      this._persistTokens(Object.assign({}, tokenData, { refresh_time: Math.floor(Date.now() / 1000) }));
    });
    if (this._openTokenExpired()) {
      throw new U115AuthError("115 Open 授权未完成，请重新扫码登录");
    }
  }

  _openTokenExpired() {
    if (!this.tokens.access_token) return true;
    const expiresIn = parseInt(this.tokens.expires_in, 10) || 0;
    const refreshTime = parseInt(this.tokens.refresh_time, 10) || 0;
    if (!expiresIn || !refreshTime) return false;
    return Math.floor(Date.now() / 1000) >= refreshTime + Math.max(0, expiresIn - 60);
  }

  async _ensureOpenAuth() {
    if (!this._openTokenExpired()) return;
    if (this.tokens.refresh_token && (await this.refreshAccessToken()) && !this._openTokenExpired()) return;
    if (this.cookie) {
      try {
        await this._authorizeOpenFromCookie();
        if (this._openTokenExpired()) {
          throw new U115AuthError("115 Open 授权未完成，请重新扫码登录");
        }
        return;
      } catch (err) {
        if (err instanceof U115AccessLimitError) throw err;
        throw new U115AuthError(`无法使用 115 Cookie 获取 Open 授权: ${err.message}`);
      }
    }
    throw new U115AuthError("缺少有效的 115 Open 授权，请重新扫码登录");
  }

  static _isOpenAuthError(err) {
    const status = isHttpStatusError(err) ? err.status : err.response && err.response.status;
    return status === 401 || status === 403;
  }

  static _isOpenAuthPayload(payload) {
    const code = String(payload.code || payload.errno || "");
    return code === "401" || code === "403" || code === "40140125";
  }

  async _recoverOpenAuth(failedAccessToken, err) {
    const current = String(this.tokens.access_token || "");
    if (current && current !== failedAccessToken) return;
    if (await this.refreshAccessToken()) return;
    if (!this.cookie) throw new U115AuthError("115 Open 授权已失效，请重新扫码登录");
    try {
      await this._authorizeOpenFromCookie();
    } catch (authErr) {
      if (authErr instanceof U115AccessLimitError) throw authErr;
      throw new U115AuthError(`无法使用 115 Cookie 获取 Open 授权: ${authErr.message}`);
    }
  }

  async ensureUploadReady() {
    await this._request("GET", "/open/user/info", { rateLimitRoute: "upload_control" });
  }

  // ───── 共享访问上限状态 ─────
  newAccessLimitState() {
    return { event: false, message: "" };
  }

  async runWithAccessLimitState(state, operation) {
    const previous = this._limitState;
    this._limitState = state;
    try {
      this._raiseIfSharedAccessLimited();
      return await operation();
    } catch (err) {
      if (err instanceof U115AccessLimitError) {
        this._markSharedAccessLimited(err);
      }
      throw err;
    } finally {
      this._limitState = previous;
    }
  }

  _raiseIfSharedAccessLimited() {
    const state = this._limitState;
    if (!state) return;
    if (!state.event) return;
    const message = String(state.message || "").trim();
    throw new U115AccessLimitError(message || "115 并发任务因访问上限中止");
  }

  _markSharedAccessLimited(error) {
    const state = this._limitState;
    if (!state) return false;
    if (error && !state.message) state.message = String(error.message || error);
    const first = !state.event;
    state.event = true;
    return first;
  }

  _requestCancelled() {
    const state = this._limitState;
    return Boolean(state && state.event);
  }

  async _waitForRequestRetry(delay) {
    const state = this._limitState;
    delay = Math.max(0, Number(delay) || 0);
    if (!state) {
      await sleep(delay);
      return;
    }
    const stepMs = 100;
    const totalMs = Math.floor(delay * 1000);
    let waited = 0;
    while (waited < totalMs) {
      if (this._requestCancelled()) {
        this._raiseIfSharedAccessLimited();
        throw new U115AccessLimitError("115 并发任务因访问上限中止");
      }
      await sleep(stepMs / 1000);
      waited += stepMs;
    }
  }

  // ───── 目录浏览 ─────
  async getDirList(cid) {
    return this._getOpenDirList(cid || "0");
  }

  async _getOpenDirList(cid) {
    const items = [];
    let offset = 0;
    const pageSize = 1150;
    while (true) {
      const payload = await this._request(
        "GET",
        "/open/ufile/files",
        {
          rateLimitRoute: "directory",
          params: {
            cid: String(cid || "0"),
            limit: pageSize,
            offset,
            show_dir: 1,
            o: "user_utime",
            asc: 0,
          },
        }
      );
      const data = this._responseData(payload);
      if (!Array.isArray(data)) throw new U115ApiError("115 Open 目录分页返回了无效响应");
      const batch = data.slice();
      items.push(...batch);
      const nextOffset = offset + batch.length;
      let total = -1;
      if (payload.count !== undefined && payload.count !== null) {
        const t = parseInt(payload.count, 10);
        if (!Number.isNaN(t)) total = t;
      }
      if (!batch.length || (total >= 0 && nextOffset >= total)) return items;
      if (total < 0 && batch.length < pageSize) return items;
      offset = nextOffset;
      await this._pacer.acquireDirectoryPage(() => this._requestCancelled());
      this._raiseIfSharedAccessLimited();
    }
  }

  async getItem(pathName) {
    const normalized = this._normalizeCloudPath(pathName);
    const payload = await this._request("POST", "/open/folder/get_info", {
      noError: true,
      rateLimitRoute: "metadata",
      form: true,
      data: { path: normalized },
    });
    return this._parseOpenItem(payload, normalized, true);
  }

  async getItemById(fileId) {
    const normalizedId = String(fileId || "").trim();
    if (!normalizedId) throw new Error("115 文件 ID 不能为空");
    if (normalizedId === "0") {
      return {
        fileid: "0",
        parent_id: "0",
        path: "/",
        type: "dir",
        name: "",
        pickcode: "",
        size: null,
        mtime: 0,
      };
    }
    const payload = await this._request("POST", "/open/folder/get_info", {
      noError: true,
      rateLimitRoute: "metadata",
      form: true,
      data: { file_id: normalizedId },
    });
    return this._parseOpenItem(payload, "", false);
  }

  _parseOpenItem(payload, requestedPath, strict) {
    strict = strict !== false;
    if (!this._isResponseSuccess(payload)) {
      const code = String(payload.code || payload.errno || "");
      const message = String(payload.message || payload.error || JSON.stringify(payload));
      if (
        code === "10014" ||
        code === "20018" ||
        code === "404" ||
        code === "430004" ||
        /不存在|未找到|找不到/.test(message)
      ) {
        return null;
      }
      throw new U115ApiError(message);
    }
    const data = payload.data;
    if (!data) return null;
    if (typeof data !== "object") throw new U115ApiError("115 文件信息响应无效");
    const fileId = this._itemId(data);
    let category = data.file_category !== undefined ? data.file_category : data.fc;
    if (category === undefined || category === null || category === "") {
      category = data.pick_code || data.pickcode || data.pc ? "1" : "0";
    }
    const name = this._itemName(data);
    let p = requestedPath || this._pathFromOpenInfo(data);
    if (!fileId || (!name && p !== "/")) {
      throw new U115ApiError("115 文件信息字段不完整");
    }
    category = String(category);
    if (category !== "0" && category !== "1") {
      throw new U115ApiError(`115 文件信息类型无效: ${category}`);
    }
    if (strict && this._itemMtime(data) <= 0) {
      throw new U115ApiError("115 文件信息缺少有效修改时间");
    }
    if (category === "1") {
      if (!String(data.pick_code || data.pickcode || data.pc || "").trim() && strict) {
        throw new U115ApiError("115 文件信息缺少 pick_code");
      }
      const size = this._itemSize(data);
      if ((size === null || size < 0) && strict) {
        throw new U115ApiError("115 文件信息缺少有效文件大小");
      }
    }
    const item = this._itemFromInfo(data, p);
    const paths = data.paths;
    if (Array.isArray(paths) && paths.length) {
      const parent = paths[paths.length - 1];
      if (parent && typeof parent === "object") {
        item.parent_id = String(parent.file_id || parent.cid || parent.id || "0");
      }
    }
    if (item.parent_id === undefined) {
      item.parent_id = String(data.parent_id || data.pid || "0");
    }
    return item;
  }

  _pathFromOpenInfo(info) {
    const direct = info.path || info.file_path;
    if (typeof direct === "string" && direct.trim()) {
      let normalized = this._normalizeCloudPath(direct);
      const name = this._itemName(info);
      if (name && posixBasename(normalized) !== name) {
        normalized = this._normalizeCloudPath(`${normalized.replace(/\/+$/, "")}/${name}`);
      }
      return normalized;
    }
    const pathValue = info.paths;
    if (typeof pathValue === "string" && pathValue.trim()) {
      let normalized = this._normalizeCloudPath(pathValue);
      const name = this._itemName(info);
      if (name && posixBasename(normalized) !== name) {
        normalized = this._normalizeCloudPath(`${normalized.replace(/\/+$/, "")}/${name}`);
      }
      return normalized;
    }
    const parts = [];
    if (Array.isArray(pathValue)) {
      for (const entry of pathValue) {
        if (entry && typeof entry === "object") {
          const entryId = String(entry.file_id || entry.cid || entry.id || "");
          const entryName = String(
            entry.file_name || entry.name || entry.n || ""
          ).replace(/^\/+|\/+$/g, "");
          if (entryId === "0" || entryName === "根目录" || entryName === "全部文件" || entryName === "文件") {
            continue;
          }
          if (entryName) parts.push(entryName);
        } else if (typeof entry === "string") {
          parts.push(...entry.replace(/\\/g, "/").split("/").filter(Boolean));
        }
      }
    }
    const name = this._itemName(info);
    if (name && (!parts.length || parts[parts.length - 1] !== name)) parts.push(name);
    if (!parts.length) throw new U115ApiError("115 文件信息缺少完整路径");
    return this._normalizeCloudPath("/" + parts.join("/"));
  }

  // ───── 生活事件（保留接口，Node 版未在 UI 暴露）─────
  async enableLifeEvents() {
    const payload = await this._requestUrl("POST", this.lifeCalendarUrl, {
      rateLimitRoute: "mutation",
      form: true,
      data: { locus: 1, open_life: 1 },
      headers: { "User-Agent": this.iosUserAgent },
    });
    if (!this._isResponseSuccess(payload)) {
      const message = String(payload.message || payload.error || JSON.stringify(payload));
      throw new U115ApiError(`开启 115 生活事件失败: ${message}`);
    }
  }

  async getLifeEventsPage(opts) {
    opts = opts || {};
    const app = String(opts.app || "ios").trim().toLowerCase();
    if (app !== "ios" && app !== "web") {
      throw new Error(`不支持的 115 生活事件接口: ${app}`);
    }
    const url = app === "web" ? this.lifeBehaviorWebUrl : this.lifeBehaviorIosUrl;
    const params = {
      type: String(opts.event_type || ""),
      date: String(opts.date || ""),
      limit: Math.min(1000, Math.max(1, parseInt(opts.limit, 10) || 1000)),
      offset: Math.max(0, parseInt(opts.offset, 10) || 0),
    };
    const payload = await this._requestUrl("GET", url, {
      rateLimitRoute: app === "web" ? "life_web" : "life_ios",
      params,
      headers: { "User-Agent": this.iosUserAgent },
    });
    const data = payload.data;
    if (!data || typeof data !== "object" || !Array.isArray(data.list)) {
      throw new U115ApiError("115 生活事件响应无效");
    }
    return {
      events: data.list.filter((item) => item && typeof item === "object"),
      count: parseInt(data.count, 10) || 0,
    };
  }

  // ───── 目录创建 ─────
  async ensureRemoteDir(pathName) {
    const cloudPath = this._normalizeCloudPath(pathName);
    let current = this._cachedRemoteDir("/");
    if (cloudPath === "/") return current;
    for (const name of cloudPath.split("/").filter(Boolean)) {
      const childPath = `${current.path.replace(/\/+$/, "")}/${name}`;
      let cached = this._cachedRemoteDir(childPath);
      if (cached) {
        current = cached;
        continue;
      }
      let found = await this._findOpenDirectory(current.fileid, name);
      if (found) {
        current = {
          fileid: this._itemId(found),
          path: childPath,
          name,
          type: "dir",
        };
        this._rememberRemoteDir(current);
        continue;
      }
      const payload = await this._request("POST", "/open/folder/add", {
        noError: true,
        rateLimitRoute: "upload_control",
        form: true,
        data: { pid: String(current.fileid || "0"), file_name: name },
      });
      let data = this._responseData(payload);
      if (this._isExistingDirectoryResponse(payload)) {
        found = await this._findOpenDirectory(current.fileid, name);
        if (!found) {
          throw new U115ApiError(`创建 115 目录失败: ${name}（目录已存在但无法读取）`);
        }
        data = found;
      } else if (!data || typeof data !== "object" || !this._itemId(data)) {
        const message = String(payload.message || payload.error || JSON.stringify(payload));
        throw new U115ApiError(`创建 115 目录失败: ${name}，原因：${message}`);
      }
      current = {
        fileid: this._itemId(data),
        path: childPath,
        name,
        type: "dir",
      };
      this._rememberRemoteDir(current);
    }
    return current;
  }

  _cachedRemoteDir(pathName) {
    const item = this._remoteDirCache[pathName];
    return item ? Object.assign({}, item) : null;
  }

  _rememberRemoteDir(item) {
    const p = this._normalizeCloudPath(String(item.path || "/"));
    this._remoteDirCache[p] = Object.assign({}, item);
  }

  clearRemoteDirCache() {
    this._remoteDirCache = { "/": { fileid: "0", path: "/", name: "", type: "dir" } };
  }

  async _findOpenDirectory(parentId, name) {
    const items = await this._getOpenDirList(parentId);
    return items.find((item) => this._isDirectory(item) && this._itemName(item) === name) || null;
  }

  // ───── 上传 ─────
  async uploadFile(targetDir, localPath) {
    await this._ensureOpenAuth();
    const stat = fs.statSync(localPath);
    const fileSize = stat.size;
    const fileSha1 = await this._calcSha1(localPath, null);
    // preid = 文件前 128KB 的 SHA1（115 Open 上传规范）；128 * 1024 是 128KB，
    // 此前写成 128 * 1024 * 1024（128MB）会算错 preid，触发 115 二次认证/秒传误判。
    const preid = await this._calcSha1(localPath, 128 * 1024);
    const targetCid = String((targetDir && targetDir.fileid) || "0");
    const initData = {
      file_name: path.basename(localPath),
      file_size: fileSize,
      target: `U_1_${targetCid}`,
      fileid: fileSha1,
      preid,
    };
    let payload = await this._request("POST", "/open/upload/init", {
      rateLimitRoute: "upload_control",
      form: true,
      data: initData,
      timeout: this.uploadRequestTimeout * 1000,
    });
    let initResult = this._responseData(payload);
    if (!initResult || typeof initResult !== "object") {
      return new UploadResult(false, false, null, "115 上传初始化失败");
    }
    const initCode = parseInt(initResult.code, 10) || 0;
    if ((initCode === 700 || initCode === 701) && initResult.sign_check) {
      const firstInitResult = Object.assign({}, initResult);
      Object.assign(initData, this._buildSignCheckData(localPath, initResult));
      payload = await this._request("POST", "/open/upload/init", {
        rateLimitRoute: "upload_control",
        form: true,
        data: initData,
        timeout: this.uploadRequestTimeout * 1000,
      });
      const secondInitResult = this._responseData(payload);
      if (!secondInitResult || typeof secondInitResult !== "object") {
        return new UploadResult(false, false, null, "115 上传二次认证失败");
      }
      initResult = this._mergeUploadInitResults(firstInitResult, secondInitResult);
    }
    const fileItem = this._uploadFileItem(initResult, path.basename(localPath));
    if (parseInt(initResult.status, 10) === 2) {
      return new UploadResult(true, true, fileItem, "");
    }
    await this._uploadToOss(localPath, fileSize, fileSha1, initData.target, initResult);
    return new UploadResult(true, false, fileItem, "");
  }

  static _uploadFileItem(data, fileName) {
    const fileId = data.file_id || data.fileid || data.fid;
    const pickcode = data.pick_code || data.pickcode || data.pc;
    if (!fileId && !pickcode) return null;
    const item = { name: fileName };
    if (fileId) item.fileid = String(fileId);
    if (pickcode) item.pickcode = String(pickcode);
    return item;
  }

  static _mergeUploadInitResults(first, second) {
    const merged = Object.assign({}, first, second);
    for (const key of ["bucket", "object", "callback", "pick_code"]) {
      if (first[key]) merged[key] = first[key];
    }
    return merged;
  }

  _buildSignCheckData(localPath, initResult) {
    const [startText, endText] = String(initResult.sign_check).split("-", 2);
    const start = parseInt(startText, 10);
    const end = parseInt(endText, 10);
    const fd = fs.openSync(localPath, "r");
    try {
      const length = end - start + 1;
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, start);
      // SHA1 全链路统一小写（对齐 fileid/preid 的 hexdigest() 与参考实现 p115client）：
      // 此前 toUpperCase() 与其余 SHA1 大小写不一致，遇 115 侧大小写敏感比对会误判。
      const signValue = crypto.createHash("sha1").update(buf).digest("hex");
      return {
        pick_code: String(initResult.pick_code || ""),
        sign_key: String(initResult.sign_key || ""),
        sign_val: signValue,
      };
    } finally {
      fs.closeSync(fd);
    }
  }

  async _calcSha1(localPath, limit) {
    const hash = crypto.createHash("sha1");
    const fd = fs.openSync(localPath, "r");
    try {
      let remaining = limit === null ? null : limit;
      let offset = 0;
      const CHUNK = 1024 * 1024;
      while (true) {
        const size = remaining === null ? CHUNK : Math.min(CHUNK, remaining);
        if (size <= 0) break;
        const buf = Buffer.alloc(size);
        const read = fs.readSync(fd, buf, 0, size, offset);
        if (read <= 0) break;
        hash.update(buf.subarray(0, read));
        offset += read;
        if (remaining !== null) {
          remaining -= read;
          if (remaining <= 0) break;
        }
      }
    } finally {
      fs.closeSync(fd);
    }
    return hash.digest("hex");
  }

  // ───── OSS 分片上传 ─────
  async _getUploadToken() {
    const payload = await this._request("GET", "/open/upload/get_token", {
      rateLimitRoute: "upload_control",
      timeout: this.uploadRequestTimeout * 1000,
    });
    const token = this._responseData(payload);
    const required = ["AccessKeyId", "AccessKeySecret", "SecurityToken", "endpoint"];
    if (!token || typeof token !== "object" || required.some((key) => !token[key])) {
      throw new U115ApiError("获取 115 上传凭证失败");
    }
    return token;
  }

  /**
   * OSS 签名 v1（StsAuth）：
   *   Authorization: OSS {AK}:{signature}
   *   string_to_sign = METHOD\nCONTENT-MD5\nCONTENT-TYPE\nDATE\n
   *                    canonicalized-x-oss-headers\ncanonicalized-resource
   *
   * 规范化规则与官方 oss2 库逐条对齐：
   *   1. 只有白名单子资源计入签名（encoding-type 等不在白名单，必须排除）；
   *   2. 空值子资源写成裸键（sequential、uploads，不带 =）；
   *   3. 子资源按键名按字典序排序（partNumber 在 uploadId 之前）。
   * 签名串与实际请求 URL 解耦：实际 URL 可保留 encoding-type=url 等参数，
   * 但签名串只包含白名单子资源的规范化形式。
   */
  _signOssRequest(method, objectPath, headers, token, subResources) {
    const accessKeyId = token.AccessKeyId;
    const accessKeySecret = token.AccessKeySecret;
    const canonicalizedResource = canonicalizeOssResource(objectPath, subResources);
    const canonOssHeaders = [];
    for (const [k, v] of Object.entries(headers)) {
      const lk = k.toLowerCase();
      if (lk.startsWith("x-oss-")) canonOssHeaders.push([lk, String(v)]);
    }
    canonOssHeaders.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    let canonHeaders = "";
    if (canonOssHeaders.length) {
      canonHeaders = canonOssHeaders.map(([k, v]) => `${k}:${v}`).join("\n") + "\n";
    }
    const contentMd5 = headers["Content-MD5"] || "";
    const contentType = headers["Content-Type"] || "";
    const date = headers["Date"] || "";
    const stringToSign = [method, contentMd5, contentType, date, canonHeaders + canonicalizedResource].join("\n");
    const signature = crypto
      .createHmac("sha1", accessKeySecret)
      .update(stringToSign)
      .digest("base64");
    return `OSS ${accessKeyId}:${signature}`;
  }

  // OSS CanonicalizedResource 使用「原始 ObjectName」（不 URL 编码），
  // 与 oss2 __get_resource_string 一致；请求 URL 才需要编码后的路径。
  static _ossResourcePath(bucketName, objectName) {
    return `/${bucketName}/${objectName}`;
  }

  // OSS 请求使用虚拟主机风格 URL：https://<bucket>.<host>/<object>
  // 115 要求必须用三级域名（Third Level Domain），路径风格会返回 403。
  static _ossEndpointUrl(endpoint, bucketName) {
    const u = new URL(endpoint);
    return `${u.protocol}//${bucketName}.${u.host}`;
  }

  static _ossUrlPath(objectName) {
    return `/${encodeURIComponent(objectName)}`;
  }

  async _initMultipartUpload(objectName, token, bucketName) {
    // 与 oss2 init_multipart_upload 一致：params {encoding-type:url, sequential:"", uploads:""}
    //   uploads 由 oss2 内部补入（请求 URL 带 uploads=），签名子资源为空值写裸键。
    const params = { "encoding-type": "url", sequential: "", uploads: "" };
    const headers = {
      Date: httpDate(),
      "x-oss-security-token": token.SecurityToken,
    };
    const resourcePath = U115Client._ossResourcePath(bucketName, objectName);
    const urlPath = U115Client._ossUrlPath(objectName);
    const ossEndpoint = U115Client._ossEndpointUrl(token.endpoint, bucketName);
    const authorization = this._signOssRequest("POST", resourcePath, headers, token, params);
    const url = `${ossEndpoint}${urlPath}?${new URLSearchParams(params).toString()}`;
    const res = await httpRequest("POST", url, {
      headers: Object.assign(headers, { Authorization: authorization, "Content-Length": 0 }),
      body: "",
    });
    // OSS init_multipart_upload 返回 XML，不是 JSON；从原始 body 中提取 UploadId。
    let uploadId = "";
    if (res.data && typeof res.data === "object" && res.data.UploadId) {
      uploadId = String(res.data.UploadId);
    } else if (typeof res.body === "string" || Buffer.isBuffer(res.body)) {
      const xml = Buffer.isBuffer(res.body) ? res.body.toString("utf8") : res.body;
      const m = xml.match(/<UploadId[^>]*>([^<]*)<\/UploadId>/i);
      if (m) uploadId = m[1];
    }
    if (!uploadId) throw new U115ApiError("115 未返回分片上传 ID");
    return uploadId;
  }

  async _uploadPart(objectName, uploadId, partNumber, localPath, offset, size, token, bucketName) {
    const fd = fs.openSync(localPath, "r");
    let buf;
    try {
      buf = Buffer.alloc(size);
      const read = fs.readSync(fd, buf, 0, size, offset);
      if (read !== size) throw new U115ApiError(`分片 ${partNumber} 读取不完整`);
    } finally {
      fs.closeSync(fd);
    }
    const params = { partNumber: String(partNumber), uploadId };
    const headers = {
      Date: httpDate(),
      "Content-Length": buf.length,
      "x-oss-security-token": token.SecurityToken,
    };
    const resourcePath = U115Client._ossResourcePath(bucketName, objectName);
    const urlPath = U115Client._ossUrlPath(objectName);
    const ossEndpoint = U115Client._ossEndpointUrl(token.endpoint, bucketName);
    const authorization = this._signOssRequest("PUT", resourcePath, headers, token, params);
    const url = `${ossEndpoint}${urlPath}?${new URLSearchParams({ uploadId, partNumber: String(partNumber) }).toString()}`;
    const res = await httpRequest("PUT", url, {
      headers: Object.assign(headers, { Authorization: authorization }),
      body: buf,
    });
    const etag = String(res.headers.etag || "").replace(/^"|"$/g, "");
    if (!etag) throw new U115ApiError(`115 分片 ${partNumber} 上传未返回 ETag`);
    return { partNumber, etag };
  }

  _completeUploadXml(parts) {
    const sorted = parts.slice().sort((a, b) => a.partNumber - b.partNumber);
    let xml = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<CompleteMultipartUpload>";
    for (const p of sorted) {
      xml += `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>"${p.etag}"</ETag></Part>`;
    }
    xml += "</CompleteMultipartUpload>";
    return xml;
  }

  async _completeMultipartUpload(objectName, uploadId, parts, callback, token, bucketName) {
    const params = { uploadId };
    const body = this._completeUploadXml(parts);
    const headers = {
      Date: httpDate(),
      "Content-Length": Buffer.byteLength(body),
      "X-oss-callback": b64encodeAsString(callback.callback),
      "x-oss-callback-var": b64encodeAsString(callback.callback_var),
      "x-oss-forbid-overwrite": "false",
      // STS 临时凭证必须随每个 OSS 请求携带，缺失会直接 403 AccessDenied。
      "x-oss-security-token": token.SecurityToken,
    };
    const resourcePath = U115Client._ossResourcePath(bucketName, objectName);
    const urlPath = U115Client._ossUrlPath(objectName);
    const ossEndpoint = U115Client._ossEndpointUrl(token.endpoint, bucketName);
    const authorization = this._signOssRequest("POST", resourcePath, headers, token, params);
    const url = `${ossEndpoint}${urlPath}?${new URLSearchParams({ uploadId }).toString()}`;
    const res = await httpRequest("POST", url, {
      headers: Object.assign(headers, { Authorization: authorization }),
      body,
    });
    return res;
  }

  async _abortMultipartUpload(objectName, uploadId, token, bucketName) {
    try {
      const params = { uploadId };
      const headers = {
        Date: httpDate(),
        "x-oss-security-token": token.SecurityToken,
      };
      const resourcePath = U115Client._ossResourcePath(bucketName, objectName);
      const urlPath = U115Client._ossUrlPath(objectName);
      const ossEndpoint = U115Client._ossEndpointUrl(token.endpoint, bucketName);
      const authorization = this._signOssRequest("DELETE", resourcePath, headers, token, params);
      const url = `${ossEndpoint}${urlPath}?${new URLSearchParams({ uploadId }).toString()}`;
      await httpRequest("DELETE", url, {
        headers: Object.assign(headers, { Authorization: authorization }),
        body: "",
      });
    } catch (err) {
      console.warn(`【115 上传】清理失败的分片任务异常: ${err.message}`);
    }
  }

  isCredentialError(err) {
    if (isHttpStatusError(err)) {
      const body = err.response && err.response.data;
      let code = "";
      if (body && typeof body === "object") {
        code = String(body.Code || "");
      } else if (typeof body === "string") {
        const m = body.match(/<Code>([^<]*)<\/Code>/);
        code = m ? m[1] : "";
      }
      return code === "SecurityTokenExpired" || code === "InvalidAccessKeyId";
    }
    return false;
  }

  async _retryWithDelay(fn, attempts) {
    attempts = Math.max(1, attempts);
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await fn(attempt);
      } catch (err) {
        lastError = err;
        if (attempt < attempts) {
          await sleep(this.uploadPartRetryDelay * Math.pow(2, Math.max(0, attempt - 1)));
        }
      }
    }
    throw lastError;
  }

  async _uploadToOss(localPath, fileSize, fileSha1, target, initResult) {
    const bucketName = String(initResult.bucket || "");
    const objectName = String(initResult.object || "");
    if (!bucketName || !objectName) {
      throw new U115ApiError("115 上传初始化响应缺少对象存储信息");
    }
    let token = await this._getUploadToken();
    const pickCode = initResult.pick_code;
    const resumePayload = await this._request("POST", "/open/upload/resume", {
      noError: true,
      rateLimitRoute: "upload_control",
      form: true,
      timeout: this.uploadRequestTimeout * 1000,
      data: { file_size: fileSize, target, fileid: fileSha1, pick_code: pickCode },
    });
    const resume = this._responseData(resumePayload);
    const resumeCallback = resume && typeof resume === "object" ? resume.callback : null;
    const callback = resumeCallback || initResult.callback || {};
    if (
      !callback ||
      typeof callback !== "object" ||
      !String(callback.callback || "").trim() ||
      !String(callback.callback_var || "").trim()
    ) {
      throw new U115ApiError("115 上传初始化响应缺少有效回调参数");
    }
    const partSize = determinePartSize(fileSize, 10 * 1024 * 1024);
    const attempts = Math.max(1, this.uploadPartAttempts);
    let uploadId = "";
    let uploadCompleted = false;

    const refreshToken = async () => {
      token = await this._getUploadToken();
    };

    try {
      await this._retryWithDelay(async () => {
        try {
          uploadId = await this._initMultipartUpload(objectName, token, bucketName);
        } catch (err) {
          if (this.isCredentialError(err)) await refreshToken();
          throw err;
        }
      }, attempts);
      if (!uploadId) throw new U115ApiError("115 未返回分片上传 ID");

      const parts = [];
      let offset = 0;
      let partNumber = 1;
      while (offset < fileSize) {
        const size = Math.min(partSize, fileSize - offset);
        const part = await this._retryWithDelay(async () => {
          try {
            return await this._uploadPart(
              objectName, uploadId, partNumber, localPath, offset, size, token, bucketName
            );
          } catch (err) {
            if (this.isCredentialError(err)) await refreshToken();
            throw err;
          }
        }, attempts);
        parts.push(part);
        partNumber += 1;
        offset += size;
      }

      let completeResult = null;
      await this._retryWithDelay(async () => {
        try {
          completeResult = await this._completeMultipartUpload(
            objectName, uploadId, parts, callback, token, bucketName
          );
          if (completeResult.status !== 200) {
            throw new U115ApiError(`完成 115 分片上传失败，HTTP 状态 ${completeResult.status}`);
          }
          uploadCompleted = true;
        } catch (err) {
          if (this.isCredentialError(err)) await refreshToken();
          throw err;
        }
      }, attempts);

      const callbackPayload = completeResult.data;
      if (!callbackPayload || typeof callbackPayload !== "object" || !this._isUploadCallbackSuccess(callbackPayload)) {
        const message = callbackPayload && typeof callbackPayload === "object"
          ? callbackPayload.message || callbackPayload.error || JSON.stringify(callbackPayload)
          : String(callbackPayload);
        throw new U115ApiError(`115 上传回调失败: ${message}`);
      }
    } catch (err) {
      if (uploadId && !uploadCompleted) {
        await this._abortMultipartUpload(objectName, uploadId, token, bucketName);
      }
      throw err;
    }
  }

  // ───── 302 取链 / 播放 ─────
  _playbackAuthMode(mode) {
    mode = String(mode || "").trim().toLowerCase();
    if (!mode) mode = this.cookie ? "cookie" : "open";
    if (mode !== "cookie" && mode !== "open") {
      throw new Error(`不支持的 302 取链模式: ${mode}`);
    }
    if (mode === "cookie") this._ensureCookieAuth();
    return mode;
  }

  async getDownloadUrl(pickcode, userAgent, mode) {
    if (!pickcode) return null;
    mode = this._playbackAuthMode(mode);
    if (mode === "cookie") return this._getCookieDownloadUrl(pickcode, userAgent);
    return this._getOpenDownloadUrl(pickcode, userAgent);
  }

  async _getCookieDownloadUrl(pickcode, userAgent) {
    const encrypted = rsa_encrypt(
      Buffer.from(JSON.stringify({ pick_code: pickcode }))
    );
    const payload = await this._requestUrl("POST", this.cookieDownloadUrl, {
      rateLimitRoute: "download_link",
      form: true,
      data: { data: encrypted },
      headers: { "User-Agent": userAgent },
    });
    const encryptedData = payload.data;
    if (!encryptedData) throw new U115ApiError("115 Cookie 取链未返回加密数据");
    let data;
    try {
      data = JSON.parse(rsa_decrypt(String(encryptedData)).toString("utf8"));
    } catch (err) {
      throw new U115ApiError("115 Cookie 下载地址解析失败");
    }
    if (!data || typeof data !== "object") throw new U115ApiError("115 Cookie 下载地址响应无效");
    return this._extractDownloadUrl(data);
  }

  static _extractDownloadUrl(data) {
    if (!data || typeof data !== "object") return null;
    const candidates = [data];
    for (const value of Object.values(data)) {
      if (value && typeof value === "object") candidates.push(value);
    }
    for (const candidate of candidates) {
      let url = candidate.url;
      if (url && typeof url === "object") url = url.url;
      if (typeof url === "string" && url) return url;
    }
    return null;
  }

  async _getOpenDownloadUrl(pickcode, userAgent) {
    const payload = await this._request("POST", this.downloadEndpoint, {
      noError: true,
      rateLimitRoute: "download_link",
      form: true,
      data: { pick_code: pickcode },
      headers: { "User-Agent": userAgent },
    });
    const data = this._responseData(payload);
    return this._extractDownloadUrl(data);
  }

  async downloadFile(pickcode, outputPath, createParent, expectedSize) {
    const userAgent = this.iosUserAgent;
    const url = await this.getDownloadUrl(pickcode, userAgent);
    if (!url) throw new U115ApiError("未获取到 115 下载地址");
    if (createParent !== false) {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    }
    const tempOutput = `${outputPath}.${process.pid}.tmp`;
    try {
      await httpDownloadToFile(url, { headers: { "User-Agent": userAgent } }, tempOutput, () => {
        this._raiseIfSharedAccessLimited();
      });
      // 下载完整性校验：有期望大小时核对最终字节数，截断/半程下载直接失败（不留半截文件）
      if (expectedSize !== undefined && expectedSize !== null) {
        const want = Number(expectedSize);
        const got = fs.statSync(tempOutput).size;
        if (want > 0 && got !== want) {
          throw new U115ApiError(`下载文件大小不符（期望 ${want}，实际 ${got}），已丢弃不完整下载`);
        }
      }
      fs.renameSync(tempOutput, outputPath);
    } catch (err) {
      if (isHttpStatusError(err) && err.status === 429) {
        throw new U115AccessLimitError("115 文件下载返回 HTTP 429，已停止本次任务");
      }
      throw err;
    } finally {
      try {
        fs.unlinkSync(tempOutput);
      } catch {
        /* 忽略 */
      }
    }
  }

  static _pickcodeToFileId(pickcode) {
    try {
      return parseInt(toId(pickcode), 10);
    } catch (err) {
      throw new U115ApiError("缺少 p115pickcode 依赖，无法启用多端播放");
    }
  }

  async _playbackDirectoryId() {
    if (this._playbackDirId) return this._playbackDirId;
    const directory = await this.ensureRemoteDir(this.playbackCopyDirectory);
    this._playbackDirId = String(directory.fileid || "");
    if (!this._playbackDirId) throw new U115ApiError("创建 115 多端播放目录失败");
    return this._playbackDirId;
  }

  async createPlaybackCopy(pickcode, mode) {
    mode = this._playbackAuthMode(mode);
    const targetCid = await this._playbackDirectoryId();
    const sourceFileId = this._pickcodeToFileId(pickcode);
    const baselineItem = await this._latestPlaybackCopyItem(targetCid);
    const baselineFileId = this._playbackCopyFileId(baselineItem || {});
    if (mode === "cookie") {
      await this._requestUrl("POST", this.webCopyUrl, {
        rateLimitRoute: "mutation",
        form: true,
        data: { fid: sourceFileId, pid: String(targetCid || "0") },
        headers: { "User-Agent": this.iosUserAgent },
      });
    } else {
      await this._request("POST", "/open/ufile/copy", {
        rateLimitRoute: "mutation",
        form: true,
        data: { file_id: sourceFileId, pid: String(targetCid || "0") },
        headers: { "User-Agent": this.iosUserAgent },
      });
    }
    let confirmedFileId = "";
    let lastError = null;
    for (const delay of this.playbackCopyDiscoveryDelays) {
      if (delay) await sleep(delay);
      const item = await this._latestPlaybackCopyItem(targetCid);
      if (!item) continue;
      const candidateFileId = this._playbackCopyFileId(item);
      if (!candidateFileId || candidateFileId === baselineFileId) continue;
      try {
        const copy = this._playbackCopyFromItem(item);
        return new PlaybackCopy(copy.fileId, copy.pickcode, mode);
      } catch (err) {
        confirmedFileId = candidateFileId;
        lastError = err;
      }
    }
    if (confirmedFileId) {
      try {
        await this.deleteFile(confirmedFileId, mode);
      } catch (cleanupErr) {
        throw new U115ApiError(`读取多端播放副本失败，且无法清理临时副本: ${cleanupErr.message}`);
      }
    }
    if (lastError) throw lastError;
    throw new U115ApiError("复制多端播放文件后未发现新副本");
  }

  async _latestPlaybackCopyItem(targetCid) {
    const params = {
      cid: String(targetCid || "0"),
      limit: 1,
      offset: 0,
      cur: 1,
      show_dir: 1,
      o: "user_ptime",
      asc: 0,
      custom_order: 2,
    };
    const payload = await this._request("GET", "/open/ufile/files", {
      rateLimitRoute: "directory",
      params,
      headers: { "User-Agent": this.iosUserAgent },
    });
    const data = this._responseData(payload);
    if (!Array.isArray(data) || !data.length || typeof data[0] !== "object") return null;
    return data[0];
  }

  static _playbackCopyFileId(item) {
    return String(item.fid || item.file_id || "");
  }

  static _playbackCopyFromItem(item) {
    const copiedPickcode = String(item.pc || item.pick_code || item.pickcode || "");
    const copiedFileId = U115Client._playbackCopyFileId(item);
    if (!copiedPickcode || !copiedFileId) {
      throw new U115ApiError("115 多端播放副本信息不完整");
    }
    return { fileId: copiedFileId, pickcode: copiedPickcode };
  }

  static _normalizeDeleteIds(fileId) {
    let raw;
    if (Array.isArray(fileId)) raw = fileId.slice();
    else raw = [fileId];
    const normalized = [];
    const seen = new Set();
    for (const value of raw) {
      const text = String(value || "").trim();
      if (!text) continue;
      // 115 ID 是 19 位十进制数，超出 JS 安全整数范围（2^53），
      // 必须按字符串原样保留，否则 parseInt 会丢失末几位导致删错对象。
      if (!/^\d{1,20}$/.test(text)) throw new Error(`无效的 115 文件 ID: ${text}`);
      if (/^0+$/.test(text)) throw new Error(`拒绝删除非法的 115 文件 ID: ${text}`);
      if (seen.has(text)) continue;
      seen.add(text);
      normalized.push(text);
    }
    return normalized;
  }

  async renameItem(fileId, name) {
    const target = String(fileId).trim();
    const newName = String(name).trim();
    if (!target) throw new Error("要改名的文件 ID 不能为空");
    if (!newName) throw new Error("新名字不能为空");
    if (newName.includes("/") || newName === "." || newName === "..") {
      throw new Error("名字里不能带路径分隔符");
    }
    await this._request("POST", "/open/ufile/update", {
      rateLimitRoute: "mutation",
      form: true,
      data: { file_id: String(target), file_name: newName },
      headers: { "User-Agent": this.iosUserAgent },
    });
  }

  async createChildDir(parentId, name) {
    const parent = String(parentId || "").trim() || "0";
    const newName = String(name).trim();
    if (!newName) throw new Error("目录名不能为空");
    if (newName.includes("/") || newName === "." || newName === "..") {
      throw new Error("目录名里不能带路径分隔符");
    }
    const payload = await this._request("POST", "/open/folder/add", {
      rateLimitRoute: "mutation",
      form: true,
      data: { pid: String(parent), file_name: newName },
      headers: { "User-Agent": this.iosUserAgent },
    });
    const data = this._responseData(payload);
    return data && typeof data === "object" ? data : {};
  }

  async deleteFile(fileId, mode) {
    const fileIds = this._normalizeDeleteIds(fileId);
    if (!fileIds.length) return;
    mode = this._playbackAuthMode(mode);
    const batchSize = Math.max(1, this.deleteBatchSize);
    for (let offset = 0; offset < fileIds.length; offset += batchSize) {
      const batch = fileIds.slice(offset, offset + batchSize);
      if (mode === "cookie") {
        const data = {};
        batch.forEach((value, index) => {
          data[`fid[${index}]`] = value;
        });
        data.ignore_warn = 1;
        await this._requestUrl("POST", this.webDeleteUrl, {
          rateLimitRoute: "mutation",
          form: true,
          data,
          headers: { "User-Agent": this.iosUserAgent },
        });
      } else {
        await this._request("POST", "/open/ufile/delete", {
          rateLimitRoute: "mutation",
          form: true,
          data: { file_ids: batch.join(",") },
          headers: { "User-Agent": this.iosUserAgent },
        });
      }
    }
  }

  async checkin(attempts, retryDelay) {
    attempts = Math.max(1, attempts === undefined ? 3 : parseInt(attempts, 10));
    retryDelay = retryDelay === undefined ? 3.0 : Number(retryDelay);
    this._ensureCookieAuth();
    const userId = this._cookieUserId();
    let isSignedToday = false;
    let data = null;
    try {
      const current = await this._requestUrl("GET", this.pointsSignUrl, {
        rateLimitRoute: "metadata",
        headers: this.pointsSignHeaders,
      });
      data = current.data;
      if (!data || typeof data !== "object") {
        throw new U115ApiError("115 签到状态返回数据无效");
      }
      isSignedToday = parseInt(data.is_sign_today, 10) === 1;
    } catch (err) {
      if (err instanceof U115AuthError || err instanceof U115AccessLimitError) throw err;
      throw new U115ApiError(`查询 115 签到状态失败: ${err.message}`);
    }
    if (isSignedToday) {
      return {
        already: true,
        message: "今日已签到",
        continuous_day: parseInt(data.continuous_day, 10) || 0,
        points_num: parseInt(data.points_num, 10) || 0,
      };
    }
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const tokenTime = Math.floor(Date.now() / 1000);
        const token = crypto
          .createHash("sha1")
          .update(`${userId}-Points_Sign@#115-${tokenTime}`)
          .digest("hex");
        const payload = await this._requestUrl("POST", this.pointsSignUrl, {
          rateLimitRoute: "mutation",
          headers: this.pointsSignHeaders,
          form: true,
          data: { token, token_time: tokenTime },
        });
        const data = payload.data;
        if (!data || typeof data !== "object") throw new U115ApiError("115 签到返回数据无效");
        return {
          already: false,
          continuous_day: data.continuous_day || 0,
          points_num: data.points_num || 0,
          message: "签到成功",
        };
      } catch (err) {
        if (err instanceof U115AccessLimitError) throw err;
        lastError = err;
        if (attempt < attempts) await sleep(retryDelay);
      }
    }
    throw lastError || new U115ApiError("115 签到失败");
  }

  _cookieUserId() {
    for (const part of String(this.cookie || "").split(";")) {
      const idx = part.indexOf("=");
      const key = (idx >= 0 ? part.slice(0, idx) : part).trim().toUpperCase();
      const value = idx >= 0 ? part.slice(idx + 1) : "";
      if (key !== "UID") continue;
      const userId = value.split("_", 1)[0];
      if (/^\d+$/.test(userId)) return parseInt(userId, 10);
      break;
    }
    throw new U115AuthError("115 Cookie 缺少有效 UID，请重新扫码登录");
  }

  // ───── 核心请求管线 ─────
  async _request(method, endpoint, options) {
    options = options || {};
    const url = `${options.baseUrl || this.baseUrl}${endpoint}`;
    const requireAuth = options.requireAuth !== false;
    if (!requireAuth) {
      return this._requestUrl(method, url, {
        requireAuth: false,
        noError: options.noError,
        rateLimitRoute: options.rateLimitRoute,
        rateLimitIsOpen: false,
        params: options.params,
        data: options.data,
        form: options.form,
        headers: options.headers,
        timeout: options.timeout,
      });
    }
    await this._ensureOpenAuth();
    const failedAccessToken = String(this.tokens.access_token || "");
    if (!failedAccessToken) {
      throw new U115AuthError("缺少有效的 115 Open 授权，请重新扫码登录");
    }
    try {
      return await this._requestOpenWithToken(
        method, url, failedAccessToken, options.noError,
        options.rateLimitRoute || "other_open", options
      );
    } catch (err) {
      if (err instanceof _U115OpenAuthError) {
        await this._recoverOpenAuth(failedAccessToken, err);
      } else if (isHttpStatusError(err) && this._isOpenAuthError(err)) {
        await this._recoverOpenAuth(failedAccessToken, err);
      } else {
        throw err;
      }
    }
    const accessToken = String(this.tokens.access_token || "");
    if (!accessToken) throw new U115AuthError("缺少有效的 115 Open 授权，请重新扫码登录");
    try {
      return await this._requestOpenWithToken(
        method, url, accessToken, options.noError,
        options.rateLimitRoute || "other_open", options
      );
    } catch (err) {
      if (err instanceof _U115OpenAuthError) {
        throw new U115AuthError("115 Open 授权恢复后仍然无效，请重新扫码登录");
      }
      if (isHttpStatusError(err) && this._isOpenAuthError(err)) {
        throw new U115AuthError("115 Open 授权恢复后仍然无效，请重新扫码登录");
      }
      throw err;
    }
  }

  async _requestOpenWithToken(method, url, accessToken, noError, rateLimitRoute, options) {
    const scopedHeaders = this._scopedAuthHeaders(options.headers, "", accessToken);
    const totalAttempts = Math.max(1, this.openAccessLimitAttempts);
    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      this._raiseIfSharedAccessLimited();
      const payload = await this._requestUrl(method, url, {
        requireAuth: false,
        noError: true,
        rateLimitRoute,
        rateLimitIsOpen: true,
        params: options.params,
        data: options.data,
        form: options.form,
        headers: scopedHeaders,
        timeout: options.timeout,
      });
      if (this._isResponseSuccess(payload)) return payload;
      if (this._isOpenAuthPayload(payload)) {
        const code = payload.code || payload.errno || "";
        const message = String(payload.message || payload.error || JSON.stringify(payload));
        throw new _U115OpenAuthError(code ? `${code}: ${message}` : message);
      }
      const message = String(payload.message || payload.error || JSON.stringify(payload));
      if (this._isAccessLimitMessage(message)) {
        const limitError = new U115AccessLimitError(`${message}（并发任务已停止本次任务）`);
        if (this._markSharedAccessLimited(limitError)) throw limitError;
        this._raiseIfSharedAccessLimited();
        if (attempt >= totalAttempts) {
          throw new U115AccessLimitError(`${message}（已按上游策略尝试 ${totalAttempts} 次）`);
        }
        const delay = Math.max(0, Number(this.openAccessLimitDelay) || 0);
        console.log(`【115 Open API】达到当前访问上限，等待 ${delay} 秒后重试（${attempt}/${totalAttempts - 1}）`);
        await this._waitForRequestRetry(delay);
        continue;
      }
      if (!noError) throw new U115ApiError(message);
      return payload;
    }
    throw new U115AccessLimitError("115 Open API 访问上限重试未返回结果");
  }

  async _requestUrl(method, url, options) {
    options = options || {};
    // 合并 GET 参数到 URL（原先 params 被忽略导致状态查询请求没有 uid/time/sign）
    const params = options.params;
    if (params && typeof params === "object") {
      const usp = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) usp.append(key, String(value));
      }
      const qs = usp.toString();
      if (qs) url += (url.includes("?") ? "&" : "?") + qs;
      delete options.params;
    }
    const requireAuth = options.requireAuth !== false;
    const noError = options.noError === true;
    const cookieRequest = requireAuth;
    if (requireAuth) {
      this._ensureCookieAuth();
      options.headers = this._scopedAuthHeaders(options.headers, this.cookie, "");
    }
    method = String(method || "GET").toUpperCase();
    const transientAttempts =
      method === "GET" || method === "HEAD" ? Math.max(1, this.readRetryAttempts) : 1;
    let attempt = 0;
    while (true) {
      try {
        this._raiseIfSharedAccessLimited();
        if (options.rateLimitRoute !== undefined) {
          await this._pacer.acquire(options.rateLimitRoute, {
            isOpen: Boolean(options.rateLimitIsOpen),
            cancelled: () => this._requestCancelled(),
          });
          this._raiseIfSharedAccessLimited();
        }
        const response = await this._httpJson(method, url, options);
        const payload = response.data;
        if (!payload || typeof payload !== "object") {
          throw new U115ApiError("115 返回了无效响应");
        }
        if (!this._isResponseSuccess(payload)) {
          const message = this._payloadMessage(payload);
          if ((cookieRequest || !noError) && this._isAccessLimitMessage(message)) {
            const limitError = new U115AccessLimitError(`${message}（并发任务已停止本次任务）`);
            if (this._markSharedAccessLimited(limitError)) throw limitError;
            this._raiseIfSharedAccessLimited();
            throw new U115AccessLimitError(message);
          }
          if (!noError && cookieRequest && this._isCookieAuthError(payload, message)) {
            throw new U115AuthError("115 Cookie 已失效，请重新扫码登录");
          }
          if (!noError) throw new U115ApiError(message);
        }
        return payload;
      } catch (err) {
        if (isHttpStatusError(err)) {
          const statusCode = err.status;
          if (statusCode === 429) {
            const limitError = new U115AccessLimitError("115 并发任务返回 HTTP 429，已停止本次任务");
            if (this._markSharedAccessLimited(limitError)) throw limitError;
            this._raiseIfSharedAccessLimited();
            // 429 必须纳入 attempt 上限：无 _limitState（未包在并发任务里）时，
            // 上面两行都是 no-op，若直接 continue 会在 while(true) 里无限重试 → 卡死。
            if (attempt >= transientAttempts - 1) {
              throw new U115AccessLimitError(
                "115 触发访问频率限制（HTTP 429），已达重试上限，请稍后再试"
              );
            }
            attempt += 1;
            const delay = this._httpStatusRetryDelay(err, attempt);
            console.log(
              `【115 HTTP】请求返回 429，等待 ${delay} 秒后重试（${attempt}/${transientAttempts - 1}）`
            );
            await this._waitForRequestRetry(delay);
            continue;
          }
          if (
            this.transientHttpStatuses.has(statusCode) &&
            attempt < transientAttempts - 1
          ) {
            attempt += 1;
            const delay = this._httpStatusRetryDelay(err, attempt);
            console.log(
              `【115 HTTP】请求返回临时状态 ${statusCode}，等待 ${delay} 秒后重试（${attempt}/${transientAttempts - 1}）`
            );
            await this._waitForRequestRetry(delay);
            continue;
          }
          throw err;
        }
        // noRetry 标记（扫码状态长轮询）：超时/网络错误直接抛出，不重试
        if (options.noRetry) throw err;
        if (attempt >= transientAttempts - 1) throw err;
        attempt += 1;
        await this._waitForRequestRetry(this.readRetryDelay * attempt);
      }
    }
  }

  _httpStatusRetryDelay(err, attempt) {
    if (err.status === 429) {
      const resetValue = err.response && err.response.headers["x-ratelimit-reset"];
      let resetDelay = this.rateLimitDefaultDelay;
      if (resetValue !== undefined && resetValue !== null && resetValue !== "") {
        const parsed = parseFloat(resetValue);
        if (!Number.isNaN(parsed)) resetDelay = parsed;
      }
      return Math.max(0, resetDelay) + Math.max(0, this.rateLimitDelayPadding);
    }
    return Math.max(0, this.readRetryDelay) * Math.pow(2, Math.max(0, attempt - 1));
  }

  _ensureCookieAuth() {
    if (!this.cookie) throw new U115AuthError("缺少有效的 115 Cookie，请重新扫码登录");
  }

  async _httpJson(method, url, options) {
    const headers = Object.assign({}, options.headers || {});
    const params = options.params;
    let finalUrl = url;
    if (params && Object.keys(params).length) {
      const qs = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) qs.append(key, value);
      }
      const qsText = qs.toString();
      if (qsText) finalUrl += (finalUrl.includes("?") ? "&" : "?") + qsText;
    }
    const data = options.data;
    let body = "";
    if (data !== undefined && data !== null) {
      if (options.form) {
        // 115 扫码登录确认接口（login/qrcode）要求 form-urlencoded
        const usp = new URLSearchParams();
        for (const [k, v] of Object.entries(data)) {
          if (v !== undefined && v !== null) usp.append(k, String(v));
        }
        body = usp.toString();
        headers["Content-Type"] = "application/x-www-form-urlencoded";
      } else {
        body = JSON.stringify(data);
        headers["Content-Type"] = "application/json";
      }
    }
    if (!headers["User-Agent"]) headers["User-Agent"] = "P115LiteAssistant/1.0";
    return httpRequest(method, finalUrl, {
      headers,
      body,
      timeout: options.timeout,
    });
  }

  _scopedAuthHeaders(headers, cookie, bearer) {
    const scoped = Object.assign({}, headers || {});
    for (const key of Object.keys(scoped)) {
      if (String(key).toLowerCase() === "authorization" || String(key).toLowerCase() === "cookie") {
        delete scoped[key];
      }
    }
    if (cookie) scoped["Cookie"] = cookie;
    if (bearer) scoped["Authorization"] = `Bearer ${bearer}`;
    return scoped;
  }

  static _payloadMessage(payload) {
    const message = String(payload.message || payload.msg || payload.error || "");
    return message.replace(/\s+/g, " ").trim();
  }

  static _isCookieAuthError(payload, message) {
    const errno = payload.errno || payload.code;
    // errno 白名单 + 明确的「需要重新登录」文案；不再用 /cookie/ 子串匹配，
    // 避免把 Bearer/Open 接口的报错误判成 Cookie 失效。
    return (
      errno === 990001 ||
      errno === "990001" ||
      /登录超时|请重新登录|重新扫码|登录状态已失效/.test(String(message || ""))
    );
  }

  static _isAccessLimitMessage(message) {
    return String(message || "").includes("已达到当前访问上限");
  }

  static _isResponseSuccess(payload) {
    let code = payload.code;
    if ((code === undefined || code === null || code === "") && "errno" in payload) {
      code = payload.errno;
    }
    if (code !== undefined && code !== null && code !== "" && code !== 0 && code !== "0") {
      return false;
    }
    const state = payload.state;
    if (state === false || state === 0 || state === "0") return false;
    if (state === true || state === 1 || state === "1") return true;
    return code === undefined || code === null || code === "" || code === 0 || code === "0";
  }

  static _isUploadCallbackSuccess(payload) {
    let code = payload.code;
    if ((code === undefined || code === null || code === "") && "errno" in payload) {
      code = payload.errno;
    }
    const state = payload.state;
    if (code !== undefined && code !== null && code !== "" && code !== 0 && code !== "0") {
      return false;
    }
    if (state !== undefined && state !== null && state !== "" && state !== true && state !== 1 && state !== "1") {
      return false;
    }
    return code === 0 || code === "0" || state === true || state === 1 || state === "1";
  }

  static _isExistingDirectoryResponse(payload) {
    const code = payload.code || payload.errno;
    return String(code) === "20004";
  }

  static _responseData(payload) {
    return payload && typeof payload === "object" && "data" in payload
      ? payload.data
      : payload;
  }

  static _isDirectory(item) {
    const category = item.fc !== undefined ? item.fc : item.file_category;
    if (category !== undefined && category !== null && category !== "") {
      return String(category) === "0";
    }
    return item.cid !== undefined && item.cid !== null && item.fid === undefined;
  }

  static _itemName(item) {
    return String(
      item.fn || item.file_name || item.n || item.category_name || ""
    );
  }

  static _itemId(item) {
    if (U115Client._isDirectory(item)) {
      return String(
        item.cid || item.file_id || item.fid || item.category_id || ""
      );
    }
    for (const key of ["fid", "file_id", "fileid"]) {
      const value = item[key];
      if (value !== undefined && value !== null && value !== "" && value !== 0 && value !== "0") {
        return String(value);
      }
    }
    return "";
  }

  static _itemMtime(item) {
    for (const key of ["user_utime", "utime", "mtime", "tu", "t"]) {
      const value = item[key];
      if (value === undefined || value === null || value === "") continue;
      const parsed = Number(value);
      if (!Number.isNaN(parsed)) return Math.floor(parsed);
    }
    return 0;
  }

  static _itemSize(item) {
    for (const key of ["size_byte", "file_size", "size", "fs"]) {
      const value = item[key];
      if (value !== undefined && value !== null) {
        const parsed = parseInt(value, 10);
        return Number.isNaN(parsed) ? null : parsed;
      }
    }
    return null;
  }

  static _normalizeCloudPath(p) {
    let normalized = String(p || "/").replace(/\\/g, "/").replace(/\/+/g, "/");
    if (normalized === "." || normalized === "") normalized = "/";
    return normalized.startsWith("/") ? normalized : `/${normalized}`;
  }

  static _itemFromInfo(info, p) {
    const category = String(
      info.file_category !== undefined ? info.file_category : info.fc !== undefined ? info.fc : "1"
    );
    return {
      fileid: U115Client._itemId(info),
      path: p,
      type: category === "0" ? "dir" : "file",
      name: U115Client._itemName(info) || posixBasename(p),
      pickcode: info.pick_code || info.pickcode || info.pc || "",
      size: U115Client._itemSize(info),
      mtime: U115Client._itemMtime(info),
    };
  }
}

// ───── 辅助函数 ─────
function posixBasename(p) {
  const trimmed = String(p || "").replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

function randomBase64Url(byteLength) {
  return crypto.randomBytes(byteLength).toString("base64url");
}

function httpDownloadToFile(url, options, outputPath, onChunk) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (err) {
      reject(err);
      return;
    }
    const mod = target.protocol === "https:" ? https : http;
    const headers = Object.assign({}, options.headers || {});
    const req = mod.request(
      {
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: target.pathname + target.search,
        method: "GET",
        headers,
        timeout: 60000,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          resolve(httpDownloadToFile(res.headers.location, options, outputPath, onChunk));
          return;
        }
        if (res.statusCode >= 400) {
          res.resume();
          const err = httpRequestError("GET", url, res.statusCode);
          err.response = { headers: res.headers, status: res.statusCode };
          reject(err);
          return;
        }
        const fd = fs.openSync(outputPath, "w");
        res.on("data", (chunk) => {
          if (onChunk) onChunk();
          fs.writeSync(fd, chunk);
        });
        res.on("end", () => {
          try {
            fs.closeSync(fd);
          } catch {
            /* 忽略 */
          }
          resolve();
        });
        res.on("error", (err) => {
          try {
            fs.closeSync(fd);
          } catch {
            /* 忽略 */
          }
          reject(err);
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("下载请求超时")));
    req.on("error", reject);
    req.end();
  });
}

module.exports = {
  U115Client,
  UploadResult,
  PlaybackCopy,
  U115AuthError,
  U115ApiError,
  U115AccessLimitError,
  httpRequest,
  httpDownloadToFile,
  b64encodeAsString,
  httpDate,
  determinePartSize,
  sleep,
};
