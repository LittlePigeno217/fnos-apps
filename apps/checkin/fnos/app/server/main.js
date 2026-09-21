"use strict";
/**
 * checkin — 入口：HTTP 服务（fnOS unix socket）+ 路由 + 每日定时/补签调度。
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const { Store } = require("./store");
const { Server } = require("./server");
const notify = require("./notify");
const { checkHotfix, applyHotfix } = require("./hotfix");
const { ROUTES } = require("./router");
const { AuthSessions, safeEq } = require("./auth");

const DATA_DIR = process.env.CHECKIN_DATA_DIR || path.join(__dirname, "..", "..", "..", "@appdata", "checkin");
const SOCKET_PATH = process.env.CHECKIN_SOCKET || path.join(__dirname, "..", "app.sock");
const APP_DIR = path.join(__dirname, "..");

const store = new Store(DATA_DIR);
const auth = new AuthSessions(); // 面板鉴权内存会话（进程重启即失效）
const api = new Server(store, notify, (msg) => {
  console.log(`${new Date().toISOString()} ${msg}`);
});

/* ── 调度：每日定时首跑 + 30 分钟漏签补跑 ─────────────────────── */
let lastSignDate = "";      // 今日已全部签到成功的日期（达到后当日不再触发任何路径）
let fullRunDate = "";       // 今日已执行过「定时首跑」全量的日期（当日只一次全量）
let catchupCount = 0;       // 当天补签次数（上限 5）
let catchupDate = "";

function pad(n) {
  return String(n).padStart(2, "0");
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 当前 HH:MM 与配置时刻比较（跨天提醒重置） */
function hhmmNow() {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function resetDailyIfNeeded() {
  const t = todayStr();
  if (catchupDate !== t) {
    catchupDate = t;
    catchupCount = 0;
  }
}

/** 今日是否已全部签到成功（status 派生：启用且已配置的站点全部 today_ok） */
function allSitesDoneToday(status) {
  const entries = Object.entries((status && status.sites) || {}).filter(([, st]) => st.enabled && st.configured);
  return entries.length > 0 && entries.every(([, st]) => st.today_ok);
}

/** 启用且已配置、但今日尚未成功的站点（定时首跑与漏签补跑的目标集） */
function todoSiteKeys(status) {
  return Object.entries((status && status.sites) || {})
    .filter(([, st]) => st.enabled && st.configured && !st.today_ok)
    .map(([k]) => k);
}

/**
 * 两个独立触发（由 tickEveryMinute 在 cron 时刻已过后调用，cron 之前绝不触发任何签到）：
 *  1) 定时首跑：今日尚未全量、且今日有未完成站点 → 全量一次（当日只一次，fullRunDate 兜底）。
 *  2) 漏签补跑：仍有失败/未签站点、未达每日 5 次上限 → 仅补跑失败/未签站点
 *     （不重跑已成功站点，避免站点负载与重复「已签到」历史）。
 */
async function runScheduled() {
  const cfg = store.getConfig();
  if (!cfg.enabled) return;
  resetDailyIfNeeded();
  const t = todayStr();
  // 今日已全部签到成功：任何路径都不再触发
  if (lastSignDate === t) return;
  // 重启后同理：cron 时刻之前不触发
  if (hhmmNow() < (cfg.cron || "08:10")) return;

  const status = api.status().data || {};
  const allDone = allSitesDoneToday(status);
  const todoKeys = todoSiteKeys(status);

  // 定时首跑：到达/越过 cron 时刻、今日未全成、当日尚未全量 → 全量一次
  if (!allDone && fullRunDate !== t && todoKeys.length) {
    fullRunDate = t;
    api._log(`每日签到时刻 ${cfg.cron} 已到，执行全量签到`);
    const r = await api.runOnce();
    const data = r.data || {};
    if (r.success && data.success_count > 0 && data.results.every((x) => x.status !== "执行失败")) {
      lastSignDate = t;
    }
    return; // 全量已触发，本次 tick 不再叠加补跑
  }

  // 漏签补跑：仅补跑失败/未签站点，维持每 30 分钟节奏与每日 5 次上限
  if (todoKeys.length && catchupCount < 5) {
    catchupCount += 1;
    api._log(`补签第 ${catchupCount} 次（当天上限 5）：${todoKeys.join("、")}`);
    const r = await api.runOnce(todoKeys);
    const data = r.data || {};
    if (r.success && data.success_count > 0 && data.results.every((x) => x.status !== "执行失败")) {
      if (allSitesDoneToday(api.status().data || {})) lastSignDate = t;
    }
    if (catchupCount >= 5) api._log("补签次数已达当日上限（5 次），今日不再补签");
  }
}

function tickEveryMinute() {
  const cfg = store.getConfig();
  if (!cfg.enabled) return;
  const minute = hhmmNow();
  const cron = cfg.cron || "08:10";
  if (minute < cron) return; // cron 时刻之前不触发任何签到（重启后同理）
  // 触发节奏：cron 准点（如 08:10 不在整点/半点时仍准点）+ 每整点/半点（补签巡检）
  if (minute === cron || minute.endsWith(":00") || minute.endsWith(":30")) {
    runScheduled().catch((err) => api._log(`定时签到异常：${err.message}`));
  }
}

/* ── HTTP 路由 ─────────────────────────────────────────────── */
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

/** 从 Authorization 头提取 Bearer token（面板鉴权会话） */
function bearer(req) {
  const h = (req.headers && req.headers["authorization"]) || "";
  const m = /^Bearer\s+(.+)$/i.exec(String(h));
  return m ? m[1].trim() : "";
}

/* 面板鉴权开放端点：无论 auth_enabled 与否始终放行（登录入口 + 状态探测 + 登出） */
const AUTH_OPEN = new Set(["checkin/auth/status", "checkin/auth/login", "checkin/auth/logout"]);

/* ── HTTP 路由：/action/<name>（对齐 115网盘助手主应用做法）──────
 * fnOS 网关对微应用以 /app/checkin/action/* 转发动态 API（独立于静态页面路径），
 * 前端统一请求 /app/checkin/action/<name>；同时兼容裸路径（取最后一段）。
 * 路由表（键 + 方法 → handlerKey）由 router.js 单一维护（ROUTES）；
 * ACTION_HANDLERS 只定义处理逻辑，handlerKey 为字符串在此查表调用。 */
const ACTION_HANDLERS = {
  getConfig: () => api.getConfig(),
  saveConfig: (body) => api.saveConfig(body),
  status: () => api.status(),
  runOnce: (body) => api.runOnce(body.sites),
  points: () => api.points(),
  testLogin: (body) => api.testLogin(body.site, body.account_id),
  getHistory: (body, ctx) => api.getHistory(new URL(ctx.req.url, "http://x").searchParams.get("limit")),
  clearHistory: () => api.clearHistory(),
  // 阶段2：账号运维
  accountsList: () => api.accountsList(),
  accountsReorder: (body) => api.accountsReorder(body),
  accountsImport: (body) => api.accountsImport(body),
  accountsExport: (body, ctx) => {
    const sp = new URL(ctx.req.url, "http://x").searchParams;
    return api.accountsExport({ site: sp.get("site"), include_secrets: sp.get("include_secrets") === "true" });
  },
  accountsClear: (body) => api.accountsClear(body),
  /** 实时运行日志：增量读取 app.log（after=上次字节偏移；文件轮转/截断自动重置） */
  getLogs: (body, ctx) => {
    const sp = new URL(ctx.req.url, "http://x").searchParams;
    const after = parseInt(sp.get("after") || "0", 10) || 0;
    const logPath = path.join(DATA_DIR, "app.log");
    try {
      if (!fs.existsSync(logPath)) return { success: true, data: { size: 0, offset: 0, lines: [] } };
      const st = fs.statSync(logPath);
      let from = st.size < after ? 0 : after; // 日志被清空/轮转 → 从头
      if (st.size > from) {
        const fd = fs.openSync(logPath, "r");
        // 对齐到行边界：增量起点向前找最近换行，避免切半中文字节
        if (from > 0) {
          const back = Buffer.alloc(Math.min(from, 8192));
          fs.readSync(fd, back, 0, back.length, Math.max(0, from - back.length));
          const nl = back.lastIndexOf(0x0a);
          if (nl >= 0) from = from - (back.length - nl);
        }
        const buf = Buffer.alloc(Math.min(262144, st.size - from));
        fs.readSync(fd, buf, 0, buf.length, from);
        fs.closeSync(fd);
        const lines = buf.toString("utf8").split("\n").filter(Boolean).slice(-800);
        return { success: true, data: { size: st.size, offset: st.size, lines } };
      }
      return { success: true, data: { size: st.size, offset: st.size, lines: [] } };
    } catch (e) {
      return { success: false, message: "读取日志失败：" + e.message };
    }
  },
  clearLogs: () => {
    try {
      fs.writeFileSync(path.join(DATA_DIR, "app.log"), "");
      return { success: true, data: { size: 0 } };
    } catch (e) {
      return { success: false, message: "清空日志失败：" + e.message };
    }
  },
  checkHotfix: () => checkHotfix(APP_DIR).then((r) => ({ success: true, data: r })).catch((err) => ({ success: false, message: "检查功能更新失败: " + err.message })),
  async applyHotfix() {
    const r = await applyHotfix(APP_DIR, DATA_DIR, null);
    if (r.success && r.version) {
      // 功能更新后版本号递增（单一事实源：热更清单版本写入 config，重启后仍显示新版本）
      try { store.setVersion(r.version); } catch { /* 版本写入失败不影响更新 */ }
    }
    if (r.restarting) {
      setTimeout(() => process.exit(0), 3000); // hotfix.js 内部已尝试系统重启；此兜底由 fnOS 拉起
    }
    return r.restarting
      ? { success: true, message: r.message, data: { restarting: true, applied: r.applied, version: r.version } }
      : { success: r.success, message: r.message, data: r };
  },
};

async function handle(req, res) {
  const send = (obj) => {
    // 禁止缓存 API 响应：否则网关/浏览器可能命中旧的 get_config 等 JSON，
    // 热更/升级后版本号仍显示旧值（用户反馈「当前版本号不对」）
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Pragma: "no-cache",
    });
    res.end(JSON.stringify(obj));
  };
  const sendFile = (filePath, forUrl) => {
    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    const content = fs.readFileSync(filePath);
    res.writeHead(200, {
      "Content-Type": forUrl.endsWith(".js") ? "application/javascript" : "text/html; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Pragma: "no-cache",
    });
    res.end(content);
  };

  try {
    const rawPath = req.url.split("?")[0];
    const pathname = rawPath.startsWith("/app/checkin") ? rawPath.slice("/app/checkin".length) || "/" : rawPath;
    const method = req.method || "GET";

    // 静态 UI
    if (pathname === "/" || pathname === "/index.html") {
      return sendFile(path.join(APP_DIR, "www", "index.html"), req.url);
    }

    // action 提取：
    //  - /action/ 分支：取 /action/ 之后「整段（含斜杠）」作为路由键（如 checkin/points），
    //    去尾部 /；空段视为无效（命名空间路由）。
    //  - 裸路径分支：取最后一段（兼容旧前端扁平名）。
    let actionName;
    if (pathname.includes("/action/")) {
      actionName = pathname.split("/action/", 2)[1].replace(/\/+$/, "");
    } else {
      actionName = pathname.split("/").filter(Boolean).pop() || "";
    }
    /* ── 面板鉴权（阶段3 B）─────────────────────────────────────
     * 开放端点常驻放行；其余 action 在 auth_enabled 时需有效 Bearer 会话，否则回 code:401。
     * 静态 UI（"/" 与 index.html）在上方已返回，不受门禁影响（登录页是 UI 的一部分）。 */
    if (actionName === "checkin/auth/status") {
      const cfg = store.getConfig();
      return send({ success: true, data: { auth_enabled: !!cfg.auth_enabled, authed: !cfg.auth_enabled || auth.valid(bearer(req)) } });
    }
    if (actionName === "checkin/auth/login") {
      if (method !== "POST") return send({ success: false, message: "405 方法不允许" });
      const body = await readBody(req);
      const cfg = store.getConfig();
      if (!cfg.auth_enabled) return send({ success: true, data: { auth_enabled: false }, message: "鉴权未开启" });
      if (!cfg.auth_token || !safeEq(String(body.token || ""), cfg.auth_token)) {
        return send({ success: false, code: 401, message: "口令错误" });
      }
      const s = auth.issue();
      return send({ success: true, data: { token: s.token, expires_in: s.expires_in } });
    }
    if (actionName === "checkin/auth/logout") {
      if (method === "POST") {
        const body = await readBody(req);
        auth.revoke(body.token || bearer(req));
      } else {
        auth.revoke(bearer(req));
      }
      return send({ success: true, data: { ok: true } });
    }
    // 门禁：开启鉴权后，非开放端点无有效会话 → code:401（HTTP 仍 200，与既有 API 约定一致）
    if (!AUTH_OPEN.has(actionName)) {
      const cfg = store.getConfig();
      if (cfg.auth_enabled && !auth.valid(bearer(req))) {
        return send({ success: false, code: 401, message: "未登录" });
      }
    }

    const route = ROUTES.get(actionName);
    if (!route) {
      // 动态交互登录路由：checkin/{site}_login/{init|status}
      //   init（POST）→ loginFlowInit；status（GET）→ loginFlowStatus。
      //   未实现 loginFlow 的站点由 server 层返回「不支持交互登录」。
      const m = actionName.match(/^(?:checkin\/)?([a-z_]+)_login\/(init|status)$/);
      if (m) {
        const site = m[1];
        const phase = m[2];
        if (phase === "init") {
          if (method !== "POST") return send({ success: false, message: "405 方法不允许" });
          const body = await readBody(req);
          return send(await api.loginFlowInit({ site, account_id: body.account_id }));
        }
        if (method !== "GET") return send({ success: false, message: "405 方法不允许" });
        const token = new URL(req.url, "http://x").searchParams.get("token");
        return send(await api.loginFlowStatus({ site, token }));
      }
      return send({ success: false, message: "404" });
    }
    const handlerKey = route[method];
    if (!handlerKey) return send({ success: false, message: "405 方法不允许" });
    const handler = ACTION_HANDLERS[handlerKey];
    if (typeof handler !== "function") return send({ success: false, message: "500 未找到处理器" });

    let body = {};
    if (method === "POST") {
      body = await readBody(req);
    }
    const ctx = { req, res, send, sendFile };
    const result = await handler(body, ctx);
    return send(result);
  } catch (err) {
    return send({ success: false, message: err.message || String(err) });
  }
}

/* ── 启动 ──────────────────────────────────────────────────── */
const server = http.createServer(handle);

try {
  if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH);
} catch { /* ignore */ }

server.listen(SOCKET_PATH, () => {
  fs.chmodSync(SOCKET_PATH, 0o777);
  console.log(`${new Date().toISOString()} 启动 checkin 后端，socket=${SOCKET_PATH}，data=${DATA_DIR}`);
  console.log(`${new Date().toISOString()} 后端已就绪（功能版本 ${store.getConfig().version}）`);
});

server.on("error", (err) => {
  console.error(`${new Date().toISOString()} 服务错误：${err.message}`);
});

setInterval(tickEveryMinute, 30 * 1000);

process.on("SIGTERM", () => {
  console.log(`${new Date().toISOString()} 收到退出信号，正在退出`);
  process.exit(0);
});
process.on("SIGINT", () => {
  process.exit(0);
});