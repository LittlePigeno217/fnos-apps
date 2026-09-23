"use strict";
/**
 * checkin — 入口：HTTP 服务（fnOS unix socket）+ 路由 + 每日定时/补签调度。
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const { Store } = require("./store");
const { Server, ADAPTERS } = require("./server");
const notify = require("./notify");
const { checkHotfix, applyHotfix } = require("./hotfix");
const { ROUTES } = require("./router");

const DATA_DIR = process.env.CHECKIN_DATA_DIR || path.join(__dirname, "..", "..", "..", "@appdata", "checkin");
const SOCKET_PATH = process.env.CHECKIN_SOCKET || path.join(__dirname, "..", "app.sock");
const APP_DIR = path.join(__dirname, "..");

const store = new Store(DATA_DIR);
const api = new Server(store, notify, (msg) => {
  console.log(`${new Date().toISOString()} ${msg}`);
});

/* ── 调度：每日定时首跑 + 30 分钟漏签补跑 ─────────────────────── */
let lastSignDate = "";      // 今日已全部签到成功的日期（达到后当日不再触发任何路径）
let fullRunDate = "";       // 今日已执行过「定时首跑」全量的日期（当日只一次全量）
let catchupCount = 0;       // 当天补签轮次数（上限 5）
let catchupDate = "";       // 补签计数所属本地日期（0 点跨天归零）
let schedRunning = false;   // 调度器本轮执行中（跨 30s tick 防重叠；与 api._running 互补）

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

/** 实际本地触发时刻（日志内容标注本地；行首 UTC 前缀保留便于机器解析） */
function localNow() {
  return `${todayStr()} ${hhmmNow()}`;
}

/** 调度状态落盘：fullRunDate/catchupCount → config 内部字段（saveConfig 白名单外、前端不可见）。
 *  失败账号集 sched_today_fail 由 Server.runOnce/runAccount 经 store.recordCheckinResults 维护。 */
function persistSched() {
  const cfg = store.getConfig();
  cfg.sched_last_full = fullRunDate;
  cfg.sched_catchup_count = catchupCount;
  try { store.save(); } catch (e) { api._log(`调度状态落盘失败：${e.message}`); }
}

/** 启动恢复调度状态：热更/重启后不重复全量、不重置补签上限 */
function restoreSched() {
  const cfg = store.getConfig();
  fullRunDate = (typeof cfg.sched_last_full === "string") ? cfg.sched_last_full : "";
  catchupCount = Number(cfg.sched_catchup_count) || 0;
  // 补签计数的日期锚点：补签只发生在当日全量之后，故 sched_last_full 即计数所属日期；
  // 跨天后 resetDailyIfNeeded 据此归零（sched_last_full 无值 → 视作今日，计数 0 无需重置）。
  catchupDate = fullRunDate || todayStr();
  api._log(`调度状态已恢复：全量日期=${fullRunDate || "无"} 补签轮次=${catchupCount}（跨天自动归零）`);
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

/** 启用且已配置、但今日尚未成功的站点（定时首跑的目标集；补签改走账号级失败集） */
function todoSiteKeys(status) {
  return Object.entries((status && status.sites) || {})
    .filter(([, st]) => st.enabled && st.configured && !st.today_ok)
    .map(([k]) => k);
}

/** 今日失败账号集（跨天自动视为空）→ 补签目标；剔除已失效账号（站点停用/账号停用/未配置），
 *  未配置账号无法签到成功，不再占用补签名额（配置后由下次全量/手动签到自然回归）。 */
function failAccounts() {
  const cfg = store.getConfig();
  const set = store.schedFailAccounts();
  const targets = [];
  for (const key of Object.keys(set)) {
    if (!set[key]) continue;
    const slash = key.lastIndexOf("/");
    if (slash <= 0 || slash === key.length - 1) continue;
    const site = key.slice(0, slash);
    const accountId = key.slice(slash + 1);
    const siteCfg = cfg.sites[site];
    if (!siteCfg || !siteCfg.enabled) continue;
    const acc = (Array.isArray(siteCfg.accounts) ? siteCfg.accounts : []).find((a) => String(a.id) === String(accountId));
    if (!acc || acc.enabled === false) continue;
    const adapter = ADAPTERS[site];
    if (!adapter || !adapter.isConfigured(acc)) continue;
    targets.push({ site, account_id: accountId });
  }
  return targets;
}

/**
 * 两个独立触发（由 tickEveryMinute 在 cron 时刻已过后调用，cron 之前绝不触发任何签到）：
 *  1) 定时首跑：今日尚未全量、且今日有未完成站点 → 全量一次（当日只一次，fullRunDate 兜底）。
 *  2) 漏签补跑：仅逐个重跑「今日失败账号」（sched_today_fail 账号级定位），未达每日 5 次上限
 *     → 不重跑已成功账号，避免重复「已签到」history；站点级 today_ok 判定保留（失败账号存在
 *     → 该站点仍算失败，UI 状态与全量触发不受影响）。
 */
async function runScheduled() {
  if (schedRunning) return; // 上一轮调度仍在执行（跨 30s tick / 长耗时）→ 跳过，防重叠
  schedRunning = true;
  try {
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

    // 定时首跑：到达/越过 cron 时刻、今日未全成、当日尚未全量 → 全量一次（当日只一次）
    if (!allDone && fullRunDate !== t && todoKeys.length) {
      if (api._running) return; // 手动签到/其他执行进行中：本轮轮空，不占用今日全量标记
      fullRunDate = t;
      persistSched();
      api._log(`每日签到时刻 ${cfg.cron} 已到，执行全量签到（本地 ${localNow()}）`);
      const r = await api.runOnce();
      const data = r.data || {};
      if (r.success && data.success_count > 0 && Array.isArray(data.results) && data.results.every((x) => x.status !== "执行失败")) {
        lastSignDate = t;
      }
      return; // 全量已触发，本次 tick 不再叠加补跑
    }

    // 漏签补跑：仅逐个重跑今日失败账号，维持每日 5 次上限
    const targets = failAccounts();
    if (targets.length && catchupCount < 5) {
      if (api._running) return; // 并发保护：跳过且不占用补签名额
      api._log(`补签第 ${catchupCount + 1} 次（本地 ${localNow()}，当天上限 5）：${targets.map((x) => `${x.site}/${x.account_id}`).join("、")}`);
      let executed = false;
      for (const trg of targets) {
        const r = await api.runAccount(trg.site, trg.account_id); // 单账号重签：结果同步进失败集（成功/已签到即清除）
        // 仅「正在执行中」的并发 bail 视为未实际执行；正常执行（含结果失败）一并通过
        if (!(r && r.success === false && /执行中/.test(r.message || ""))) executed = true;
      }
      if (executed) {
        catchupCount += 1; // runAccount 实际执行后递增（并发/重叠 tick 跳过不计名额）
        persistSched();
        if (catchupCount >= 5) api._log(`补签次数已达当日上限（5 次），今日不再补签`);
      }
    }
  } catch (err) {
    api._log(`定时签到异常：${err.message}`);
  } finally {
    schedRunning = false;
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
// B10：请求体大小上限（1MB）——防 socket 直连发送超大 body 拖垮内存
const MAX_BODY_BYTES = 1024 * 1024;

/** 读取并解析 JSON body。body 超过 1MB 立即以 413 语义信封拒绝（请求体过大（上限 1MB））
 *  并关闭连接，resolve(null) 告知调用方「响应已发、勿再写」。JSON 解析失败回落 {}（与原行为一致）。 */
function readBody(req, res) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let over = false;
    const rejectTooBig = () => {
      if (over) return;
      over = true;
      try {
        if (res && !res.headersSent) {
          res.writeHead(413, { "Content-Type": "application/json; charset=utf-8", Connection: "close" });
          res.end(JSON.stringify({ success: false, message: "请求体过大（上限 1MB）" }));
        }
      } catch (e) { /* 连接可能已关闭 */ }
      // 响应写入完成后再强制关闭底层连接（终止客户端继续上传，防内存/连接占用）
      res && res.once ? res.once("finish", () => { try { req.destroy(); } catch {} }) : req.destroy();
      resolve(null);
    };
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { rejectTooBig(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (over) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        resolve({});
      }
    });
    req.on("error", () => { if (!over) resolve({}); });
  });
}

/* ── app.log copytruncate 轮转（B14）──────────────────────────
 * app.log 由 fnOS 进程 stdout 重定向持续写入（进程持有 fd，永不关闭），无大小上限会无限增长。
 * 采用 logrotate 惯用 copytruncate：超过 2MB → 复制为 app.log.1（覆盖旧 .1，保留 1 份）+
 * truncate 原文件（不 rename——进程 fd 保持有效，写入自动回到文件头，依赖 stdout 重定向的
 * O_APPEND 语义；比 rename+重建更稳，进程无需感知轮转）。
 * 触发点：getLogs 被轮询调用前检查大小（>2MB 触发一次）；1 分钟节流避免每次读都 stat 的额外 IO。 */
const LOG_ROTATE_BYTES = 2 * 1024 * 1024;    // 2MB
const LOG_ROTATE_INTERVAL_MS = 60 * 1000;    // 1 分钟节流
let logRotateLastCheck = 0;                  // 上次检查时间戳（ms）；首次调用立即触发

function maybeRotateAppLog(logPath) {
  const now = Date.now();
  if (now - logRotateLastCheck < LOG_ROTATE_INTERVAL_MS) return; // 节流：1 分钟内不再检查
  logRotateLastCheck = now;
  try {
    const st = fs.statSync(logPath);
    if (st.size > LOG_ROTATE_BYTES) {
      fs.copyFileSync(logPath, `${logPath}.1`); // 覆盖旧的 .1（保留 1 份，不再轮转）
      fs.truncateSync(logPath, 0);              // 截断原文件（不 rename，进程 fd 保持有效）
      console.log(`${new Date().toISOString()} app.log 超过 2MB，已轮转（copytruncate 保留 1 份）`);
    }
  } catch (e) {
    // 轮转失败不阻断 getLogs（文件可能正被写/权限瞬态），下次轮询再试
    console.error(`${new Date().toISOString()} app.log 轮转失败：${(e && e.message) || e}`);
  }
}

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
  runAccount: (body) => api.runAccount(body.site, body.account_id),
  points: () => api.points(),
  // 1.5.4：签到历史可视化——统计聚合（读端点，开放）与 CSV 导出（原始 text/csv 响应）
  historyStats: () => api.historyStats(),
  historyExport: (body, ctx) => {
    // 原始 text/csv 响应：UTF-8 BOM（Excel 兼容）+ Content-Disposition 附件下载（URL 触发浏览器下载）。
    // history 不含 token/cookie，可安全导出；行序 = history 顺序（新→旧）。
    const csv = api.historyExportCsv();
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    const filename = `checkin_history_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.csv`;
    try {
      ctx.res.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store, no-cache, must-revalidate",
        Pragma: "no-cache",
      });
      ctx.res.end(csv);
    } catch (e) {
      // 写出失败（连接已关闭等）不影响后续请求；记日志便于排查
      console.error(`history_export 写出失败：${(e && e.message) || e}`);
    }
    return { __raw: true }; // 标记：响应已由 handler 直接写出，handle() 不再 send
  },
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
    maybeRotateAppLog(logPath); // B14：轮询前检查大小，>2MB 触发 copytruncate 轮转（节流 1 分钟）
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
    // B9 修复：版本号仅在「重启已确认调度（r.restarting）」后写入。重启失败/需手动重启时
    // 不写 version（保持旧版），避免 UI 显示新版而进程仍在跑旧代码；生效条件由热更消息明示。
    if (r.restarting && r.version) {
      // 功能更新后版本号递增（单一事实源：热更清单版本写入 config，重启后仍显示新版本）
      try { store.setVersion(r.version); } catch { /* 版本写入失败不影响更新 */ }
    }
    if (r.restarting) {
      setTimeout(() => process.exit(0), 3000); // hotfix.js 内部已尝试系统重启；此兜底由 fnOS 拉起
      return { success: true, message: r.message, data: { restarting: true, applied: r.applied, version: r.version } };
    }
    return { success: r.success, message: r.message, data: r };
  },
};

/* ── 安全防线：敏感/写端点要求 fnOS 网关鉴权（1.4.10，不重引入 1.3.4 前的登录遮罩/面板口令）──
 * 现状威胁：socket chmod 0777 → 本地任意进程可直连 socket，绕过 fnOS 网关的会话校验，
 * 任意触发 accountsExport?include_secrets=true / apply_hotfix / run / save_config 等。
 * 防线两层（均不破坏既有 UI/桌面打开/热更流程）：
 *   1) 主防线：socket 权限从 0777 收紧到 0660（对齐 p115assistant 已验证值；两个应用同以
 *      root 运行，fnOS 网关（root）照常连接，本地非 root 进程无法再直连）。
 *   2) 纵深防御：fnOS 统一网关在转发 `/app/checkin/*` 前校验用户会话，并注入可信头
 *      X-Trim-Userid / X-Trim-Isadmin / X-Trim-Username（fnOS 官方文档确认；
 *      p115assistant 后端已读取 x-trim-userid 作网关身份，现有实践佐证）。
 *      敏感/写端点校验 X-Trim-Userid 非空即放行，缺失拒绝（阻断「能连上 socket 但
 *      未走网关」的本地进程）。读端点（get_config 已脱敏 / status / get_logs / points /
 *      history / accounts_list / check_hotfix）保持开放，不影响只读巡检与 UI 渲染。
 * 注意：网关只确认登录状态，业务权限仍由本应用负责；这里不做跨 fnOS 用户区分。 */
const GATEWAY_HEADER = "x-trim-userid";
function viaGateway(req) {
  return String((req && req.headers && req.headers[GATEWAY_HEADER]) || "").trim().length > 0;
}
const GATEWAY_DENY_MSG = "未授权：仅允许经 fnOS 网关访问（请从 fnOS 桌面打开应用）";
/** 敏感/写端点（ACTION_HANDLERS 的 key 级白名单）：保存/签到/测试/账号运维/登录流/历史清理/清日志/热更 */
const SENSITIVE_HANDLERS = new Set([
  "saveConfig",
  "runOnce",
  "runAccount",
  "testLogin",
  "accountsReorder",
  "accountsImport",
  "accountsExport",
  "accountsClear",
  "clearHistory",
  "clearLogs",
  "applyHotfix",
]);

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
    const route = ROUTES.get(actionName);
    if (!route) {
      // 动态交互登录路由：checkin/{site}_login/{init|status}
      //   init（POST）→ loginFlowInit；status（GET）→ loginFlowStatus。
      //   未实现 loginFlow 的站点由 server 层返回「不支持交互登录」。
      const m = actionName.match(/^(?:checkin\/)?([a-z_]+)_login\/(init|status|password|oauth)$/);
      if (m) {
        // 登录流涉及凭据提交/会话落盘，全部阶段（含 status 轮询）纳入敏感端点
        if (!viaGateway(req)) return send({ success: false, message: GATEWAY_DENY_MSG, data: {} });
        const site = m[1];
        const phase = m[2];
        if (phase === "init") {
          if (method !== "POST") return send({ success: false, message: "405 方法不允许" });
          const body = await readBody(req, res);
          if (body === null) return; // B10：413 已响应，连接已关闭
          return send(await api.loginFlowInit({ site, account_id: body.account_id, provider: body.provider, base_url: body.base_url }));
        }
        if (phase === "oauth") {
          // OAuth 回调完成：粘贴授权回调链接 → 换 token → 落账号
          if (method !== "POST") return send({ success: false, message: "405 方法不允许" });
          const body = await readBody(req, res);
          if (body === null) return; // B10：413 已响应，连接已关闭
          return send(await api.loginFlowOAuthComplete({ site, token: body.token, callback_url: body.callback_url }));
        }
        if (phase === "password") {
          // 账号密码登录（form 站点通用入口）：提交凭据即时登录 → 自动获取会话 → 落账号
          if (method !== "POST") return send({ success: false, message: "405 方法不允许" });
          const body = await readBody(req, res);
          if (body === null) return; // B10：413 已响应，连接已关闭
          return send(await api.loginFlowPassword({ site, fields: body.fields, remark: body.remark, account_id: body.account_id }));
        }
        if (method !== "GET") return send({ success: false, message: "405 方法不允许" });
        const token = new URL(req.url, "http://x").searchParams.get("token");
        return send(await api.loginFlowStatus({ site, token }));
      }
      return send({ success: false, message: "404" });
    }
    const handlerKey = route[method];
    if (!handlerKey) return send({ success: false, message: "405 方法不允许" });
    // 敏感/写端点必须经 fnOS 网关（X-Trim-Userid 非空）；直连 socket 的本地进程缺失该头 → 拒绝
    if (SENSITIVE_HANDLERS.has(handlerKey) && !viaGateway(req)) {
      return send({ success: false, message: GATEWAY_DENY_MSG, data: {} });
    }
    const handler = ACTION_HANDLERS[handlerKey];
    if (typeof handler !== "function") return send({ success: false, message: "500 未找到处理器" });

    let body = {};
    if (method === "POST") {
      body = await readBody(req, res);
      if (body === null) return; // B10：413 已响应，连接已关闭
    }
    const ctx = { req, res, send, sendFile };
    const result = await handler(body, ctx);
    if (result && result.__raw) return; // 原始响应（如 history_export 的 CSV）已由 handler 直接写出
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
  // 1.4.10 安全：socket 权限从 0777 收紧到 0660（对齐 p115assistant 已验证值；
  // fnOS 网关以 root 转发仍可连接，本地非 root 进程无法再直连绕过网关鉴权）
  fs.chmodSync(SOCKET_PATH, 0o660);
  console.log(`${new Date().toISOString()} 启动 checkin 后端，socket=${SOCKET_PATH}，data=${DATA_DIR}`);
  console.log(`${new Date().toISOString()} 后端已就绪（功能版本 ${store.getConfig().version}）`);
});

restoreSched(); // 启动即恢复调度状态（重启不重复全量、不重置补签上限）；在首个 tick 前执行

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