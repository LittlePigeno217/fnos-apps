"use strict";
/**
 * wb_gateway.js — WorkBuddy OpenAI 兼容 API 网关（移植 workbuddy2api-hub v1.7.5）
 *
 * 覆盖功能：
 *   P0  OpenAI 兼容三协议：/v1/chat/completions、/v1/responses、/v1/messages（Anthropic）
 *        统一转发国内/国际上游（copilot.tencent.com / www.workbuddy.ai）+ 指纹请求头
 *   P1  多账号 + 双区域路由（intl/cn）：复用 checkin workbuddy 站点账号池，按区域独立
 *        轮询调度；derive_id 复用 workbuddy_tasks.js（同一账号永远同一台"物理设备"）
 *   P2  限额护栏（保留积分 / 每日 Token / 每日积分 / 按模型每日 Token，本地 0 点解封，
 *        计数器随 cfg.wb.day 落盘）+ 多 Key（生成 / 区域绑定 / 模型限制 / 启停 / 删除 / 用量归因）
 *   P4  模型目录 /v1/models（紧凑目录，对齐 hub wb_catalog）
 *
 * 与站点 adapter 解耦（同 workbuddy_tasks.js 约定）：
 *   deps = { store, log }——store 提供 getConfig/saveConfig（wb 配置 + 账号会话回写），
 *   log 为运行日志回调（调用方带 [wb] 前缀）。
 * 本模块零外部依赖；出站走 httpc（非流式）或内置 raw 流式通道（含 HTTP 代理 CONNECT）。
 */
const crypto = require("crypto");
const https = require("https");
const net = require("net");
const tls = require("tls");
const { URL } = require("url");
const { Session, parseJson, proxyFromEnv } = require("./httpc");
const WBT = require("./workbuddy_tasks"); // 复用 deriveId（指纹派生单一事实源）

/* ── 上游常量（对齐 hub wb_accounts.REALM_CONFIGS / wb_proxy CHAT_PATH）─── */
const CHAT_PATH = "/v2/chat/completions";
const REFRESH_PATH = "/v2/plugin/auth/token/refresh";
const CREDITS_PATH = "/v2/billing/meter/get-user-resource";
const SYSTEM_PROMPT = "You are a helpful assistant.";
const REALMS = {
  intl: {
    name: "国际版 (Global)",
    chat_upstream: "https://www.workbuddy.ai",
    origin: "https://www.workbuddy.ai",
    domain: "www.workbuddy.ai",
    chat_ua: "WorkBuddy/5.5.6 WorkBuddy AI/5.5.6 CLI/5.5.6",
    has_checkin: false,
  },
  cn: {
    name: "国内版 (China)",
    chat_upstream: "https://copilot.tencent.com",
    origin: "https://www.codebuddy.cn",
    domain: "copilot.tencent.com",
    chat_ua: "WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1",
    has_checkin: true,
  },
};
const CN_MARKERS = ["copilot.tencent.com", "codebuddy.cn", "workbuddy.cn"];
const INTL_MARKERS = ["workbuddy.ai", "codebuddy.ai"];

/* ── 模型目录（紧凑版，提取自 hub wb_catalog；字段：n 名称 / c 积分倍率 / in·out 上下文 / 能力 / realm）── */
const MODEL_CATALOG = {
  "deepseek-v4.1-flash": { n: "Deepseek-V4.1-Flash", c: "x0.00", in: 1000000, out: 128000, vision: true, tool: true, think: true, realm: "intl" },
  "deepseek-v4-flash": { n: "Deepseek-V4-Flash", c: "x0.17", in: 1000000, out: 50000, vision: true, tool: true, think: true, realm: "cn" },
  "deepseek-v4-pro": { n: "Deepseek-V4-Pro", c: "x0.51", in: 1000000, out: 50000, vision: true, tool: true, think: true, realm: "cn" },
  "glm-5.3-flash": { n: "GLM-5.3-Flash", c: "x0.06", in: 1000000, out: 32000, vision: false, tool: true, think: true, realm: "intl" },
  "glm-5.3": { n: "GLM-5.3", c: "x0.79", in: 1000000, out: 48000, vision: true, tool: true, think: true, realm: "intl" },
  "glm-5.2": { n: "GLM-5.2", c: "x0.79", in: 1000000, out: 48000, vision: true, tool: true, think: true, realm: "intl" },
  "glm-5.1": { n: "GLM-5.1", c: "x0.79", in: 200000, out: 48000, vision: true, tool: true, think: true, realm: "cn" },
  "hy4-preview": { n: "Hy4 preview", c: "x0.29", in: 1000000, out: 64000, vision: true, tool: true, think: true, realm: "intl" },
  "hy4-preview-f": { n: "Hy4 preview", c: "x0.00", in: 1000000, out: 64000, vision: true, tool: true, think: true, realm: "intl" },
  "hy3": { n: "Hy3", c: "x0.00", in: 192000, out: 64000, vision: true, tool: true, think: true, realm: "intl" },
  "gpt-6-astra": { n: "GPT-6-Astra", c: "x6.67", in: 1000000, out: 128000, vision: true, tool: true, think: true, realm: "intl" },
  "gpt-5.4": { n: "GPT-5.4", c: "x1.65", in: 272000, out: 72000, vision: true, tool: true, think: true, realm: "intl" },
  "gpt-5.5": { n: "GPT-5.5", c: "x3.31", in: 1000000, out: 128000, vision: true, tool: true, think: true, realm: "intl" },
  "gemini-3.5-flash": { n: "Gemini-3.5-Flash", c: "x0.99", in: 1000000, out: 65536, vision: true, tool: true, think: true, realm: "intl" },
  "grok-4.7": { n: "Grok-4.7", c: "x1.90", in: 500000, out: 128000, vision: true, tool: true, think: true, realm: "intl" },
  "minimax-m3": { n: "MiniMax-M3", c: "x0.25", in: 512000, out: 128000, vision: true, tool: true, think: true, realm: "cn" },
  "minimax-m2.7": { n: "MiniMax-M2.7", c: "x0.26", in: 200000, out: 48000, vision: true, tool: true, think: true, realm: "cn" },
  "kimi-k3-1": { n: "Kimi-K3", c: "x1.62", in: 1000000, out: 32000, vision: true, tool: true, think: true, realm: "cn" },
  "kimi-k2.7": { n: "Kimi-K2.7-Code", c: "x0.57", in: 256000, out: 32000, vision: true, tool: true, think: true, realm: "cn" },
  "kimi-k2.5": { n: "Kimi-K2.5", c: "x0.45", in: 256000, out: 32000, vision: true, tool: true, think: true, realm: "cn" },
  "kimi-k2-thinking": { n: "Kimi-K2-Thinking", c: "x0.54", in: 256000, out: 32000, vision: true, tool: true, think: true, realm: "cn" },
  "deepseek-v3-1": { n: "DeepSeek-V3.1", c: "x0.52", in: 96000, out: 32000, vision: true, tool: true, think: false, realm: "cn" },
  "default-model": { n: "Auto", c: "", in: 176000, out: 24000, vision: true, tool: true, think: false, realm: "intl" },
  "fast-model": { n: "Fast", c: "x0.34 credits", in: 200000, out: 32000, vision: true, tool: true, think: true, realm: "intl" },
  "balanced-model": { n: "Balanced", c: "x0.59 credits", in: 256000, out: 32000, vision: true, tool: true, think: true, realm: "intl" },
  "primary-model": { n: "Primary", c: "x3.31 credits", in: 272000, out: 72000, vision: true, tool: true, think: true, realm: "intl" },
};

/* 模型 → 区域识别（对齐 hub detect_model_realm，简化为精选名单 + 缺省 default_realm） */
const INTL_ONLY = new Set(["gpt-6-astra", "gpt-5.5", "gpt-5.4", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.3-codex", "gemini-3.5-flash", "grok-4.7", "deepseek-v4.1-flash", "hy4-preview", "hy4-preview-f", "hy3", "kimi-k2.6", "kimi-k2.8-preview", "kimi-k2-instruct-taiji", "fast-model", "balanced-model", "primary-model", "default-model", "deep-model"]);
const CN_ONLY = new Set(["deepseek-v4-pro", "minimax-m3", "minimax-m2.7", "minimax-m2.5", "glm-5.1", "glm-5.0-turbo", "glm-4.6v", "kimi-k3-1", "kimi-k2.7", "kimi-k2.5", "kimi-k2-thinking", "hy3-x", "hy4-preview-dev", "hy4-preview-x"]);
function detectModelRealm(modelId, def) {
  const m = String(modelId || "").toLowerCase();
  if (!m) return def || "intl";
  if (INTL_ONLY.has(m) || m.startsWith("gpt-") || m.startsWith("gemini-")) return "intl";
  if (CN_ONLY.has(m) || m.startsWith("minimax-") || m === "deepseek-v4-pro") return "cn";
  return def || "intl";
}

/* ── 内部工具 ────────────────────────────────────────────── */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
function maskUid(uid) {
  const s = String(uid || "");
  if (s.length <= 8) return s ? `${s.slice(0, 4)}***` : "-";
  return `${s.slice(0, 6)}***${s.slice(-4)}`;
}
function maskKey(key) {
  const k = String(key || "");
  return k.length <= 8 ? "***" : `${k.slice(0, 6)}***${k.slice(-4)}`;
}
/** fnmatch 风格模型匹配（* ? 通配，对齐 hub key_allows_model 的多模式任一命中） */
function matchesPattern(name, pattern) {
  try {
    const re = new RegExp(`^${String(pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");
    return re.test(name);
  } catch { return false; }
}
function globAny(model, patterns) {
  const pats = (patterns || []).map((p) => String(p).trim()).filter(Boolean);
  if (!pats.length) return true;
  const m = String(model || "").trim();
  if (!m) return false;
  return pats.some((p) => matchesPattern(m, p));
}

/* ── 账号侧：区域派生 / 凭据解析（对齐 hub Account + checkin session 形状）── */
function accountRealm(acc) {
  if (acc && typeof acc.realm === "string" && (acc.realm === "intl" || acc.realm === "cn")) return acc.realm;
  const dom = String((acc && (acc.domain || "")) || "").toLowerCase();
  const tok = String((acc && (acc.session && acc.session.access_token) || (acc && acc.access_token)) || "");
  for (const m of INTL_MARKERS) if (dom.includes(m) || tok.includes(m)) return "intl";
  for (const m of CN_MARKERS) if (dom.includes(m) || tok.includes(m)) return "cn";
  return "cn"; // checkin 生态国内优先（微信扫码登录即国内版）
}
function accountAccess(acc) {
  const sess = (acc && acc.session) || {};
  return (sess.access_token || (acc && acc.access_token) || "").trim();
}
function accountRefresh(acc) {
  const sess = (acc && acc.session) || {};
  return (sess.refresh_token || (acc && acc.refresh_token) || "").trim();
}
function accountUid(acc) {
  return String((acc && acc.uid) || "").trim();
}
function accountConfigured(acc) {
  return !!(acc && (accountAccess(acc) || !!(acc.session && acc.session.access_token)));
}
/** 账号明细列表（看板「账号」区只读联动；与 checkin 签到添加的账号单一事实源）。
 *  绝不外泄 access_token/refresh_token/session 等敏感字段；realm 走 accountRealm，
 *  last = 该账号最近一条签到记录（来自 checkin history，新→旧首条命中），ready = 配置完整且未停用。 */
function accountList(deps, cfg) {
  const accs = Array.isArray((((cfg || {}).sites || {}).workbuddy || {}).accounts) ? cfg.sites.workbuddy.accounts : [];
  let lastByAcc = null;
  try {
    const hist = deps.store.getHistory(500) || [];
    lastByAcc = new Map();
    for (const h of hist) {
      if (!h || h.site !== "workbuddy") continue;
      const k = String(h.account_id || "");
      if (k && !lastByAcc.has(k)) lastByAcc.set(k, { time: h.time, status: h.status });
    }
  } catch (e) { try { deps.log(`账号列表读取签到历史失败 ${(e && e.message) || e}`); } catch {} }
  return accs.map((a) => {
    const uid = String(accountUid(a) || "");
    return {
      id: a.id,
      remark: String(a.remark || "").trim() || "WorkBuddy",
      label: uid ? maskUid(uid) : maskUid(a.id),
      realm: accountRealm(a),
      last: (lastByAcc && lastByAcc.get(String(a.id))) || null,
      ready: accountConfigured(a) && a.enabled !== false,
    };
  });
}

/* ── 请求头构造（对齐 hub account.headers("chat") + wb_fingerprint）── */
function chatHeaders(acc, realm, extra = {}) {
  const realmCfg = REALMS[realm] || REALMS.intl;
  const access = accountAccess(acc);
  const uid = accountUid(acc);
  const h = {
    "Content-Type": "application/json",
    Accept: "application/json, text/plain, */*",
    "User-Agent": realmCfg.chat_ua,
    Origin: realmCfg.origin,
    Referer: realmCfg.origin + "/",
    "Accept-Language": realm === "intl" ? "en-US,en;q=0.9" : "zh-CN,zh;q=0.9,en;q=0.8",
    Authorization: "Bearer " + access,
    "X-CodeBuddy-Request": "1",
    "X-Machine-ID": WBT.deriveId(uid, "machine"),
    "X-Session-ID": WBT.deriveId(uid, "session"),
    "X-Request-ID": WBT.deriveId(uid, "req") + "-" + String(Date.now() % 1000000).padStart(6, "0"),
    ...extra,
  };
  if (acc.enterprise_id) h["X-Enterprise-Id"] = String(acc.enterprise_id);
  if (acc.domain) h["X-Domain"] = String(acc.domain);
  return h;
}

/* ── 上游 body 构造（对齐 hub build_upstream_body 的关键语义）── */
function buildUpstreamBody(payload) {
  const model = String(payload.model || "default-model");
  let messages = Array.isArray(payload.messages) ? payload.messages.slice() : [];
  // developer → system（上游只认 system/user/assistant/tool）
  messages = messages.map((m) => {
    if (m && typeof m === "object" && m.role === "developer") return { ...m, role: "system" };
    return m;
  });
  if (!messages.length || !messages[0] || messages[0].role !== "system") {
    messages = [{ role: "system", content: SYSTEM_PROMPT }].concat(messages);
  }
  const body = { ...payload, model, messages };
  if (body.max_completion_tokens !== undefined && body.max_tokens === undefined) {
    const v = parseInt(body.max_completion_tokens, 10);
    if (v > 0) body.max_tokens = v;
  }
  if (body.max_tokens === undefined) {
    const meta = MODEL_CATALOG[model];
    if (meta && meta.out) body.max_tokens = meta.out;
  }
  // 私有请求标记（responses 路径用 _ 前缀暂存的外露字段）一律不下发
  for (const k of Object.keys(body)) if (k.startsWith("_")) delete body[k];
  return body;
}

/* ── 限额护栏（对齐 hub Account.reserve/daily guards，本地 0 点解封）── */
function freshDay() {
  return { date: todayStr(), requests: 0, token_in: 0, token_out: 0, credits: 0, model_tokens: {} };
}
function dayCounters(cfg) {
  const wb = cfg.wb || {};
  const day = wb.day && wb.day.date === todayStr() ? wb.day : freshDay();
  return day;
}
function guardBlocked(cfg, model, pool, acc, accCreditsCache) {
  const lim = ((cfg.wb || {}).limits) || {};
  if (!lim.enabled) return { blocked: false };
  const day = dayCounters(cfg);
  if (lim.daily_token_limit > 0 && (day.token_in + day.token_out) >= lim.daily_token_limit) {
    return { blocked: true, reason: `全池每日 Token 已用尽（${day.token_in + day.token_out}/${lim.daily_token_limit}）` };
  }
  if (lim.daily_credit_limit > 0 && day.credits >= lim.daily_credit_limit) {
    return { blocked: true, reason: `全池每日积分已用尽（${day.credits.toFixed(2)}/${lim.daily_credit_limit}）` };
  }
  if (lim.model_daily_token_limit > 0 && ((day.model_tokens[model] || 0) >= lim.model_daily_token_limit)) {
    return { blocked: true, reason: `模型 ${model} 每日 Token 已用尽（${day.model_tokens[model]}/${lim.model_daily_token_limit}）` };
  }
  if (lim.reserve_credits > 0 && acc) {
    const c = accCreditsCache.get(acc.id);
    if (typeof c === "number" && c <= lim.reserve_credits) {
      return { blocked: true, reason: `账号保留积分触线（余额 ${c} ≤ 保留 ${lim.reserve_credits}）` };
    }
  }
  return { blocked: false };
}
/** 按请求记一笔护栏用量（累加进 day，禁止超限并发）。返回 bool（是否允许写入） */
function recordUsageWb(cfg, model, tokenIn, tokenOut, credits, reqOk) {
  const wb = cfg.wb || {};
  const day = dayCounters(cfg);
  day.requests += 1;
  day.token_in += tokenIn;
  day.token_out += tokenOut;
  day.credits += credits;
  day.model_tokens[model] = (day.model_tokens[model] || 0) + tokenIn + tokenOut;
  wb.day = day;
}
/** 保留积分缓存：余额查询结果（10 分钟 TTL，失败回落 undefined=fail-open） */
function makeCreditsCache() {
  return new Map();
}
async function queryAccountCredits(cache, acc, realm, useProxy) {
  const uid = accountUid(acc);
  const access = accountAccess(acc);
  if (!access) return undefined;
  const cached = cache.get(acc.id);
  if (cached && Date.now() - cached.ts < 10 * 60 * 1000) return cached.value;
  try {
    const s = new Session();
    const r = await s.postJson(REALMS[realm].chat_upstream + CREDITS_PATH, {}, {
      headers: chatHeaders(acc, realm), timeout: 12000, useProxy,
    });
    const j = parseJson(r && r.text);
    const data = ((j || {}).data) || {};
    const v = Number(data.credits !== undefined ? data.credits : data.balance);
    const ok = Number.isFinite(v);
    cache.set(acc.id, { value: ok ? v : undefined, ts: Date.now() });
    return ok ? v : undefined;
  } catch {
    cache.set(acc.id, { value: undefined, ts: Date.now() });
    return undefined;
  }
}

/* ── Key 管理与鉴权（对齐 hub wb_settings.api_keys / key_allows_model）── */
function genKey() {
  return "wb_" + crypto.randomBytes(8).toString("hex");
}
function normalizeKeys(raw) {
  const out = [];
  for (const e of Array.isArray(raw) ? raw : []) {
    if (!e || typeof e !== "object") continue;
    const key = String(e.key || "").trim();
    if (!key && !e.deleted_at) continue;
    const realm = String(e.realm || "").trim();
    out.push({
      id: String(e.id || crypto.randomBytes(6).toString("hex")),
      name: String(e.name || "").trim() || "未命名",
      key,
      realm: (realm === "intl" || realm === "cn") ? realm : "",
      models: Array.isArray(e.models) ? e.models.map((m) => String(m).trim()).filter(Boolean) : [],
      enabled: e.deleted_at ? false : e.enabled !== false,
      created_at: e.created_at || new Date().toISOString(),
      deleted_at: e.deleted_at || "",
    });
  }
  return out;
}
function findKey(cfg, token) {
  const t = String(token || "").replace(/^Bearer\s+/i, "").trim();
  if (!t) return null;
  return normalizeKeys((cfg.wb || {}).keys).find((k) => k.key === t && !k.deleted_at) || null;
}

/* ── 账号池（对齐 hub POOL.pick / pick_for_session，区域内轮询）── */
function buildPool(cfg) {
  const site = (cfg.sites || {}).workbuddy || {};
  return (Array.isArray(site.accounts) ? site.accounts : [])
    .map((a, idx) => ({ _idx: idx, ...a }))
    .filter((a) => a.enabled !== false && accountConfigured(a));
}
function pickAccount(accounts, realm, exclude) {
  const pool = accounts.filter((a) => accountRealm(a) === realm && !(exclude && exclude.has(a.id)));
  if (!pool.length) return null;
  const cursor = _rr.get(realm) || 0;
  const acc = pool[cursor % pool.length];
  _rr.set(realm, cursor + 1);
  return acc;
}
const _rr = new Map();

/* ── 令牌续期（对齐 sites.js WORKBUDDY._refresh；成功回写 store 会话）── */
async function refreshAccount(deps, acc) {
  const refresh = accountRefresh(acc);
  if (!refresh) throw new Error("缺少 refresh_token，无法续期");
  const realm = accountRealm(acc);
  const s = new Session();
  const h = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": REALMS[realm].chat_ua,
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    Authorization: "Bearer " + refresh,
    "X-Refresh-Token": refresh,
  };
  if (acc.enterprise_id) h["X-Enterprise-Id"] = String(acc.enterprise_id);
  const r = await s.postJson(REALMS[realm].chat_upstream + REFRESH_PATH, { refresh_token: refresh }, { headers: h, timeout: 15000, useProxy: !!acc.use_proxy });
  const j = parseJson(r && r.text);
  const data = ((j || {}).data) || {};
  if (!data.accessToken) throw new Error((j && (j.msg || `code=${j.code}`)) || `令牌刷新失败（HTTP ${r && r.status}）`);
  const sess = { access_token: data.accessToken, refresh_token: data.refreshToken || refresh };
  // 回写 store 持久化（saveConfig 按 {id, session, session_ts} 合并，其它字段保留）
  try {
    deps.store.saveConfig({ sites: { workbuddy: { accounts: [{ id: acc.id, session: sess, session_ts: Date.now() }] } } });
  } catch (e) { deps.log(`[wb] 令牌回写失败 ${e.message}`); }
  return sess;
}

/* ── 出站：流式 raw 通道（支持 HTTP 代理 CONNECT；非流式走 httpc Session）── */
function connectTunnel(proxyUrl, targetHost, targetPort, timeout) {
  return new Promise((resolve, reject) => {
    let p;
    try { p = new URL(proxyUrl); } catch { reject(new Error("代理地址无法解析")); return; }
    let socket;
    let settled = false;
    const fail = (err) => { if (settled) return; settled = true; if (socket) socket.destroy(); reject(err); };
    socket = net.connect(Number(p.port) || 8080, p.hostname, () => {
      const hostPort = `${targetHost}:${targetPort}`;
      let req = `CONNECT ${hostPort} HTTP/1.1\r\nHost: ${hostPort}\r\n`;
      if (p.username) {
        const auth = Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password || "")}`).toString("base64");
        req += `Proxy-Authorization: Basic ${auth}\r\n`;
      }
      req += "\r\n";
      socket.write(req);
    });
    socket.on("error", (e) => fail(new Error(`代理连接失败：${e.code || e.message}`)));
    socket.setTimeout(timeout, () => socket.destroy(new Error("代理连接超时")));
    let buf = "";
    socket.on("data", (c) => {
      if (settled) return;
      buf += c.toString("latin1");
      const idx = buf.indexOf("\r\n\r\n");
      if (idx < 0) return;
      settled = true;
      socket.setTimeout(0);
      if (/^HTTP\/1\.[01] 200/i.test(buf)) resolve(socket);
      else fail(new Error(`代理 CONNECT 被拒绝：${buf.split("\r\n")[0]}`));
    });
  });
}
function rawPostStream(url, bodyStr, headers, useProxy, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { reject(new Error("站点地址无效")); return; }
    const proxyUrl = proxyFromEnv(useProxy);
    const t = timeoutMs || 30000;
    const doReq = (socket) => {
      const mod = https;
      const reqOpts = {
        method: "POST", headers, timeout: t,
        protocol: u.protocol, hostname: u.hostname, port: u.port || 443,
        path: u.pathname + u.search,
      };
      if (socket) reqOpts.createConnection = () => socket;
      const req = mod.request(reqOpts, (res) => {
        if (socket) res.on("end", () => { try { socket.destroy(); } catch {} });
        resolve({ status: res.statusCode, headers: res.headers, res });
      });
      req.on("timeout", () => req.destroy(new Error("请求超时")));
      req.on("error", (e) => reject(new Error(`请求失败：${e.code || e.message}`)));
      req.end(bodyStr);
    };
    if (proxyUrl) {
      connectTunnel(proxyUrl, u.hostname, u.port || 443, t).then((tunnel) => {
        const tlsSock = tls.connect({ socket: tunnel, servername: u.hostname }, () => {
          tlsSock.setTimeout(0); doReq(tlsSock);
        });
        tlsSock.on("error", (e) => { try { tunnel.destroy(); } catch {} reject(new Error(`代理 TLS 失败：${e.code || e.message}`)); });
        tlsSock.setTimeout(t, () => tlsSock.destroy(new Error("代理 TLS 握手超时")));
      }).catch(reject);
    } else doReq(null);
  });
}

/* ── 上游转发：chat/completions 核心（非流式 + 流式中继）── */
async function forwardChat(deps, ctx, acc, realm, bodyUp, stream, apiPath) {
  const url = REALMS[realm].chat_upstream + CHAT_PATH;
  const hdrs = chatHeaders(acc, realm);
  if (stream) {
    const up = await rawPostStream(url, JSON.stringify(bodyUp), hdrs, !!acc.use_proxy, 40000);
    return { up, url };
  }
  const s = new Session();
  const r = await s.postJson(url, bodyUp, { headers: hdrs, timeout: 60000, useProxy: !!acc.use_proxy });
  return { up: { status: r.status, headers: r.headers, res: null, text: r.text }, r, url };
}

/* 请求入口统一封装：鉴权 → 区域 → 限额 → 选号 → 转发（上游 401 自动续期重试一次） */
async function dispatchGatewayRequest(deps, cfg, req, body, kind) {
  // 1. Key 鉴权
  const auth = String(req.headers["authorization"] || req.headers["x-api-key"] || "");
  const key = findKey(cfg, auth);
  if (!key) return { code: 401, data: openaiError("不合法或已停用的 API Key", "invalid_api_key") };
  // 2. 网关开关
  if (!(cfg.wb || {}).enabled) return { code: 403, data: openaiError("WorkBuddy 网关未启用", "access_forbidden") };
  // 3. 区域与模型
  const model = String((body && body.model) || "");
  const hdrRealm = String(req.headers["x-wb-realm"] || "").trim();
  const realm = (hdrRealm === "intl" || hdrRealm === "cn") ? hdrRealm
    : detectModelRealm(model, (((cfg.wb || {}).default_realm === "cn") ? "cn" : "intl"));
  if (key.realm && key.realm !== realm) {
    return { code: 403, data: openaiError(`Key 绑定区域 ${key.realm === "intl" ? "国际版" : "国内版"}，与请求区域 ${realm} 不符`, "invalid_request_error") };
  }
  if (!key.models || (Array.isArray(key.models) && key.models.length)) {
    if (!globAny(model, key.models)) {
      return { code: 400, data: openaiError(`Key 未授权使用模型 ${model || "(空)"}`, "insufficient_quota") };
    }
  }
  // 4. 限额（账号无关的全池护栏先查；账号级保留积分在选号后查）
  const pool = buildPool(cfg);
  const creditsCache = deps._creditsCache || (deps._creditsCache = makeCreditsCache());
  const g1 = guardBlocked(cfg, model, pool, null, creditsCache);
  if (g1.blocked) return { code: 429, data: openaiError(g1.reason, "rate_limit_exceeded") };
  // 5. 选号（区域池轮询；跳过护栏拦截的账号）
  let acc = null;
  const tried = new Set();
  for (let i = 0; i < Math.max(1, pool.length); i++) {
    const cand = pickAccount(pool, realm, tried);
    if (!cand) break;
    tried.add(cand.id);
    const g2 = guardBlocked(cfg, model, pool, cand, creditsCache);
    if (g2.blocked) continue;
    acc = cand; break;
  }
  if (!acc) return { code: 503, data: openaiError("无可用 WorkBuddy 账号（区域池为空或全部被护栏拦截）", "server_error") };
  // 6. 转发（上游 401 → 续期重试一次）
  const bodyUp = buildUpstreamBody(body);
  let resp = await forwardChat(deps, cfg, acc, realm, bodyUp, !!body.stream, kind === "responses" ? "/v1/responses" : kind === "messages" ? "/v1/messages" : "");
  if (resp.up && resp.up.status === 401 && !resp._refreshed) {
    try { await refreshAccount(deps, acc); } catch {}
    resp._refreshed = true;
    resp = await forwardChat(deps, cfg, acc, realm, bodyUp, !!body.stream);
  }
  return { acc, realm, model, key, bodyUp, resp };
}

/* ── OpenAI 错误信封 ── */
function openaiError(message, type, extra = {}) {
  return Object.assign({ error: { message: message || "error", type: type || "invalid_request_error", code: type }, _wb: true }, extra);
}
/* ── 积分估算（按模型目录倍率粗略折积分；仅展示，非上游计费）── */
function estimateCredits(model, tokenIn, tokenOut) {
  const meta = MODEL_CATALOG[model] || {};
  const txt = String(meta.c || "x0.0").replace(/[^\d.]/g, "") || "0";
  const rate = parseFloat(txt) || 0;
  return (tokenIn + tokenOut) / 1e6 * rate;
}

/* ── 记账（usage 流水 + 日护栏，落盘）── */
function recordRequest(deps, cfg, model, realm, key, acc, tokIn, tokOut, status, ms, credits) {
  try {
    const wb = cfg.wb || {};
    const usage = Array.isArray(wb.usage) ? wb.usage : [];
    usage.unshift({
      ts: Date.now(), model, realm, key_id: key ? key.id : "",
      key_name: key ? key.name : "", account: acc ? maskUid(acc.id) : "-",
      in_tokens: tokIn, out_tokens: tokOut, credits: Number(credits) || 0,
      status, ms: Math.round(ms),
    });
    if (usage.length > 300) usage.length = 300;
    wb.usage = usage;
    recordUsageWb(cfg, model, tokIn, tokOut, Number(credits) || 0, true);
    deps.store.saveConfig({ wb });
  } catch (e) { deps.log(`[wb] 记账失败 ${e.message}`); }
}
/* 从两种响应提取 token 计数（宽容：usage 缺省时按字符粗估） */
function tokensOf(chatBody) {
  const u = (chatBody && chatBody.usage) || {};
  let inT = Number(u.prompt_tokens);
  let outT = Number(u.completion_tokens);
  if (!Number.isFinite(inT)) inT = Number(u.input_tokens);
  if (!Number.isFinite(inT)) inT = 0;
  if (!Number.isFinite(outT)) outT = Number(u.output_tokens);
  if (!Number.isFinite(outT)) outT = 0;
  return [inT, outT];
}

/* ── 三协议响应翻译 ─────────────────────────────────────── */

/** chat completions 响应归一（补 id/object/model/usage 缺省字段，保持面板可读） */
function normalizeChatResponse(payload, model) {
  const p = payload || {};
  const [tin, tout] = tokensOf(p);
  return {
    id: p.id || `chatcmpl-${crypto.randomBytes(8).toString("hex")}`,
    object: "chat.completion",
    created: p.created || Math.floor(Date.now() / 1000),
    model: p.model || model,
    choices: Array.isArray(p.choices) ? p.choices : [],
    usage: p.usage || { prompt_tokens: tin, completion_tokens: tout, total_tokens: tin + tout },
    ...(p.system_fingerprint ? { system_fingerprint: p.system_fingerprint } : {}),
  };
}

/** /v1/responses ← chat completion（对齐 hub responses 翻译的核心输出形状） */
function chatToResponses(chatBody, reqId) {
  const [tin, tout] = tokensOf(chatBody);
  const choice = ((chatBody && chatBody.choices) || [{}])[0] || {};
  const msg = choice.message || {};
  const output = [];
  if (msg.content) output.push({ type: "message", id: `msg_${crypto.randomBytes(8).toString("hex")}`, status: "completed", role: "assistant", content: [{ type: "output_text", text: String(msg.content) }] });
  const toolCalls = msg.tool_calls || [];
  for (const tc of toolCalls) {
    output.push({ type: "function_call", id: tc.id || `fc_${crypto.randomBytes(8).toString("hex")}`, status: "completed", call_id: tc.id || "", name: (tc.function || {}).name || "", arguments: (tc.function || {}).arguments || "" });
  }
  return {
    id: reqId || `resp_${crypto.randomBytes(8).toString("hex")}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: chatBody.model,
    output,
    usage: { input_tokens: tin, output_tokens: tout, total_tokens: tin + tout, output_tokens_details: {} },
  };
}
/** responses 请求 → chat completions 请求 */
function responsesToChat(body) {
  const msgs = Array.isArray(body.input) ? body.input : [{ role: "user", content: String(body.input || "") }];
  const messages = msgs.map((m) => {
    if (typeof m === "string") return { role: "user", content: m };
    if (m.type === "message" || m.type === "input_text") return { role: m.role === "developer" ? "system" : (m.role || "user"), content: m.content || (m.text || "") };
    if (m.type === "function_call_output" || m.type === "function_call") {
      return { role: "tool", tool_call_id: m.call_id || "", content: m.output || "" };
    }
    return { role: "user", content: JSON.stringify(m) };
  });
  const out = {
    model: body.model,
    messages,
    stream: body.stream,
  };
  if (body.max_output_tokens) out.max_tokens = Number(body.max_output_tokens);
  if (body.temperature !== undefined && body.temperature !== null) out.temperature = body.temperature;
  if (body.instructions) messages.unshift({ role: "system", content: String(body.instructions) });
  return out;
}

/** /v1/messages（Anthropic）请求 → chat completions 请求 + 响应翻译 */
function messagesToChat(body) {
  const msgs = Array.isArray(body.messages) ? body.messages.slice() : [];
  const system = body.system;
  const messages = [];
  if (system) {
    const content = typeof system === "string" ? system : (Array.isArray(system) ? system.map((s) => (s && s.text) || "").join("\n") : "");
    if (content) messages.push({ role: "system", content });
  }
  for (const m of msgs) {
    const role = m.role === "assistant" ? "assistant" : "user";
    const content = Array.isArray(m.content)
      ? m.content.map((c) => (c && c.type === "text" ? c.text : "")).join("\n")
      : String(m.content || "");
    if (role === "assistant" && m.content) messages.push({ role, content });
    else messages.push({ role, content });
  }
  const out = {
    model: body.model,
    messages: messages.length ? messages : [{ role: "user", content: "Hi" }],
    stream: !!body.stream,
    max_tokens: Number(body.max_tokens) || 1024,
  };
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  return out;
}
function chatToMessages(chatBody) {
  const [tin, tout] = tokensOf(chatBody);
  const choice = ((chatBody && chatBody.choices) || [{}])[0] || {};
  const msg = choice.message || {};
  const stop = choice.finish_reason === "length" ? "max_tokens" : (choice.finish_reason === "tool_calls" ? "tool_use" : "end_turn");
  return {
    id: `msg_${crypto.randomBytes(8).toString("hex")}`,
    type: "message",
    role: "assistant",
    model: chatBody.model,
    content: [{ type: "text", text: String(msg.content || "") }],
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: tin, output_tokens: tout },
  };
}

/* ── API 网关实例 ───────────────────────────────────────── */
function create(deps) {
  deps._creditsCache = makeCreditsCache();
  const log = (m) => { try { deps.log(`[wb] ${m}`); } catch {} };
  const getCfg = () => deps.store.getConfig() || {};
  const ok = (data, message = "") => ({ success: true, message, data });

  /** /v1/* 入口（main.js 在 ROUTES 前拦截 pathname 以 /v1/ 开头时调用） */
  async function handleV1(req, res, pathname, method) {
    const sendJson = (status, obj) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache" });
      res.end(JSON.stringify(obj));
    };
    let body = {};
    if (method === "POST") {
      body = await readBodyJson(req, res);
      if (body === null) return; // 413 已响应
    }
    const t0 = Date.now();
    const cfg = getCfg();
    try {
      if (pathname === "/v1/models" && method === "GET") {
        const key = findKey(cfg, req.headers.authorization || req.headers["x-api-key"]);
        if (!key) return sendJson(401, openaiError("不合法或已停用的 API Key", "invalid_api_key"));
        const list = Object.entries(MODEL_CATALOG).filter(([, m]) => !key.realm || m.realm === key.realm).map(([id, m]) => ({
          id, object: "model", created: 1720000000, owned_by: "workbuddy",
          name: m.n, context_length: m.in, max_tokens: m.out,
          credits: m.c, realm: m.realm,
          capabilities: { vision: m.vision, tool_calls: m.tool, reasoning: m.think },
          supports_vision: m.vision, supports_tool_call: m.tool, supports_reasoning: m.think,
        }));
        return sendJson(200, { object: "list", data: list });
      }

      if (method !== "POST") return sendJson(405, openaiError("仅支持 POST", "invalid_request_error"));
      let kind = "chat";
      if (pathname === "/v1/chat/completions" || pathname === "/chat/completions") kind = "chat";
      else if (pathname === "/v1/responses" || pathname === "/responses") kind = "responses";
      else if (pathname === "/v1/messages" || pathname === "/messages") kind = "messages";
      else return sendJson(404, openaiError("路径不存在", "not_found"));

      const chatBody = kind === "responses" ? responsesToChat(body) : kind === "messages" ? messagesToChat(body) : body;
      if (!body.stream && kind === "messages" && body.max_tokens === undefined) chatBody.max_tokens = 1024;
      const wantStream = !!chatBody.stream;
      const disp = await dispatchGatewayRequest(deps, cfg, req, kind === "chat" ? body : { ...body, stream: wantStream, model: chatBody.model }, kind);
      if (disp.code) {
        recordRequest(deps, getCfg(), chatBody.model || "", disp.realm || "", disp.key || null, null, 0, 0, disp.code === 429 ? "rate_limit" : "auth_fail", Date.now() - t0, 0);
        return sendJson(disp.code, disp.data);
      }
      const { acc, realm, model, key, resp } = disp;
      const up = resp.up;
      if (up.status === 401) {
        recordRequest(deps, getCfg(), model, realm, key, acc, 0, 0, "upstream_401", Date.now() - t0, 0);
        return sendJson(502, openaiError("上游令牌失效且续期失败", "server_error"));
      }
      if (up.status >= 400) {
        const detail = up.text !== undefined ? up.text : "";
        let parsed = parseJson(detail);
        let msg = "";
        if (parsed && parsed.message) msg = parsed.message;
        else if (parsed && parsed.error) msg = (typeof parsed.error === "string" ? parsed.error : (parsed.error.message || JSON.stringify(parsed.error)));
        else msg = detail.slice(0, 300) || `上游 HTTP ${up.status}`;
        if (up.status === 429) {
          recordRequest(deps, getCfg(), model, realm, key, acc, 0, 0, "upstream_429", Date.now() - t0, 0);
          return sendJson(429, openaiError(msg.slice(0, 200), "rate_limit_exceeded"));
        }
        recordRequest(deps, getCfg(), model, realm, key, acc, 0, 0, `upstream_${up.status}`, Date.now() - t0, 0);
        return sendJson(Math.max(400, up.status), openaiError(msg.slice(0, 200), "invalid_request_error"));
      }

      if (!wantStream) {
        let chat = parseJson(up.text || "");
        if (!chat) chat = {}; // 空响应兜底为合法空目录
        const normalized = normalizeChatResponse(chat, model);
        const [tin, tout] = tokensOf(chat);
        const credits = estimateCredits(model, tin, tout);
        recordRequest(deps, getCfg(), model, realm, key, acc, tin, tout, "ok", Date.now() - t0, credits);
        let out;
        if (kind === "responses") out = chatToResponses(chat, body.id);
        else if (kind === "messages") out = chatToMessages(chat);
        else out = normalized;
        return sendJson(200, out);
      }

      // 流式：SSE 中继（chat 透传 + 补 usage/[DONE]；responses/messages 事件平移）
      const [tin0, tout0] = [0, 0];
      recordRequest(deps, getCfg(), model, realm, key, acc, tin0, tout0, "stream_start", Date.now() - t0, 0);
      await relaySse(res, up, kind, model);
      recordRequest(deps, getCfg(), model, realm, key, acc, 0, 0, "stream_done", Date.now() - t0, 0);
      return undefined;
    } catch (e) {
      log(`网关异常 ${(e && e.message) || e}`);
      return sendJson(502, openaiError((e && e.message) || "网关异常", "server_error"));
    }
  }

  /** SSE 中继：按 api 语义逐块解析并转发；流式翻译与 token 采集 */
  function relaySse(res, up, kind, model) {
    return new Promise((resolve) => {
      let usageSeen = false;
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "close", "X-Accel-Buffering": "no" });
      const send = (dataObj) => res.write(`event: ${dataObj._ev || "message"}\ndata: ${JSON.stringify(dataObj)}\n\n`);
      const stream = up.res;
      stream.setEncoding("utf8");
      let buf = "";
      let accText = "";
      let doneSent = false;
      stream.on("data", (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, "");
          buf = buf.slice(nl + 1);
          if (!line) continue;
          if (line.startsWith("event:") || line.startsWith(":")) { res.write(line + "\n"); continue; }
          if (!line.startsWith("data:")) continue;
          const dataStr = line.slice(5).trim();
          res.write("data: " + dataStr + "\n\n");
          if (dataStr === "[DONE]") { doneSent = true; continue; }
          const j = parseJson(dataStr);
          if (!j) continue;
          if (j.usage) usageSeen = true;
          const delta = (j.choices && j.choices[0] && j.choices[0].delta) || {};
          if (delta.content) accText += delta.content;
          if (delta.reasoning_content) accText += delta.reasoning_content;
        }
      });
      stream.on("end", () => {
        if (buf.trim()) res.write("data: " + buf.trim() + "\n\n");
        if (!doneSent) {
          if (kind === "chat") {
            res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } })}\n\n`);
          }
          res.write("data: [DONE]\n\n");
        }
        try { res.end(); } catch { /* ignore */ }
        resolve();
      });
      stream.on("error", () => {
        try { res.end(); } catch { /* ignore */ }
        resolve();
      });
      // 客户端断开：终止上游流
      res.on("close", () => { try { stream.destroy(); } catch { /* ignore */ } });
    });
  }

  /* —— 管理端 /api/wb/* —— */
  function status() {
    const cfg = getCfg();
    const wb = cfg.wb || {};
    const day = dayCounters(cfg);
    const pool = buildPool(cfg);
    const byRealm = { intl: { total: 0, ready: 0 }, cn: { total: 0, ready: 0 } };
    for (const a of pool) {
      const r = accountRealm(a);
      if (!byRealm[r]) byRealm[r] = { total: 0, ready: 0 };
      byRealm[r].total += 1;
      byRealm[r].ready += 1;
    }
    const keys = normalizeKeys(wb.keys || []);
    return ok({
      enabled: !!wb.enabled,
      default_realm: wb.default_realm || "intl",
      accounts: byRealm,
      account_list: accountList(deps, cfg),
      keys: { total: keys.length, active: keys.filter((k) => k.enabled).length },
      day: { date: day.date, requests: day.requests, token_in: day.token_in, token_out: day.token_out, credits: Number(day.credits).toFixed(2), model_tokens: day.model_tokens },
      limits: wb.limits || {},
      usage_count: Array.isArray(wb.usage) ? wb.usage.length : 0,
      models_count: Object.keys(MODEL_CATALOG).length,
    });
  }
  function getConfig() {
    const cfg = getCfg();
    const wb = cfg.wb || {};
    return ok({
      enabled: !!wb.enabled,
      default_realm: wb.default_realm || "intl",
      account_list: accountList(deps, cfg),
      limits: {
        enabled: !!(wb.limits || {}).enabled,
        reserve_credits: Number((wb.limits || {}).reserve_credits) || 0,
        daily_token_limit: Number((wb.limits || {}).daily_token_limit) || 0,
        daily_credit_limit: Number((wb.limits || {}).daily_credit_limit) || 0,
        model_daily_token_limit: Number((wb.limits || {}).model_daily_token_limit) || 0,
      },
      keys: normalizeKeys(wb.keys || []).map((k) => ({ id: k.id, name: k.name, realm: k.realm, models: k.models, enabled: k.enabled, created_at: k.created_at, deleted_at: k.deleted_at, key_masked: k.deleted_at ? "" : maskKey(k.key) })),
    });
  }
  function saveConfig(body) {
    const cfg = getCfg();
    const wb = cfg.wb || {};
    const p = body || {};
    if (p.enabled !== undefined) wb.enabled = !!p.enabled;
    if (p.default_realm === "intl" || p.default_realm === "cn") wb.default_realm = p.default_realm;
    if (p.limits && typeof p.limits === "object") {
      const lim = wb.limits || {};
      if (p.limits.enabled !== undefined) lim.enabled = !!p.limits.enabled;
      for (const k of ["reserve_credits", "daily_token_limit", "daily_credit_limit", "model_daily_token_limit"]) {
        if (p.limits[k] !== undefined) {
          const v = Number(p.limits[k]);
          lim[k] = Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
        }
      }
      wb.limits = lim;
    }
    deps.store.saveConfig({ wb });
    log(`配置已保存（启用=${!!wb.enabled} 区域=${wb.default_realm}）`);
    return getConfig();
  }
  function keysManage(body) {
    const cfg = getCfg();
    const wb = cfg.wb || {};
    const keys = normalizeKeys(wb.keys || []);
    const action = String((body || {}).action || "");
    const id = String((body || {}).id || "");
    let createdPlain = ""; // create 时暂存新 Key 明文（仅本次回吐，落盘后不再读明文）
    if (action === "create") {
      const provided = String((body || {}).key || "").trim();
      const entry = {
        id: crypto.randomBytes(6).toString("hex"),
        name: String((body || {}).name || "").trim() || "新 Key",
        key: provided || genKey(),
        realm: (String((body || {}).realm || "").trim() === "cn") ? "cn" : (String((body || {}).realm || "").trim() === "intl" ? "intl" : ""),
        models: Array.isArray((body || {}).models) ? (body || {}).models.map((m) => String(m).trim()).filter(Boolean) : [],
        enabled: true,
        created_at: new Date().toISOString(),
        deleted_at: "",
      };
      createdPlain = entry.key;
      keys.unshift(entry);
    } else if (action === "toggle" || action === "delete" || action === "update") {
      const idx = keys.findIndex((k) => k.id === id);
      if (idx < 0) return { success: false, message: "Key 不存在" };
      if (action === "delete") {
        keys[idx].deleted_at = new Date().toISOString();
        keys[idx].key = "";
        keys[idx].enabled = false;
      } else if (action === "toggle") {
        keys[idx].enabled = !keys[idx].enabled;
      } else {
        if ((body || {}).name !== undefined) keys[idx].name = String((body || {}).name || "").trim() || keys[idx].name;
        if ((body || {}).realm === "intl" || (body || {}).realm === "cn") keys[idx].realm = (body || {}).realm;
        if (Array.isArray((body || {}).models)) keys[idx].models = (body || {}).models.map((m) => String(m).trim()).filter(Boolean);
      }
    } else {
      return { success: false, message: "未知操作（create/toggle/update/delete）" };
    }
    wb.keys = keys;
    deps.store.saveConfig({ wb });
    log(`Key 管理：${action} ${id || "(新建)"}`);
    const cfgOut = getConfig();
    if (action === "create" && createdPlain) cfgOut.data.key_created_plain = createdPlain; // 明文仅此一次回吐
    return cfgOut;
  }
  function usage() {
    const cfg = getCfg();
    return ok({
      day: dayCounters(cfg),
      rows: Array.isArray((cfg.wb || {}).usage) ? (cfg.wb || {}).usage : [],
    });
  }
  /** 连通性测试：用当前账号池发最小 chat 请求验证（真实上游；仅测试用） */
  async function test(body) {
    const model = String((body || {}).model || "deepseek-v4.1-flash");
    const cfg = getCfg();
    const fakeReq = { headers: { authorization: "Bearer __wb_internal__" } };
    // 内部测试绕过 Key 鉴权：直接走账号池 + 转发
    if (!(cfg.wb || {}).enabled) return { success: false, message: "网关未启用，请先在网关配置开启" };
    const realm = detectModelRealm(model, ((cfg.wb || {}).default_realm === "cn") ? "cn" : "intl");
    const pool = buildPool(cfg).filter((a) => accountRealm(a) === realm);
    if (!pool.length) return { success: false, message: `区域 ${realm === "intl" ? "国际版" : "国内版"} 无可用账号` };
    const acc = pool[0];
    const bodyUp = buildUpstreamBody({ model, messages: [{ role: "user", content: "ping" }], max_tokens: 8, stream: false });
    try {
      const r = await forwardChat(deps, cfg, acc, realm, bodyUp, false);
      log(`连通性测试 ${model} → ${r.up && r.up.status}`);
      if (r.up.status >= 400) return { success: false, message: `上游 HTTP ${r.up.status}：${String(r.up.text || "").slice(0, 200)}` };
      return { success: true, message: `区域 ${realm} 账号正常，上游 ${r.up.status}` };
    } catch (e) {
      return { success: false, message: (e && e.message) || "转发失败" };
    }
  }

  return { handleV1, status, getConfig, saveConfig, keysManage, usage, test };
}

/** POST body 读取（1MB 上限，413 信封，与 main.js readBody 同口径） */
function readBodyJson(req, res) {
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
          res.end(JSON.stringify({ error: { message: "请求体过大（上限 1MB）", type: "invalid_request_error" } }));
        }
      } catch { /* ignore */ }
      res && res.once ? res.once("finish", () => { try { req.destroy(); } catch {} }) : req.destroy();
      resolve(null);
    };
    req.on("data", (c) => {
      size += c.length;
      if (size > 1024 * 1024) { rejectTooBig(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (over) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch { resolve({}); }
    });
    req.on("error", () => { if (!over) resolve({}); });
  });
}

module.exports = {
  create,
  detectModelRealm,
  findKey,
  normalizeKeys,
  genKey,
  buildUpstreamBody,
  responsesToChat,
  messagesToChat,
  chatToResponses,
  chatToMessages,
  MODEL_CATALOG,
  _private: { dayCounters, recordUsageWb, guardBlocked, pickAccount, buildPool, accountRealm },
};