"use strict";
/**
 * checkin — API 层（Node.js 版）。
 * 方法：getConfig / saveConfig / status / runOnce / testLogin / getHistory / clearHistory
 * 统一返回 { success, message, data }。
 */
const crypto = require("crypto");
const { ADAPTERS } = require("./sites");   // ADAPTERS 单一事实源（本地不再维护拷贝）
const qrcode = require("./qrcode");        // 纯 JS 二维码编码（扫码登录 auth_url → 图片）

/** auth_url → data:image/gif base64 二维码（离线本地生成，不外传登录票据） */
function renderQrDataUrl(text) {
  try {
    const t = qrcode(0, "M"); // type 0=自动版本，纠错级 M
    t.addData(String(text));
    t.make();
    return t.createDataURL(4, 8); // cellSize=4, margin=8
  } catch {
    return ""; // 生成失败：前端回落展示链接
  }
}

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
    this._loginSessions = new Map(); // 扫码登录会话：token → { site, account_id, sess, expires_at }（进程内，重启即失效）
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
        // meta：站点元数据单一事实源（前端据此渲染，新增站点前端零改动）
        meta: {
          key: adapter.key,
          name: adapter.name,
          short: adapter.short || "",
          mode: adapter.mode,
          desc: adapter.desc || "",
          fields: Array.isArray(adapter.fields) ? adapter.fields : [],
          // login_caps：登录能力（qr/password/password_cookie/cookie）——前端「添加账号」窗口据此渲染 tab
          login_caps: Array.isArray(adapter.login_caps) ? adapter.login_caps : [],
        },
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
    patch = patch || {};
    const cfg = this._store.saveConfig(patch);
    return ok({
      version: cfg.version,
      enabled: cfg.enabled,
      cron: cfg.cron,
      notify_enabled: cfg.notify_enabled,
      feishu_configured: !!cfg.feishu_webhook,
    });
  }

  status() {
    const cfg = this._store.getConfig();
    const history = this._store.getHistory(500);
    const sites = {};
    for (const key of Object.keys(ADAPTERS)) {
      const site = cfg.sites[key] || {};
      const adapter = ADAPTERS[key];
      const accs = Array.isArray(site.accounts) ? site.accounts : [];
      // per-site 聚合：扫描该站全部历史记录（最新在前），避免「最后一条是成功」掩盖早前失败：
      // 任一「执行失败」→ today_failed；否则存在今日成功/已签到 → today_ok。
      const siteHist = (history || []).filter((h) => h && h.site === key);
      const last = siteHist[0] || null;
      let today_ok = false;
      let today_failed = false;
      for (const h of siteHist) {
        if (!sameDayStr(h.time)) continue;
        if (h.status === "执行失败") { today_failed = true; break; }
        today_ok = true;
      }
      if (today_failed) today_ok = false;
      sites[key] = {
        name: adapter.name,
        enabled: !!site.enabled,
        use_proxy: !!site.use_proxy, // status 结构对齐 get_config：前端 renderSiteCards 后 SITE_DATA 据此渲染编辑弹窗
        configured: accs.some((a) => adapter.isConfigured(a)),
        account_count: accs.length,
        meta: {
          key: adapter.key,
          name: adapter.name,
          short: adapter.short || "",
          mode: adapter.mode,
          desc: adapter.desc || "",
          fields: Array.isArray(adapter.fields) ? adapter.fields : [],
          login_caps: Array.isArray(adapter.login_caps) ? adapter.login_caps : [],
        },
        accounts: accs.map((a) => ({
          id: a.id,
          enabled: a.enabled !== false,
          remark: a.remark || "",
          label: adapter.getAccountLabel(a),
          configured: adapter.isConfigured(a),
        })),
        last: last ? { time: last.time, status: last.status, message: last.message, account: last.account || "" } : null,
        today_ok,
        today_failed,
      };
    }
    const enabledKeys = Object.keys(ADAPTERS).filter((k) => sites[k].enabled && sites[k].configured);
    const done = enabledKeys.filter((k) => sites[k].today_ok).length;
    const failed = enabledKeys.filter((k) => sites[k].today_failed);
    return ok({
      enabled: cfg.enabled,
      cron: cfg.cron,
      version: cfg.version,
      sites,
      today: { done, total: enabledKeys.length, failed },
    });
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
            await this._snapshotBalance(adapter, acc); // 签到成功后刷新余额快照（失败不致命）
            results.push({ site_key: key, account_id: acc.id, account: accLabel, ...r });
            history.push({ time: r.time, site: key, site_name: r.site_name, account_id: acc.id, account: accLabel, status: r.status, message: r.message, reward: r.reward ?? "", total: r.total ?? "", error: "" });
            this._log(`签到 ${adapter.name} → ${r.status}`);
          } catch (err) {
            const msg = err.message || String(err);
            results.push({ site_key: key, account_id: acc.id, account: accLabel, site_name: adapter.name, status: "执行失败", error: msg });
            history.push({ time: new Date().toLocaleString("zh-CN", { hour12: false }), site: key, site_name: adapter.name, account_id: acc.id, account: accLabel, status: "执行失败", message: "", reward: "", total: "", error: msg });
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

  /**
   * 单账号立即签到：按 site + account_id 精确定位一个账号，仅跑该账号。
   * 复用 runOnce 的单账号执行逻辑（isConfigured → runCheckin → snapshotBalance → 落 history）。
   * 返回该账号结果（成功/已签到/失败原因 + reward/total），无该账号返回明确错误。
   */
  async runAccount(site, accountId) {
    const adapter = ADAPTERS[site];
    if (!adapter) return fail(`未知站点：${site}`);
    if (accountId == null || accountId === "") return fail("缺少 account_id");
    if (this._running) return fail("签到正在执行中，请稍后再试");
    this._running = true;
    try {
      const cfg = this._store.getConfig();
      if (!cfg.enabled) return fail("总开关未开启（设置 → 应用启用）");
      const st = cfg.sites[site];
      if (!st || !st.enabled) return fail("该站点未启用");
      const accs = Array.isArray(st.accounts) ? st.accounts : [];
      const acc = accs.find((a) => String(a.id) === String(accountId));
      if (!acc) return fail("未找到指定账号");
      if (acc.enabled === false) return fail("该账号已停用");
      const accLabel = adapter.getAccountLabel(acc);
      const who = accLabel ? `（${accLabel}）` : "";
      this._log(`单账号签到 ${adapter.name}${who}…`);
      let result;
      let history;
      try {
        if (!adapter.isConfigured(acc)) throw new Error("该账号尚未配置凭据");
        const r = await adapter.runCheckin(acc);
        await this._snapshotBalance(adapter, acc); // 签到成功后刷新余额快照（失败不致命）
        result = { site_key: site, account_id: acc.id, account: accLabel, ...r };
        history = { time: r.time, site, site_name: r.site_name, account_id: acc.id, account: accLabel, status: r.status, message: r.message, reward: r.reward ?? "", total: r.total ?? "", error: "" };
        this._log(`单账号签到 ${adapter.name} → ${r.status}`);
      } catch (err) {
        const msg = err.message || String(err);
        result = { site_key: site, account_id: acc.id, account: accLabel, site_name: adapter.name, status: "执行失败", error: msg };
        history = { time: new Date().toLocaleString("zh-CN", { hour12: false }), site, site_name: adapter.name, account_id: acc.id, account: accLabel, status: "执行失败", message: "", reward: "", total: "", error: msg };
        this._log(`单账号签到 ${adapter.name}${who} 失败：${msg}`);
      }
      this._store.appendHistory(history);
      if (this._notifier && cfg.notify_enabled) {
        const text = this._notifier.buildNotifyText("签到工具", [result]);
        const sent = await this._notifier.sendText(cfg.feishu_webhook, text);
        if (sent) this._log("单账号签到通知已发送");
      }
      const okRun = result.status !== "执行失败";
      return ok({ result, success_count: okRun ? 1 : 0, total: 1 }, okRun ? result.status : "执行失败");
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
      await this._snapshotBalance(adapter, acc); // 测试连接成功后刷新余额快照（失败不致命）
      return ok({ ...r, account_id: acc.id, account: adapter.getAccountLabel(acc) });
    } catch (err) {
      return fail(err.message || "测试失败");
    }
  }

  /**
   * 账号级余额快照：仅对声明了 queryBalance 的 adapter（workbuddy 积分 / anyrouter quota）生效。
   * 写入 acc.balance（原始数值）、acc.balance_delta（与上次快照差；无上次 → null）、acc.balance_ts。
   * 任何异常都吞掉——余额取不到绝不影响签到/测试结果。凭据/token 绝不返回，仅存数值。
   */
  async _snapshotBalance(adapter, acc) {
    if (!adapter || typeof adapter.queryBalance !== "function") return;
    const label = adapter.balanceLabel || "余额";
    try {
      const val = await adapter.queryBalance(acc);
      // 凭据有效但解析不出数值（例如上游结构变更）——过去被静默吞掉，现在明确记一行
      if (val == null || !Number.isFinite(Number(val))) {
        console.error(`${adapter.key} ${label}查询失败：接口返回空值（凭据有效但未解析出${label}，疑似上游响应结构变更）`);
        return;
      }
      const next = Number(val);
      const prev = (acc.balance == null) ? null : Number(acc.balance);
      acc.balance_delta = (prev == null) ? null : Number((next - prev).toFixed(6));
      acc.balance = next;
      acc.balance_ts = Date.now();
      this._store.save();
      console.log(`${adapter.key} ${label}快照成功：${label}=${next}`);
    } catch (err) {
      // 失败记状态码/错误消息（adapter 抛出的消息不含 token/敏感值）
      console.error(`${adapter.key} ${label}查询失败：${(err && err.message) || err}`);
    }
  }

  getHistory(limit) {
    return ok({ records: this._store.getHistory(Number(limit) || 50) });
  }

  /**
   * 积分聚合：按 site 分组统计最近 window 条 history 中的 reward。
   * history 最新在前（Store.appendHistory 头插），每组取第一条（最新）的 site_name 与 last_time。
   * reward 单位因站而异（MB / 积分 / USD…），故 total_points 仅做粗略展示，
   * per-site 的 total_points 才是有效口径，不跨站换算。
   * 累计口径：仅统计 workbuddy 站点（其余站点当前无真实积分），明细仍列出各站。
   */
  points(window = 500) {
    const hist = this._store.getHistory(window) || [];
    const bySite = new Map(); // site -> { count, sum }
    for (const h of hist) {
      const key = h && h.site;
      if (!key) continue;
      const g = bySite.get(key) || { count: 0, sum: 0 };
      g.count += 1;
      g.sum += parseReward(h.reward);
      bySite.set(key, g);
    }
    const sites = [];
    let totalPoints = 0;
    for (const [key, g] of bySite) {
      const first = hist.find((h) => h.site === key) || {};
      sites.push({
        site: key,
        site_name: first.site_name || key, // 组内最新一条的 site_name
        count: g.count,
        total_points: Number(g.sum.toFixed(4)), // 防浮点尾巴
        last_time: first.time || "",
      });
      if (key === "workbuddy") totalPoints += g.sum; // 累计仅计 workbuddy
    }
    return ok({
      sites,
      total_count: hist.length,
      total_points: Number(totalPoints.toFixed(4)),
      window,
    });
  }

  clearHistory() {
    this._store.clearHistory();
    return ok({ cleared: true });
  }

  /* ── 阶段 2：账号运维（list/reorder/import/export/clear）─────────────
   * 统一 ok/fail 包裹；每个方法先校验 site 存在于 ADAPTERS。
   * list/export 默认脱敏，绝不回吐凭据/session 明细。 */

  /** 账号清单（脱敏）：只含 id/enabled/remark/label/configured/has_session/last/points */
  accountsList() {
    const cfg = this._store.getConfig();
    const hist = this._store.getHistory(500) || [];
    const sites = {};
    for (const key of Object.keys(ADAPTERS)) {
      const adapter = ADAPTERS[key];
      const site = cfg.sites[key] || {};
      const accs = Array.isArray(site.accounts) ? site.accounts : [];
      sites[key] = {
        accounts: accs.map((a) => {
          const accHist = hist.filter((h) => h && h.site === key && String(h.account_id) === String(a.id));
          const last = accHist[0] || null;
          const points = Number(accHist.reduce((s, h) => s + parseReward(h.reward), 0).toFixed(4));
          // 余额快照（脱敏——纯数值/展示串，绝不含 token/cookie）：
          // supports_balance = adapter 是否声明 queryBalance（前端据此决定是否显示余额行）
          const supportsBalance = typeof adapter.queryBalance === "function";
          const rawBal = (a.balance == null) ? null : Number(a.balance);
          const rawDelta = (a.balance_delta == null) ? null : Number(a.balance_delta);
          const fmt = (v) => (typeof adapter.fmtBalance === "function" ? adapter.fmtBalance(v) : String(v));
          return {
            id: a.id,
            enabled: a.enabled !== false,
            remark: a.remark || "",
            label: adapter.getAccountLabel(a),
            site_name: adapter.name,
            configured: adapter.isConfigured(a),
            has_session: !!a.session,
            last: last ? { time: last.time, status: last.status } : null,
            points,
            supports_balance: supportsBalance,
            balance_label: supportsBalance ? (adapter.balanceLabel || "余额") : "",
            balance: rawBal,
            balance_delta: rawDelta,
            balance_ts: Number(a.balance_ts) || 0,
            balance_display: (supportsBalance && rawBal != null) ? fmt(rawBal) : "",
            balance_delta_display: (supportsBalance && rawDelta != null && rawDelta !== 0)
              ? ((rawDelta > 0 ? "+" : "") + fmt(rawDelta)) : "",
          };
        }),
      };
    }
    return ok({ sites });
  }

  /** 重排账号顺序：ids 必须是该站现有账号 id 的一个排列 */
  accountsReorder(body) {
    const { site, ids } = body || {};
    const adapter = ADAPTERS[site];
    if (!adapter) return fail(`未知站点：${site}`);
    if (!Array.isArray(ids)) return fail("ids 必须为数组");
    const cfg = this._store.getConfig();
    const accs = Array.isArray(cfg.sites[site].accounts) ? cfg.sites[site].accounts : [];
    const curIds = accs.map((a) => String(a.id));
    const wantIds = ids.map(String);
    if (
      wantIds.length !== curIds.length ||
      new Set(wantIds).size !== wantIds.length ||
      !wantIds.every((id) => curIds.includes(id))
    ) {
      return fail("ids 必须是该站点现有账号 id 的一个排列");
    }
    const byId = new Map(accs.map((a) => [String(a.id), a]));
    cfg.sites[site].accounts = wantIds.map((id) => byId.get(id));
    this._store.save();
    return ok({ site, order: wantIds }, "顺序已更新");
  }

  /** 导入账号（默认追加，id 重新分配不冲突）。导入允许带密（导入功能本身目的）。 */
  accountsImport(body) {
    const { site, data } = body || {};
    const adapter = ADAPTERS[site];
    if (!adapter) return fail(`未知站点：${site}`);
    let items;
    try {
      items = typeof data === "string" ? JSON.parse(data) : data;
    } catch {
      return fail("data 不是合法 JSON");
    }
    if (items && !Array.isArray(items) && typeof items === "object") items = [items];
    if (!Array.isArray(items) || !items.length) return fail("导入数据为空");

    const cfg = this._store.getConfig();
    if (!Array.isArray(cfg.sites[site].accounts)) cfg.sites[site].accounts = [];
    const cur = cfg.sites[site].accounts;
    const fieldKeys = adapter.fields.map((f) => f.key);
    const usedIds = new Set(cur.map((a) => String(a.id)));
    const allocId = () => {
      let max = 0;
      for (const id of usedIds) {
        const m = parseInt(String(id).replace(/\D/g, ""), 10);
        if (Number.isFinite(m) && m > max) max = m;
      }
      const nid = "a" + (max + 1);
      usedIds.add(nid);
      return nid;
    };
    let added = 0;
    for (const it of items) {
      if (!it || typeof it !== "object") continue;
      const acc = { id: allocId(), enabled: it.enabled !== false, remark: String(it.remark || "").trim() };
      acc.session = (it.session && typeof it.session === "object") ? it.session : null;
      acc.session_ts = acc.session ? (Number(it.session_ts) || Date.now()) : 0;
      for (const f of fieldKeys) acc[f] = it[f] !== undefined ? String(it[f]) : "";
      cur.push(acc);
      added += 1;
    }
    this._store.save();
    return ok({ site, added, total: cur.length }, `已导入 ${added} 个账号（追加）`);
  }

  /** 导出账号：默认脱敏（password 型字段与 session 打码）；include_secrets=true 才带密 */
  accountsExport(body) {
    const { site, include_secrets } = body || {};
    const adapter = ADAPTERS[site];
    if (!adapter) return fail(`未知站点：${site}`);
    const cfg = this._store.getConfig();
    const accs = Array.isArray(cfg.sites[site].accounts) ? cfg.sites[site].accounts : [];
    const fieldKeys = adapter.fields.map((f) => f.key);
    const secretKeys = new Set(adapter.fields.filter((f) => f.type === "password").map((f) => f.key));
    const withSecrets = include_secrets === true;
    const accounts = accs.map((a) => {
      const out = { id: a.id, enabled: a.enabled !== false, remark: a.remark || "" };
      for (const f of fieldKeys) {
        const v = a[f] || "";
        out[f] = (secretKeys.has(f) && !withSecrets && v) ? "***" : v;
      }
      if (withSecrets) {
        out.session = a.session || null;
        out.session_ts = Number(a.session_ts) || 0;
      } else {
        out.session = a.session ? "***" : null;
      }
      return out;
    });
    return ok({ site, exported_at: new Date().toISOString(), include_secrets: withSecrets, accounts });
  }

  /** 清空某站点全部账号 */
  accountsClear(body) {
    const { site } = body || {};
    const adapter = ADAPTERS[site];
    if (!adapter) return fail(`未知站点：${site}`);
    const cfg = this._store.getConfig();
    cfg.sites[site].accounts = [];
    this._store.save();
    return ok({ site, cleared: true }, "已清空该站点账号");
  }

  /* ── 阶段 2/4：交互登录（loginFlow）─────────────────────────────
   * 两种模式统一 {site}_login/{init,status}：
   *   form（flzt/ypojie/anyrouter）：init 同步产出 session 写入账号，status 恒 ready（行为不回归）。
   *   qr（workbuddy）：init 建上游扫码会话 → 返回二维码 + token（不建账号）；
   *     前端轮询 status?token= → pending/expired/ready；ready 时自动建/更账号。tokens 绝不回吐/落日志。 */

  /** 触发交互登录：form 模式写入账号 session；qr 模式建扫码会话并回二维码 */
  async loginFlowInit(body) {
    const { site, account_id } = body || {};
    const adapter = ADAPTERS[site];
    if (!adapter) return fail(`未知站点：${site}`);
    const flow = adapter.loginFlow;
    if (!flow) return fail("该站点不支持交互登录（请用 Cookie 配置）");

    // qr 模式：无需既有账号，建上游会话 → 前端展示二维码 → 轮询 status
    if (flow.mode === "qr") {
      try {
        const site_cfg = this._store.getConfig().sites[site] || {};
        const sess = await flow.startSession({ use_proxy: !!site_cfg.use_proxy });
        // 清理过期会话，避免内存累积
        const nowMs = Date.now();
        for (const [k, v] of this._loginSessions) if (v.expires_at <= nowMs) this._loginSessions.delete(k);
        const token = crypto.randomBytes(12).toString("hex");
        this._loginSessions.set(token, {
          site, account_id: account_id || null, sess,
          expires_at: nowMs + (flow.ttl_ms || 5 * 60 * 1000),
        });
        return ok({
          status: "pending",
          state: "qr",
          token,
          login_url: sess.auth_url,          // 扫码链接（前端 QR 内容 + 浏览器打开 fallback）
          qr: renderQrDataUrl(sess.auth_url), // data:image/gif 二维码（本地生成）
          login_mode: "qr",
          message: flow.tip || "请用手机扫码登录",
        });
      } catch (err) {
        return fail(err.message || "扫码会话创建失败");
      }
    }

    // form 模式：既有行为——同步登录产出 session 写入指定账号
    const cfg = this._store.getConfig();
    const accs = Array.isArray(cfg.sites[site].accounts) ? cfg.sites[site].accounts : [];
    const acc = account_id
      ? accs.find((a) => String(a.id) === String(account_id))
      : accs.find((a) => a.enabled !== false);
    if (!acc) return fail(account_id ? "未找到指定账号" : "该站点没有可用账号");
    try {
      const r = await adapter.loginFlow.init(acc);
      if (!r || !r.session) return fail("登录未返回会话");
      acc.session = r.session;
      acc.session_ts = Date.now();
      this._store.save();
      return ok({
        status: r.status || "ready",
        session_type: r.session.type,
        login_mode: "form",
        message: r.message || "登录成功",
        account: { id: acc.id, label: adapter.getAccountLabel(acc), has_session: true },
      });
    } catch (err) {
      return fail(err.message || "登录失败");
    }
  }

  /** 交互登录状态：form 恒 ready；qr 按 token 轮询上游（ready 时自动建账号） */
  async loginFlowStatus(body) {
    const { site, token } = body || {};
    const adapter = ADAPTERS[site];
    if (!adapter) return fail(`未知站点：${site}`);
    const flow = adapter.loginFlow;
    if (!flow) return fail("该站点不支持交互登录（请用 Cookie 配置）");

    // form 模式：能力探测 + 同步完成（恒 ready）
    if (flow.mode !== "qr") return ok({ state: "ready", login_mode: "form" });

    // qr 模式：无 token（前端能力探测）→ 回 pending（success:true 即代表支持）
    if (!token) return ok({ state: "pending", login_mode: "qr" });
    const entry = this._loginSessions.get(token);
    if (!entry || entry.site !== site) {
      return ok({ state: "expired", login_mode: "qr", message: "登录会话不存在，请重新扫码" });
    }
    if (Date.now() > entry.expires_at) {
      this._loginSessions.delete(token);
      return ok({ state: "expired", login_mode: "qr", message: "二维码已过期，请重新获取" });
    }
    try {
      const site_cfg = this._store.getConfig().sites[site] || {};
      const r = await flow.poll(entry.sess, { use_proxy: !!site_cfg.use_proxy });
      if (r.state === "ready") {
        const acc = this._upsertLoginAccount(site, adapter, r.account || {}, entry.account_id);
        // 落会话：qr 流的 poll 回传 session（{access_token, refresh_token}），写入账号使
        // has_session=true（对齐 form/password 流）；缺 session 时回落 r.account 兜底构造。
        const sess = r.session || (r.account && r.account.access_token
          ? { access_token: r.account.access_token, refresh_token: r.account.refresh_token || "" }
          : null);
        if (sess) { acc.session = sess; acc.session_ts = Date.now(); this._store.save(); }
        this._loginSessions.delete(token);
        // 扫码建号即拉一次积分/余额快照（不必等签到；失败不致命，仅记日志）
        await this._snapshotBalance(adapter, acc);
        this._log(`扫码登录成功：${adapter.name}（${adapter.getAccountLabel(acc)}）`);
        return ok({ state: "ready", login_mode: "qr", account: { id: acc.id, label: adapter.getAccountLabel(acc), has_session: !!sess } });
      }
      if (r.state === "expired") {
        this._loginSessions.delete(token);
        return ok({ state: "expired", login_mode: "qr", message: r.message || "二维码已失效，请重新获取" });
      }
      return ok({ state: "pending", login_mode: "qr" });
    } catch (err) {
      // 瞬时错误不打断轮询（对齐上游：保持等待态）
      return ok({ state: "pending", login_mode: "qr", message: err.message || "" });
    }
  }

  /**
   * 账号密码登录（form 站点通用入口）：用前端提交的凭据即时登录 → 自动产出会话（token/cookie）
   * → 落账号（新建或按 account_id 更新），会话型 session.cookie 自动回填站点 cookie 字段。
   * 满足用户诉求「账号密码登录后自动获取 cookie 填写」：个人自有账号登录，非逆向。
   * body: { site, fields:{email/username/password/base_url…}, remark?, account_id? }
   */
  async loginFlowPassword(body) {
    const { site, fields, remark, account_id } = body || {};
    const adapter = ADAPTERS[site];
    if (!adapter) return fail(`未知站点：${site}`);
    const flow = adapter.loginFlow;
    if (!flow || flow.mode !== "form") return fail("该站点不支持账号密码登录");
    const caps = Array.isArray(adapter.login_caps) ? adapter.login_caps : [];
    // password 或 password_cookie 均走此账号密码登录入口（与前端 tab 归并逻辑一致）
    if (!caps.includes("password") && !caps.includes("password_cookie")) return fail("该站点不支持账号密码登录");

    // 用提交的凭据构造临时配置（仅取 adapter 认识的字段），走既有 loginFlow.init 登录逻辑
    const site_cfg = this._store.getConfig().sites[site] || {};
    const fieldKeys = adapter.fields.map((f) => f.key);
    const tmp = { use_proxy: !!site_cfg.use_proxy };
    for (const f of fieldKeys) {
      if (fields && fields[f] !== undefined && fields[f] !== null && String(fields[f]) !== "") {
        tmp[f] = String(fields[f]).trim();
      } else if (adapter.defaultConfig && adapter.defaultConfig()[f] !== undefined) {
        tmp[f] = adapter.defaultConfig()[f]; // base_url 等留空时回落默认
      }
    }
    let r;
    try {
      r = await flow.init(tmp); // 复用 loginPath 登录逻辑，成功返回 { session, ... }
    } catch (err) {
      return fail(err.message || "登录失败");
    }
    if (!r || !r.session) return fail("登录未返回会话");

    // 自动提取 cookie（会话型 session）→ 供落账号时回填站点 cookie 字段（若有）
    const autoCookie = extractSessionCookie(r.session);

    // 落账号：写入提交的明文字段 + 自动 cookie（有 cookie 字段时）+ 会话
    const data = {};
    for (const f of fieldKeys) if (tmp[f] !== undefined) data[f] = tmp[f];
    if (autoCookie && fieldKeys.includes("cookie")) data.cookie = autoCookie;
    if (remark) data.remark = String(remark);
    const acc = this._upsertLoginAccount(site, adapter, data, account_id);
    acc.session = r.session;
    acc.session_ts = Date.now();
    this._store.save();

    this._log(`账号密码登录成功：${adapter.name}（${adapter.getAccountLabel(acc)}）`);
    return ok({
      status: "ready",
      login_mode: "password",
      session_type: r.session.type,
      auto_cookie: !!autoCookie, // 是否自动获取到 cookie（前端提示用，绝不回吐 cookie 值）
      message: r.message || "登录成功，已自动获取会话",
      account: { id: acc.id, label: adapter.getAccountLabel(acc), has_session: true },
    });
  }

  /** 扫码登录落账号：优先按 account_id、其次按 uid 去重更新；否则新建。凭据写入 adapter 字段。 */
  _upsertLoginAccount(site, adapter, data, accountId) {
    const cfg = this._store.getConfig();
    // 站点配置入口兜底：真实 store 恒预建全部站点键，但扫码流首个账号新建站点时不可依赖
    if (!cfg.sites[site] || typeof cfg.sites[site] !== "object") cfg.sites[site] = { enabled: true, use_proxy: false, accounts: [] };
    if (!Array.isArray(cfg.sites[site].accounts)) cfg.sites[site].accounts = [];
    const arr = cfg.sites[site].accounts;
    const fieldKeys = adapter.fields.map((f) => f.key);
    let acc = null;
    if (accountId) acc = arr.find((a) => String(a.id) === String(accountId));
    if (!acc && data.uid) acc = arr.find((a) => a.uid && String(a.uid) === String(data.uid));
    if (!acc) {
      let max = 0;
      for (const a of arr) {
        const m = parseInt(String(a.id || "").replace(/\D/g, ""), 10);
        if (Number.isFinite(m) && m > max) max = m;
      }
      acc = { id: "a" + (max + 1), enabled: true, remark: "", session: null, session_ts: 0 };
      for (const f of fieldKeys) acc[f] = "";
      arr.push(acc);
    }
    // 仅写入 adapter 认识的字段；空值不覆盖（保留原凭据）
    for (const f of fieldKeys) {
      if (data[f] !== undefined && data[f] !== null && String(data[f]) !== "") acc[f] = String(data[f]);
    }
    if (data.remark && !acc.remark) acc.remark = String(data.remark);
    this._store.save();
    return acc;
  }
}

/**
 * 从登录会话对象中宽容提取 cookie 串（用于账号密码登录后自动回填 cookie 字段）。
 * 命中：session.cookie（ypojie 型）/ session.headers.Cookie（anyrouter cookie 型）；
 * token 型会话（flzt/anyrouter token）无 cookie → 返回空串。
 */
function extractSessionCookie(session) {
  if (!session || typeof session !== "object") return "";
  if (typeof session.cookie === "string" && session.cookie.trim()) return session.cookie.trim();
  const h = session.headers;
  if (h && typeof h === "object") {
    const v = h.Cookie || h.cookie;
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

/**
 * 从 reward 字符串中提取「第一个数字 token」作为积分数值。
 * 命中情况：2.5积分 → 2.5；"+0.0001" → 0.0001；"0" → 0；"-" / 空 / 旧记录无 reward → 0。
 */
function parseReward(reward) {
  if (typeof reward !== "string" && typeof reward !== "number") return 0;
  const m = String(reward).match(/-?\d+(\.\d+)?/);
  if (!m) return 0;
  const n = parseFloat(m[0]);
  return Number.isFinite(n) ? n : 0;
}

/** 判断 history 时间字符串（'2026/9/20 23:40:15'）是否为今天 */
function sameDayStr(t) {
  if (!t) return false;
  const todayPrefix = new Date().toLocaleDateString("zh-CN", { hour12: false });
  return String(t).startsWith(todayPrefix);
}

module.exports = { Server, ADAPTERS };