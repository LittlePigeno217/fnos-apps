"use strict";
/**
 * checkin — 配置存储（config.json 持久化，fnOS 应用数据目录）。
 * 敏感值（站点密码/Cookie）以明文存于 config.json，目录权限由 fnOS 保证（应用数据目录）。
 */
const fs = require("fs");
const path = require("path");
const { ADAPTERS } = require("./sites");   // ADAPTERS 单一事实源（本地不再维护拷贝）

const SITE_KEYS = Object.keys(ADAPTERS);

/** 某站点账号字段 key 集：来自 adapter.fields（前端表单与后端白名单同源） */
function accountFieldKeys(slug) {
  const adapter = ADAPTERS[slug];
  return Array.isArray(adapter && adapter.fields) ? adapter.fields.map((f) => f.key) : [];
}

// 站点默认配置单一事实源：每站点 { enabled, use_proxy, accounts: [] }（多账号模型）
const DEFAULT_SITES = {};
for (const key of SITE_KEYS) {
  DEFAULT_SITES[key] = { enabled: false, use_proxy: false, accounts: [] };
}

const DEFAULT_CONFIG = {
  enabled: false,          // 总开关
  version: "1.3.2",        // 功能版本（UI 左下角显示；热更后递增）
  cron: "08:10",           // 每日签到时刻 HH:MM
  notify_enabled: true,    // 飞书通知开关
  retry_count: 3,          // 站点失败重试次数
  feishu_webhook: "",      // 飞书机器人 Webhook
  auth_enabled: false,     // 面板鉴权总开关（阶段3 B，默认关闭）
  auth_token: "",          // 面板访问口令（明文本地防护；开启鉴权时必须非空）
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
    // 版本永远反映当前代码常量（DEFAULT_CONFIG.version，由 --bump 同步）：
    // 不参与持久化合并，避免 config 文件旧版本号在「fpk 升级 / 热更未回写」时
    // 覆盖新字面量，导致重启后版本号不变（对齐 p115assistant 已验证机制）。
    cfg.version = DEFAULT_CONFIG.version;
    // 面板鉴权字段类型规整（旧 config 无此字段时回落默认）
    cfg.auth_enabled = !!raw.auth_enabled;
    cfg.auth_token = String(raw.auth_token || "");
    cfg.sites = {};
    for (const k of SITE_KEYS) {
      const rawSite = (raw.sites || {})[k] || {};
      cfg.sites[k] = { enabled: !!rawSite.enabled, use_proxy: !!rawSite.use_proxy, accounts: this._migrateAccounts(rawSite, k) };
    }
    return cfg;
  }

  /** 旧版单账号格式 → 多账号 accounts[0]（顶层凭据字段迁移，登录信息不丢） */
  _migrateAccounts(rawSite, slug) {
    let accs = Array.isArray(rawSite.accounts) ? rawSite.accounts.slice() : [];
    if (accs.length === 0) {
      const legacy = {};
      let has = false;
      for (const f of accountFieldKeys(slug)) {
        if (rawSite[f] !== undefined && rawSite[f] !== "") {
          legacy[f] = rawSite[f];
          has = true;
        }
      }
      if (has) accs = [{ enabled: true, remark: "", ...legacy }];
    }
    const allocId = this._createIdAllocator(accs);
    return accs.map((a) => {
      const base = {
        id: String(a.id || allocId()),
        enabled: a.enabled !== false,
        remark: String(a.remark || ""),
        // session：登录产物（token/cookie），旧文件无此字段自动补 null（不强制清理）
        session: (a.session && typeof a.session === "object") ? a.session : null,
        session_ts: Number(a.session_ts) || 0,
        // balance：账号级余额快照（workbuddy 积分 / anyrouter quota）。旧文件无此字段 → null；
        // balance_delta：与上次快照的差值（无上次 → null）；balance_ts：快照时间戳（毫秒）。
        balance: (a.balance === null || a.balance === undefined || a.balance === "") ? null : Number(a.balance),
        balance_delta: (a.balance_delta === null || a.balance_delta === undefined || a.balance_delta === "") ? null : Number(a.balance_delta),
        balance_ts: Number(a.balance_ts) || 0,
      };
      // 字段按 adapter.fields 动态遍历（新站点类型新字段无需改白名单）
      for (const f of accountFieldKeys(slug)) {
        base[f] = String(a[f] || "");
      }
      return base;
    });
  }

  /** 批量分配账号 id 的游标：seed 为已占用的 id 列表（对象数组或字符串数组）。
   *  返回「生成并登记一个新 id」的闭包；同一次保存的多个新账号共享同一游标，
   *  保证 id 互不相同且递增（a1/a2/…），避免多个新账号拿到相同 id（下次编辑凭据串号）。 */
  _createIdAllocator(seed) {
    const used = new Set((seed || []).map((a) => String((a && a.id) || "")).filter(Boolean));
    return () => {
      let max = 0;
      for (const id of used) {
        const m = parseInt(String(id).replace(/\D/g, ""), 10);
        if (Number.isFinite(m) && m > max) max = m;
      }
      const id = "a" + (max + 1);
      used.add(id);
      return id;
    };
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
    // 面板鉴权：口令留空=保留原值（与 feishu_webhook 一致的敏感字段惯例）；
    // 开启前必须已有口令的校验由 Server.saveConfig 完成（store 层只落值）。
    if (patch.auth_token !== undefined) {
      const v = String(patch.auth_token || "").trim();
      if (v) cfg.auth_token = v;
    }
    if (patch.auth_enabled !== undefined) cfg.auth_enabled = !!patch.auth_enabled;
    if (patch.sites && typeof patch.sites === "object") {
      for (const k of SITE_KEYS) {
        const site = patch.sites[k];
        if (!site || typeof site !== "object") continue;
        const cur = cfg.sites[k];
        if (site.enabled !== undefined) cur.enabled = !!site.enabled;
        if (site.use_proxy !== undefined) cur.use_proxy = !!site.use_proxy;
        if (Array.isArray(site.accounts)) {
          // 同一次保存的多个新账号共享 id 游标：seed 自旧列表全部 id，
          // 每生成一个新 id 即登记，避免多个新账号拿到相同 id（下次编辑凭据串号）。
          const allocId = this._createIdAllocator(cur.accounts);
          const next = site.accounts
            .map((a) => {
              if (!a || typeof a !== "object") return null;
              const id = String(a.id || allocId());
              const prev = cur.accounts.find((x) => String(x.id) === id) || {};
              // 敏感值留空 = 保留原值（password/cookie 等由 adapter 字段驱动；规则统一）
              const merged = {
                id,
                enabled: a.enabled !== false,
                remark: String(a.remark !== undefined ? a.remark : (prev.remark || "")).trim(),
              };
              // session（登录产物）语义区别于明文字段：
              //   undefined → 保留现值；null/空串 → 清空（登出）；对象 → 整体替换
              if (a.session === undefined) {
                merged.session = prev.session || null;
                merged.session_ts = Number(prev.session_ts) || 0;
              } else if (a.session === null || a.session === "") {
                merged.session = null;
                merged.session_ts = 0;
              } else if (typeof a.session === "object") {
                merged.session = a.session;
                merged.session_ts = Number(a.session_ts) || Date.now();
              } else {
                merged.session = prev.session || null;
                merged.session_ts = Number(prev.session_ts) || 0;
              }
              // balance 快照非 UI 表单字段：patch 未带则保留现值（余额只由签到/测试写入）
              merged.balance = (a.balance === null || a.balance === undefined || a.balance === "")
                ? (prev.balance === null || prev.balance === undefined ? null : Number(prev.balance))
                : Number(a.balance);
              merged.balance_delta = (a.balance_delta === null || a.balance_delta === undefined || a.balance_delta === "")
                ? (prev.balance_delta === null || prev.balance_delta === undefined ? null : Number(prev.balance_delta))
                : Number(a.balance_delta);
              merged.balance_ts = Number(a.balance_ts) || Number(prev.balance_ts) || 0;
              for (const f of accountFieldKeys(k)) {
                const rawV = a[f];
                const prevV = prev[f] || "";
                if (rawV === undefined) {
                  merged[f] = prevV;
                } else if (rawV === "") {
                  // 留空 = 保留原值（对 password/cookie 等敏感字段语义一致）
                  merged[f] = prevV;
                } else {
                  merged[f] = String(rawV).trim();
                }
              }
              return merged;
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
