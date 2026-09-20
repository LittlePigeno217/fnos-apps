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

const DATA_DIR = process.env.CHECKIN_DATA_DIR || path.join(__dirname, "..", "..", "..", "@appdata", "checkin");
const SOCKET_PATH = process.env.CHECKIN_SOCKET || path.join(__dirname, "..", "app.sock");
const APP_DIR = path.join(__dirname, "..");

const store = new Store(DATA_DIR);
const api = new Server(store, notify, (msg) => {
  console.log(`${new Date().toISOString()} ${msg}`);
});

/* ── 调度：每日定时 + 30 分钟补签巡检 ─────────────────────── */
let lastSignDate = "";      // 上一次成功「全部签到完成」的日期
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

async function runScheduled(kind) {
  const cfg = store.getConfig();
  if (!cfg.enabled) return;
  resetDailyIfNeeded();
  const t = todayStr();
  // 今天已全部签到成功就不再跑
  if (lastSignDate === t) return;

  const r = await api.runOnce();
  const data = r.data || {};
  const ok = r.success && data.success_count > 0 && data.results.every((x) => x.status !== "执行失败");
  if (ok) lastSignDate = t;
  else if (kind === "catchup") {
    catchupCount += 1;
    api._log(`补签第 ${catchupCount} 次（当天上限 5）`);
    if (catchupCount >= 5) lastSignDate = t; // 今天不再无限重试
  }
}

function tickEveryMinute() {
  const minute = hhmmNow();
  const cfg = store.getConfig();
  if (cfg.enabled) {
    // 每日定时：到点触发
    if (minute === (cfg.cron || "08:10")) {
      api._log("每日签到时刻到达，执行签到");
      runScheduled("cron").catch((err) => api._log(`定时签到异常：${err.message}`));
    }
    // 补签巡检：每 30 分钟（整点与半点）
    if (minute.endsWith(":00") || minute.endsWith(":30")) {
      runScheduled("catchup").catch((err) => api._log(`补签巡检异常：${err.message}`));
    }
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

/* ── HTTP 路由：/action/<name>（对齐 115网盘助手主应用做法）──────
 * fnOS 网关对微应用以 /app/checkin/action/* 转发动态 API（独立于静态页面路径），
 * 前端统一请求 /app/checkin/action/<name>；同时兼容裸路径（取最后一段）。
 * ACTIONS: action 名 → [允许方法, 处理器]（白名单）。 */
const ACTIONS = new Map([
  ["get_config", ["GET", "getConfig"]],
  ["save_config", ["POST", "saveConfig"]],
  ["status", ["GET", "status"]],
  ["run", ["POST", "runOnce"]],
  ["test_login", ["POST", "testLogin"]],
  ["history", ["GET", "getHistory"]],
  ["history_clear", ["POST", "clearHistory"]],
  ["get_logs", ["GET", "getLogs"]],
  ["clear_logs", ["POST", "clearLogs"]],
  ["check_hotfix", ["GET", "checkHotfix"]],
  ["apply_hotfix", ["POST", "applyHotfix"]],
]);

const ACTION_HANDLERS = {
  getConfig: () => api.getConfig(),
  saveConfig: (body) => api.saveConfig(body),
  status: () => api.status(),
  runOnce: (body) => api.runOnce(body.sites),
  testLogin: (body) => api.testLogin(body.site),
  getHistory: (body, ctx) => api.getHistory(new URL(ctx.req.url, "http://x").searchParams.get("limit")),
  clearHistory: () => api.clearHistory(),
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
    res.writeHead(200, { "Content-Type": "application/json" });
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

    // action 提取：/action/<name> 或裸路径最后段（兼容旧前端）
    let actionName;
    if (pathname.includes("/action/")) {
      actionName = pathname.split("/action/", 2)[1].split("/", 1)[0];
    } else {
      actionName = pathname.split("/").filter(Boolean).pop() || "";
    }
    if (!ACTIONS.has(actionName)) return send({ success: false, message: "404" });
    const [allowedMethod, handlerKey] = ACTIONS.get(actionName);
    if (method !== allowedMethod) return send({ success: false, message: "405 方法不允许" });
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