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

/** TOTP（RFC 6238，对齐 all-api-hub：SHA1 / 6 位 / 30 秒 / Base32 密钥）——2FA 登录 */
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

/** 1.8.3：Turnstile 类「签到需人机验证」识别——面板签到接口开启
 *  Turnstile 强校验时，后端无浏览器环境产不出 token（如「Turnstile token 为空」）→ 该站
 *  无自动签到能力。小写化 contains 匹配，信号以适配器实际抛出的 message
 *  实际会抛出的 message 为准：turnstile / cf-turnstile / 人机验证 / verification required /
 *  verify you are human。刻意不含「已签到」类正常文案，避免误伤。 */
const TURNSTILE_MARKERS = ["turnstile", "cf-turnstile", "人机验证", "verification required", "verify you are human", "are you human"];
function isTurnstileRequired(message) {
  const t = String(message || "").toLowerCase();
  return TURNSTILE_MARKERS.some((m) => t.includes(m.toLowerCase()));
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

module.exports = {
  FLZT,
  RIGHT_FORUM,
  YPOJIE,
  isAlreadyCheckedIn,
  isTurnstileRequired,
  maskEmail,
  maskSecret,
  // ADAPTERS 单一事实源：store.js / server.js 均从这里导入，禁止各自维护拷贝
  ADAPTERS: { ypojie: YPOJIE, right_forum: RIGHT_FORUM, flzt: FLZT },
};
