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

/* ── HTTP 路由表（path → handler；handler 收到 { req, res, url, method, send, sendFile }）── */
const ROUTES = {
  "/": (ctx) => ctx.sendFile(path.join(APP_DIR, "www", "index.html")),
  "/index.html": (ctx) => ctx.sendFile(path.join(APP_DIR, "www", "index.html")),
  "/get_config": (ctx) => ctx.send(api.getConfig()),
  "/save_config": async (ctx) => ctx.send(api.saveConfig(await readBody(ctx.req))),
  "/status": (ctx) => ctx.send(api.status()),
  "/run": async (ctx) => {
    const body = await readBody(ctx.req);
    ctx.send(await api.runOnce(body.sites));
  },
  "/test_login": async (ctx) => {
    const body = await readBody(ctx.req);
    ctx.send(await api.testLogin(body.site));
  },
  "/history": (ctx) => {
    const q = new URL(ctx.req.url, "http://x").searchParams;
    ctx.send(api.getHistory(q.get("limit")));
  },
  "/history/clear": (ctx) => ctx.send(api.clearHistory()),
  "/check_hotfix": async (ctx) => ctx.send(await checkHotfix(APP_DIR)),
  "/apply_hotfix": async (ctx) => {
    const r = await applyHotfix(APP_DIR, DATA_DIR, null);
    if (r.success && r.version) {
      // 功能更新后版本号递增（单一事实源：热更清单版本写入 config，重启后仍显示新版本）
      try { store.setVersion(r.version); } catch { /* 版本写入失败不影响更新 */ }
    }
    if (r.restarting) {
      ctx.send({ success: true, message: r.message, data: { restarting: true, applied: r.applied, version: r.version } });
      setTimeout(() => process.exit(0), 3000); // hotfix.js 内部已尝试系统重启；此兜底由 fnOS 拉起
      return;
    }
    ctx.send({ success: r.success, message: r.message, data: r });
  },
};

async function handle(req, res) {
  const send = (obj) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  const sendFile = (filePath) => {
    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    const content = fs.readFileSync(filePath);
    res.writeHead(200, {
      "Content-Type": url.endsWith(".js") ? "application/javascript" : "text/html; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Pragma: "no-cache",
    });
    res.end(content);
  };
  // fnOS 网关以 /app/checkin 前缀转发请求，剥离后再做路由匹配
  let rawPath = req.url.split("?")[0];
  if (rawPath === "/app/checkin" || rawPath.startsWith("/app/checkin/")) {
    rawPath = rawPath.slice("/app/checkin".length) || "/";
  }
  const url = rawPath;
  const ctx = { req, res, url, method: req.method || "GET", send, sendFile };
  const handler = ROUTES[url];
  try {
    if (!handler) return send({ success: false, message: "404" });
    return await handler(ctx);
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