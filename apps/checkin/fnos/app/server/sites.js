"use strict";
/**
 * checkin — 三个站点签到适配器（移植自 MoviePilot-Plugins/plugins/checkin v1.7.0）。
 * 每个 adapter 实现：isConfigured / runCheckin / testConnection / getAccountLabel
 * 统一返回/抛出：成功 {site, site_name, status, message, reward, total, account, time}
 * 失败抛 Error（原因供通知/历史展示）。
 */
const { Session, parseJson, cleanText, extractFormhash } = require("./httpc");

/* ── 通用识别 ─────────────────────────────────────────────── */
function isAlreadyCheckedIn(message) {
  const text = String(message || "").trim().toLowerCase();
  return (
    ["already checked in", "已签到", "今日已签", "今天已签", "今天已经签过", "今天已经签过到", "签过到", "明儿再来"].some((k) => text.includes(k))
  );
}

function maskEmail(email) {
  if (!email || !email.includes("@")) return email || "-";
  const [name, domain] = email.split("@", 2);
  const masked = name.length <= 2 ? "*".repeat(name.length) : name[0] + "*".repeat(Math.max(name.length - 2, 1)) + name[name.length - 1];
  return `${masked}@${domain}`;
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

/* ── FLZT ─────────────────────────────────────────────────── */
const FLZT = {
  key: "flzt",
  name: "FLZT",
  short: "FL",
  mode: "账号密码",
  desc: "flzt.club · 账号密码登录后调用签到 API",
  fields: [
    { key: "email", label: "账号 / 邮箱", type: "text", ph: "name@example.com" },
    { key: "password", label: "密码", type: "password", ph: "输入新密码（留空不改）" },
  ],
  base: "https://flzt.club",
  loginPath: "/api/v1/passport/auth/login",
  checkinPath: "/api/v1/user/checkIn",

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
    const total = fmtTraffic(data.total_checkin_traffic);

    if (j.status === "success") {
      return this._ok("签到成功", message || "签到成功", reward, total, cfg);
    }
    if (isAlreadyCheckedIn(message)) {
      return this._ok("今日已签到", message, reward, total, cfg);
    }
    throw new Error(message || "签到失败");
  },

  async testConnection(cfg) {
    const token = await this._resolveToken(cfg);
    return { site: this.key, site_name: this.name, message: `登录测试成功（Token ${token.slice(0, 12)}…）` };
  },

  _ok(status, message, reward, total, cfg) {
    return { site: this.key, site_name: this.name, status, message, reward, total, account: this.getAccountLabel(cfg), time: now() };
  },
};

/* ── 恩山无线论坛 ─────────────────────────────────────────── */
const RIGHT_FORUM = {
  key: "right_forum",
  name: "恩山无线论坛",
  short: "恩",
  mode: "Cookie",
  desc: "right.com.cn · Cookie 签到（formhash + 人机验证识别）",
  fields: [
    { key: "cookie", label: "Cookie", type: "password", ph: "粘贴浏览器 Cookie（留空不改）" },
  ],
  base: "https://www.right.com.cn/forum",
  signPages: ["/plugin.php?id=erling_qd:sign_in", "/erling_qd-sign_in.html"],
  signAction: "/plugin.php?id=erling_qd:action&action=sign",
  forumPage: "/forum.php",
  CHALLENGE_MARKERS: ["_waf_is_mobile", "CF_APP_WAF", '"sceneId"', 'id="renderData"'],

  defaultConfig() {
    return { enabled: false, use_proxy: false, cookie: "" };
  },
  isConfigured(cfg) {
    return !!(cfg && cfg.cookie && cfg.cookie.trim());
  },
  getAccountLabel() {
    return "Cookie";
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

  async runCheckin(cfg) {
    const cookie = (cfg.cookie || "").trim();
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

    return {
      site: this.key, site_name: this.name, status: statusText, message: finalMsg,
      reward: "-", total: "-", account: "Cookie", time: now(),
    };
  },

  async testConnection(cfg) {
    await this._fetchSignPage((cfg.cookie || "").trim(), cfg.use_proxy);
    return { site: this.key, site_name: this.name, message: "Cookie 有效，签到页可访问" };
  },
};

/* ── 易破解 ───────────────────────────────────────────────── */
const YPOJIE = {
  key: "ypojie",
  name: "易破解",
  short: "易",
  mode: "账号密码",
  desc: "ypojie.com · WordPress 登录后 AJAX 签到",
  fields: [
    { key: "email", label: "账号 / 邮箱", type: "text", ph: "name@example.com" },
    { key: "password", label: "密码", type: "password", ph: "输入新密码（留空不改）" },
  ],
  base: "https://www.ypojie.com",
  vipPath: "/vip?pd=money",
  loginPath: "/wp-login.php",
  ajaxPath: "/wp-admin/admin-ajax.php",

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

  /** 会话优先取登录态 Session：有效 session（type=cookie）→ 用 Cookie 构造并校验；否则登录 */
  async _resolveSession(cfg) {
    if (sessionValid(cfg) && cfg.session.type === "cookie" && cfg.session.cookie) {
      const s = sessionFromCookie(cfg.session.cookie);
      const vip = await this._getVip(s, cfg);
      this._validateLoginPage(vip.text); // 会话失效则抛错（提示重新登录）
      return { s, beforePage: vip.text };
    }
    return this._login(cfg);
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
    const beforeBal = this._extractBalance(beforePage);
    const afterBal = this._extractBalance(afterPage);
    if (beforeBal != null && afterBal != null && afterBal >= beforeBal) {
      const diff = afterBal - beforeBal;
      if (diff > 0) rewardMsg = `本次签到增加：${diff.toFixed(2)}积分`;
    }

    const message = j.msg || j.message || "";
    if (Number(j.status) === 200) {
      return {
        site: this.key, site_name: this.name, status: "签到成功",
        message: rewardMsg || message || "签到成功", reward: "-", total: "-",
        account: this.getAccountLabel(cfg), time: now(),
      };
    }
    if (message && isAlreadyCheckedIn(message)) {
      return {
        site: this.key, site_name: this.name, status: "今日已签到",
        message: rewardMsg || message, reward: "-", total: "-",
        account: this.getAccountLabel(cfg), time: now(),
      };
    }
    throw new Error(message || `易破解签到失败（status=${j.status}）`);
  },

  async testConnection(cfg) {
    await this._resolveSession(cfg);
    return { site: this.key, site_name: this.name, message: "登录测试成功，可用于签到" };
  },
};

/* ── AnyRouter / NewAPI 通用（anyrouter-check-in 移植）────────────── */
const ANYROUTER = {
  key: "anyrouter",
  name: "AnyRouter / NewAPI 通用",
  short: "AR",
  mode: "Cookie / 账号",
  desc: "anyrouter.top 及 NewAPI/OneAPI 平台 · Cookie 或账号密码签到",
  fields: [
    { key: "base_url", label: "平台地址", type: "text", ph: "https://anyrouter.top（自建 NewAPI 填内网地址）" },
    { key: "username", label: "账号", type: "text", ph: "账号密码方式（二选一，无 WAF 平台可用）" },
    { key: "password", label: "密码", type: "password", ph: "输入新密码（留空不改）" },
    { key: "cookie", label: "Cookie", type: "password", ph: "浏览器会话 Cookie（二选一，WAF 站点用这个）" },
    { key: "api_user", label: "API User", type: "text", ph: "new-api-user 值（Cookie 方式可选）" },
  ],
  base: "https://anyrouter.top",
  loginPath: "/api/user/login",
  signInPath: "/api/user/sign_in",
  fallbackSignInPath: "/api/user/checkin", // OneAPI 平台
  userInfoPath: "/api/user/self",
  WAF_MARKERS: ["acw_sc__v2", "var arg1=", "cdn_sec_tc"],

  defaultConfig() {
    return {
      enabled: false, use_proxy: false,
      base_url: "https://anyrouter.top",
      username: "", password: "", cookie: "", api_user: "",
    };
  },
  isConfigured(cfg) {
    if (!cfg) return false;
    if (cfg.username && cfg.password) return true;         // 账号密码方式
    if (cfg.cookie && String(cfg.cookie).trim()) return true; // Cookie 方式
    return false;
  },
  getAccountLabel(cfg) {
    if (cfg && cfg.username) return maskEmail(cfg.username);
    if (cfg && cfg.api_user) return "User " + cfg.api_user;
    return "Cookie";
  },

  _base(cfg) {
    return String((cfg && cfg.base_url) || this.base || "").trim().replace(/\/+$/, "");
  },
  /** 阿里云盾 WAF JS 挑战页识别（anyrouter.top 无 WAF cookie 时被拦） */
  _isWafChallenge(text) {
    const t = String(text || "").toLowerCase();
    return this.WAF_MARKERS.some((m) => t.includes(m.toLowerCase()));
  },
  _isLoginExpired(status, text) {
    if (status === 401) return true;
    const t = String(text || "").toLowerCase();
    return /session.*(invalid|expired)|token.*(invalid|expired)|未登录|登录已过期|invalid session/i.test(t);
  },
  _headers(auth, extra) {
    const h = { Accept: "application/json, text/plain, */*", ...(extra || {}) };
    if (auth.type === "token") h.Authorization = "Bearer " + auth.token;
    else Object.assign(h, auth.headers);
    return h;
  },

  /** 构造认证：账号密码 → /api/user/login 拿 token；Cookie → 直接带 Cookie（+new-api-user） */
  async _authHeaders(cfg) {
    const base = this._base(cfg);
    if (!base) throw new Error("请先配置平台地址（base_url）");
    if (cfg.username && cfg.password) {
      const s = new Session();
      const r = await s.postJson(base + this.loginPath, { username: cfg.username, password: cfg.password }, { timeout: 15000, useProxy: cfg.use_proxy });
      if (this._isWafChallenge(r.text)) {
        throw new Error(`平台有 WAF 人机验证，账号密码方式被拦截：请在浏览器访问 ${base} 后改用「Cookie + api_user」方式配置`);
      }
      const j = parseJson(r.text);
      if (!j || !j.success || !(j.data || {}).access_token) {
        throw new Error((j && (j.message || j.msg)) || `登录失败（HTTP ${r.status}）`);
      }
      return { type: "token", token: j.data.access_token, base };
    }
    if (cfg.cookie && String(cfg.cookie).trim()) {
      const h = { Cookie: String(cfg.cookie).trim() };
      if (cfg.api_user) h["new-api-user"] = String(cfg.api_user).trim();
      return { type: "cookie", headers: h, base };
    }
    throw new Error("请配置账号密码，或 Cookie + api_user");
  },

  /** 会话优先构造认证：有效 session（token/cookie）直接用；否则走 _authHeaders 登录 */
  async _resolveAuth(cfg) {
    if (sessionValid(cfg) && cfg.session && typeof cfg.session === "object") {
      const sess = cfg.session;
      if (sess.type === "token" && sess.token) {
        return { type: "token", token: sess.token, base: sess.base || this._base(cfg) };
      }
      if (sess.type === "cookie" && sess.headers) {
        return { type: "cookie", headers: sess.headers, base: sess.base || this._base(cfg) };
      }
    }
    return this._authHeaders(cfg);
  },

  loginFlow: {
    mode: "form",
    desc: "账号密码 / Cookie 产出会话（token 或 cookie）",
    async init(cfg) {
      const auth = await ANYROUTER._authHeaders(cfg);
      const session = auth.type === "token"
        ? { type: "token", token: auth.token, base: auth.base }
        : { type: "cookie", headers: auth.headers, base: auth.base };
      return {
        mode: "form",
        status: "ready",
        session,
        account_label: ANYROUTER.getAccountLabel(cfg),
        message: "登录成功",
      };
    },
  },

  async _getUserInfo(auth, useProxy) {
    const s = new Session();
    const r = await s.get(auth.base + this.userInfoPath, { headers: this._headers(auth), timeout: 15000, useProxy });
    if (r.status === 401) throw new Error("登录态失效（HTTP 401）：Cookie 过期或 Token 无效，请重新获取（session 约 1 个月有效）");
    const j = parseJson(r.text);
    if (!j || !j.success || !(j.data || {}).quota) return null;
    return { quota: Number(j.data.quota) || 0, used_quota: Number(j.data.used_quota) || 0 };
  },

  _fmtUsd(quota) {
    return "$" + (Number(quota || 0) / 500000).toFixed(2); // NewAPI quota：500000 点 = $1
  },

  async runCheckin(cfg) {
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
    }

    if (this._isWafChallenge(r.text)) {
      throw new Error(`平台 WAF 拦截（Cookie 缺人机验证）：请在浏览器访问 ${auth.base} 通过验证后重新复制完整 Cookie`);
    }
    if (this._isLoginExpired(r.status, r.text)) {
      throw new Error(`登录态失效（HTTP ${r.status}）：Cookie 过期或 Token 无效，请重新获取（session 约 1 个月有效）`);
    }

    const j = parseJson(r.text);
    if (!j || typeof j !== "object") {
      throw new Error(`签到接口没回 JSON：${cleanText(r.text).slice(0, 60) || "空响应"}`);
    }
    const msg = String(j.msg || j.message || "").trim();
    const success = j.ret === 1 || j.code === 0 || j.success === true;

    // 签到后余额（对比奖励）
    let after = null;
    try { after = await this._getUserInfo(auth, cfg.use_proxy); } catch { /* 取不到不致命 */ }
    const balanceMsg = after
      ? `余额 ${this._fmtUsd(after.quota)}` + (after.used_quota ? `，累计消耗 ${this._fmtUsd(after.used_quota)}` : "")
      : "";
    let rewardMsg = "";
    if (before && after && after.quota > before.quota) {
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
    const info = await this._getUserInfo(auth, cfg.use_proxy);
    if (!info) throw new Error("登录态有效，但用户信息接口未返回 quota");
    return { site: this.key, site_name: this.name, message: `连接成功，${cfg.username ? maskEmail(cfg.username) : "Cookie"} 有效，余额 ${this._fmtUsd(info.quota)}` };
  },

  _ok(status, message, reward, total, cfg, auth) {
    return { site: this.key, site_name: this.name, status, message, reward, total, account: (cfg && cfg.username) ? maskEmail(cfg.username) : (auth && auth.type === "cookie" ? (cfg.api_user ? "User " + cfg.api_user : "Cookie") : "-"), time: now() };
  },
};

module.exports = {
  FLZT,
  RIGHT_FORUM,
  YPOJIE,
  ANYROUTER,
  isAlreadyCheckedIn,
  maskEmail,
  // ADAPTERS 单一事实源：store.js / server.js 均从这里导入，禁止各自维护拷贝
  ADAPTERS: { flzt: FLZT, right_forum: RIGHT_FORUM, ypojie: YPOJIE, anyrouter: ANYROUTER },
};
