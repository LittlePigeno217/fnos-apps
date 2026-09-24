"use strict";
/**
 * checkin — 三个站点签到适配器（移植自 MoviePilot-Plugins/plugins/checkin v1.7.0）。
 * 每个 adapter 实现：isConfigured / runCheckin / testConnection / getAccountLabel
 * 统一返回/抛出：成功 {site, site_name, status, message, reward, total, account, time}
 * 失败抛 Error（原因供通知/历史展示）。
 */
const crypto = require("crypto");
const { Session, parseJson, cleanText, extractFormhash } = require("./httpc");

/* ── 通用识别 ─────────────────────────────────────────────── */

/** TOTP（RFC 6238，对齐 all-api-hub：SHA1 / 6 位 / 30 秒 / Base32 密钥）——NewAPI 2FA 登录 */
function genTOTP(secret) {
  const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = String(secret || "").toUpperCase().replace(/[\s\-]/g, "").replace(/=+$/g, "");
  let bits = "";
  for (const ch of clean) {
    const v = B32.indexOf(ch);
    if (v < 0) continue;
    bits += v.toString(2).padStart(5, "0");
  }
  const key = Buffer.alloc(Math.floor(bits.length / 8));
  for (let i = 0; i < key.length; i++) key[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  const msg = Buffer.alloc(8);
  let c = Math.floor(Date.now() / 1000 / 30);
  for (let i = 7; i >= 0; i--) { msg[i] = c & 0xff; c = Math.floor(c / 256); }
  const h = crypto.createHmac("sha1", key).update(msg).digest();
  const o = h[h.length - 1] & 0xf;
  const code = ((h[o] & 0x7f) * 0x1000000 + (h[o + 1] & 0xff) * 0x10000 + (h[o + 2] & 0xff) * 0x100 + (h[o + 3] & 0xff)) % 1000000;
  return String(code).padStart(6, "0");
}

function isAlreadyCheckedIn(message) {
  const text = String(message || "").trim().toLowerCase();
  return (
    ["already checked in", "已签到", "今日已签", "今天已签", "今天已经签到", "已经签到", "今天已经签过", "今天已经签过到", "签过到", "明儿再来"].some((k) => text.includes(k))
  );
}

function maskEmail(email) {
  if (!email || !email.includes("@")) return email || "-";
  const [name, domain] = email.split("@", 2);
  const masked = name.length <= 2 ? "*".repeat(name.length) : name[0] + "*".repeat(Math.max(name.length - 2, 1)) + name[name.length - 1];
  return `${masked}@${domain}`;
}

/** 敏感字段脱敏（cookie/token/password 等，仅用于编辑页回显；服务端计算，绝不回吐明文）：
 *  长度>8 → 前4+"***"+后4；长度≤8 → 前2+"***"+后2（短值也不泄露）；空值 → ""。 */
function maskSecret(v) {
  const s = String(v == null ? "" : v);
  if (!s) return "";
  if (s.length > 8) return s.slice(0, 4) + "***" + s.slice(-4);
  if (s.length > 4) return s.slice(0, 2) + "***" + s.slice(-2);
  return "***"; // 极短值（≤4）连头尾都不给，仅示意「已配置」
}

function fmtTraffic(v) {
  const n = Number(v || 0);
  if (!n) return "0";
  if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(2) + " KB";
  return n + " B";
}

function now() {
  return new Date().toLocaleString("zh-CN", { hour12: false });
}

/* ── 会话（loginFlow 产物）通用工具 ───────────────────────────
 * session 是登录产物（token 或 cookie），存于账号 { session, session_ts }。
 * runCheckin/testConnection 会话优先：有效 session → 直接构造认证，跳过重新登录；
 * 无 session 或已过期 → 走原明文字段登录逻辑（行为不变）。 */
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 天（无 session_ts 或超期视为过期）

/** 账号 session 是否有效：存在对象、有 session_ts、且未超过 30 天 */
function sessionValid(cfg) {
  const sess = cfg && cfg.session;
  if (!sess || typeof sess !== "object") return false;
  const ts = Number(cfg.session_ts || 0);
  if (!ts) return false;
  return Date.now() - ts < SESSION_MAX_AGE_MS;
}

/** 从 Cookie 串构造一个已带该 Cookie 的 Session（复用其 cookie jar） */
function sessionFromCookie(cookieStr) {
  const s = new Session();
  for (const pair of String(cookieStr || "").split(";")) {
    const idx = pair.indexOf("=");
    if (idx < 0) continue;
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (name) s.cookies[name] = value;
  }
  return s;
}

/** 从对象里按候选键顺序取第一个非空字符串（上游字段大小写/命名不稳定时的宽容取值） */
function firstStr(obj, keys) {
  if (!obj || typeof obj !== "object") return "";
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

/* ── NewAPI 家族共享（anyrouter / newapi 两个站点适配器共用）────────
 * anyrouter.top / AgentRouter 与通用 NewAPI/OneAPI/Sub2API 共用同一批协议工具：
 * 请求头构造、WAF / 登录失效识别、签到成功判定、$ 余额换算、/api/user/self 查询。
 * 单一事实源：两个 adapter 只引用这些纯函数/常量，不各自复制实现。 */
const NEWAPI_WAF_MARKERS = ["acw_sc__v2", "var arg1=", "cdn_sec_tc", "acw_tc"];

/** NewAPI 统一登录能力（GitHub/LinuxDO OAuth + 账号密码 + Cookie）——anyrouter 与 newapi 共用（单一事实源） */
const NEWAPI_LOGIN_CAPS = ["oauth_github", "oauth_linuxdo", "password", "password_cookie", "cookie"];

/** 认证对象（{type:"token",token}|{type:"cookie",headers}）→ 请求头 */
function newApiHeaders(auth, extra) {
  const h = { Accept: "application/json, text/plain, */*", ...(extra || {}) };
  if (auth.type === "token") h.Authorization = "Bearer " + auth.token;
  else Object.assign(h, auth.headers);
  return h;
}

/** 阿里云盾 WAF JS 挑战页识别（缺 WAF cookie 时被拦，anyrouter.top/agentrouter 常见） */
function isWafChallenge(text) {
  const t = String(text || "").toLowerCase();
  return NEWAPI_WAF_MARKERS.some((m) => t.includes(m.toLowerCase()));
}

/** 登录态失效判定：HTTP 401 或 body 含会话/token 过期文案（含中文变体） */
function isLoginExpired(status, text) {
  if (Number(status) === 401) return true;
  const t = String(text || "").toLowerCase();
  return /session.*(invalid|expired)|token.*(invalid|expired)|未登录|登录已过期|invalid session|会话已过期|登录态失效|登录状态已失效|登录会话已过期|身份已过期/i.test(t);
}

/** base_url 归一：去尾斜杠；缺省回落 fallback（anyrouter 用自有默认，newapi 不回落） */
function napiBase(cfg, fallback) {
  return String((cfg && cfg.base_url) || fallback || "").trim().replace(/\/+$/, "");
}

/** 从 base_url 提取纯 host（去协议/路径，小写），用于平台/签到模式判定 */
function napiHost(cfg, fallback) {
  const base = napiBase(cfg, fallback);
  const m = base.match(/^https?:\/\/([^/]+)/i);
  return (m ? m[1] : base).toLowerCase();
}

/** 签到成功判定：NewAPI sign_in/checkin 响应 ret/code/success 任一成立（对齐 anyrouter-check-in execute_check_in） */
function napiSignInSuccess(j) {
  return !!(j && (j.ret === 1 || j.code === 0 || j.success === true));
}

/** NewAPI quota：500000 点 = $1（美元） */
function napiUsd(quota) {
  return "$" + (Number(quota || 0) / 500000).toFixed(2);
}

/** GET {base}/api/user/self → {quota, used_quota}；401 抛明确失效文案；WAF 拦截抛人机验证指引；其余解析失败 → null */
async function fetchUserInfo(base, auth, useProxy) {
  const s = new Session();
  const r = await s.get(base + "/api/user/self", { headers: newApiHeaders(auth), timeout: 15000, useProxy });
  if (r.status === 401) throw new Error("登录态失效（HTTP 401）：Cookie 过期或 Token 无效，请重新获取（session 约 1 个月有效）");
  if (isWafChallenge(r.text)) {
    throw new Error(`平台 WAF 人机验证拦截了用户信息接口：Cookie 缺少 acw_sc__v2 等验证标识，请在浏览器访问 ${base} 通过验证后复制完整 Cookie`);
  }
  const j = parseJson(r.text);
  if (!j || !j.success || !(j.data || {}).quota) return null;
  return { quota: Number(j.data.quota) || 0, used_quota: Number(j.data.used_quota) || 0 };
}

/** Cookie + api_user → 认证对象（带 new-api-user 请求头） */
function cookieAuth(cfg, base) {
  const h = { Cookie: String(cfg.cookie).trim() };
  if (cfg.api_user) h["new-api-user"] = String(cfg.api_user).trim();
  return { type: "cookie", headers: h, base };
}

/** 签到前后余额对比 → 本次签到奖励 $ 文案；无法对比 → 空串。
 *  对齐 anyrouter-check-in：总分配 = 余额 + 累计消耗；奖励 = 签到后总分配 - 签到前总分配（期间消耗已抵扣）。 */
function napiRewardMsg(before, after) {
  if (!(before && after)) return "";
  const totalBefore = before.quota + before.used_quota;
  const totalAfter = after.quota + after.used_quota;
  const reward = Number((totalAfter - totalBefore).toFixed(6));
  if (reward <= 0) return "";
  return `本次签到 +${napiUsd(reward)}`;
}

/** 用户信息 → 余额展示文案（$，含累计消耗） */
function napiBalanceMsg(info) {
  if (!info) return "";
  const s = `余额 ${napiUsd(info.quota)}`;
  return info.used_quota ? `${s}，累计消耗 ${napiUsd(info.used_quota)}` : s;
}

/* ── FLZT ─────────────────────────────────────────────────── */
const FLZT = {
  key: "flzt",
  name: "FLZT",
  short: "FL",
  mode: "账号密码",
  // login_caps：登录能力声明（前端「添加账号」窗口据此动态渲染 tab；优先序 qr > password > cookie）
  // password：账号密码直登；password_cookie：登录后自动产出会话（token/cookie）并落库，无需手填
  login_caps: ["password", "password_cookie"],
  desc: "flzt.club · 账号密码登录后调用签到 API",
  fields: [
    { key: "email", label: "账号 / 邮箱", type: "text", ph: "name@example.com" },
    { key: "password", label: "密码", type: "password", ph: "输入新密码（留空不改）" },
  ],
  base: "https://flzt.club",
  loginPath: "/api/v1/passport/auth/login",
  checkinPath: "/api/v1/user/checkIn",
  // 英雄大数字（当前持有量）：只读查询「可转换流量」（签到累计所得、可转换的流量，见 _queryHold），
  // 语义与标签「可转换流量」一致；查询不可用时回落签到响应里的 total_checkin_traffic（累计签到流量）。
  holdLabel: "可转换流量",
  fmtHold(v) { return fmtTraffic(v); },

  defaultConfig() {
    return { enabled: false, use_proxy: false, email: "", password: "" };
  },
  isConfigured(cfg) {
    return !!(cfg && cfg.email && cfg.password);
  },
  getAccountLabel(cfg) {
    return maskEmail(cfg && cfg.email);
  },

  async _login(cfg) {
    const s = new Session();
    const r = await s.postJson(this.base + this.loginPath, { email: cfg.email, password: cfg.password }, { timeout: 15000, useProxy: cfg.use_proxy });
    const j = parseJson(r.text);
    if (!j || j.status !== "success" || !(j.data || {}).auth_data) {
      throw new Error((j && j.message) || `FLZT 登录失败（HTTP ${r.status}）`);
    }
    return { s, token: j.data.auth_data };
  },

  /** 会话优先取 token：有效 session（type=token）直接用；否则登录 */
  async _resolveToken(cfg) {
    if (sessionValid(cfg) && cfg.session.type === "token" && cfg.session.token) {
      return cfg.session.token;
    }
    const { token } = await this._login(cfg);
    return token;
  },

  /**
   * 只读查询「可转换流量」（hero 大数字源，绝不触发签到/写操作）。
   * FLZT 为 V2Board/Xboard 面板，GET /api/v1/user/info 返回 checkin_reward_traffic
   *（累计签到所得、可转换的流量，单位 bytes）——即前端「可转换流量：N GB」的数据源
   *（真机只读探测校准：checkin_reward_traffic=190684557803 ≈ 177.59 GB，与页面一致）。
   * 注意：不再用 getSubscribe 的 transfer_enable-(u+d)（那是套餐剩余总量，会算出上万 GB 的错值）。
   * 字段缺失/非有限值 → 返回 null（hero 显示「—」）。纯 GET 只读，异常一律吞掉，
   * 绝不影响测试连接 / 签到结果；响应内含 token 的字段（如订阅 URL）从不输出。
   */
  async _queryHold(cfg, token) {
    try {
      const s = new Session();
      const r = await s.get(this.base + "/api/v1/user/info", {
        headers: { authorization: token, Accept: "application/json, text/plain, */*" },
        timeout: 15000, useProxy: cfg.use_proxy,
      });
      const j = parseJson(r.text);
      const d = j && j.data ? j.data : null;
      if (!d) return null;
      const convertible = Number(d.checkin_reward_traffic); // 可转换流量（bytes），与 fmtHold=fmtTraffic 口径一致
      return Number.isFinite(convertible) ? Math.max(0, convertible) : null;
    } catch { return null; }
  },

  loginFlow: {
    mode: "form",
    desc: "账号密码自动登录产出会话（authorization token）",
    async init(cfg) {
      const { token } = await FLZT._login(cfg);
      return {
        mode: "form",
        status: "ready",
        session: { type: "token", token },
        account_label: FLZT.getAccountLabel(cfg),
        message: "登录成功",
      };
    },
  },

  async runCheckin(cfg) {
    const token = await this._resolveToken(cfg);
    const s = new Session();
    const r = await s.get(this.base + this.checkinPath, {
      headers: { authorization: token, Accept: "application/json, text/plain, */*" },
      timeout: 15000, useProxy: cfg.use_proxy,
    });
    const j = parseJson(r.text);
    if (!j || !["success", "fail"].includes(j.status)) {
      throw new Error((j && j.message) || "FLZT 签到返回异常");
    }
    const message = j.message || "";
    const data = j.data || {};
    const reward = String(data.reward_mb || data.reward || "0");
    // 当天奖励累计源（server 侧按 status==="签到成功" 累计）：本次签到获得的流量，单位 MB
    const rewardVal = Number(data.reward_mb || data.reward || 0);
    const total = fmtTraffic(data.total_checkin_traffic);
    // 当前持有量（hero 大数字源）：优先只读查询「可转换流量」（与 testConnection 同源，语义匹配「可转换流量」）；
    // 查询失败/字段缺失时回落累计签到流量 total_checkin_traffic（保证首签后 hero 始终有值，绝不回退到「—」）。
    const liveHold = await this._queryHold(cfg, token);
    const fallbackHold = Number.isFinite(Number(data.total_checkin_traffic)) ? Number(data.total_checkin_traffic) : null;
    const holdVal = (liveHold != null) ? liveHold : fallbackHold;

    if (j.status === "success") {
      return this._ok("签到成功", message || "签到成功", reward, total, cfg, rewardVal, "MB", holdVal);
    }
    if (isAlreadyCheckedIn(message)) {
      return this._ok("今日已签到", message, reward, total, cfg, rewardVal, "MB", holdVal);
    }
    throw new Error(message || "签到失败");
  },

  async testConnection(cfg) {
    const token = await this._resolveToken(cfg); // 仅验证凭据可换取有效 token；不再回显 token 前缀（B11）
    const hold = await this._queryHold(cfg, token); // 只读查询可转换流量供 hero 快照（失败/无字段 → null → 「—」）
    return { site: this.key, site_name: this.name, message: "登录测试成功，凭据有效（token 鉴权已确认）", hold_value: hold };
  },

  // reward_value/reward_unit：结构化当天奖励（数值+单位），server 侧当天累计用；不影响 history/points（仍读 reward 字符串）
  // hold_value：当前持有量原始值（total_checkin_traffic），server 侧快照进 acc.hold 供 hero 大数字展示
  _ok(status, message, reward, total, cfg, rewardVal, rewardUnit, holdVal) {
    return { site: this.key, site_name: this.name, status, message, reward, total, account: this.getAccountLabel(cfg), time: now(), reward_value: Number(rewardVal) || 0, reward_unit: rewardUnit || "", hold_value: (holdVal == null ? null : Number(holdVal)) };
  },
};

/* ── 恩山无线论坛 ─────────────────────────────────────────── */
const RIGHT_FORUM = {
  key: "right_forum",
  name: "恩山无线论坛",
  short: "恩",
  mode: "账号密码 / Cookie",
  // Discuz! 账号密码登录后自动产出 Cookie 落库（password_cookie），WAF/验证码时回落手动 Cookie
  login_caps: ["password_cookie", "cookie"],
  desc: "right.com.cn · 账号密码自动获取 Cookie 或手填 Cookie（formhash + 人机验证识别）",
  fields: [
    { key: "username", label: "账号 / 用户名", type: "text", ph: "恩山论坛用户名或邮箱" },
    { key: "password", label: "密码", type: "password", ph: "输入密码（留空不改）" },
    { key: "cookie", label: "Cookie", type: "password", ph: "或直接粘贴浏览器 Cookie（留空不改）" },
  ],
  base: "https://www.right.com.cn/forum",
  signPages: ["/plugin.php?id=erling_qd:sign_in", "/erling_qd-sign_in.html"],
  signAction: "/plugin.php?id=erling_qd:action&action=sign",
  forumPage: "/forum.php",
  // Discuz! 登录：GET 登录页取 formhash + loginhash → POST 提交表单（inajax）→ Set-Cookie 出 xxx_auth
  loginPage: "/member.php?mod=logging&action=login",
  loginSubmit: "/member.php?mod=logging&action=login&loginsubmit=yes&handlekey=login&inajax=1",
  CHALLENGE_MARKERS: ["_waf_is_mobile", "CF_APP_WAF", '"sceneId"', 'id="renderData"'],
  // 真实验证码/安全验证标记（questionid 安全提问下拉框为 Discuz 常规字段，不计入）
  CAPTCHA_MARKERS: ["seccodeverify", "misc.php?mod=seccode", "请输入验证码", "需要验证码", "验证码不正确"],
  // 英雄大数字标签：hero 显示恩山「当前积分」（用户菜单顶栏 id="extcreditmenu" 的「积分: N」，
  // 即当前持有总积分，非签到当日收益 credit）。只读 GET 页面抓取，见 _queryHold/_extractHold。
  holdLabel: "积分",

  defaultConfig() {
    return { enabled: false, use_proxy: false, username: "", password: "", cookie: "" };
  },
  isConfigured(cfg) {
    if (!cfg) return false;
    if (cfg.cookie && String(cfg.cookie).trim()) return true;
    return !!(cfg.username && cfg.password);
  },
  getAccountLabel(cfg) {
    const u = cfg && cfg.username && String(cfg.username).trim();
    return u ? maskEmail(u) : "Cookie";
  },

  _headers(cookie, referer, ajax) {
    const h = { Cookie: cookie, Referer: `${this.base}${referer}` };
    if (ajax) {
      h["X-Requested-With"] = "XMLHttpRequest";
      h.Accept = "application/json, text/javascript, */*; q=0.01";
      h["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
    }
    return h;
  },

  _isChallenge(text) {
    return this.CHALLENGE_MARKERS.some((m) => String(text || "").includes(m));
  },

  _ensureUsable(text) {
    if (this._isChallenge(text)) {
      throw new Error("站点的人机验证挡住了这次请求，过一会儿再试，或在浏览器里过一次验证后更新 Cookie");
    }
    if (text.includes("请先登录") || text.includes("您需要登录后才能使用签到功能") || (text.includes("立即登录") && text.includes("签到功能"))) {
      throw new Error("Cookie 已失效，去设置里重新粘一份");
    }
    if (text.includes("安全验证") || text.includes("滑块")) {
      throw new Error("站点要求安全验证，在浏览器里过一次再更新 Cookie");
    }
    if (text.includes("不存在或存在语法错误")) {
      throw new Error("站点的签到插件当前不可用，等站点修好再试");
    }
  },

  async _fetchSignPage(cookie, useProxy) {
    let lastErr = null;
    for (const path of this.signPages) {
      try {
        const s = new Session();
        const r = await s.get(this.base + path, { headers: this._headers(cookie, this.forumPage), timeout: 15000, useProxy: useProxy });
        const text = r.text;
        this._ensureUsable(text);
        const formhash = extractFormhash(text);
        if (formhash) return { formhash, text, path };
        lastErr = new Error("签到页里没有 formhash");
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error("签到页打不开");
  },

  _extractStats(text) {
    const cleaned = cleanText(text);
    const parts = [];
    let m = cleaned.match(/今日积分[:：]\s*(\d+)/);
    if (m) parts.push(`今日积分：${m[1]}`);
    m = cleaned.match(/连续签到[:：]\s*(\d+)\s*天/);
    if (m) parts.push(`连续签到：${m[1]} 天`);
    m = cleaned.match(/总签到天数[:：]\s*(\d+)\s*天/);
    if (m) parts.push(`总签到天数：${m[1]} 天`);
    return parts.join("；");
  },

  _hasCaptcha(text) {
    return this.CAPTCHA_MARKERS.some((m) => String(text || "").includes(m));
  },

  /**
   * 从 Discuz 页面 HTML 提取「当前总积分」（hero 大数字源）。
   * 真机只读探测确认：登录后 forum.php 顶栏用户菜单含
   *   <a ... id="extcreditmenu" ...>积分: 274</a>（即当前持有总积分）。
   * 优先精确锚定 extcreditmenu；回落到清洗文本里的「积分: N」（排除「今日积分」当日收益）。
   * 取不到 → null（hero 维持「—」，绝不误报）。
   */
  _extractHold(html) {
    const raw = String(html || "");
    // 主锚点：用户菜单 extcreditmenu 链接文本「积分: N」（最稳定，仅登录态出现）
    let m = raw.match(/id=["']extcreditmenu["'][\s\S]{0,80}?积分[:：]?\s*(\d[\d,]*)/);
    if (!m) {
      // 回落：清洗后文本里的「积分: N」，用负向前瞻排除「今日积分」（当日收益，非持有量）
      m = cleanText(raw).match(/(?<!今日)积分[:：]\s*(\d[\d,]*)/);
    }
    if (!m) return null;
    const n = Number(String(m[1]).replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  },

  /**
   * 只读查询当前总积分（hero 大数字源，绝不触发签到/写操作）。
   * 纯 GET forum.php 顶栏用户菜单抓「积分: N」（登录态即含，无需 uid、单次请求最省）。
   * Cookie 失效/被拦截/未登录 → 返回 null（hero 显示「—」）。异常一律吞掉，绝不影响测试/签到；
   * Cookie 敏感值绝不输出。
   */
  async _queryHold(cfg, cookie) {
    try {
      const ck = (cookie || "").trim();
      if (!ck) return null;
      const s = new Session();
      const r = await s.get(this.base + this.forumPage, { headers: this._headers(ck, this.forumPage), timeout: 15000, useProxy: cfg.use_proxy });
      const text = String(r.text || "");
      if (this._isChallenge(text)) return null;
      if (/您需要登录|请先登录|立即登录/.test(text)) return null;
      return this._extractHold(text);
    } catch { return null; }
  },

  /** Discuz! 账号密码登录：GET 登录页取 formhash+loginhash → POST 提交 → 会话 jar 出 xxx_auth。
   *  真机只读探测确认：无验证码时可用；命中验证码/WAF/失败均抛明确文案，回落手填 Cookie。 */
  async _passwordLogin(cfg) {
    const username = (cfg.username || "").trim();
    const password = (cfg.password || "").trim();
    if (!username || !password) throw new Error("请先填写恩山账号和密码");

    const s = new Session();
    // 1. GET 登录页取 formhash 与动态 loginhash
    const lp = await s.get(this.base + this.loginPage, { headers: this._headers("", this.forumPage), timeout: 15000, useProxy: cfg.use_proxy });
    this._ensureUsable(lp.text);
    if (this._hasCaptcha(lp.text)) {
      throw new Error("恩山登录当前需要验证码，账号密码方式不可用：请在浏览器登录后到设置里手填 Cookie");
    }
    const formhash = extractFormhash(lp.text);
    if (!formhash) throw new Error("登录页里没有 formhash（站点结构变化或被拦截），请改用手填 Cookie");
    const loginhash = (String(lp.text).match(/loginhash=([0-9a-zA-Z]+)/) || [])[1] || "";

    // 2. POST 登录（inajax 提交，会话 jar 自动累积 Set-Cookie）
    const submitPath = this.loginSubmit + (loginhash ? "&loginhash=" + loginhash : "");
    const form = {
      formhash,
      referer: this.base + this.forumPage,
      loginfield: "username",
      username,
      password,
      questionid: "0",
      answer: "",
      cookietime: "2592000",
    };
    const r = await s.postForm(this.base + submitPath, form, { headers: this._headers(s.cookieHeader(), this.loginPage, true), timeout: 15000, useProxy: cfg.use_proxy });
    const body = String(r.text || "");
    this._ensureUsable(body);

    // 登录结果判定：成功后会话 jar 出现 xxx_auth（最可靠）；辅以成功/失败文案
    const hasAuth = Object.keys(s.cookies).some((k) => /_auth$/i.test(k));
    if (this._hasCaptcha(body)) {
      throw new Error("恩山登录触发验证码：请在浏览器登录后到设置里手填 Cookie");
    }
    if (!hasAuth) {
      if (/密码错误|帐号|账号|用户名不存在|不存在或/.test(body) && /错误|不存在/.test(body)) {
        throw new Error("恩山登录失败：账号或密码错误");
      }
      if (/尝试登录次数|登录失败次数|请\s*\d+\s*分钟/.test(body)) {
        throw new Error("恩山登录失败次数过多，请稍后再试或在浏览器登录后手填 Cookie");
      }
      throw new Error("恩山登录未成功：未获取到登录 Cookie（可能触发安全验证），请在浏览器登录后手填 Cookie");
    }
    const cookie = s.cookieHeader();
    if (!cookie) throw new Error("登录成功但未取到会话 Cookie");
    return { s, cookie };
  },

  loginFlow: {
    mode: "form",
    desc: "账号密码自动登录产出 Cookie（Discuz! member.php 登录）",
    async init(cfg) {
      const { cookie } = await RIGHT_FORUM._passwordLogin(cfg);
      return {
        mode: "form",
        status: "ready",
        // type=cookie：server 自动提取 cookie 回填 cookie 字段，后续签到走既有 Cookie 路径
        session: { type: "cookie", cookie },
        account_label: RIGHT_FORUM.getAccountLabel(cfg),
        message: "登录成功，已自动获取 Cookie",
      };
    },
  },

  async runCheckin(cfg) {
    let cookie = (cfg.cookie || "").trim();
    if (!cookie && (cfg.username || "").trim() && (cfg.password || "").trim()) {
      // 无 Cookie 但账密齐全 → 自动走 Discuz 登录流获取 Cookie，本次签到直接用并回写账号
      // cookie 字段（调用方 runOnce/runAccount 的统一 save 落盘持久化，后续可直接使用）。
      // 登录失败抛明确文案：验证码/密码错/WAF 已由 _passwordLogin 区分（复用 1.2.9 文案）。
      try {
        const login = await this._passwordLogin(cfg);
        cookie = (login && login.cookie) || "";
        if (cookie) cfg.cookie = cookie;
      } catch (err) {
        throw new Error("恩山账号密码自动登录失败：" + ((err && err.message) || err));
      }
    }
    if (!cookie) throw new Error("请先配置恩山无线论坛 Cookie");

    const { formhash, text: pageText, path } = await this._fetchSignPage(cookie, cfg.use_proxy);
    const pageStats = this._extractStats(pageText);

    const s = new Session();
    const r = await s.postForm(this.base + this.signAction, { formhash }, { headers: this._headers(cookie, path, true), timeout: 15000, useProxy: cfg.use_proxy });
    this._ensureUsable(r.text);
    const payload = parseJson(r.text);
    if (!payload || typeof payload !== "object") {
      throw new Error(`签到接口没回 JSON：${cleanText(r.text).slice(0, 60) || "空响应"}`);
    }

    const message = String(payload.message || "").trim();
    let statusText;
    if (payload.success) {
      statusText = Number(payload.credit || 0) > 0 ? "签到成功" : "今日已签到";
    } else if (isAlreadyCheckedIn(message)) {
      statusText = "今日已签到";
    } else if (message.includes("请求来源验证失败")) {
      throw new Error("站点拒了这次请求（来源校验失败），Cookie 可能是另一个域名下复制的");
    } else {
      throw new Error(message || "站点没说原因");
    }

    const parts = [];
    if (payload.credit !== undefined && String(payload.credit).trim() !== "" && Number(payload.credit) !== 0) {
      parts.push(`今日积分：${payload.credit}`);
    }
    if (payload.continuous_days !== undefined && String(payload.continuous_days).trim() !== "") {
      parts.push(`连续签到：${payload.continuous_days} 天`);
    }
    const finalMsg = parts.length ? parts.join("；") : pageStats || message || statusText;

    // 当天奖励累计源：今日积分 credit（仅签到成功时 >0；已签为 0）。单位「积分」。history reward 仍保留 "-"（不改 points 聚合）
    const creditVal = Number(payload.credit || 0);
    // 当前总积分（hero 大数字）：从已抓取的签到页文本提取「积分: N」，不新增触网；取不到 → null → 「—」
    const holdVal = this._extractHold(pageText);
    return {
      site: this.key, site_name: this.name, status: statusText, message: finalMsg,
      reward: "-", total: "-", account: "Cookie", time: now(),
      reward_value: Number.isFinite(creditVal) ? Math.max(0, creditVal) : 0, reward_unit: "积分",
      hold_value: holdVal,
    };
  },

  /** 解析可用 Cookie：优先已存 Cookie；无 Cookie 但账密齐全 → Discuz 登录产出（只读，不签到）。 */
  async _resolveCookie(cfg) {
    let cookie = (cfg.cookie || "").trim();
    if (!cookie && (cfg.username || "").trim() && (cfg.password || "").trim()) {
      const login = await this._passwordLogin(cfg);
      cookie = (login && login.cookie) || "";
    }
    return cookie;
  },

  async testConnection(cfg) {
    const cookie = await this._resolveCookie(cfg);
    await this._fetchSignPage(cookie, cfg.use_proxy);
    // 只读抓当前总积分供 hero 快照（forum.php 顶栏「积分: N」）；失败/无字段 → null → 「—」
    const hold = await this._queryHold(cfg, cookie);
    return { site: this.key, site_name: this.name, message: "Cookie 有效，签到页可访问", hold_value: hold };
  },
};

/* ── 易破解 ───────────────────────────────────────────────── */
const YPOJIE = {
  key: "ypojie",
  name: "易破解",
  short: "易",
  mode: "账号密码",
  login_caps: ["password", "password_cookie"],
  desc: "ypojie.com · WordPress 登录后 AJAX 签到",
  fields: [
    { key: "email", label: "账号 / 邮箱", type: "text", ph: "name@example.com" },
    { key: "password", label: "密码", type: "password", ph: "输入新密码（留空不改）" },
  ],
  base: "https://www.ypojie.com",
  vipPath: "/vip?pd=money",
  loginPath: "/wp-login.php",
  ajaxPath: "/wp-admin/admin-ajax.php",
  // 英雄大数字（当前持有量）：复用签到时已抓取的 vip 页余额（_extractBalance「可用余额 N 积分」），
  // 不新增触网。取不到 → null，前端显示「—」。
  holdLabel: "积分",
  fmtHold(v) { return String(Number(Number(v).toFixed(2))); },

  defaultConfig() {
    return { enabled: false, use_proxy: false, email: "", password: "" };
  },
  isConfigured(cfg) {
    return !!(cfg && cfg.email && cfg.password);
  },
  getAccountLabel(cfg) {
    return maskEmail(cfg && cfg.email);
  },

  _loginHeaders() {
    return { Origin: this.base, Referer: `${this.base}${this.vipPath}`, "X-Requested-With": "XMLHttpRequest" };
  },

  /** 站点防爆破：该出口 IP 被暂时封锁（多次登录失败触发，约 10 分钟自解） */
  _blockedIpMessage() {
    return "易破解：当前出口 IP 被暂时封锁（多次登录失败触发防爆破，约 10 分钟自动解除），期间无法登录签到；可开启该站点代理更换出口，或稍后自动重试";
  },
  _isIpBlocked(text) {
    return !!String(text || "").includes("因多次登录失败已被暂时封锁");
  },

  /** 站内公告 /1.html：重复登录触发安全机制后，需在链接后加 ?cf=1 绕过 */
  _blockedPage(page) {
    return (
      page.includes("您不能访问此页面") ||
      page.includes("IP地址受限") ||
      page.includes("cf=1") ||
      page.includes("出于安全原因")
    );
  },

  /** 访问 vip 页（签到/余额页）；触发安全机制时带 &cf=1 重试一次 */
  async _getVip(s, cfg) {
    let r = await s.get(this.base + this.vipPath, { headers: this._loginHeaders(), timeout: 15000, useProxy: cfg.use_proxy });
    if (this._blockedPage(r.text)) {
      r = await s.get(this.base + this.vipPath + "&cf=1", { headers: this._loginHeaders(), timeout: 15000, useProxy: cfg.use_proxy });
    }
    return r;
  },

  _extractSlider(page) {
    const token = String(page || "").match(/name="slider_token"\s+value="([^"]+)"/);
    const nonce = String(page || "").match(/name="slider_nonce"\s+value="([^"]+)"/);
    if (!token || !nonce) return { verified: false };
    return { verified: true, slider_token: token[1], slider_nonce: nonce[1] };
  },

  _validateLoginPage(page) {
    if (page.includes("Hi,") || page.includes("今日签到") || page.includes("个人中心")) return;
    if (this._isIpBlocked(page)) {
      throw new Error(this._blockedIpMessage());
    }
    // 易破解安全机制（站内公告 /1.html）
    if (page.includes("您不能访问此页面")) {
      throw new Error("易破解登录安全机制触发：请在浏览器访问 https://www.ypojie.com/?cf=1 后重试");
    }
    if (page.includes("IP地址受限") || page.includes("出于安全原因")) {
      throw new Error("易破解 IP 受限（防撞库保护），约 2 小时后自动解锁");
    }
    if (page.includes("Captcha didn't verify")) {
      throw new Error("易破解登录验证码未通过：请稍后重试，或检查网络/DNS（公告 /5657.html）");
    }
    if (page.includes("wp-login.php") || page.includes("用户名或电子邮件地址") || page.includes("无效的凭证")) {
      throw new Error("易破解登录失败，请检查账号或密码");
    }
    throw new Error("易破解登录状态未确认，请检查账号密码或站点登录限制");
  },

  _extractBalance(page) {
    const m = cleanText(page).match(/可用余额\s*([0-9]+(?:\.[0-9]+)?)\s*积分/);
    return m ? parseFloat(m[1]) : null;
  },

  async _login(cfg) {
    const account = cfg.email || "";
    const password = cfg.password || "";
    if (!account || !password) throw new Error("请先配置易破解账号和密码");

    const s = new Session();
    // 前置 ?cf=1：绕过重复登录安全机制（站内公告 /1.html）
    await s.get(this.base + "/?cf=1", { timeout: 15000, useProxy: cfg.use_proxy }).catch(() => {});
    const loginPage = await s.get(this.base + this.loginPath, { headers: this._loginHeaders(), timeout: 15000, useProxy: cfg.use_proxy });
    const slider = this._extractSlider(loginPage.text);

    const form = {
      log: account,
      pwd: password,
      rememberme: "forever",
      "wp-submit": "登录",
      redirect_to: this.base + this.vipPath,
      testcookie: "1",
    };
    if (slider.verified) {
      Object.assign(form, {
        slider_verified: "1",
        slider_token: slider.slider_token,
        slider_nonce: slider.slider_nonce,
        _wp_http_referer: this.loginPath,
      });
    }
    const loginResp = await s.postForm(this.base + this.loginPath, form, { headers: this._loginHeaders(), timeout: 15000, useProxy: cfg.use_proxy });
    // 出口 IP 防爆破封锁检测（先于验证码/凭证判定：封锁是 IP 级，重试无意义）
    if (this._isIpBlocked(loginResp.text)) {
      throw new Error(this._blockedIpMessage());
    }
    // 登录提交后：精确检查验证码错误提示（页面正常含 captcha 字段不算失败）
    if (loginResp.text && loginResp.text.includes("Captcha didn't verify")) {
      throw new Error("易破解登录验证码未通过：请稍后重试，或检查网络/DNS（公告 /5657.html）");
    }

    // 登录后验证：访问 vip 页确认已登录（安全机制触发时自动 &cf=1 重试）
    const vipPage = await this._getVip(s, cfg);
    this._validateLoginPage(vipPage.text);
    return { s, beforePage: vipPage.text };
  },

  loginFlow: {
    mode: "form",
    desc: "账号密码自动登录产出会话（Cookie）",
    async init(cfg) {
      const { s } = await YPOJIE._login(cfg);
      const cookie = s.cookieHeader();
      if (!cookie) throw new Error("登录成功但未获取到会话 Cookie");
      return {
        mode: "form",
        status: "ready",
        session: { type: "cookie", cookie },
        account_label: YPOJIE.getAccountLabel(cfg),
        message: "登录成功",
      };
    },
  },

  /** 会话优先取登录态 Session：有效 session（type=cookie）→ 用 Cookie 构造并校验；失效/被拒 → 回退账密全新登录一次。
   * 登录/验证后统一回写会话（成功后后续签到复用 Cookie，避免每次签到全量登录触发站点防爆破）。 */
  async _resolveSession(cfg) {
    let s = null;
    let beforePage = "";
    if (sessionValid(cfg) && cfg.session && cfg.session.type === "cookie" && cfg.session.cookie) {
      s = sessionFromCookie(cfg.session.cookie);
      try {
        const vip = await this._getVip(s, cfg);
        this._validateLoginPage(vip.text); // 会话失效则抛错 → 走下方全新登录
        beforePage = vip.text;
      } catch (e) {
        delete cfg.session;
        delete cfg.session_ts;
        s = null; // 旧会话失效（WP 轮换/IP 封锁后 cookie 作废）
      }
    }
    if (!s) {
      const r = await this._login(cfg); // 登录失败带真实原因（封锁/凭证）向上抛出
      s = r.s;
      beforePage = r.beforePage;
      // 回写会话：登录成功即持久（runOnce 尾部 save 落盘）
      cfg.session = { type: "cookie", cookie: s.cookieHeader() };
      cfg.session_ts = Date.now();
    } else {
      cfg.session_ts = Date.now(); // 旧会话有效 → 刷新有效期
    }
    return { s, beforePage };
  },

  async runCheckin(cfg) {
    const { s, beforePage } = await this._resolveSession(cfg);
    const r = await s.postForm(this.base + this.ajaxPath, { action: "epd_checkin" }, { headers: this._loginHeaders(), timeout: 15000, useProxy: cfg.use_proxy });
    const j = parseJson(r.text) || {};
    let afterPage = "";
    try {
      const after = await this._getVip(s, cfg);
      afterPage = after.text;
    } catch { /* 余额差取不到不致命 */ }

    let rewardMsg = "";
    let rewardVal = 0; // 当天奖励累计源：本次签到积分增量（余额差；取不到 → 0 不累计）
    const beforeBal = this._extractBalance(beforePage);
    const afterBal = this._extractBalance(afterPage);
    if (beforeBal != null && afterBal != null && afterBal >= beforeBal) {
      const diff = afterBal - beforeBal;
      if (diff > 0) { rewardMsg = `本次签到增加：${diff.toFixed(2)}积分`; rewardVal = diff; }
    }

    const message = j.msg || j.message || "";
    // 当前持有量（hero 大数字源）：签到后 vip 页余额（afterBal；取不到 → null → 前端「—」）
    const holdVal = (afterBal != null && Number.isFinite(afterBal)) ? afterBal : null;
    // B15：先判「今日已签到」再判 status 成功——部分站点「已签」仍回 HTTP 200 + 已签到文案，
    // 若先判 200 会把「今日已签到」误标为「签到成功」（历史/通知/补签判定全部串扰）。
    if (message && isAlreadyCheckedIn(message)) {
      return {
        site: this.key, site_name: this.name, status: "今日已签到",
        message: rewardMsg || message, reward: "-", total: "-",
        account: this.getAccountLabel(cfg), time: now(),
        reward_value: rewardVal, reward_unit: "积分", hold_value: holdVal,
      };
    }
    if (Number(j.status) === 200) {
      return {
        site: this.key, site_name: this.name, status: "签到成功",
        message: rewardMsg || message || "签到成功", reward: "-", total: "-",
        account: this.getAccountLabel(cfg), time: now(),
        reward_value: rewardVal, reward_unit: "积分", hold_value: holdVal,
      };
    }
    throw new Error(message || `易破解签到失败（status=${j.status}）`);
  },

  async testConnection(cfg) {
    const { beforePage } = await this._resolveSession(cfg);
    // 复用登录/校验时已拉取的 vip 页（不新增触网、不签到）提取可用余额供 hero 快照；取不到 → null → 「—」
    const bal = this._extractBalance(beforePage);
    const hold = (bal != null && Number.isFinite(bal)) ? bal : null;
    return { site: this.key, site_name: this.name, message: "登录测试成功，可用于签到", hold_value: hold };
  },
};

/* ── AnyRouter 并入 NewAPI 通用（09-24 任务书）────────────────
 * AnyRouter/AgentRouter 与 NewAPI/OneAPI 同源，登录方式并入「NewAPI 通用」：
 * ANYROUTER 只做键归一（email → username、base_url 缺省回落 anyrouter.top），
 * runCheckin/testConnection/loginFlow/queryBalance 全部复用 NEWAPI 适配器。
 * 移除 relogin 强制分派（WAF 下自动 logout→login 不可行，用户已放弃该模式）；
 * 保留 new-api-user 头 / WAF 识别 / B16a 账密失败回退 Cookie。 */

/* ── AnyRouter（anyrouter.top / AgentRouter）────────────────── */
const ANYROUTER = {
  key: "anyrouter",
  name: "其他 NewAPI",
  short: "其他",
  mode: "Cookie / 账号 / OAuth",
  // 登录方式与 NEWAPI 通用一致（OAuth 在 WAF 下可能失败属运行时问题，选项保留）
  login_caps: NEWAPI_LOGIN_CAPS,
  desc: "anyrouter.top / AgentRouter · 配置对齐 anyrouter-check-in 仓库原生项：provider / email+password / cookies / api_user",
  fields: [
    { key: "provider", label: "提供商", type: "select", options: [
      { value: "anyrouter", label: "AnyRouter（anyrouter.top）" },
      { value: "agentrouter", label: "AgentRouter（agentrouter.org）" },
    ] },
    { key: "email", label: "账号 / 邮箱", type: "text", ph: "邮箱密码登录（推荐）" },
    { key: "password", label: "密码", type: "password", ph: "可选：与账号配合登录（留空不改）" },
    { key: "totp", label: "TOTP 密钥", type: "password", ph: "2FA 验证器密钥（可选，登录自动生成验证码）" },
    { key: "cookies", label: "Cookies", type: "password", ph: "浏览器会话 Cookies（WAF 站点需完整复制）" },
    { key: "api_user", label: "API User", type: "text", ph: "new-api-user 值（可选）" },
  ],
  base: "https://anyrouter.top",

  defaultConfig() {
    return {
      enabled: false, use_proxy: false,
      provider: "anyrouter", cookies: "", api_user: "", email: "", password: "",
    };
  },
  isConfigured(cfg) {
    return NEWAPI.isConfigured(this._toNewApiCfg(cfg));
  },
  getAccountLabel(cfg) {
    return NEWAPI.getAccountLabel(this._toNewApiCfg(cfg));
  },

  /** 键归一（原生 anyrouter-check-in 配置 → NEWAPI 语义）：
   * provider 决定平台地址（anyrouter.top / agentrouter.org）；cookies/cookie 兼容；
   * 旧账号 base_url 自动推导 provider；email 补位 username */
  _toNewApiCfg(cfg) {
    const n = { ...cfg };
    if (!n.username && n.email) n.username = n.email;
    let provider = n.provider || "anyrouter";
    if (!n.provider && n.base_url) {
      if (String(n.base_url).toLowerCase().includes("agentrouter")) provider = "agentrouter";
    }
    n.base_url = n.base_url || (provider === "agentrouter" ? "https://agentrouter.org" : this.base);
    n.cookie = (n.cookies != null ? n.cookies : n.cookie) || "";
    delete n.cookies;
    return n;
  },

  async runCheckin(cfg) {
    const ncfg = this._toNewApiCfg(cfg);
    try {
      const r = await NEWAPI.runCheckin(ncfg);
      return { ...r, site: this.key, site_name: this.name };
    } catch (err) {
      // B16a：账密被拒（NEWAPI 登录失败标记 loginRejected）且配置了 Cookies → 回退 Cookie 签到
      const ck = String(cfg.cookies != null ? cfg.cookies : cfg.cookie || "").trim();
      if (err && err.loginRejected && ck) {
        const fbCfg = this._toNewApiCfg({ ...cfg, password: "" });
        const fb = await NEWAPI.runCheckin(fbCfg);
        fb.message = `${fb.message || ""}（账密登录失败已回退 Cookie 签到）`;
        return { ...fb, site: this.key, site_name: this.name };
      }
      throw err;
    }
  },

  async testConnection(cfg) {
    const r = await NEWAPI.testConnection(this._toNewApiCfg(cfg));
    return { ...r, site: this.key, site_name: this.name };
  },

  /* 添加账号弹窗登录流程复用 NEWAPI（form：账号密码/Cookie 产出会话；OAuth 同款） */
  loginFlow: {
    mode: "form",
    desc: "账号密码 / Cookie 产出会话（token 或 cookie）；支持 NewAPI 统一 OAuth（与 NewAPI 通用一致）",
    async init(cfg) {
      return NEWAPI.loginFlow.init(ANYROUTER._toNewApiCfg(cfg));
    },
    async oauthInit(provider, cfg) {
      return NEWAPI.loginFlow.oauthInit(provider, ANYROUTER._toNewApiCfg(cfg));
    },
    async oauthComplete(args) {
      const a2 = { ...args };
      if (a2.cfg) a2.cfg = ANYROUTER._toNewApiCfg(a2.cfg);
      return NEWAPI.loginFlow.oauthComplete(a2);
    },
  },

  balanceLabel: "余额",
  async queryBalance(cfg) {
    return NEWAPI.queryBalance(this._toNewApiCfg(cfg));
  },
  /** 余额数值 → 展示串（USD）；delta 同单位 */
  fmtBalance(v) {
    return NEWAPI.fmtBalance(v);
  },
};
/* ── NewAPI 通用（NewAPI / OneAPI / Sub2API）────────────────── */
const NEWAPI = {
  key: "newapi",
  name: "通用 NewAPI",
  short: "NP",
  mode: "Cookie / 账号 / OAuth",
  // GitHub / LinuxDO OAuth（NewAPI 统一 OAuth）优先；账号密码直登 + 登录后自动产出会话；WAF 站点回落手动 Cookie
  login_caps: ["cookie"], // 1.6.5：按用户要求仅保留「手动 Cookie」登录方式（删除第三方登录/账号密码登录 tab）
  desc: "NewAPI / OneAPI / Sub2API 通用 · 手动 Cookie 配置（访问令牌/账密/OAuth 登录已按需移除）",
  fields: [
    { key: "base_url", label: "平台地址", type: "text", ph: "https://your-new-api.com（自建 NewAPI 填内网地址）" },
    { key: "username", label: "账号", type: "text", ph: "账号密码方式（二选一，无 WAF 平台可用）" },
    { key: "password", label: "密码", type: "password", ph: "输入新密码（留空不改）" },
    { key: "totp", label: "TOTP 密钥", type: "password", ph: "2FA 验证器密钥（可选，登录自动生成验证码）" },
    { key: "cookie", label: "Cookie", type: "password", ph: "浏览器会话 Cookie（二选一，WAF 站点用这个）" },
    { key: "api_user", label: "API User", type: "text", ph: "new-api-user 值（Cookie 方式可选）" },
    { key: "access_token", label: "访问令牌", type: "password", ph: "站点访问令牌/Token（Bearer 认证，NewAPI/Sub2API 通用，优先）" },
  ],
  base: "", // NewAPI 无默认地址（base_url 必填，缺失时明确报错，避免请求假占位域名）
  loginPath: "/api/user/login",
  signInPath: "/api/user/sign_in",
  fallbackSignInPath: "/api/user/checkin", // OneAPI / NewAPI 平台
  userInfoPath: "/api/user/self",
  // Sub2API 平台（access_token 直登，/api/v1 协议；协议来自 all-api-hub sub2api 系列）
  sub2MePath: "/api/v1/auth/me",
  sub2SignInPath: "/api/v1/redeem/checkin",
  sub2SignInStatusPath: "/api/v1/redeem/checkin/status",
  // NewAPI 统一 OAuth（协议来源：开源 github.com/QuantumNous/new-api，公开源码非逆向）：
  //   1) POST /api/oauth/state {provider,intent:"login"} → {data:{flow_token}}（flow_token 即 state，CSRF）
  //   2) 客户端拼授权 URL（client_id 取自 /api/status 的 {provider}_client_id），跳转 provider
  //   3) provider 回调 {origin}/oauth/{provider}?code&state → GET /api/oauth/{provider}?code&state
  //      服务端换 token + 建/登用户 → {data:{access_token,...}}（access_token 即 NewAPI 会话 token，Bearer 直用）
  statusPath: "/api/status",
  oauthStatePath: "/api/oauth/state",
  oauthCallbackPath: "/api/oauth/", // + provider
  OAUTH_PROVIDERS: {
    github: {
      name: "GitHub", client_key: "github_client_id", enabled_key: "github_oauth",
      // web/src/lib/oauth.ts buildGitHubOAuthUrl
      authorize: (cid, state) =>
        "https://github.com/login/oauth/authorize?client_id=" + encodeURIComponent(cid) +
        "&state=" + encodeURIComponent(state) + "&scope=user:email",
    },
    linuxdo: {
      name: "LinuxDO", client_key: "linuxdo_client_id", enabled_key: "linuxdo_oauth",
      // web/src/lib/oauth.ts buildLinuxDOOAuthUrl
      authorize: (cid, state) =>
        "https://connect.linux.do/oauth2/authorize?response_type=code&client_id=" + encodeURIComponent(cid) +
        "&state=" + encodeURIComponent(state),
    },
  },

  defaultConfig() {
    return {
      enabled: false, use_proxy: false,
      base_url: "",
      username: "", password: "", cookie: "", api_user: "", access_token: "",
    };
  },
  isConfigured(cfg) {
    if (!cfg) return false;
    if (cfg.username && cfg.password) return true;         // 账号密码方式
    if (cfg.cookie && String(cfg.cookie).trim()) return true; // Cookie 方式
    if (cfg.access_token && String(cfg.access_token).trim()) return true; // 访问令牌方式（通用 Bearer）
    // OAuth 登录：无明文凭据，凭 session（NewAPI 会话 token）鉴权
    if (cfg.session && cfg.session.type === "token" && cfg.session.token) return true;
    return false;
  },
  getAccountLabel(cfg) {
    if (cfg && cfg.username) return maskEmail(cfg.username);
    if (cfg && cfg.api_user) return "User " + cfg.api_user;
    if (cfg && cfg.access_token && String(cfg.access_token).trim()) return "访问令牌";
    if (cfg && cfg.oauth_login) return String(cfg.oauth_login); // OAuth 账号标签（如「GitHub @user」）
    if (cfg && cfg.session && cfg.session.type === "token" && cfg.session.token) return "OAuth 登录";
    return "Cookie";
  },
  /** Sub2API 部署判定：填写了 access_token 即走 /api/v1 协议（与 NewAPI 流程互斥） */
  _isSub2Api(cfg) {
    return !!(cfg && cfg.access_token && String(cfg.access_token).trim());
  },
  _sub2Auth(cfg) {
    return { type: "token", token: String(cfg.access_token).trim(), base: this._base(cfg) };
  },
  /** Sub2API 签到：Bearer JWT 直登。/api/v1/redeem/checkin 提交，
   *  /status 探测、/auth/me 验身份。信封 {code,message,data:{message,reward_amount,new_balance,checked_in_at}}，
   *  错误 403/409 + reason（DAILY_CHECKIN_DISABLED / ROLE_FORBIDDEN / ALREADY_CHECKED）。 */
  async _runSub2Checkin(cfg) {
    const auth = this._sub2Auth(cfg);
    const s = new Session();
    // 1) 状态探测：enabled=false → 禁用；已签到 → 直接返回
    const st = await s.get(auth.base + this.sub2SignInStatusPath, { headers: this._headers(auth), timeout: 15000, useProxy: cfg.use_proxy });
    if (isLoginExpired(st.status, st.text)) {
      throw new Error("登录态失效（HTTP " + st.status + "）：access_token 无效或已过期，请重新获取");
    }
    const sj = parseJson(st.text);
    if (sj && typeof sj.data === "object") {
      const d = sj.data;
      if (d.enabled === false) {
        throw new Error(d.reason === "DAILY_CHECKIN_DISABLED" || d.reason === "DISABLED" ? "平台当日签到功能已关闭（" + (d.reason || "DISABLED") + "）" : (d.message || "签到功能已被平台禁用"));
      }
      if (d.checked_in_today === true || d.checkedInToday === true || d.checked_in === true || d.checked_in === 1) {
        return this._ok("今日已签到", d.message || "今日已签到", "-", "-", cfg, auth);
      }
    }
    // 2) 提交签到
    const r = await s.postJson(auth.base + this.sub2SignInPath, {}, { headers: this._headers(auth), timeout: 15000, useProxy: cfg.use_proxy });
    if (isLoginExpired(r.status, r.text)) {
      throw new Error("登录态失效（HTTP " + r.status + "）：access_token 无效或已过期，请重新获取");
    }
    const j = parseJson(r.text);
    if (!j || typeof j !== "object") {
      throw new Error(`Sub2API 签到接口没回 JSON：${cleanText(r.text).slice(0, 60) || "空响应"}`);
    }
    // 业务信封 code===0 → 成功
    if (Number(j.code) === 0 && j.data && typeof j.data === "object") {
      const d = j.data;
      const reward = (d.reward_amount != null && d.reward_amount !== "") ? ((Number(d.reward_amount) >= 0 ? "+" : "") + d.reward_amount) : "";
      const total = (d.new_balance != null && d.new_balance !== "") ? String(d.new_balance) : "";
      return this._ok("签到成功", d.message || "签到成功", reward || "-", total || "-", cfg, auth);
    }
    if (j.reason === "ALREADY_CHECKED" || /already|重复签到|已签到/.test(String(j.message || ""))) {
      return this._ok("今日已签到", j.message || "ALREADY_CHECKED", "-", "-", cfg, auth);
    }
    if (j.reason === "DAILY_CHECKIN_DISABLED" || (Number(j.code) === 403 && j.reason === "ROLE_FORBIDDEN")) {
      throw new Error(j.message || "签到被拒绝：" + (j.reason || ""));
    }
    throw new Error((j.message || `签到失败（code=${j.code} ret=${j.ret}）`));
  },

  /** base_url → 归一 base（NewAPI 无默认：缺失留空，由 _authHeaders 明确报错） */
  _base(cfg) {
    return napiBase(cfg);
  },
  /** base_url → 纯 host（小写），用于平台判定 */
  _host(cfg) {
    return napiHost(cfg);
  },
  _headers(auth, extra) {
    return newApiHeaders(auth, extra);
  },
  /** 构造认证：账号密码 → /api/user/login 拿 token；Cookie → 直接带 Cookie（+new-api-user） */
  async _authHeaders(cfg) {
    const base = this._base(cfg);
    if (!base) throw new Error("请先配置平台地址（base_url）");
    // 1.6.4：访问令牌优先（通用 Bearer 认证——NewAPI/OneAPI/Sub2API 统一；不再仅限 Sub2API 协议）
    if (cfg.access_token && String(cfg.access_token).trim()) {
      return { type: "token", token: String(cfg.access_token).trim(), base };
    }
    if (cfg.username && cfg.password) {
      const s = new Session();
      let r = await s.postJson(base + this.loginPath, { username: cfg.username, password: cfg.password }, { timeout: 15000, useProxy: cfg.use_proxy });
      if (isWafChallenge(r.text)) {
        throw new Error(`平台有 WAF 人机验证，账号密码方式被拦截：请在浏览器访问 ${base} 后改用「Cookie + api_user」方式配置`);
      }
      let j = parseJson(r.text);
      // 2FA（对齐 all-api-hub/NewAPI）：响应标记 require_2fa / need_2fa → 用 TOTP 自动提交验证码
      const d2 = (j && typeof j === "object" && j.data && typeof j.data === "object") ? j.data : {};
      const need2fa = !!(j && (j.require_2fa === true || j.need_2fa === true || d2.require_2fa === true || d2.need_2fa === true));
      if (need2fa) {
        const totp = String(cfg.totp || "").trim();
        if (!totp) throw new Error("平台需要两步验证（2FA）：请在账号配置「TOTP 密钥」填写验证器密钥");
        const code = genTOTP(totp);
        const flowToken = d2.flow_token || d2.state || "";
        // 统一流程（新版 NewAPI）：/api/user/login/verify {code, method:"2fa", flow_token}；经典：/api/user/login/2fa {code}
        const ep = flowToken ? "/api/user/login/verify" : "/api/user/login/2fa";
        const body = flowToken ? { code, method: "2fa", flow_token: flowToken } : { code };
        r = await s.postJson(base + ep, body, { timeout: 15000, useProxy: cfg.use_proxy });
        j = parseJson(r.text);
      }
      if (!j || !j.success || !(j.data || {}).access_token) {
        // B16a：账密被拒标记（ANYROUTER 委托路径据此回退 Cookie 签到；newapi 站点感知不到该标志，行为不变）
        const err = new Error((j && (j.message || j.msg)) || `登录失败（HTTP ${r.status}）`);
        err.loginRejected = true;
        throw err;
      }
      return { type: "token", token: j.data.access_token, base };
    }
    if (cfg.cookie && String(cfg.cookie).trim()) {
      return cookieAuth(cfg, base);
    }
    // P1-1 修复：OAuth 建号仅持 session（登录产物 token/cookie）——有效期内作为认证兜底（过期需重新授权，非持久保持登录态）
    if (sessionValid(cfg) && cfg.session && typeof cfg.session === "object") {
      const sess = cfg.session;
      if (sess.type === "token" && sess.token) {
        return { type: "token", token: sess.token, base: sess.base || base };
      }
      if (sess.type === "cookie" && sess.headers) {
        return { type: "cookie", headers: sess.headers, base: sess.base || base };
      }
    }
    throw new Error("请配置账号密码，或 Cookie + api_user");
  },

  /** 会话构造认证（1.6.7）：NewAPI 不保持登录态——每次签到从配置凭据现场认证，不读取/复用已存 session */
  async _resolveAuth(cfg) {
    return this._authHeaders(cfg);
  },

  loginFlow: {
    mode: "form",
    desc: "账号密码 / Cookie 产出会话（token 或 cookie）；支持 NewAPI 统一 OAuth",
    async init(cfg) {
      const auth = await NEWAPI._authHeaders(cfg);
      const session = auth.type === "token"
        ? { type: "token", token: auth.token, base: auth.base }
        : { type: "cookie", headers: auth.headers, base: auth.base };
      return {
        mode: "form",
        status: "ready",
        session,
        account_label: NEWAPI.getAccountLabel(cfg),
        message: "登录成功",
      };
    },

    /* OAuth 发起（oauth_github / oauth_linuxdo）：探 /api/status 拿 client_id + 开关，
     * POST /api/oauth/state 拿 flow_token（state），拼授权 URL 返给前端。不触发真实授权。 */
    async oauthInit(provider, cfg) {
      const p = NEWAPI.OAUTH_PROVIDERS[provider];
      if (!p) throw new Error("不支持的 OAuth 提供方：" + provider);
      const base = NEWAPI._base(cfg);
      if (!base) throw new Error("请先配置平台地址（base_url）");
      const s = new Session();
      // 1) /api/status：确认该 provider 已启用并取 client_id
      const stR = await s.get(base + NEWAPI.statusPath, {
        headers: { Accept: "application/json, text/plain, */*" }, timeout: 15000, useProxy: cfg && cfg.use_proxy,
      });
      if (isWafChallenge(stR.text)) {
        throw new Error("平台有 WAF 人机验证，服务端无法直接发起 OAuth：请在浏览器登录后改用「手动 Cookie」方式");
      }
      const stj = parseJson(stR.text);
      const sd = (stj && typeof stj.data === "object") ? stj.data : (stj || {});
      if (sd[p.enabled_key] === false) throw new Error("平台未启用 " + p.name + " OAuth 登录");
      const clientId = firstStr(sd, [p.client_key]);
      if (!clientId) throw new Error("平台未返回 " + p.name + " client_id（可能未配置 OAuth 或非 NewAPI 平台）");
      // 2) POST /api/oauth/state {provider,intent:login} → data.flow_token（state）
      const flowR = await s.postJson(base + NEWAPI.oauthStatePath, { provider, intent: "login" }, {
        headers: { Accept: "application/json, text/plain, */*" }, timeout: 15000, useProxy: cfg && cfg.use_proxy,
      });
      if (isWafChallenge(flowR.text)) {
        throw new Error("平台有 WAF 人机验证，OAuth state 接口被拦截：请改用「手动 Cookie」方式");
      }
      const fj = parseJson(flowR.text);
      const fd = (fj && typeof fj.data === "object") ? fj.data : (fj || {});
      const state = firstStr(fd, ["flow_token", "state"]);
      if (!state) {
        throw new Error((fj && (fj.message || fj.msg)) || "获取 OAuth state 失败（HTTP " + flowR.status + "）");
      }
      return { provider, base, state, auth_url: p.authorize(clientId, state) };
    },

    /* OAuth 回调完成：解析回调 URL 的 code/state → GET /api/oauth/{provider}?code&state
     * 服务端换 token + 建/登用户 → data.access_token（NewAPI 会话 token）。产出 token 型 session。 */
    async oauthComplete(args) {
      const { provider, code, state, cfg } = args || {};
      const p = NEWAPI.OAUTH_PROVIDERS[provider];
      if (!p) throw new Error("不支持的 OAuth 提供方：" + provider);
      if (!code) throw new Error("回调链接缺少 code 参数（请粘贴完整的授权回调地址）");
      const base = NEWAPI._base(cfg);
      const s = new Session();
      const url = base + NEWAPI.oauthCallbackPath + encodeURIComponent(provider) +
        "?code=" + encodeURIComponent(code) + (state ? "&state=" + encodeURIComponent(state) : "");
      const r = await s.get(url, { headers: { Accept: "application/json, text/plain, */*" }, timeout: 20000, useProxy: cfg && cfg.use_proxy });
      if (isWafChallenge(r.text)) {
        throw new Error("平台 WAF 拦截了 OAuth 回调：请在浏览器完成登录后改用「手动 Cookie」方式");
      }
      const j = parseJson(r.text);
      if (!j || typeof j !== "object") {
        throw new Error("OAuth 回调没回 JSON：" + (cleanText(r.text).slice(0, 60) || "空响应") + "（code 可能已被浏览器消费，请重新发起授权）");
      }
      if (j.success === false) {
        throw new Error((j.message || j.msg) || "OAuth 登录被拒绝（授权失败或 state 失效）");
      }
      const d = (j.data && typeof j.data === "object") ? j.data : {};
      const token = firstStr(d, ["access_token"]);
      if (!token) {
        throw new Error((j.message || j.msg) || "未获取到 access_token（该平台回调可能仅下发 Cookie，请改用「手动 Cookie」方式）");
      }
      // 账号展示标签：优先 provider + 用户名
      const u = (d.user && typeof d.user === "object") ? d.user : {};
      const uname = firstStr(u, ["username", "display_name", "github_id", "linux_do_id", "email"]);
      const label = p.name + (uname ? " @" + uname : "");
      return {
        session: { type: "token", token, base },
        account: { base_url: base, oauth_login: label, remark: label },
        account_label: label,
        message: p.name + " 授权登录成功",
      };
    },
  },

  async _getUserInfo(auth, useProxy) {
    return fetchUserInfo(auth.base, auth, useProxy);
  },
  _fmtUsd(quota) {
    return napiUsd(quota);
  },

  async runCheckin(cfg) {
    // 1.6.4：统一走通用 NewAPI 流程（访问令牌 Bearer / 账密 / Cookie）；通用端点 404/不存在时自动回退 Sub2API（/api/v1）协议
    const auth = await this._resolveAuth(cfg);
    let before = null;
    try { before = await this._getUserInfo(auth, cfg.use_proxy); } catch { /* 取不到不致命 */ }

    const doSign = (path) => {
      const s = new Session();
      return s.postRaw(path, null, {
        headers: this._headers(auth, { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" }),
        timeout: 15000, useProxy: cfg.use_proxy,
      });
    };
    let r = await doSign(auth.base + this.signInPath);
    // OneAPI 平台没有 /api/user/sign_in → fallback /api/user/checkin
    if (r.status === 404 || /not found|接口不存在|invalid action/i.test(String(r.text || ""))) {
      r = await doSign(auth.base + this.fallbackSignInPath);
      // 通用 NewAPI 端点均不存在 → Sub2API（/api/v1/redeem/checkin）自动回退适配（访问令牌通用认证）
      if (r.status === 404 || /not found|接口不存在|invalid action/i.test(String(r.text || ""))) {
        // P3-1：仅访问令牌账号可回退 Sub2（账密/Cookie 账号回退会发空 Bearer 误导用户）
        if (!cfg.access_token || !String(cfg.access_token).trim()) {
          throw new Error("该平台无通用 NewAPI 签到接口（HTTP 404）：如为 Sub2API 平台请在账号配置填写「访问令牌」");
        }
        return this._runSub2Checkin(cfg);
      }
    }

    if (isWafChallenge(r.text)) {
      throw new Error(`平台 WAF 拦截（Cookie 缺人机验证）：请在浏览器访问 ${auth.base} 通过验证后重新复制完整 Cookie`);
    }
    if (isLoginExpired(r.status, r.text)) {
      throw new Error(`登录态失效（HTTP ${r.status}）：Cookie 过期或 Token 无效，请重新获取（session 约 1 个月有效）`);
    }

    const j = parseJson(r.text);
    if (!j || typeof j !== "object") {
      throw new Error(`签到接口没回 JSON：${cleanText(r.text).slice(0, 60) || "空响应"}`);
    }
    const msg = String(j.msg || j.message || "").trim();
    const success = napiSignInSuccess(j);
    const data = (j.data && typeof j.data === "object") ? j.data : null;

    // 结构化解读（NewApiCheckInStatus）：data.enabled===false → 禁用；data.checked_in===true → 已签到
    if (data && data.enabled === false) {
      throw new Error(msg || "签到功能已被平台禁用（enabled=false）");
    }
    if (data && data.checked_in === true) {
      return this._ok("今日已签到", msg || "今日已签到", "-", "-", cfg, auth);
    }

    // 签到后余额（对比奖励）
    let after = null;
    try { after = await this._getUserInfo(auth, cfg.use_proxy); } catch { /* 取不到不致命 */ }
    const balanceMsg = napiBalanceMsg(after);
    // 奖励优先取接口直接回写的 quota_awarded（NewApiCheckInRecord 字段），否则用签到前后余额差
    let rewardMsg = "";
    if (data && data.quota_awarded != null && data.quota_awarded !== "") {
      rewardMsg = `本次签到 +${this._fmtUsd(Number(data.quota_awarded) || 0)}`;
    } else if (before && after && after.quota > before.quota) {
      rewardMsg = `本次签到 +${this._fmtUsd(after.quota - before.quota)}`;
    }

    if (success) {
      const detail = [rewardMsg, balanceMsg].filter(Boolean).join("；") || msg || "签到成功";
      return this._ok("签到成功", detail, rewardMsg || "-", balanceMsg || "-", cfg, auth);
    }
    if (isAlreadyCheckedIn(msg) || /已经签到|重复签到|already checked|already signed/i.test(msg)) {
      const detail = [balanceMsg || msg, rewardMsg].filter(Boolean).join("；") || "今日已签到";
      return this._ok("今日已签到", detail, "-", balanceMsg || "-", cfg, auth);
    }
    throw new Error(msg || `签到失败（ret=${j.ret} code=${j.code}）`);
  },

  async testConnection(cfg) {
    const auth = await this._resolveAuth(cfg);
    try {
      const info = await this._getUserInfo(auth, cfg.use_proxy);
      if (!info) throw new Error("登录态有效，但用户信息接口未返回 quota");
      const who = cfg.username ? maskEmail(cfg.username) : (auth.type === "token" ? "访问令牌" : "Cookie");
      return { site: this.key, site_name: this.name, message: `连接成功，${who} 有效，余额 ${this._fmtUsd(info.quota)}` };
    } catch (e) {
      // 1.6.4：通用用户信息端点失败（Sub2API 无 /api/user/self）→ 自动回退 Sub2API /api/v1/user/self 校验
      if (auth.type === "token" && cfg.access_token) {
        try {
          const s2 = new Session();
          const sa = this._sub2Auth(cfg);
          const r2 = await s2.get(sa.base + this.sub2MePath, { headers: this._headers(sa), timeout: 15000, useProxy: cfg.use_proxy });
          const j2 = parseJson(r2.text);
          if (!isLoginExpired(r2.status, r2.text) && j2 && Number(j2.code) === 0) {
            return { site: this.key, site_name: this.name, message: "连接成功，访问令牌有效（Sub2API）" };
          }
        } catch { /* Sub2 校验失败 → 抛原错误 */ }
      }
      throw e;
    }
  },

  /* 账号级余额快照（server 在签到/测试成功后调用）：返回原始数值 quota（点数）。
   * Sub2API 无独立用户信息端点 → 通用 self 失败返回 null（该模式余额随签到响应，不单独快照）。 */
  balanceLabel: "余额",
  async queryBalance(cfg) {
    try {
      const auth = await this._resolveAuth(cfg);
      const info = await this._getUserInfo(auth, cfg.use_proxy);
      if (!info) return null;
      return Number(info.quota) || 0; // 原始点数（500000 点 = $1）
    } catch { return null; } // Sub2API 无 self 端点等 → 跳过快照
  },
  /** 余额数值 → 展示串（USD）；delta 同单位 */
  fmtBalance(v) {
    return this._fmtUsd(Number(v) || 0);
  },

  _ok(status, message, reward, total, cfg, auth) {
    const account = (cfg && cfg.username) ? maskEmail(cfg.username)
      : ((auth && auth.type === "cookie")
        ? (cfg && cfg.api_user ? "User " + cfg.api_user : "Cookie")
        : "-");
    return { site: this.key, site_name: this.name, status, message, reward, total, account, time: now() };
  },
};

/* ── 千问办公 / WorkBuddy（腾讯 CodeBuddy 每日签到）──────────────────
 * 协议来源：开源仓库 github.com/veenyi/XingyunAPI（pkg/checkin/workbuddy.go、
 * pkg/workbuddy/chat.go），公开可读，非逆向。三个上游端点：
 *   - 签到：POST https://www.codebuddy.cn/v2/billing/meter/daily-checkin
 *   - 积分：POST https://www.codebuddy.cn/v2/billing/meter/get-user-resource
 *   - 刷新：POST https://copilot.tencent.com/v2/plugin/auth/token/refresh（体 {refresh_token}）
 * 鉴权：Authorization: Bearer <access_token>；企业上下文 X-Enterprise-Id / X-Domain。
 * 扫码登录（微信）为异步二维码流（loginFlow.mode="qr"，对齐行云）：
 *   1. POST copilot.tencent.com/v2/plugin/auth/state?platform=CLI → 建会话，回 state + auth_url（二维码内容）
 *   2. 轮询 GET /v2/plugin/auth/token?state=… → 未确认回业务码 11217（pending）；确认后回 data.accessToken/refreshToken/domain（camelCase）
 *   3. 带 Bearer GET /v2/plugin/login/account?state=… → uid/nickname/enterpriseId
 *   扫码链路专用 UA「CLI/2.63.2 CodeBuddy/2.63.2」+ X-Requested-With + Origin/Referer codebuddy.cn
 *   （auth/state 只认这套头，浏览器 UA 会打到不同网关规则）；会话 TTL 5 分钟。
 * 手填 access_token / refresh_token 表单作为 fallback 保留（签到前过期用 refresh_token 自动续期）。
 */
const WORKBUDDY = {
  key: "workbuddy",
  name: "WorkBuddy",
  short: "W",
  mode: "Token",
  // 微信扫码优先；手填 access/refresh token 表单作为高级 fallback（cookie tab 承载）
  login_caps: ["qr", "cookie"],
  desc: "www.codebuddy.cn · 腾讯 CodeBuddy 每日签到领积分（access/refresh token 自动续期）",
  fields: [
    { key: "access_token", label: "Access Token", type: "password", ph: "粘贴 access token（登录后抓包获取；留空不改）" },
    { key: "refresh_token", label: "Refresh Token", type: "password", ph: "粘贴 refresh token（自动续期用；留空不改）" },
    { key: "uid", label: "UID（可选）", type: "text", ph: "账号用户 ID，仅用于展示" },
    { key: "enterprise_id", label: "Enterprise ID（可选）", type: "text", ph: "企业 / 租户 ID" },
    { key: "domain", label: "Domain（可选）", type: "text", ph: "部门域名" },
  ],
  base: "https://www.codebuddy.cn",
  authBase: "https://copilot.tencent.com",
  checkinPath: "/v2/billing/meter/daily-checkin",
  usagePath: "/v2/billing/meter/get-user-resource",
  refreshPath: "/v2/plugin/auth/token/refresh",
  // 浏览器惯例 UA（对齐 workbuddy.go wbHeaderUserAgent）
  UA: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) CodeBuddy/1.0.0 Chrome/133.0.0.0 Safari/537.36",
  ALREADY_MARKERS: ["已签到", "今日已签", "重复签到", "already", "checked_in", "checked in", "duplicate"],
  CREDIT_MARKERS: ["积分不足", "积分用完", "额度用尽", "余额不足", "配额用尽", "每日上限", "insufficient", "out of credit", "quota exhaust"],

  defaultConfig() {
    return { enabled: false, use_proxy: false, access_token: "", refresh_token: "", uid: "", enterprise_id: "", domain: "" };
  },
  isConfigured(cfg) {
    return !!(cfg && (cfg.access_token || (cfg.session && cfg.session.access_token)));
  },
  getAccountLabel(cfg) {
    return (cfg && (cfg.uid || cfg.remark)) || "WorkBuddy";
  },

  /* 微信扫码登录流（qr 模式）：server 层负责会话持有（token→state）与轮询编排、
   * 成功后自动建账号；adapter 只封装两步上游协议。tokens 绝不落日志/报告。 */
  loginFlow: {
    mode: "qr",
    desc: "微信扫码登录，自动添加账号（对齐行云签到中心）",
    ttl_ms: 5 * 60 * 1000, // 扫码会话有效期 5 分钟（对齐上游 wbLoginTTL）
    tip: "手机端 CodeBuddy 扫码即可自动添加账号",
    authStatePath: "/v2/plugin/auth/state",
    authTokenPath: "/v2/plugin/auth/token",
    loginAccountPath: "/v2/plugin/login/account",
    // 扫码链路专用 UA（auth/state 只认这套头，浏览器 UA 会打到不同网关规则）
    loginUA: "CLI/2.63.2 CodeBuddy/2.63.2",

    _headers() {
      return {
        "Content-Type": "application/json",
        Accept: "application/json, text/plain, */*",
        "User-Agent": this.loginUA,
        "X-Requested-With": "XMLHttpRequest",
        Origin: "https://www.codebuddy.cn",
        Referer: "https://www.codebuddy.cn/",
      };
    },

    /** 合并上游包裹层字段（data 覆盖顶层，命名/大小写不稳定时宽容取值） */
    _merged(j) {
      if (!j || typeof j !== "object") return {};
      return { ...j, ...(j.data && typeof j.data === "object" ? j.data : {}) };
    },

    /** 建扫码会话：POST auth/state?platform=CLI → {state, auth_url}（auth_url 即二维码内容） */
    async startSession(cfg) {
      const s = new Session();
      const r = await s.postJson(
        WORKBUDDY.authBase + this.authStatePath + "?platform=CLI",
        {},
        { headers: this._headers(), timeout: 15000, useProxy: cfg && cfg.use_proxy },
      );
      const j = parseJson(r.text) || {};
      const cand = this._merged(j);
      const state = firstStr(cand, ["state", "auth_state", "ticket"]);
      const authUrl = firstStr(cand, ["auth_url", "authUrl", "url", "login_url"]);
      if (!state || !authUrl) {
        throw new Error(WORKBUDDY._msg(j) || `扫码会话创建失败（HTTP ${r.status}，缺少 state/authUrl）`);
      }
      return { state, auth_url: authUrl };
    },

    /** 轮询一次：pending / expired / ready（ready 带 account={access_token, refresh_token, uid, ...}） */
    async poll(sess, cfg) {
      const s = new Session();
      const tr = await s.get(
        WORKBUDDY.authBase + this.authTokenPath + "?state=" + encodeURIComponent(sess.state),
        { headers: this._headers(), timeout: 15000, useProxy: cfg && cfg.use_proxy },
      );
      const tj = parseJson(tr.text) || {};
      const tok = this._merged(tj);
      const access = firstStr(tok, ["accessToken", "access_token"]);
      if (!access) {
        // 未扫码/未确认（业务码 11217 login ing…）→ pending；会话失效关键词 → expired
        const text = WORKBUDDY._msg(tj);
        if (/过期|expired|失效|invalid|不存在/i.test(text)) {
          return { state: "expired", message: text || "登录已过期，请重新扫码" };
        }
        return { state: "pending" };
      }
      const account = {
        access_token: access,
        refresh_token: firstStr(tok, ["refreshToken", "refresh_token"]),
      };
      const domain = firstStr(tok, ["domain"]);
      if (domain) account.domain = domain;
      // 二段：带 Bearer 拉账号信息（uid/nickname/enterpriseId）——失败不影响登录
      try {
        const h = { ...this._headers(), Authorization: "Bearer " + access };
        const ar = await s.get(
          WORKBUDDY.authBase + this.loginAccountPath + "?state=" + encodeURIComponent(sess.state),
          { headers: h, timeout: 15000, useProxy: cfg && cfg.use_proxy },
        );
        const cand = this._merged(parseJson(ar.text) || {});
        const uid = firstStr(cand, ["uid", "user_id", "userid"]);
        if (uid) account.uid = uid;
        const nick = firstStr(cand, ["nickname", "display_name", "username"]);
        if (nick) account.remark = nick;
        const ent = firstStr(cand, ["enterpriseId", "enterprise_id"]);
        if (ent) account.enterprise_id = ent;
      } catch { /* 账号信息拉取失败：仍以 tokens 完成登录 */ }
      // session 与 _billingDo/_pickAccess 读取形状一致（{access_token, refresh_token}）；
      // 供 server 层落账号时写入 acc.session，使 has_session 判定为已登录（对齐 form/password 流）。
      return {
        state: "ready",
        account,
        session: { access_token: account.access_token, refresh_token: account.refresh_token || "" },
      };
    },
  },

  /** 计费端点公共头（Bearer + 企业上下文） */
  _billingHeaders(accessToken, cfg) {
    const h = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": this.UA,
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      Authorization: "Bearer " + accessToken,
    };
    if (cfg && cfg.enterprise_id) h["X-Enterprise-Id"] = String(cfg.enterprise_id);
    if (cfg && cfg.domain) h["X-Domain"] = String(cfg.domain);
    return h;
  },

  /** 计费请求体：企业上下文透传，其余留空 */
  _billingBody(cfg) {
    const body = {};
    if (cfg && cfg.enterprise_id) body.enterprise_id = String(cfg.enterprise_id);
    if (cfg && cfg.domain) body.domain = String(cfg.domain);
    return body;
  },

  _hasMarker(text, markers) {
    const t = String(text || "").toLowerCase();
    return markers.some((m) => t.includes(m.toLowerCase()));
  },

  /** 上游宽容包裹层：code 成功判定（0/200/success/ok/true 视为成功） */
  _okCode(j) {
    if (!j || typeof j !== "object") return false;
    const c = j.code;
    if (c !== undefined && c !== null) {
      if (typeof c === "number" && c !== 0 && c !== 200) return false;
      if (typeof c === "string" && c !== "" && c !== "0" && c !== "200" && !/^(success|ok)$/i.test(c)) return false;
    }
    if (typeof j.success === "boolean" && !j.success) return false;
    if (typeof j.success === "string" && /^false$/i.test(j.success)) return false;
    return true;
  },

  _msg(j) {
    if (!j) return "";
    return String(j.msg || j.message || (typeof j.error === "string" ? j.error : "") || j.status || "");
  },

  /** 用 refresh_token 换新 access_token（copilot.tencent.com，体仅 refresh_token，
   *  响应 data 为 camelCase accessToken/refreshToken）。成功后回写 cfg.session。 */
  async _refresh(cfg) {
    const refresh = (cfg.refresh_token || (cfg.session && cfg.session.refresh_token) || "").trim();
    if (!refresh) throw new Error("缺少 refresh_token，请重新登录 WorkBuddy 后补充凭据");
    const s = new Session();
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": this.UA,
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      Authorization: "Bearer " + refresh,
      "X-Refresh-Token": refresh,
    };
    if (cfg.enterprise_id) headers["X-Enterprise-Id"] = String(cfg.enterprise_id);
    const r = await s.postJson(this.authBase + this.refreshPath, { refresh_token: refresh }, { headers, timeout: 15000, useProxy: cfg.use_proxy });
    const j = parseJson(r.text);
    const data = (j && j.data) || {};
    if (!data.accessToken) {
      throw new Error((j && this._msg(j)) || `WorkBuddy 令牌刷新失败（HTTP ${r.status}）`);
    }
    return { access_token: data.accessToken, refresh_token: data.refreshToken || refresh };
  },

  /** 会话优先取 access_token：有效 session 直接用；否则用字段值；调用方按 401 触发刷新 */
  _pickAccess(cfg) {
    if (sessionValid(cfg) && cfg.session && cfg.session.access_token) return cfg.session.access_token;
    return (cfg.access_token || "").trim();
  },
  _pickRefresh(cfg) {
    if (sessionValid(cfg) && cfg.session && cfg.session.refresh_token) return cfg.session.refresh_token;
    return (cfg.refresh_token || "").trim();
  },

  /** 调计费端点：401/鉴权失效时用 refresh_token 续期后重试一次；成功续期回写内存 cfg.session。 */
  async _billingDo(cfg, path) {
    let access = this._pickAccess(cfg);
    if (!access) throw new Error("缺少 access_token，请编辑签到账号补充凭据");
    const s = new Session();
    const call = (token) => s.postJson(this.base + path, this._billingBody(cfg), {
      headers: this._billingHeaders(token, cfg), timeout: 15000, useProxy: cfg.use_proxy,
    });
    let r = await call(access);
    // 访问令牌过期（401/鉴权错误）→ 尝试刷新一次
    if (r.status === 401 || (r.status >= 400 && /token|unauthor|登录|鉴权|过期|expired|invalid/i.test(r.text || ""))) {
      if (this._pickRefresh(cfg)) {
        const fresh = await this._refresh(cfg);
        cfg.session = { access_token: fresh.access_token, refresh_token: fresh.refresh_token };
        cfg.session_ts = Date.now();
        access = fresh.access_token;
        r = await call(access);
      }
    }
    return r;
  },

  async runCheckin(cfg) {
    const r = await this._billingDo(cfg, this.checkinPath);
    const j = parseJson(r.text);
    const text = this._msg(j);
    // 上游对「已签到」常回 HTTP 400（body code=10001 今天已签到）
    if (r.status < 200 || r.status > 299) {
      if (this._hasMarker(text || r.text, this.ALREADY_MARKERS)) {
        return this._ok("今日已签到", text || "今天已签到", cfg);
      }
      throw new Error(text || `WorkBuddy 签到失败（HTTP ${r.status}）`);
    }
    if (!this._okCode(j)) {
      if (this._hasMarker(text, this.ALREADY_MARKERS)) return this._ok("今日已签到", text, cfg);
      if (this._hasMarker(text, this.CREDIT_MARKERS)) throw new Error(text);
      throw new Error(text || "WorkBuddy 签到请求失败");
    }
    const data = (j && j.data) || {};
    if (data.checked_in === true || data.checked === true) {
      return this._ok("今日已签到", text || "今天已签到", cfg);
    }
    if (this._hasMarker(text, this.ALREADY_MARKERS)) return this._ok("今日已签到", text, cfg);
    // 尝试附带积分（不致命）
    let reward = "-";
    try {
      const credits = await this._queryCredits(cfg);
      if (credits.credits != null) reward = String(credits.credits);
    } catch { /* 积分取不到不影响签到结果 */ }
    return this._ok("签到成功", text || "签到成功", cfg, reward);
  },

  /** 查询积分（get-user-resource），宽容解析剩余/总量 */
  async _queryCredits(cfg) {
    const r = await this._billingDo(cfg, this.usagePath);
    const j = parseJson(r.text);
    if (r.status < 200 || r.status > 299 || !this._okCode(j)) {
      // 状态码进错误消息，便于 _snapshotBalance 记 console.error（不含 token/敏感值）
      throw new Error(this._msg(j) || `积分响应异常（HTTP ${r.status}）`);
    }
    // 有 data 包裹层用 data，否则退回整个信封（上游可能不套 data）
    const root = (j && j.data != null) ? j.data : (j || {});
    return this._extractCredits(root);
  },

  /**
   * 从 get-user-resource 响应中宽容解析积分。
   * 根因加固：不再假设资源包一定挂在 data.accounts[] —— 递归收集任意层级里带
   * capacityRemain/capacitySize（及其大小写/下划线/连字符变体）的字段并求和，
   * 兼容上游把数组改名为 resources / resourcePacks / packages / list 或加一层包裹。
   * 若整树都没有资源包字段（单值余额结构），退回顶层扁平键扫描。
   */
  _extractCredits(root) {
    const norm = (k) => String(k).toLowerCase().replace(/[_\s-]/g, "");
    const num = (v) => {
      if (typeof v === "number") return Number.isFinite(v) ? v : null;
      if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
      return null;
    };
    const REMAIN = new Set(["capacityremain", "remaincapacity", "remainingcapacity", "availablecapacity", "remainamount", "remaining", "remain"]);
    const SIZE = new Set(["capacitysize", "totalcapacity", "capacitytotal", "totalsize", "maxcapacity"]);
    let credits = null, total = null, matched = false;
    const seen = new Set();
    const walk = (node) => {
      if (!node || typeof node !== "object" || seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) { for (const it of node) walk(it); return; }
      for (const [k, v] of Object.entries(node)) {
        const nk = norm(k);
        if (REMAIN.has(nk)) { const n = num(v); if (n != null) { credits = (credits || 0) + n; matched = true; continue; } }
        if (SIZE.has(nk)) { const n = num(v); if (n != null) { total = (total || 0) + n; matched = true; continue; } }
        if (v && typeof v === "object") walk(v);
      }
    };
    walk(root);
    // 回落：非资源包结构（单值余额）——扫顶层扁平键
    if (!matched && root && typeof root === "object" && !Array.isArray(root)) {
      for (const [k, v] of Object.entries(root)) {
        const nk = norm(k);
        if (credits == null && ["credits", "credit", "remaining", "balance", "left", "quota", "points", "point"].includes(nk)) { const n = num(v); if (n != null) credits = n; }
        if (total == null && ["creditstotal", "total", "totalcredits", "limit", "quotatotal"].includes(nk)) { const n = num(v); if (n != null) total = n; }
      }
    }
    return { credits, total };
  },

  async testConnection(cfg) {
    const { credits, total } = await this._queryCredits(cfg);
    const detail = credits != null ? `积分 ${credits}${total != null ? ` / ${total}` : ""}` : "凭据有效";
    return { site: this.key, site_name: this.name, message: `连接成功，${detail}` };
  },

  /* 账号级余额快照（server 在签到/测试成功后调用）：返回当前积分（ΣcapacityRemain）。 */
  balanceLabel: "积分",
  async queryBalance(cfg) {
    const { credits } = await this._queryCredits(cfg);
    return credits != null ? Number(credits) : null; // 原始积分数值
  },
  /** 积分数值 → 展示串（整数优先，保留必要小数） */
  fmtBalance(v) {
    const n = Number(v) || 0;
    return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(4)));
  },

  _ok(status, message, cfg, reward, total) {
    return {
      site: this.key, site_name: this.name, status, message,
      reward: reward != null ? reward : "-", total: total != null ? total : "-",
      account: this.getAccountLabel(cfg), time: now(),
    };
  },
};

module.exports = {
  FLZT,
  RIGHT_FORUM,
  YPOJIE,
  NEWAPI,
  ANYROUTER,
  WORKBUDDY,
  isAlreadyCheckedIn,
  maskEmail,
  maskSecret,
  // ADAPTERS 单一事实源：store.js / server.js 均从这里导入，禁止各自维护拷贝
  ADAPTERS: { newapi: NEWAPI, anyrouter: ANYROUTER, ypojie: YPOJIE, right_forum: RIGHT_FORUM, flzt: FLZT, workbuddy: WORKBUDDY },
};
