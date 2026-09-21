"use strict";
/**
 * checkin — 分组路由表（命名空间化 REST + 旧扁平名兼容）。
 *
 * 路由键语义：
 *   - 命名空间键（如 "checkin/config"）：新版分层路由，对齐「行云 API」的
 *     /api/checkin/{config,status,run,points} 命名空间风格；main.js 从
 *     /action/ 之后整段（含斜杠）提取路由键。
 *   - 扁平别名键（如 "get_config"）：旧前端与裸路径兼容入口，语义等价于对应命名空间键。
 *     前端 ui/index.html 本轮零改动，故所有旧 action 名必须继续可用。
 *
 * 值结构：{ GET?: handlerKey, POST?: handlerKey }
 *   - handlerKey 为字符串，指向 main.js 的 ACTION_HANDLERS 键（保持单一事实源，
 *     真正的处理逻辑只在 main.js 里定义一次，路由表只做「键 + 方法 → handlerKey」映射）。
 *   - 同一路由键可同时映射 GET 与 POST（如 checkin/config）。
 */
const ROUTES = new Map([
  // ── 命名空间主路由 ──────────────────────────────
  ["checkin/config", { GET: "getConfig", POST: "saveConfig" }],
  ["checkin/status", { GET: "status" }],
  ["checkin/run", { POST: "runOnce" }],
  ["checkin/run_account", { POST: "runAccount" }],   // 单账号签到（body: {site, account_id}）
  ["checkin/points", { GET: "points" }],   // 阶段1：积分聚合，无旧别名

  // ── 阶段2：账号运维（命名空间，无旧别名）────────────
  ["checkin/accounts", { GET: "accountsList" }],
  ["checkin/accounts/reorder", { POST: "accountsReorder" }],
  ["checkin/accounts/import", { POST: "accountsImport" }],
  ["checkin/accounts/export", { GET: "accountsExport" }],
  ["checkin/accounts/clear", { POST: "accountsClear" }],
  // 交互登录 checkin/{site}_login/{init|status} 为动态路由，由 main.js 正则处理

  // ── 旧扁平名兼容别名（前端零改动必须成立）─────────
  ["get_config", { GET: "getConfig" }],
  ["save_config", { POST: "saveConfig" }],
  ["status", { GET: "status" }],
  ["run", { POST: "runOnce" }],

  // ── 其余保持原样（无命名空间化需求）──────────────
  ["test_login", { POST: "testLogin" }],
  ["history", { GET: "getHistory" }],
  ["history_clear", { POST: "clearHistory" }],
  ["get_logs", { GET: "getLogs" }],
  ["clear_logs", { POST: "clearLogs" }],
  ["check_hotfix", { GET: "checkHotfix" }],
  ["apply_hotfix", { POST: "applyHotfix" }],
]);

module.exports = { ROUTES };
