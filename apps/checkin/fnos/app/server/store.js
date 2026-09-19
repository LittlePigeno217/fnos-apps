"use strict";
/**
 * checkin — 配置存储（config.json 持久化，fnOS 应用数据目录）。
 * 敏感值（站点密码/Cookie）以明文存于 config.json，目录权限由 fnOS 保证（应用数据目录）。
 */
const fs = require("fs");
const path = require("path");
const { FLZT, RIGHT_FORUM, YPOJIE } = require("./sites");

const ADAPTERS = { flzt: FLZT, right_forum: RIGHT_FORUM, ypojie: YPOJIE };
const SITE_KEYS = Object.keys(ADAPTERS);

// 站点默认配置单一事实源：来自每个 adapter 的 defaultConfig()（内部补 use_proxy: false）
const DEFAULT_SITES = {};
for (const key of SITE_KEYS) {
  const adapter = ADAPTERS[key];
  DEFAULT_SITES[key] = { use_proxy: false, ...(adapter.defaultConfig ? adapter.defaultConfig() : {}) };
}

const DEFAULT_CONFIG = {
  enabled: false,          // 总开关
  version: "1.0.0",        // 功能版本（UI 左下角显示；热更后递增）
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
    cfg.sites = { ...DEFAULT_CONFIG.sites };
    for (const k of SITE_KEYS) {
      cfg.sites[k] = { ...DEFAULT_CONFIG.sites[k], ...((raw.sites || {})[k] || {}) };
    }
    return cfg;
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
        if (site.email !== undefined) cur.email = String(site.email || "").trim();
        if (site.password !== undefined) {
          const v = String(site.password || "");
          if (v) cur.password = v; // 留空 = 不修改
        }
        if (site.cookie !== undefined) {
          const v = String(site.cookie || "").trim();
          if (v) cur.cookie = v; // 留空 = 不修改
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
