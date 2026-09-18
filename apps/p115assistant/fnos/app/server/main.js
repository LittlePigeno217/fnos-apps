"use strict";

/**
 * 115网盘助手 FPK —— 后端入口（Node.js 版）。
 *
 * 职责：
 * - 读取 TRIM_* 环境变量，确认运行环境与身份。
 * - 在 TRIM_APPDEST/app.sock 上启动 Unix Socket HTTP 服务，处理 fnOS 统一
 *   网关转发的请求（X-Trim-* 携带网关用户身份，只做日志与可选 ACL）。
 * - 把 HTTP 请求按 /action/<name> 路由到 Server 的方法。
 * - 周期定时器驱动签到等定时任务；应用退出时清理 Socket 文件。
 *
 * 安全边界：
 * - 永不把 TRIM_API_TOKEN 写入文件/日志/前端；它只在本进程内存中使用。
 * - Unix Socket 由安装目录私有，网关同域转发；后端不做跨用户授权，身份只做审计。
 * - 所有请求路径视为不可信输入，仅接受已知 action 白名单。
 */

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");

const { Server, ok, error, gatewayError } = require("./server");
const { Store } = require("./store");

// 把各模块的加载放到 Store/Server 之前，保证语法/依赖问题在启动即暴露。
require("./client");
require("./crypto");
require("./limiter");
require("./notify");
require("./records");

const APP_NAME = "p115assistant";

/** 网关层错误信封（与 Server 方法返回结构一致）。 */
const _error = gatewayError;

// configureLogging 返回的日志控制句柄（退出前显式 flush）。
let _logHandle = null;

// /action/<name> -> [允许方法, Server 方法名]。只放与 UI 交互相关的安全暴露面。
const REDIRECT_LIMITER = new Map(); // 302 播放中转限流桶（进程级共享，跨请求生效）

const ACTIONS = new Map([
  ["get_config", ["GET", "getConfig"]],
  ["save_config", ["POST", "saveConfig"]],
  ["status", ["GET", "status"]],
  ["qrcode", ["GET", "qrcode"]],
  ["check_login", ["GET", "checkLogin"]],
  ["logout", ["POST", "logout"]],
  ["dirs_only", ["GET", "dirsOnly"]],
  ["disk_list", ["GET", "diskList"]],
  ["disk_mkdir", ["POST", "diskMkdir"]],
  ["disk_rename", ["POST", "diskRename"]],
  ["disk_delete", ["POST", "diskDelete"]],
  ["upload_mappings", ["GET", "uploadMappings"]],
  ["save_upload_mapping", ["POST", "saveUploadMapping"]],
  ["delete_upload_mapping", ["POST", "deleteUploadMapping"]],
  ["upload_status", ["GET", "uploadStatus"]],
  ["upload_sweep", ["POST", "uploadSweep"]],
  ["watcher_start", ["POST", "watcherStart"]],
  ["watcher_stop", ["POST", "watcherStop"]],
  ["watcher_status", ["GET", "watcherStatus"]],
  ["strm_mappings", ["GET", "strmMappings"]],
  ["save_strm_mapping", ["POST", "saveStrmMapping"]],
  ["delete_strm_mapping", ["POST", "deleteStrmMapping"]],
  ["strm_status", ["GET", "strmStatus"]],
  ["strm_sync", ["POST", "strmSync"]],
  ["strm_once", ["POST", "strmOnce"]],
  ["upload_once", ["POST", "uploadOnce"]],
  ["ledger", ["GET", "ledger"]],
  ["ledger_verify", ["POST", "ledgerVerify"]],
  ["library_drop", ["POST", "libraryDrop"]],
  ["upload_conflicts", ["GET", "uploadConflicts"]],
  ["upload_conflicts_resolve", ["POST", "resolveUploadConflicts"]],
  ["task_cancel", ["POST", "taskCancel"]],
  ["checkin_now", ["POST", "checkinNow"]],
  ["check_update", ["GET", "checkUpdate"]],
  ["download_update", ["POST", "downloadUpdate"]],
  ["apply_update", ["POST", "applyUpdate"]],
  ["fnos_login", ["POST", "fnosLogin"]],
  ["fnos_forget", ["POST", "fnosForget"]],
  ["link", ["GET", "link"]],
  ["history", ["GET", "history"]],
  ["browse_local", ["GET", "browseLocal"]],
  ["log_tail", ["GET", "logTail"]],
  ["test_notify", ["POST", "testNotify"]],
]);

function maskValue(key, value) {
  if (["cookie", "tokens", "feishu_webhook", "fnos_password"].includes(String(key).toLowerCase())) {
    return "***";
  }
  return value;
}

class TrimHandler {
  constructor(server, req, res) {
    this.server = server;
    this.req = req;
    this.res = res;
  }

  async handle() {
    const req = this.req;
    const res = this.res;
    const chunks = [];
    try {
      for await (const chunk of req) chunks.push(chunk);
    } catch (err) {
      this._respond(400, _error("请求读取失败"));
      return;
    }
    const raw = Buffer.concat(chunks);
    const method = String(req.method || "GET").toUpperCase();
    const target = String(req.url || "/");
    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      headers[String(key).toLowerCase()] = String(value);
    }
    try {
      await this.dispatch(method, target, headers, raw);
    } catch (err) {
      console.warn(`请求处理异常：${err.message}`);
      try {
        this._respond(400, _error("请求格式错误"));
      } catch {
        /* 忽略应答失败 */
      }
    }
  }

  dispatch(method, target, headers, body) {
    let parsed;
    try {
      parsed = new URL(target, "http://localhost");
    } catch {
      this._respond(400, _error("请求格式错误"));
      return Promise.resolve();
    }
    const pathname0 = parsed.pathname.replace(/\/+$/, "") || "/";
    // fnOS 网关把 /app/<appname> 前缀原样转发到 socket；先剥离再路由。
    let pathname = pathname0;
    const appPrefix = pathname0.match(/^\/app\/[^/]+/);
    if (appPrefix) {
      pathname = pathname0.slice(appPrefix[0].length) || "/";
    }
    // 请求上下文：供后端自动推导 STRM 基础地址（用户无需配置）。
    // Host 经 fnOS 网关 proxy_set_header Host $host 保留；X-Forwarded-Proto 记录协议。
    this._reqMeta = {
      proto: String(
        (headers["x-forwarded-proto"] || "http").split(",")[0].trim() || "http"
      ),
      host: String(headers["x-forwarded-host"] || headers["host"] || "").trim(),
      prefix: appPrefix ? appPrefix[0] : "",
    };
    if (this.server && this.server.api) {
      this.server.api._reqMeta = this._reqMeta;
    }
    // UI 静态托管：根路径与 /index.html 返回前端页面；/static/<file> 返回 ui 目录资源
    if (pathname === "/" || pathname === "/index.html") {
      this._uiRelPath = "index.html";
      return this._serveUI();
    }
    if (pathname.startsWith("/static/")) {
      this._uiRelPath = pathname.slice("/static/".length);
      if (!this._uiRelPath) {
        this._uiRelPath = "index.html";
      }
      return this._serveUI();
    }
    let actionName;
    // 匿名 302 跳转兼容路径：应用自身 /redirect 与插件同源格式
    //   /api/v1/plugin/P115LiteAssistant/redirect（对齐 MoviePilot 插件 115 轻量助手，
    //   使插件生成的 .strm 链接在本应用同样可播放）
    if (
      pathname === "/redirect" ||
      pathname === "/action/redirect" ||
      pathname === "/api/v1/plugin/P115LiteAssistant/redirect"
    ) {
      return this._handleRedirect(parsed, headers, method);
    }
    if (pathname.includes("/action/")) {
      actionName = pathname.split("/action/", 2)[1].split("/", 1)[0];
    } else {
      const segments = pathname.split("/").filter(Boolean);
      actionName = segments[segments.length - 1] || "";
    }
    if (!ACTIONS.has(actionName)) {
      this._respond(404, _error("未知动作"));
      return Promise.resolve();
    }
    const [allowedMethod, handlerName] = ACTIONS.get(actionName);
    if (method !== allowedMethod) {
      this._respond(405, _error("方法不允许"));
      return Promise.resolve();
    }
    const handler = this.server.api[handlerName];
    if (typeof handler !== "function") {
      this._respond(500, _error("动作执行异常: 未找到处理器"));
      return Promise.resolve();
    }
    const userid = String(headers["x-trim-userid"] || "");
    let resultPromise;
    if (method === "POST") {
      let payload = null;
      if (body.length) {
        try {
          payload = JSON.parse(body.toString("utf8"));
        } catch {
          this._respond(400, _error("请求体不是 JSON"));
          return Promise.resolve();
        }
        if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
          payload = null;
        }
      }
      // Server 方法与 Python 版签名不同：全部接受 (payload) 形态；尝试直接调用，
      // 失败则回退到空载荷（Python 的 TypeError 分支语义）。
      resultPromise = payload !== null ? Promise.resolve(handler.call(this.server.api, payload)) : Promise.resolve(handler.call(this.server.api));
    } else {
      const query = {};
      for (const [key, value] of parsed.searchParams.entries()) {
        query[key] = value;
      }
      resultPromise = Promise.resolve().then(() => {
        if (Object.keys(query).length) {
          return handler.call(this.server.api, query);
        }
        return handler.call(this.server.api);
      });
    }
    return resultPromise.then(
      (result) => this._respond(200, result, userid),
      (err) => {
        console.warn(`动作执行异常：${err.message}`);
        this._respond(500, _error(`执行异常: ${err.message}`));
      }
    );
  }

  _respond(status, obj, userid) {
    const data = Buffer.from(JSON.stringify(obj), "utf8");
    const headers = {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": data.length,
      "Cache-Control": "no-store",
      Connection: "close",
    };
    if (userid) headers["X-Trim-Userid"] = userid;
    const reason = status === 200 ? "OK" : "Error";
    const res = this.res;
    // 直接 res.write 会让 node 自动补发自己的状态行，导致 body 里出现重复的
    // HTTP 响应；必须用 writeHead 让 node 统一生成头部。
    res.writeHead(status, reason, headers);
    res.end(data);
  }

  // 匿名 302 跳转：播放器/浏览器无需带任何 cookie，凭 pickcode+HMAC 签名取链。
  // 限流：60 req/60s 滑动窗口（对齐 DDSRem/p115liteassistant 插件），按真实 IP 分桶。
  // 直连 3667 时无 x-forwarded-for/x-real-ip，必须用 socket.remoteAddress 兜底，
  // 否则所有直连客户端共享同一个 "unknown" 桶（媒体库转 m3u8 分片会高频请求 → 429）。
  _handleRedirect(parsed, headers, method) {
    const isHead = method === "HEAD";
    if (method !== "GET" && !isHead) {
      this._respond(405, _error("方法不允许"));
      return Promise.resolve();
    }
    const pickcode = parsed.searchParams.get("pickcode") || "";
    const sign = parsed.searchParams.get("sign") || "";
    const file_name = parsed.searchParams.get("file_name") || "";
    const userAgent = String(headers["user-agent"] || "");
    const source = String(headers["x-forwarded-for"] || "").split(",")[0].trim()
      || String(headers["x-real-ip"] || "").trim()
      || String(this.req && this.req.socket && this.req.socket.remoteAddress || "").replace(/^::ffff:/, "")
      || "unknown";
    const limiter = this._redirectLimiter();
    const now = Date.now();
    const bucket = limiter.get(source) || { n: 0, start: now };
    if (now - bucket.start > 60000) {
      bucket.n = 0;
      bucket.start = now;
    }
    if (bucket.n >= 60) {
      this._respond(429, _error("请求过于频繁，请稍后再试"));
      return Promise.resolve();
    }
    bucket.n += 1;
    limiter.set(source, bucket);
    if (limiter.size > 4096) {
      for (const [key, b] of limiter) {
        if (now - b.start > 120000) limiter.delete(key);
      }
    }
    return this.server.api.redirectTarget(pickcode, sign, file_name, userAgent).then((result) => {
      if (result.code === 302) {
        // 播放器 302 播放：不设置 Content-Disposition（下载场景才需要，且
        // 中文/特殊字符文件名会触发 Node writeHead Invalid character 校验失败，
        // 导致播放器请求 400 无法跳转）。播放器按 Content-Type/Location 处理即可。
        // Location 全量百分号编码（仿 DDSRem encode_url_fully）：CDN 路径段含
        // 空格/非 ASCII/括号等特殊字符时，严格客户端需编码后的 Location 才能跳转。
        const encodedUrl = result.url.split("#")[0].replace(/[^0-9A-Za-z\-._~:/?#@!$&'()*+,;=%]/g, (c) =>
          encodeURIComponent(c)
        );
        const headersOut = { Location: encodedUrl, Connection: "close", "Cache-Control": "no-store" };
        this.res.writeHead(302, "Found", headersOut);
        if (isHead) {
          this.res.end();
        } else {
          // 302 带 JSON body（与 DDSRem 一致），便于 curl/日志排障
          this.res.end(JSON.stringify({ status: "redirecting", url: result.url }));
        }
        return;
      }
      this._respond(result.code || 502, _error(result.message || "取链失败"));
    }, (err) => {
      console.warn(`匿名取链异常：${err.message}`);
      this._respond(502, _error(`取链失败: ${err.message}`));
    });
  }

  _redirectLimiter() {
    // 进程级共享限流桶：限流必须跨请求生效。
    // 不能挂在每请求新建的 TrimHandler 实例上（否则桶永远从 n=0 开始，
    // 60req/60s 形同虚设——claude 审查 P1-1 回归问题）。
    return REDIRECT_LIMITER;
  }

  // 托管前端页面：微应用在 fnOS 网关的根路径就是 /app/p115assistant，
  // 网关把页面请求原样转发到本 socket；这里直接返回自包含的 ui/index.html。
  // 也支持 ui 目录下的静态资源（qrcode.js 等），路径做白名单/防穿越处理。
  _serveUI() {
    return new Promise((resolve) => {
      const rel = this._uiRelPath;
      const uiDir = path.join(__dirname, "..", "www");
      const filePath = path.resolve(uiDir, rel);
      if (filePath !== uiDir && !filePath.startsWith(uiDir + path.sep)) {
        this._respond(403, _error("禁止访问"));
        resolve();
        return;
      }
      const contentType =
        rel.endsWith(".js") ? "application/javascript; charset=utf-8"
        : rel.endsWith(".css") ? "text/css; charset=utf-8"
        : rel.endsWith(".png") ? "image/png"
        : "text/html; charset=utf-8";
      fs.readFile(filePath, (err, data) => {
        if (err) {
          this._respond(404, _error("资源不存在"));
          resolve();
          return;
        }
        const res = this.res;
        res.writeHead(200, {
          "Content-Type": contentType,
          "Content-Length": data.length,
          "Cache-Control": "no-store",
          Connection: "close",
        });
        res.end(data);
        resolve();
      });
    });
  }
}

function startServer(sockPath, api) {
  if (fs.existsSync(sockPath)) {
    try {
      fs.unlinkSync(sockPath);
    } catch {
      /* 忽略 */
    }
  }
  fs.mkdirSync(path.dirname(sockPath) || ".", { recursive: true });
  const server = http.createServer((req, res) => {
    const handler = new TrimHandler({ api }, req, res);
    handler.handle().catch((err) => {
      console.warn(`请求处理异常：${err.message}`);
      try {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ success: false, message: "请求格式错误", data: {} }));
      } catch {
        /* 忽略 */
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(sockPath, () => {
      try {
        fs.chmodSync(sockPath, 0o660);
      } catch {
        /* 忽略 */
      }
      resolve(server);
    });
  });
}

function startRedirectPort(api, port) {
  // 独立 302 播放中转端口：绕开 fnOS 网关对 /app/* 的强制认证，
  // 播放器直连本端口即可匿名取链（HMAC 验签 + IP 限流仍生效）。
  // 只放行 redirect 路径，其余一律 404，不暴露 UI/API。
  const server = http.createServer((req, res) => {
    let pathname = "/";
    try {
      pathname = new URL(req.url, "http://localhost").pathname.replace(/\/+$/, "") || "/";
    } catch { /* 保持根路径 */ }
    const isRedirectPath =
      pathname === "/redirect" ||
      pathname === "/action/redirect" ||
      pathname === "/api/v1/plugin/P115LiteAssistant/redirect";
    if (!isRedirectPath) {
      res.writeHead(404, { "Content-Type": "application/json; charset=utf-8", Connection: "close" });
      res.end(JSON.stringify({ success: false, message: "未知动作", data: {} }));
      return;
    }
    const handler = new TrimHandler({ api }, req, res);
    handler.handle().catch((err) => {
      console.warn(`中转端口请求处理异常：${err.message}`);
      try {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ success: false, message: "请求格式错误", data: {} }));
      } catch { /* 忽略 */ }
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "0.0.0.0", () => {
      console.log(`302 播放中转端口已启动：0.0.0.0:${port}`);
      resolve(server);
    });
  });
}

function configureLogging(logFile) {
  // 单一写入路径：所有 console.* 只写带时间戳的 app.log（fs.createWriteStream）。
  // 不再调用 original.apply(console, args) —— 平台启动器会把 stdout 重定向到
  // 同一个 app.log，此前双写导致每条日志落盘两次、统计失真。
  const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5MB 轮转
  const KEEP_LOG_FILES = 2; // app.log + app.log.1
  let stream = fs.createWriteStream(logFile, { flags: "a" });
  let bytesSinceRotate = 0;
  let flushed = false;

  const maybeRotate = () => {
    try {
      const size = fs.statSync(logFile).size;
      if (size < MAX_LOG_BYTES) return;
      stream.end();
      for (let i = KEEP_LOG_FILES - 1; i >= 1; i--) {
        const from = i === 1 ? logFile : `${logFile}.${i - 1}`;
        const to = `${logFile}.${i}`;
        if (fs.existsSync(from)) fs.renameSync(from, to);
      }
      // stream.end() 后需要新建流继续写
      stream = fs.createWriteStream(logFile, { flags: "a" });
      bytesSinceRotate = 0;
    } catch (_e) {
      /* 轮转失败不阻断日志 */
    }
  };

  const log = (...args) => {
    const stamp = new Date().toISOString();
    const line = `${stamp} ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`;
    try {
      bytesSinceRotate += Buffer.byteLength(line);
      if (bytesSinceRotate >= MAX_LOG_BYTES) maybeRotate();
      stream.write(line);
    } catch (_e) {
      /* 日志写入失败不影响业务 */
    }
  };
  console.log = log;
  console.info = log;
  console.warn = log;
  console.error = log;
  console.debug = log;

  // 退出前显式 flush，避免 process.exit 抢在异步缓冲刷新之前丢失最后一行。
  return {
    flush(callback) {
      if (flushed) {
        if (typeof callback === "function") callback();
        return;
      }
      flushed = true;
      stream.end(() => {
        if (typeof callback === "function") callback();
      });
    },
  };
}

function parseArgs(argv) {
  const args = {
    socket: "",
    data: "",
    log: "",
  };
  const list = argv.slice(2);
  for (let i = 0; i < list.length; i++) {
    const token = list[i];
    if (token === "--socket") args.socket = list[++i] || "";
    else if (token === "--data") args.data = list[++i] || "";
    else if (token === "--log") args.log = list[++i] || "";
    else if (String(token).startsWith("--socket=")) args.socket = token.split("=", 2)[1] || "";
    else if (String(token).startsWith("--data=")) args.data = token.split("=", 2)[1] || "";
    else if (String(token).startsWith("--log=")) args.log = token.split("=", 2)[1] || "";
  }
  return args;
}

async function main(argv) {
  const args = parseArgs(argv || process.argv);
  const appDest = process.env.TRIM_APPDEST || "";
  const sockPath =
    args.socket || (appDest ? path.join(appDest, "app.sock") : "/tmp/p115assistant.sock");
  const dataDir =
    args.data || process.env.TRIM_PKGVAR || "/tmp/p115assistant_data";
  const logPath = args.log || (dataDir ? path.join(dataDir, "app.log") : "/tmp/p115assistant.log");

  for (const varName of ["TRIM_APPDEST", "TRIM_PKGVAR"]) {
    if (!process.env[varName]) {
      console.warn(`未设置环境变量 ${varName}，功能可能受限`);
    }
  }

  // TRIM_API_TOKEN 只确认存在，绝不落盘、不打日志。
  if (!process.env.TRIM_API_TOKEN) {
    console.warn("未检测到 TRIM_API_TOKEN；开放 API 相关能力将不可用（本应用不需要调用开放 API）");
  }

  try {
    _logHandle = configureLogging(logPath);
  } catch (err) {
    console.warn(`日志初始化失败：${err.message}`);
  }
  console.log(`启动 115网盘助手后端，socket=${sockPath}，data=${dataDir}`);

  const store = new Store(dataDir);
  const api = new Server(store);

  let server;
  try {
    server = await startServer(sockPath, api);
  } catch (err) {
    console.error(`启动失败：${err.message}`);
    process.exit(2);
  }
  // 独立 302 播放中转端口（绕开 fnOS 网关认证，播放器直连）
  const relayPort = parseInt(args.port || process.env.P115_RELAY_PORT || "3667", 10) || 3667;
  try {
    await startRedirectPort(api, relayPort);
  } catch (err) {
    console.warn(`302 中转端口启动失败（不影响主服务）：${err.message}`);
  }
  console.log("后端已就绪");

  // 启动时恢复上次启用的文件监听
  try {
    const cfg = store.getConfig();
    if (cfg.watch_enabled) {
      api._fileWatcher.start();
      console.log("已恢复文件监听（watch_enabled=true）");
    }
  } catch (err) {
    console.warn(`恢复文件监听失败：${err.message}`);
  }

  // 周期调度：每分钟推动一次 Server.schedulerTick。
  const scheduler = setInterval(() => {
    api.schedulerTick().catch((err) => {
      console.warn(`调度异常：${err.message}`);
    });
  }, 60 * 1000);
  scheduler.unref();

  let shuttingDown = false;
  const exitNow = (code) => {
    try {
      if (fs.existsSync(sockPath)) fs.unlinkSync(sockPath);
    } catch {
      /* 忽略 */
    }
    console.log("已退出");
    if (_logHandle && typeof _logHandle.flush === "function") {
      _logHandle.flush(() => process.exit(code));
    } else {
      process.exit(code);
    }
  };
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(scheduler);
    console.log("收到退出信号，正在退出");
    server.close(() => exitNow(0));
    // 兜底：长连接或有请求处理中时强制退出
    setTimeout(() => exitNow(0), 5000).unref();
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  return new Promise(() => {}); // 常驻
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`后端异常退出：${err.message}`);
    process.exit(2);
  });
}

module.exports = { main, TrimHandler, ACTIONS, maskValue, configureLogging, startServer, startRedirectPort };