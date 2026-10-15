"use strict";
/**
 * workbuddy_tasks.js — WorkBuddy 每日自动化引擎（移植自 workbuddy2api-hub v1.7.5）
 *
 * 移植来源：
 *   - wb_tasks.py        国内版成长任务（查询/接取/事件上报点亮/领奖）、连续打卡 streak、
 *                        能量 energy、猫猫旅行（buddy travel）自动派出/领奖
 *   - wb_fingerprint.py  稳定设备指纹 derive_id（同一账号永远来自同一台"物理设备"）
 *   - wb_activity.py     国际版每日活跃打卡（TASK_DAILY_CHAT 语义）
 *
 * 与 sites.js 的 WORKBUDDY 适配器解耦：本模块不 require sites.js（避免循环依赖），
 * 运行所需的 token 解析/续期/日志由调用方经 deps 注入：
 *   deps = {
 *     access: () => string            当前 access_token（复用现有 session/access 机制）
 *     refresh: async () => string     用 refresh_token 续期，写回 cfg.session 并返回新 access_token
 *     log: (line) => void             运行日志（调用方负责带 [workbuddy] 前缀）
 *     useProxy: boolean               站点级代理开关
 *   }
 * 任何一步失败都不抛异常：dead endpoint 只会在日志里留下失败说明，绝不中止整轮。
 */
const crypto = require("crypto");
const { Session, parseJson } = require("./httpc");

/* ── 上游常量（对齐 wb_tasks.py）────────────────────────────── */
const CHAT_BASE = "https://copilot.tencent.com";       // 国内版 chat 侧（成长任务/上报/连登）
const BILL_BASE = "https://www.codebuddy.cn";          // 国内版计费侧
const WEB_BASE = "https://www.workbuddy.cn";           // 国内版 web 域（claim 降级）
const INTL_CHAT_BASE = "https://www.workbuddy.ai";     // 国际版 chat 侧
const INTL_CHAT_PATH = "/v2/chat/completions";
const DESKTOP_UA = "WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1";
const WEB_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
const DAILY_CHAT_MODEL = "deepseek-v4.1-flash";        // 国际版每日活跃对话模型（wb_accounts DAILY_CHAT_MODEL）
const GAP_MS = 1000;                                   // ≥1.0s 防风控间隔（对齐 hub）

/* 成长任务规格：task_code → 事件 kind / 目标 / 奖励（对齐 wb_tasks.TASK_SPECS） */
const TASK_SPECS = {
  create_canvas: { kind: "canvas", target: 1, reward: 300, name: "创建设计任务" },
  template_5: { kind: "template", target: 5, reward: 200, name: "模板创建任务" },
  expert_5: { kind: "expert", target: 5, reward: 200, name: "使用专家助手" },
  Expert_team_use_3: { kind: "team", target: 3, reward: 150, name: "使用专家团队" },
  skill_1: { kind: "skill", target: 1, reward: 100, name: "体验技能" },
  automation_1: { kind: "automation", target: 1, reward: 100, name: "创建自动化任务" },
  playbook_prompt: { kind: "playbook", target: 1, reward: 100, name: "灵感案例使用" },
  Expert_lighthouse: { kind: "lighthouse", target: 1, reward: 100, name: "轻量云专家使用" },
  Buddy_App: { kind: "buddy5", target: 1, reward: 100, name: "进入 Buddy 应用" },
  Buddy_App_QQ: { kind: "buddy5", target: 1, reward: 100, name: "企鹅教师助手" },
  Hp_Appearance: { kind: "skin", target: 1, reward: 100, name: "应用主题外观" },
  chat_5: { kind: "chat", target: 5, reward: 100, name: "发起 5 次对话" },
  "Model_chat_GLM5.2": { kind: "glmchat", target: 1, reward: 100, name: "体验 GLM-5.2" },
  black_cat: { kind: "cat", target: 3, reward: 100, name: "夜猫子任务 (23:00-08:00)" },
  RichMeow_Chat: { kind: "richmeow", target: 1, reward: 100, name: "桌面对话事件链" },
  Library_read: { kind: "library", target: 1, reward: 100, name: "浏览资料库" },
  // first_buddy 是 auto 类（上游不接受接取），完成后领奖才发放 Buddy 实例；
  // 它是所有 single 任务与猫猫旅行的前置（"prerequisite not met: first_buddy"）。
  first_buddy: { kind: "chat", target: 1, reward: 300, name: "领取一只 Buddy" },
  wb_wechat_oa_subscribe_task: { unforgeable: true, reward: 100, reason: "需在微信关注「腾讯 WorkBuddy」公众号满 24 小时", name: "关注官方公众号" },
  Expert_Philanthropy: { unforgeable: true, reason: "真实捐款动作", reward: 0, name: "公益爱心捐赠" },
};

/* 只认桌面端真实行为的任务：伪造 /v2/report 事件会被忽略，诚实跳过并给出深链 */
const DESKTOP_ONLY_TASKS = {
  RichMeow_Chat: "在桌面端发起 1 次对话",
  Library_read: "在桌面端打开「资料库」并读完介绍文档",
  Buddy_App: "在桌面端左上角「发现应用」进入任意一个 Buddy 应用",
  Buddy_App_QQ: "在桌面端「发现应用」进入「企鹅教师助手」",
};
const NIGHT_TASK_CODES = new Set(["black_cat"]);

/* 专家/团队事件必须彼此不同：上游按 (eventCode, id) 去重，重复 id 进度不动。
 * 下列 id 已在 hub 2026-09 实测中验证可推进任务进度。 */
const EXPERT_ID_POOL = [
  ["ex_PZw8Gu81HfN4", "运维工程师"], ["ex_ROsDtJbzADFV", "产品经理"],
  ["ex_SMUnl0nJbPix", "UI设计师"], ["ex_ZTR062oVBOCW", "数据分析师"],
  ["ex_a3sSSFBy8qaC", "后端架构师"], ["ex_aG1kvKbq8lPx", "文案策划"],
  ["ex_al1vxtUOYQ10", "测试专家"], ["ex_cZfiyuET9UQP", "安全顾问"],
  ["ex_eggOvQuVP0hq", "算法工程师"], ["ex_hSwsQjkSKnkX", "前端工程师"],
  ["ex_mMbwwmFA9n9P", "项目管理专家"], ["ex_uAQE5POfk7Zh", "增长运营专家"],
  ["ex_uZzSAScSy7FZ", "行业研究员"], ["ex_LHywGrZOtG7G", "数据分析师"],
  ["ex_NX5C8GBciVed", "测试架构师"], ["ex_DdCsaoq4AtcO", "云端运维专家"],
  ["ex_KzqKQguubrNQ", "内容创作专家"], ["ex_2cvvUZQhDyeJ", "腾讯轻量云专家"],
];
const TEAM_ID_POOL = [
  ["CloudOpsTeam", "运维专家团队"], ["CloudContentTeam", "内容专家团队"],
  ["CloudDevTeam", "研发专家团队"], ["ProductStrategyTeam", "产品战略团队"],
  ["MarketingCampaignTeam", "营销活动团队"], ["SalesBattleTeam", "销售作战团队"],
  ["DesignEngineTeam", "设计引擎团队"], ["HrOperationsTeam", "人力运营团队"],
];

/* ── 设备指纹（对齐 wb_fingerprint.py）────────────────────────── */

/** uid + salt 稳定派生 36 位十六进制设备/会话标识（幂等：同一账号每次调用结果一致） */
function deriveId(uid, salt) {
  const seed = `${salt}:${uid || "anonymous"}`;
  return crypto.createHash("md5").update(seed, "utf8").digest("hex").slice(0, 36);
}

/** 带稳定前缀 + 微秒时间戳的防风控 X-Request-ID */
function generateRequestId(uid) {
  return `${deriveId(uid, "req")}-${String(Date.now() % 1000000).padStart(6, "0")}`;
}

/** 标准完整桌面端指纹（上报事件 / 请求头用，同一账号稳定不漂移） */
function desktopFingerprint(uid, nickname = "") {
  const now = Date.now();
  return {
    timezone: "Asia/Shanghai", reportDelay: 2000, userId: uid,
    username: nickname, userNickname: nickname, product: "SaaS",
    releaseDate: 1789036585355, commit: "5f9692923c93033111c51ad7b003eb80204a9b75",
    ideName: "WorkBuddy", ideType: "WorkBuddy", ideVersion: "5.5.6",
    machineId: deriveId(uid, "machine"), sessionId: deriveId(uid, "session"),
    extName: "workbuddy-desktop", extVersion: "5.5.6",
    os: "win32", arch: "x64", osVersion: "10.0.26220", cpuCores: 20, memorySize: 24,
    timestamp: now, presentAt: now,
  };
}

/* ── 内部工具 ──────────────────────────────────────────────── */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const _log = (deps, line) => { if (deps && typeof deps.log === "function") deps.log(line); };

function _accessOf(deps) {
  return typeof deps.access === "function" ? String(deps.access() || "") : "";
}

function _useProxy(deps) {
  return !!(deps && deps.useProxy);
}

/** 国内版 chat 侧请求头（对齐 hub account.headers("chat") + wb_fingerprint） */
function chatHeaders(uid, access, cfg, intl = false) {
  const origin = intl ? "https://www.workbuddy.ai" : "https://www.codebuddy.cn";
  const h = {
    "Content-Type": "application/json",
    Accept: "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    "User-Agent": intl ? DESKTOP_UA : DESKTOP_UA,
    Origin: origin,
    Referer: origin + "/",
    "X-CodeBuddy-Request": "1",
    "Accept-Language": intl ? "en-US" : "zh-CN",
    Authorization: "Bearer " + access,
    "X-Machine-ID": deriveId(uid, "machine"),
    "X-Session-ID": deriveId(uid, "session"),
    "X-Request-ID": generateRequestId(uid),
  };
  if (cfg && cfg.enterprise_id) h["X-Enterprise-Id"] = String(cfg.enterprise_id);
  if (cfg && cfg.domain) h["X-Domain"] = String(cfg.domain);
  return h;
}

/** web 域 claim 降级用请求头（对齐 hub claim_task 的 web_hdrs） */
function webClaimHeaders(access, uid) {
  return {
    Authorization: "Bearer " + access,
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
    Origin: WEB_BASE,
    Referer: `${WEB_BASE}/profile/growth-center`,
    "x-client-platform": "web",
    "User-Agent": WEB_UA,
    "X-User-Id": uid,
    "X-Domain": WEB_BASE,
  };
}

/** 发 GET 并解析 JSON；鉴权失效时经 deps.refresh 续期重试一次（失败不抛，返回 null） */
async function apiGet(deps, url, uid, intl = false) {
  const doReq = (access) => {
    const s = new Session();
    return s.get(url, { headers: chatHeaders(uid, access, null, intl), timeout: 15000, useProxy: _useProxy(deps) });
  };
  let r = await doReq(_accessOf(deps));
  if (needsRefresh(r) && typeof deps.refresh === "function") {
    try { await deps.refresh(); r = await doReq(_accessOf(deps)); } catch { /* 续期失败：用原响应 */ }
  }
  return parseJson(r && r.text);
}

/** 发 POST（JSON body）并解析 JSON；鉴权失效时续期重试一次（失败不抛，返回 null） */
async function apiPost(deps, url, body, uid, headersOverride = null, intl = false) {
  const doReq = (access) => {
    const s = new Session();
    const hdrs = headersOverride || chatHeaders(uid, access, null, intl);
    // headersOverride 场景 access 已内嵌（web claim），无需重取
    if (!headersOverride) hdrs.Authorization = "Bearer " + access;
    return s.postJson(url, body == null ? {} : body, { headers: hdrs, timeout: 15000, useProxy: _useProxy(deps) });
  };
  let r = await doReq(_accessOf(deps));
  if (!headersOverride && needsRefresh(r) && typeof deps.refresh === "function") {
    try { await deps.refresh(); r = await doReq(_accessOf(deps)); } catch { /* 续期失败：用原响应 */ }
  }
  return parseJson(r && r.text);
}

/** 401 / 鉴权失效判定（对齐 sites.js _billingDo 的刷新触发条件） */
function needsRefresh(r) {
  if (!r) return false;
  const t = String(r.text || "");
  return r.status === 401 || (r.status >= 400 && /token|unauthor|登录|鉴权|过期|expired|invalid/i.test(t));
}

/* ── 成长任务：查询 / 接取 / 领奖 / 上报 ─────────────────────── */

/** 查询成长任务列表（失败返回 []，单端点死掉不中止整轮） */
async function fetchGrowthTasks(cfg, deps) {
  const uid = cfg.uid || "";
  const j = await apiGet(deps, `${CHAT_BASE}/v2/activity/growth/tasks`, uid);
  const rawTasks = ((j && j.data) || {}).tasks || [];
  const tasks = [];
  for (const t of rawTasks) {
    const code = String(t.task_code || "");
    const spec = TASK_SPECS[code] || {};
    const prog = t.progress || {};
    tasks.push({
      task_code: code,
      name: t.title || spec.name || code,
      description: t.description || t.task_desc || "",
      jump_url: t.jump_url || "",
      status: t.accept_status || "not_accepted",
      task_type: t.task_type || "",
      current: Number(prog.current) || 0,
      target: Number(prog.target) || Number(spec.target) || 1,
      reward_credit: Number(t.reward_credit) || Number(spec.reward) || 0,
      reward_energy: Number(t.reward_energy) || 0,
      unforgeable: !!spec.unforgeable,
      reason: spec.reason || "",
    });
  }
  return tasks;
}

/** 批量接取任务（按 20 个一批；返回 {ok, accepted[], failed[], msg}） */
async function acceptTasks(cfg, deps, codes) {
  const out = { ok: true, accepted: [], failed: [], msg: "" };
  if (!codes || !codes.length) return out;
  const uid = cfg.uid || "";
  for (let i = 0; i < codes.length; i += 20) {
    const part = codes.slice(i, i + 20);
    const j = await apiPost(deps, `${CHAT_BASE}/v2/activity/growth/tasks/accept`, { task_codes: part }, uid);
    if (!j || j.code !== 0) {
      out.ok = false;
      out.msg = (j && (j.msg || `code=${j.code}`)) || "接取请求失败";
      out.failed.push(...part);
      continue;
    }
    const results = ((j.data || {}).results) || [];
    const seen = new Set();
    for (const item of results) {
      const code = String(item.task_code || "");
      const st = String(item.status || "");
      seen.add(code);
      if (st === "accepted" || st === "already_accepted") out.accepted.push(code);
      else { out.failed.push(code); }
    }
    for (const code of part) if (!seen.has(code)) out.failed.push(code);
  }
  return out;
}

/** 领奖：支持 copilot.tencent.com → www.workbuddy.cn 自动降级（HTTP 400 时） */
async function claimTask(cfg, deps, code) {
  const uid = cfg.uid || "";
  const url = `${CHAT_BASE}/activity/growth/tasks/${code}/claim`;
  let r;
  try {
    const s = new Session();
    r = await s.postJson(url, {}, { headers: chatHeaders(uid, _accessOf(deps), cfg), timeout: 15000, useProxy: _useProxy(deps) });
  } catch (e) {
    return { ok: false, credit: 0, energy: 0, msg: (e && e.message) || String(e) };
  }
  const j = parseJson(r && r.text);
  if (r && r.status >= 200 && r.status <= 299 && j && j.code === 0) {
    const d = j.data || {};
    return { ok: true, credit: Number(d.credit) || 0, energy: Number(d.energy) || 0 };
  }
  let errMsg = (j && (j.msg || `code=${j.code}`)) || (r ? `HTTP ${r.status}` : "无响应");
  if (r && r.status === 400) {
    // 降级到 web 域领奖
    const wj = await apiPost(deps, `${WEB_BASE}/activity/growth/tasks/${code}/claim`, {}, uid, webClaimHeaders(_accessOf(deps), uid));
    if (wj && wj.code === 0) {
      const d = wj.data || {};
      return { ok: true, credit: Number(d.credit) || 0, energy: Number(d.energy) || 0 };
    }
    errMsg = (wj && (wj.msg || `code=${wj.code}`)) || errMsg;
  }
  return { ok: false, credit: 0, energy: 0, msg: errMsg };
}

/** 构造指定类型的真实规范事件（对齐 wb_tasks.build_event） */
function buildEvent(uid, kind, idx = 0, expert = null) {
  const now = Date.now();
  const cid = `wb-task-${now}-${idx}`;
  const rid = `${cid}-req`;
  if (kind === "canvas") {
    return { eventCode: "wbx_design_canvas_task_create", timestamp: now, reportDelay: 0, conversationId: cid, requestId: rid, source: "summon_keyword", isCustomModel: false, name: "", inputLength: 12, id: `wbx-canvas-${now}`, cost: 0, isSuccessful: true, userId: uid };
  }
  if (kind === "template") {
    return { eventCode: "agent_task_created_with_template", timestamp: now, reportDelay: 0, isCustomModel: true, id: String(idx), name: "幻灯片", requestId: rid, conversationId: cid, userId: uid };
  }
  if (kind === "expert" || kind === "team" || kind === "lighthouse") {
    const etype = kind === "team" ? "team" : "agent";
    let exId, name;
    if (expert) { exId = expert[0]; name = expert[1]; }
    else if (kind === "lighthouse") { exId = "ex_2cvvUZQhDyeJ"; name = "腾讯轻量云专家"; }
    else if (kind === "team") { exId = "CloudOpsTeam"; name = "运维专家团队"; }
    else { exId = "ContentCreator"; name = "内容创作专家"; }
    return { eventCode: "expert_actual_use", timestamp: now, reportDelay: 0, mode: "CLOUD", id: exId, name, expertTitle: name, type: "02-Engineering", expertType: etype, source: "builtin", version: "1.0.2", cost: 0, characterCount: 12, conversationId: cid, requestId: rid, messageId: rid, requestModelId: "deepseek-v4-flash", requestModelName: "DeepSeek V4 Flash", userId: uid };
  }
  if (kind === "skill") {
    return { eventCode: "skill_info", timestamp: now, reportDelay: 0, skillId: "skill_2096525080079265792", name: "pptx", userId: uid };
  }
  if (kind === "automation") {
    return { eventCode: "automated_task_create_suc", timestamp: now, reportDelay: 0, name: "每周工作整理", type: "cron", source: "manually", modelId: "deepseek-v4-flash", modelIsThinking: false, conversationId: cid, requestId: rid, schedule: { type: "recurring", rrule: "FREQ=WEEKLY;BYDAY=FR;BYHOUR=9;BYMINUTE=0" }, prompt: "每周五自动整理本周工作", userId: uid };
  }
  if (kind === "playbook") {
    return { eventCode: "playbook_prompt_send", timestamp: now, reportDelay: 0, id: "worker-ledger-freedom-dashboard", name: "打工人小账本", type: "other", promptLength: 10, isOfficial: 1, source: "discover", conversationId: cid, requestId: rid, userId: uid };
  }
  if (kind === "skin") {
    return { eventCode: "appearance_skin_apply", timestamp: now, reportDelay: 0, action: "apply", source: "settings_close", id: "theme-tkmw7j", vipLevel: "free", series: "craft", type: "unknown", name: "和平精英激战金秋", userId: uid };
  }
  if (kind === "chat" || kind === "glmchat" || kind === "cat") {
    const mId = kind === "glmchat" || kind === "cat" ? "glm-5.2" : "deepseek-v4-flash";
    const mNm = kind === "glmchat" || kind === "cat" ? "GLM-5.2" : "DeepSeek V4 Flash";
    const mode = kind === "cat" ? "night" : "craft";
    return { eventCode: "chat_request_send", timestamp: now, reportDelay: 0, mode, conversationId: cid, requestId: rid, inputLength: 12, requestModelId: mId, requestModelName: mNm, isPlan: false, agentName: "default", agentType: "conversation", userId: uid };
  }
  return { eventCode: "heartbeat", timestamp: now, userId: uid };
}

/** 上报事件数组（POST /v2/report，与桌面客户端真实上报地址一致）；成功返回 true */
async function reportEvents(cfg, deps, events) {
  const uid = cfg.uid || "";
  const j = await apiPost(deps, `${CHAT_BASE}/v2/report`, events, uid);
  return !!(j && j.code === 0);
}

/* ── 猫猫旅行（对齐 wb_tasks.do_cat_travel）────────────────────── */

async function fetchTravelStatus(cfg, deps) {
  const uid = cfg.uid || "";
  const j = await apiGet(deps, `${CHAT_BASE}/activity/growth/buddy/travel/status`, uid);
  return (j && j.data) || {};
}

/** 派出旅行；返回 {data, err} */
async function travelDepart(cfg, deps, locationId) {
  const uid = cfg.uid || "";
  const j = await apiPost(deps, `${CHAT_BASE}/activity/growth/buddy/travel/depart`, { location_id: locationId }, uid);
  if (!j) return { data: null, err: "旅行派出请求失败（无响应）" };
  if (j.code === 0) return { data: j.data || {}, err: null };
  return { data: null, err: j.msg || `code=${j.code}` };
}

/** 确保账号已领到 Buddy 实例（没有则完成并领取 first_buddy）；返回是否已就绪 */
async function ensureBuddy(cfg, deps, wlog) {
  let tasks = await fetchGrowthTasks(cfg, deps);
  let fb = tasks.find((t) => t.task_code === "first_buddy");
  if (!fb) return false;
  if (fb.status === "claimed") return true;
  await progressOne(cfg, deps, fb, wlog);
  tasks = await fetchGrowthTasks(cfg, deps);
  fb = tasks.find((t) => t.task_code === "first_buddy");
  return !!(fb && fb.status === "claimed");
}

/** 检查并执行猫猫旅行（领奖 / 派出） */
async function runBuddyTravel(cfg, deps) {
  const logs = [];
  const wlog = (line) => { logs.push(line); _log(deps, line); };
  if (cfg.enterprise_id) { wlog("猫猫旅行 跳过 企业版账号无成长体系"); return { ok: true, action: "skip", msg: "企业版账号无成长体系，跳过", logs }; }
  let st;
  try { st = await fetchTravelStatus(cfg, deps); }
  catch (e) { wlog(`猫猫旅行 失败 查询旅行状态出错（${(e && e.message) || e}）`); return { ok: false, msg: "查询旅行状态失败", logs }; }
  if (!st || !st.state) { wlog("猫猫旅行 跳过 未获取到旅行状态"); return { ok: true, action: "unknown", msg: "未获取到旅行状态", logs }; }

  const state = st.state;
  if (state === "arrived") {
    const uid = cfg.uid || "";
    const j = await apiPost(deps, `${CHAT_BASE}/activity/growth/buddy/travel/claim`, {}, uid);
    if (j && j.code === 0) {
      const credit = Number((j.data || {}).reward_credit) || 0;
      wlog(`猫猫旅行 领奖成功 旅行归来！获得 ${credit} 积分`);
      return { ok: true, action: "claim", credit, msg: `旅行归来领奖成功！获得 ${credit} 积分`, logs };
    }
    wlog(`猫猫旅行 领奖失败 ${(j && (j.msg || `code=${j.code}`)) || "无响应"}`);
    return { ok: false, action: "claim", msg: "领奖失败", logs };
  }

  if (state === "idle") {
    if (st.daily_limit_reached) { wlog("猫猫旅行 跳过 今日已完成旅行，明日 00:00 刷新"); return { ok: true, action: "idle", msg: "猫猫今日已完成旅行，明日 00:00 刷新", logs }; }
    // 目的地清单在 travel/config；查不到回退 location_id=1
    let lid = null;
    const uid = cfg.uid || "";
    const cfgJ = await apiGet(deps, `${CHAT_BASE}/activity/growth/buddy/travel/config`, uid);
    const locs = ((cfgJ && cfgJ.data) || {}).locations || [];
    if (locs.length) lid = locs[0].id;
    if (lid == null) lid = 1;
    // 先直接派，失败再补齐 first_buddy（其奖励即 Buddy 实例）重试一次
    let { data, err } = await travelDepart(cfg, deps, lid);
    if (data == null && /no active buddy/i.test(err || "")) {
      if (await ensureBuddy(cfg, deps, wlog)) {
        ({ data, err } = await travelDepart(cfg, deps, lid));
      } else {
        wlog("猫猫旅行 失败 还没有 Buddy：需先完成并领取「领取一只 Buddy」任务");
        return { ok: false, msg: "还没有 Buddy：需先完成并领取「领取一只 Buddy」任务", logs };
      }
    }
    if (data) {
      const loc = ((data.location || {}).name) || "";
      wlog(`猫猫旅行 派出成功 猫猫已出发前往「${loc}」，预计数小时后归来`);
      return { ok: true, action: "depart", msg: `猫猫已出发前往「${loc}」，预计数小时后归来！`, logs };
    }
    wlog(`猫猫旅行 派出失败 ${err}`);
    return { ok: false, action: "depart", msg: `派出旅行失败: ${err}`, logs };
  }

  if (state === "traveling") { wlog("猫猫旅行 进行中 正在旅行途中，稍后再来查看"); return { ok: true, action: "traveling", msg: "猫猫正在旅行途中，请稍后再来查看！", logs }; }
  wlog(`猫猫旅行 状态 ${state}`);
  return { ok: true, action: state, msg: `当前状态: ${state}`, logs };
}

/* ── 成长任务单任务推进（对齐 wb_tasks._progress_one）────────── */

function inNightWindow() {
  const h = new Date().getHours();
  return h >= 23 || h < 8;
}

/** 推进单个任务并返回本次到账积分 */
async function progressOne(cfg, deps, t, wlog) {
  const code = t.task_code;
  const spec = TASK_SPECS[code];
  if (!spec || spec.unforgeable) {
    if (spec && spec.reason) wlog(`成长任务 跳过 [${spec.name || code}] 需真实操作完成: ${spec.reason}`);
    return 0;
  }
  const status = t.status;
  const cur = t.current || 0;
  const tgt = t.target || 1;
  if (status === "claimed") return 0;

  // 已完成的任务先领奖（桌面端/夜间任务可能被真实操作完成，不能丢掉奖励）
  if (status === "completed" || cur >= tgt) {
    const res = await claimTask(cfg, deps, code);
    if (res.ok) {
      wlog(`成长任务 领奖成功 [${spec.name}] +${res.credit} 积分`);
      await sleep(GAP_MS);
      return res.credit;
    }
    wlog(`成长任务 领奖失败 [${spec.name}] ${res.msg || "未知原因"}`);
    await sleep(GAP_MS);
    return 0;
  }

  if (DESKTOP_ONLY_TASKS[code]) {
    const jump = t.jump_url || "workbuddy://chat";
    wlog(`成长任务 跳过 [${spec.name}] 需真实操作完成: ${DESKTOP_ONLY_TASKS[code]}（深链 ${jump}），跳过事件伪造`);
    return 0;
  }

  if (NIGHT_TASK_CODES.has(code) && !inNightWindow()) {
    wlog(`成长任务 跳过 [${spec.name}] 仅 23:00-08:00 上报计数，当前不在窗口（每日 01:00 调度器自动执行，累计 3 天）`);
    return 0;
  }

  if (status === "not_accepted" && t.task_type !== "auto") {
    wlog(`成长任务 跳过 [${spec.name}] 仍未接取（先解决接取失败）`);
    return 0;
  }

  const need = Math.max(1, tgt - cur);
  const kind = spec.kind;
  wlog(`成长任务 点亮 [${spec.name}] 需上报 ${need} 次...`);
  let reportOk = true;
  const idPool = kind === "expert" || kind === "team" ? (kind === "team" ? TEAM_ID_POOL : EXPERT_ID_POOL) : null;
  for (let i = 0; i < need; i++) {
    const expert = idPool ? idPool[(cur + i) % idPool.length] : null;
    const ev = buildEvent(cfg.uid || "", kind, i, expert);
    if (!(await reportEvents(cfg, deps, [ev]))) reportOk = false;
    if (i < need - 1) await sleep(GAP_MS);
  }
  if (!reportOk) wlog(`成长任务 部分事件上报失败 [${spec.name}]（上游拒绝），继续尝试领奖`);
  await sleep(1500);

  // 等上游落账再领奖：进度 1-3 秒可见，先快查几次；只在确实在动才继续等
  let prog = cur;
  for (let attempt = 0; attempt < 6; attempt++) {
    const fresh = (await fetchGrowthTasks(cfg, deps)).find((x) => x.task_code === code);
    if (fresh) {
      prog = fresh.current || 0;
      if (prog >= tgt || fresh.status === "completed" || fresh.status === "claimed") break;
      if (prog > cur) { await sleep(2500); continue; }
    }
    if (attempt < 2) await sleep(1500);
    else break;
  }
  if (prog < tgt) {
    wlog(`成长任务 顺延 [${spec.name}] 已上报但进度 ${prog}/${tgt} 未达成，领奖顺延到下次运行`);
    await sleep(GAP_MS);
    return 0;
  }

  const res = await claimTask(cfg, deps, code);
  if (res.ok) {
    wlog(`成长任务 完成 [${spec.name}] 点亮并领奖成功 +${res.credit} 积分`);
    await sleep(GAP_MS);
    return res.credit;
  }
  wlog(`成长任务 领奖失败 [${spec.name}] 进度已达 ${prog}/${tgt} 但领奖失败: ${res.msg || "未知原因"}`);
  await sleep(GAP_MS);
  return 0;
}

/* ── 连登 / 能量（对齐 wb_tasks.fetch_growth_summary）───────── */

/** 查询连续打卡、能量余额与抽奖机会（失败字段安全回落默认值） */
async function fetchStreakEnergy(cfg, deps) {
  const uid = cfg.uid || "";
  const out = { energy: 0, streak_days: 0, makeup_cards: 0, lottery_chances: 0, tier_statuses: {} };
  try {
    const j = await apiGet(deps, `${CHAT_BASE}/v2/activity/growth/energy`, uid);
    out.energy = Number((j && j.data || {}).balance) || 0;
  } catch { /* 单个端点失败不影响其余 */ }
  try {
    const j = await apiGet(deps, `${CHAT_BASE}/activity/growth/streak`, uid);
    const d = (j && j.data) || {};
    const st = d.streak || {};
    out.streak_days = Number(st.days) || 0;
    out.makeup_cards = Number((d.makeup_cards || {}).balance) || 0;
    const redemp = d.redemption_status || {};
    out.tier_statuses = {
      "7d": redemp.tier_7d_status || "locked",
      "14d": redemp.tier_14d_status || "locked",
      "28d": redemp.tier_28d_status || "locked",
    };
  } catch { /* ignore */ }
  try {
    const j = await apiGet(deps, `${CHAT_BASE}/activity/growth/lottery/summary`, uid);
    out.lottery_chances = Number((j && j.data || {}).chances) || 0;
  } catch { /* ignore */ }
  return out;
}

/** 连续打卡 / 能量查询与汇报（只读，不发写请求） */
async function runStreakEnergy(cfg, deps) {
  const logs = [];
  const wlog = (line) => { logs.push(line); _log(deps, line); };
  if (cfg.enterprise_id) { wlog("连登能量 跳过 企业版账号无成长体系"); return { ok: true, logs, msg: "企业版账号无成长体系，跳过" }; }
  const s = await fetchStreakEnergy(cfg, deps);
  wlog(`连登能量 查询 连续打卡 ${s.streak_days} 天，能量余额 ${s.energy}，补签卡 ${s.makeup_cards} 张`);
  const tierNames = { "7d": "7 天", "14d": "14 天", "28d": "28 天" };
  for (const [k, label] of Object.entries(tierNames)) {
    const st = s.tier_statuses[k] || "locked";
    if (st === "claimed") wlog(`连登能量 兑换 ${label} 档位已领取`);
    else if (st !== "locked") wlog(`连登能量 可兑换 ${label} 档位（状态 ${st}）`);
  }
  if (s.lottery_chances > 0) wlog(`连登能量 抽奖机会 ${s.lottery_chances} 次`);
  return { ok: true, logs, msg: `连续打卡 ${s.streak_days} 天，能量 ${s.energy}`, energy: s.energy, streak_days: s.streak_days };
}

/* ── 国际版每日活跃（对齐 wb_activity TASK_DAILY_CHAT / _daily_chat_upstream）────── */

/** 国际版（workbuddy.ai）每日活跃打卡：轻量对话触发每日活跃福利 */
async function runIntlDaily(cfg, deps) {
  const logs = [];
  const wlog = (line) => { logs.push(line); _log(deps, line); };
  const uid = cfg.uid || "";
  const body = {
    model: DAILY_CHAT_MODEL,
    messages: [{ role: "user", content: "Hi" }],
    stream: true,
    max_tokens: 10,
    reasoning_effort: "none",
  };
  let r;
  try {
    const s = new Session();
    r = await s.postJson(INTL_CHAT_BASE + INTL_CHAT_PATH, body, {
      headers: chatHeaders(uid, _accessOf(deps), cfg, true), timeout: 20000, useProxy: _useProxy(deps),
    });
  } catch (e) {
    wlog(`国际版打卡 失败 ${(e && e.message) || e}`);
    return { ok: false, logs, msg: (e && e.message) || "请求失败" };
  }
  const ok = !!(r && r.status >= 200 && r.status <= 299);
  if (ok) {
    wlog("国际版打卡 成功 每日活跃对话已完成");
    return { ok: true, logs, msg: "每日活跃对话成功完成" };
  }
  const j = parseJson(r && r.text);
  const why = (j && (j.msg || j.error)) || (r ? `HTTP ${r.status}` : "无响应");
  wlog(`国际版打卡 失败 ${why}`);
  return { ok: false, logs, msg: why };
}

/* ── 成长任务主流程（对齐 wb_tasks.run_growth_tasks）─────────── */

/** 完整执行批量成长任务点亮与领奖 + 连登/能量汇报 */
async function runGrowthTasks(cfg, deps) {
  const logs = [];
  const wlog = (line) => { logs.push(line); _log(deps, line); };
  wlog("成长任务 开始 运行每日成长任务自动化...");
  if (cfg.enterprise_id) { wlog("成长任务 跳过 企业版账号无成长体系"); return { ok: true, logs, earned_credit: 0, msg: "企业版账号无成长体系，跳过" }; }

  let tasks = [];
  try { tasks = await fetchGrowthTasks(cfg, deps); } catch { tasks = []; }
  if (!tasks.length) {
    wlog("成长任务 失败 未能获取到任务清单，请检查网络或账号状态");
    return { ok: false, logs, earned_credit: 0, msg: "未能获取任务清单" };
  }

  let totalEarned = 0;
  const needsAccept = (x) => x.status === "not_accepted" && !x.unforgeable && x.task_type !== "auto";

  // 0. auto 类任务（first_buddy 等）不需要接取，且可能是其它任务与猫猫旅行的前置
  for (const t of tasks) if (t.task_type === "auto") totalEarned += await progressOne(cfg, deps, t, wlog);

  // 1. 批量接取未接任务（auto 类不接受接取，unforgeable 无法自动化）
  const unaccepted = tasks.filter(needsAccept).map((t) => t.task_code);
  if (unaccepted.length) {
    wlog(`成长任务 接取 发现 ${unaccepted.length} 个待接取任务，正在批量接取...`);
    const acc = await acceptTasks(cfg, deps, unaccepted);
    if (acc.accepted.length) wlog(`成长任务 接取 已接取 ${acc.accepted.length} 个任务`);
    if (acc.failed.length) {
      const why = acc.msg || "";
      wlog(`成长任务 接取 未成功 ${acc.failed.length} 个: ${acc.failed.slice(0, 5).join(", ")}${acc.failed.length > 5 ? " ..." : ""}${why ? `（${why}）` : ""}`);
    }
    await sleep(GAP_MS);
    tasks = (await fetchGrowthTasks(cfg, deps)) || tasks;
    // 复核一次：上游偶尔瞬时拒绝整个批次，仍未接取的补一次
    const still = tasks.filter(needsAccept).map((t) => t.task_code);
    if (still.length) {
      wlog(`成长任务 接取 仍有 ${still.length} 个未接取，重试接取一次...`);
      const retry = await acceptTasks(cfg, deps, still);
      if (retry.accepted.length) wlog(`成长任务 接取 重试成功 ${retry.accepted.length} 个`);
      await sleep(GAP_MS);
      tasks = (await fetchGrowthTasks(cfg, deps)) || tasks;
    }
    const stillPending = tasks.filter(needsAccept).map((t) => t.task_code);
    if (stillPending.length) wlog(`成长任务 接取 仍有 ${stillPending.length} 个处于未接取状态，未接取任务上报不计进度，本轮跳过这些任务`);
  }

  // 2. 处理每个任务（auto 已在第 0 步处理过）
  for (const t of tasks) if (t.task_type !== "auto") totalEarned += await progressOne(cfg, deps, t, wlog);

  // 3. 连登 / 能量汇报（同属成长体系）
  const s = await fetchStreakEnergy(cfg, deps);
  wlog(`连登能量 查询 连续打卡 ${s.streak_days} 天，能量余额 ${s.energy}，抽奖机会 ${s.lottery_chances} 次`);

  wlog(`成长任务 完成 本次累计新增到账 +${totalEarned} 积分`);
  return { ok: true, logs, earned_credit: totalEarned, energy: s.energy, streak_days: s.streak_days };
}

module.exports = {
  deriveId,
  desktopFingerprint,
  runGrowthTasks,
  runBuddyTravel,
  runStreakEnergy,
  runIntlDaily,
};
