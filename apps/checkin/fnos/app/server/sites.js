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

/* ── FLZT ─────────────────────────────────────────────────── */
const FLZT = {
  key: "flzt",
  name: "FLZT",
  mode: "账号密码",
  base: "https://flzt.club",
  loginPath: "/api/v1/passport/auth/login",
  checkinPath: "/api/v1/user/checkIn",

  defaultConfig() {
    return { enabled: false, email: "", password: "" };
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

  async runCheckin(cfg) {
    const { token } = await this._login(cfg);
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
    const { token } = await this._login(cfg);
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
  mode: "Cookie",
  base: "https://www.right.com.cn/forum",
  signPages: ["/plugin.php?id=erling_qd:sign_in", "/erling_qd-sign_in.html"],
  signAction: "/plugin.php?id=erling_qd:action&action=sign",
  forumPage: "/forum.php",
  CHALLENGE_MARKERS: ["_waf_is_mobile", "CF_APP_WAF", '"sceneId"', 'id="renderData"'],

  defaultConfig() {
    return { enabled: false, cookie: "" };
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
  mode: "账号密码",
  base: "https://www.ypojie.com",
  vipPath: "/vip?pd=money",
  loginPath: "/wp-login.php",
  ajaxPath: "/wp-admin/admin-ajax.php",

  defaultConfig() {
    return { enabled: false, email: "", password: "" };
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

  _extractSlider(page) {
    const token = String(page || "").match(/name="slider_token"\s+value="([^"]+)"/);
    const nonce = String(page || "").match(/name="slider_nonce"\s+value="([^"]+)"/);
    if (!token || !nonce) return { verified: false };
    return { verified: true, slider_token: token[1], slider_nonce: nonce[1] };
  },

  _validateLoginPage(page) {
    if (page.includes("Hi,") || page.includes("今日签到") || page.includes("个人中心")) return;
    if (page.includes("wp-login.php") || page.includes("用户名或电子邮件地址") || page.includes("登录")) {
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
    await s.postForm(this.base + this.loginPath, form, { headers: this._loginHeaders(), timeout: 15000, useProxy: cfg.use_proxy });

    // 登录后验证：访问 vip 页确认已登录
    const vipPage = await s.get(this.base + this.vipPath, { headers: this._loginHeaders(), timeout: 15000, useProxy: cfg.use_proxy });
    this._validateLoginPage(vipPage.text);
    return { s, beforePage: vipPage.text };
  },

  async runCheckin(cfg) {
    const { s, beforePage } = await this._login(cfg);
    const r = await s.postForm(this.base + this.ajaxPath, { action: "epd_checkin" }, { headers: this._loginHeaders(), timeout: 15000, useProxy: cfg.use_proxy });
    const j = parseJson(r.text) || {};
    let afterPage = "";
    try {
      const after = await s.get(this.base + this.vipPath, { headers: this._loginHeaders(), timeout: 15000, useProxy: cfg.use_proxy });
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
    await this._login(cfg);
    return { site: this.key, site_name: this.name, message: "登录测试成功，可用于签到" };
  },
};

module.exports = { FLZT, RIGHT_FORUM, YPOJIE, isAlreadyCheckedIn, maskEmail };
