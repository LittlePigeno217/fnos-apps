"use strict";
/**
 * checkin — 配置存储（config.json 持久化，fnOS 应用数据目录）。
 * 敏感值（站点密码/Cookie）以明文存于 config.json，目录权限由 fnOS 保证（应用数据目录）。
 */
const fs = require("fs");
const path = require("path");
const { FLZT, RIGHT_FORUM, YPOJIE, ANYROUTER } = require("./sites");

const ADAPTERS = { flzt: FLZT, right_forum: RIGHT_FORUM, ypojie: YPOJIE, anyrouter: ANYROUTER };
const SITE_KEYS = Object.keys(ADAPTERS);

// 站点默认配置单一事实源：每站点 { enabled, use_proxy, accounts: [] }（多账号模型）
const DEFAULT_SITES = {};
for (const key of SITE_KEYS) {
  DEFAULT_SITES[key] = { enabled: false, use_proxy: false, accounts: [] };
}

const DEFAULT_CONFIG = {
  enabled: false,          // 总开关
  version: "1.0.8",        // 功能版本（UI 左下角显示；热更后递增）
  cron: "08:10",           // 每日签到时刻 HH:MM
  notify_enabled: true,    // 飞书通知开关
  retry_count: 3,          // 站点失败重试次数
  feishu_webhook: "",      // 飞书机器人 Webhook
  sites: DEFAULT_SITES,
};

class Store {
  constructor(dataDir) {
    this._dataDir = dataDir;
    this._path = path.join(dataDir, "checkin_config.json");
    this._historyPath = path.join(dataDir, "checkin_history.json");
    this._cfg = this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this._path, "utf8"));
      return this._mergeDefaults(raw);
    } catch {
      return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    }
  }

  _mergeDefaults(raw) {
    const cfg = { ...DEFAULT_CONFIG, ...raw };
    cfg.sites = {};
    for (const k of SITE_KEYS) {
      const rawSite = (raw.sites || {})[k] || {};
      cfg.sites[k] = { enabled: !!rawSite.enabled, use_proxy: !!rawSite.use_proxy, accounts: this._migrateAccounts(rawSite) };
    }
    return cfg;
  }

  /** 旧版单账号格式 → 多账号 accounts[0]（顶层 email/password/cookie/... 迁移，登录信息不丢） */
  _migrateAccounts(rawSite) {
    const accs = Array.isArray(rawSite.accounts) ? rawSite.accounts.slice() : [];
    if (accs.length === 0) {
      const legacy = {};
      let has = false;
      for (const f of ["email", "password", "cookie", "username", "api_user", "base_url"]) {
        if (rawSite[f] !== undefined && rawSite[f] !== "") {
          legacy[f] = rawSite[f];
          has = true;
        }
      }
      if (has) accs.push({ id: this._nextAccountId([]), enabled: true, remark: "", ...legacy });
    }
    return accs.map((a) => ({
      id: a.id || this._nextAccountId(accs),
      enabled: a.enabled !== false,
      remark: String(a.remark || ""),
      email: String(a.email || ""),
      password: String(a.password || ""),
      cookie: String(a.cookie || ""),
      username: String(a.username || ""),
      api_user: String(a.api_user || ""),
      base_url: String(a.base_url || ""),
    }));
  }

  /** 生成下一个账号 id（a1/a2/...） */
  _nextAccountId(accs) {
    const n = (accs || []).reduce((m, a) => Math.max(m, parseInt(String((a && a.id) || "").replace(/\D/g, ""), 10) || 0), 0) + 1;
    return "a" + n;
  }

  save() {
    fs.mkdirSync(this._dataDir, { recursive: true });
    const tmp = this._path + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this._cfg, null, 2));
    fs.renameSync(tmp, this._path);
  }

  getConfig() {
    return this._cfg;
  }

  /** 保存配置（白名单键，敏感值允许写入） */
  saveConfig(patch) {
    const cfg = this._cfg;
    if (patch.enabled !== undefined) cfg.enabled = !!patch.enabled;
    if (patch.cron !== undefined) cfg.cron = String(patch.cron || "08:10");
    if (patch.notify_enabled !== undefined) cfg.notify_enabled = !!patch.notify_enabled;
    if (patch.retry_count !== undefined) {
      const n = parseInt(patch.retry_count, 10);
      cfg.retry_count = Number.isFinite(n) ? Math.max(1, Math.min(10, n)) : cfg.retry_count;
    }
    if (patch.feishu_webhook !== undefined) {
      const v = String(patch.feishu_webhook || "").trim();
      if (v) cfg.feishu_webhook = v; // 留空 = 不修改
    }
    if (patch.sites && typeof patch.sites === "object") {
      for (const k of SITE_KEYS) {
        const site = patch.sites[k];
        if (!site || typeof site !== "object") continue;
        const cur = cfg.sites[k];
        if (site.enabled !== undefined) cur.enabled = !!site.enabled;
        if (site.use_proxy !== undefined) cur.use_proxy = !!site.use_proxy;
        if (Array.isArray(site.accounts)) {
          const next = site.accounts
            .map((a) => {
              if (!a || typeof a !== "object") return null;
              const id = String(a.id || this._nextAccountId(cur.accounts));
              const prev = cur.accounts.find((x) => String(x.id) === id) || {};
              // 敏感值留空 = 保留原值
              return {
                id,
                enabled: a.enabled !== false,
                remark: String(a.remark !== undefined ? a.remark : (prev.remark || "")).trim(),
                email: String(a.email !== undefined ? a.email : (prev.email || "")).trim(),
                password: String(a.password !== undefined && a.password !== "" ? a.password : (prev.password || "")),
                cookie: String(a.cookie !== undefined && a.cookie !== "" ? a.cookie : (prev.cookie || "")).trim(),
                username: String(a.username !== undefined && a.username !== "" ? a.username : (prev.username || "")).trim(),
                api_user: String(a.api_user !== undefined && a.api_user !== "" ? a.api_user : (prev.api_user || "")).trim(),
                base_url: String(a.base_url !== undefined && a.base_url !== "" ? a.base_url : (prev.base_url || "")).trim(),
              };
            })
            .filter(Boolean);
          cur.accounts = next;
        }
      }
    }
    this.save();
    return this._cfg;
  }

  setVersion(v) {
    this._cfg.version = String(v || "1.0.0");
    this.save();
  }

  /* ── 历史记录 ─────────────────────────────── */
  getHistory(limit = 50) {
    try {
      const arr = JSON.parse(fs.readFileSync(this._historyPath, "utf8"));
      return Array.isArray(arr) ? arr.slice(0, limit) : [];
    } catch {
      return [];
    }
  }

  appendHistory(record) {
    let arr = [];
    try {
      arr = JSON.parse(fs.readFileSync(this._historyPath, "utf8"));
      if (!Array.isArray(arr)) arr = [];
    } catch {
      arr = [];
    }
    arr.unshift(record);
    if (arr.length > 500) arr = arr.slice(0, 500);
    fs.mkdirSync(this._dataDir, { recursive: true });
    fs.writeFileSync(this._historyPath, JSON.stringify(arr, null, 2));
  }

  clearHistory() {
    fs.mkdirSync(this._dataDir, { recursive: true });
    fs.writeFileSync(this._historyPath, JSON.stringify([], null, 2));
  }
}

module.exports = { Store, SITE_KEYS, DEFAULT_CONFIG };
