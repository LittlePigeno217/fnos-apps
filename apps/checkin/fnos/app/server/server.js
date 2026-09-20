"use strict";
/**
 * checkin — API 层（Node.js 版）。
 * 方法：getConfig / saveConfig / status / runOnce / testLogin / getHistory / clearHistory
 * 统一返回 { success, message, data }。
 */
const { FLZT, RIGHT_FORUM, YPOJIE, ANYROUTER } = require("./sites");

const ADAPTERS = { flzt: FLZT, right_forum: RIGHT_FORUM, ypojie: YPOJIE, anyrouter: ANYROUTER };

function ok(data, message = "") {
  return { success: true, message, data };
}
function fail(message) {
  return { success: false, message: String(message || "未知错误"), data: {} };
}

class Server {
  constructor(store, notifier, log) {
    this._store = store;
    this._notifier = notifier || null;
    this._log = log || (() => {});
    this._running = false; // 防并发执行
  }

  getConfig() {
    const cfg = this._store.getConfig();
    const publicCfg = {
      enabled: cfg.enabled,
      version: cfg.version,          // 功能版本（左下角显示）
      cron: cfg.cron,
      notify_enabled: cfg.notify_enabled,
      retry_count: cfg.retry_count,
      feishu_configured: !!(cfg.feishu_webhook),
      sites: {},
    };
    for (const key of Object.keys(ADAPTERS)) {
      const site = cfg.sites[key] || {};
      const adapter = ADAPTERS[key];
      const accs = Array.isArray(site.accounts) ? site.accounts : [];
      publicCfg.sites[key] = {
        name: adapter.name,
        mode: adapter.mode,
        enabled: !!site.enabled,
        use_proxy: !!site.use_proxy,
        configured: accs.some((a) => adapter.isConfigured(a)),
        accounts: accs.map((a) => ({
          id: a.id,
          enabled: a.enabled !== false,
          remark: a.remark || "",
          label: adapter.getAccountLabel(a),
          configured: adapter.isConfigured(a),
        })),
      };
    }
    return ok(publicCfg);
  }

  saveConfig(patch) {
    const cfg = this._store.saveConfig(patch || {});
    return ok({ version: cfg.version, enabled: cfg.enabled, cron: cfg.cron, notify_enabled: cfg.notify_enabled, feishu_configured: !!cfg.feishu_webhook });
  }

  status() {
    const cfg = this._store.getConfig();
    const sites = {};
    for (const key of Object.keys(ADAPTERS)) {
      const site = cfg.sites[key] || {};
      const adapter = ADAPTERS[key];
      const accs = Array.isArray(site.accounts) ? site.accounts : [];
      sites[key] = {
        name: adapter.name,
        enabled: !!site.enabled,
        configured: accs.some((a) => adapter.isConfigured(a)),
        account_count: accs.length,
        accounts: accs.map((a) => ({
          id: a.id,
          enabled: a.enabled !== false,
          remark: a.remark || "",
          label: adapter.getAccountLabel(a),
          configured: adapter.isConfigured(a),
        })),
      };
    }
    return ok({ enabled: cfg.enabled, cron: cfg.cron, version: cfg.version, sites });
  }

  /** 立即执行签到：全部启用的站点；sites 参数可选（仅执行指定站点） */
  async runOnce(sitesArg) {
    if (this._running) {
      return fail("签到正在执行中，请稍后再试");
    }
    this._running = true;
    try {
      const cfg = this._store.getConfig();
      if (!cfg.enabled) {
        return fail("总开关未开启（设置 → 应用启用）");
      }
      const wanted = Array.isArray(sitesArg) && sitesArg.length ? sitesArg : null;
      const results = [];
      const history = [];
      for (const key of Object.keys(ADAPTERS)) {
        if (wanted && !wanted.includes(key)) continue;
        const site = cfg.sites[key];
        if (!site || !site.enabled) continue;
        const adapter = ADAPTERS[key];
        const accs = (Array.isArray(site.accounts) ? site.accounts : []).filter((a) => a.enabled !== false);
        if (!accs.length) continue;
        for (const acc of accs) {
          const accLabel = adapter.getAccountLabel(acc);
          const who = accLabel ? `（${accLabel}）` : "";
          this._log(`签到 ${adapter.name}${who}…`);
          try {
            if (!adapter.isConfigured(acc)) throw new Error("该账号尚未配置凭据");
            const r = await adapter.runCheckin(acc);
            results.push({ site_key: key, account_id: acc.id, account: accLabel, ...r });
            history.push({ time: r.time, site: key, site_name: r.site_name, account_id: acc.id, account: accLabel, status: r.status, message: r.message, error: "" });
            this._log(`签到 ${adapter.name} → ${r.status}`);
          } catch (err) {
            const msg = err.message || String(err);
            results.push({ site_key: key, account_id: acc.id, account: accLabel, site_name: adapter.name, status: "执行失败", error: msg });
            history.push({ time: new Date().toLocaleString("zh-CN", { hour12: false }), site: key, site_name: adapter.name, account_id: acc.id, account: accLabel, status: "执行失败", message: "", error: msg });
            this._log(`签到 ${adapter.name}${who} 失败：${msg}`);
          }
        }
      }
      for (const h of history.reverse()) this._store.appendHistory(h);
      const allOk = results.length > 0 && results.every((r) => r.status !== "执行失败");
      if (this._notifier && cfg.notify_enabled) {
        const text = this._notifier.buildNotifyText("签到工具", results);
        const sent = await this._notifier.sendText(cfg.feishu_webhook, text);
        if (sent) this._log("签到通知已发送");
      }
      this._lastResults = results;
      return ok({ results, summary: allOk ? "全部成功" : (results.length ? "部分成功" : "无启用的站点"), total: results.length, success_count: results.filter((r) => r.status !== "执行失败").length });
    } finally {
      this._running = false;
    }
  }

  async testLogin(siteKey, accountId) {
    const adapter = ADAPTERS[siteKey];
    if (!adapter) return fail(`未知站点：${siteKey}`);
    const cfg = this._store.getConfig();
    const site = cfg.sites[siteKey];
    const accs = (site && Array.isArray(site.accounts) ? site.accounts : []).filter((a) => a.enabled !== false);
    const acc = accountId ? accs.find((a) => String(a.id) === String(accountId)) : accs[0];
    if (!acc || !adapter.isConfigured(acc)) return fail(accountId ? "该账号尚未配置凭据" : "该站点没有可用账号");
    try {
      const r = await adapter.testConnection(acc);
      return ok({ ...r, account_id: acc.id, account: adapter.getAccountLabel(acc) });
    } catch (err) {
      return fail(err.message || "测试失败");
    }
  }

  getHistory(limit) {
    return ok({ records: this._store.getHistory(Number(limit) || 50) });
  }

  clearHistory() {
    this._store.clearHistory();
    return ok({ cleared: true });
  }
}

module.exports = { Server, ADAPTERS };