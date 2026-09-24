"use strict";
/**
 * checkin — API 层（Node.js 版）。
 * 方法：getConfig / saveConfig / status / runOnce / testLogin / getHistory / clearHistory
 * 统一返回 { success, message, data }。
 */
const crypto = require("crypto");
const { ADAPTERS, maskSecret } = require("./sites");   // ADAPTERS 单一事实源（本地不再维护拷贝）
const { maskProxyUrl } = require("./httpc"); // 代理地址脱敏回显（B17：userinfo 密码回显掩码）
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

/* ── 站点标题抓取（1.6.2：账号卡标题链接 base_url → <title>）──────────
 * WAF 站点（anyrouter.top 等）后端抓不到 <title>（挑战页 gzip 无标题）：
 * 内置映射表覆盖已知平台；其余站点动态抓取 + 内存缓存（TTL 60 分钟）。 */
const SITE_TITLE_MAP = {
  "anyrouter.top": "Any Router",
  "agentrouter.org": "Agent Router",
};
const titleCache = new Map(); // url → { title, ts }
const TITLE_CACHE_TTL = 60 * 60 * 1000;
async function fetchSiteTitleCached(url) {
  const host = String(url).replace(/^https?:\/\//i, "").split("/")[0].toLowerCase();
  if (SITE_TITLE_MAP[host]) return SITE_TITLE_MAP[host];
  const hit = titleCache.get(url);
  if (hit && Date.now() - hit.ts < TITLE_CACHE_TTL) return hit.title;
  let title = null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      },
      signal: ctrl.signal,
      redirect: "follow",
    });
    clearTimeout(timer);
    if (res.ok) {
      const html = await res.text();
      // 1) 品牌 span 优先（NewAPI 前台侧边栏 logo 文本，如 <span class="max-w-[12rem] truncate">JustDoWork</span>）——
      //    这才是真实站点名；<title> 常是框架默认「New API」
      const b = html.match(/<span[^>]*class="[^"]*max-w-\[12rem\]\s+truncate[^"]*"[^>]*>([^<]{1,40})<\/span>/i)
        || html.match(/<span[^>]*class="[^"]*truncate[^"]*"[^>]*>\s*([A-Za-z0-9][^<]{1,38})<\/span>/i);
      if (b) {
        title = b[1].replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "").slice(0, 80);
      } else {
        // 2) 无品牌 span → <title> 兜底
        const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        if (m) title = m[1].replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "").slice(0, 80);
      }
    }
  } catch (e) { /* 抓取失败 → null，前端回落 host */ }
  titleCache.set(url, { title, ts: Date.now() });
  return title;
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
    this._injectedProxy = new Set(); // 站点级 use_proxy 注入的账号对象（save 前还原，不落盘）
  }

  /** 站点标题（1.6.2）：遍历全部账号 base_url → <title>（内置映射/动态抓取/缓存），供账号卡标题链接使用 */
  async siteTitles() {
    const cfg = this._store.getConfig();
    const urls = new Set();
    for (const sk of Object.keys(cfg.sites || {})) {
      for (const a of ((cfg.sites[sk] || {}).accounts || [])) {
        let b = a && a.base_url;
        // 1.7.3：anyrouter 账号无 base_url（provider 驱动）→ 按 provider 推导，标题映射/抓取才可达
        if (sk === "anyrouter" && !b && a) {
          b = a.provider === "agentrouter" ? "https://agentrouter.org" : "https://anyrouter.top";
        }
        if (b && /^https?:\/\//i.test(b)) urls.add(String(b).replace(/\/+$/, ""));
      }
    }
    const titles = {};
    await Promise.all([...urls].map(async (u) => { titles[u] = await fetchSiteTitleCached(u); }));
    return ok({ titles });
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
      proxy_enabled: !!cfg.proxy_enabled,   // 全局代理开关
      proxy_url: maskProxyUrl(cfg.proxy_url), // 回显脱敏（B17：userinfo 密码掩码）；save 值完整保留于 config
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
    let cfg;
    try {
      cfg = this._store.saveConfig(patch);
    } catch (err) {
      return fail(err.message || "保存配置失败"); // 校验失败（如代理地址非法）→ 标准 fail 信封
    }
    return ok({
      version: cfg.version,
      enabled: cfg.enabled,
      cron: cfg.cron,
      notify_enabled: cfg.notify_enabled,
      feishu_configured: !!cfg.feishu_webhook,
      proxy_enabled: !!cfg.proxy_enabled,
      proxy_url: maskProxyUrl(cfg.proxy_url), // 回显脱敏（B17）
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
          this._applySiteProxy(site, acc); // 站点级 use_proxy 兜底注入（内存合并，save 前还原）
          const accLabel = adapter.getAccountLabel(acc);
          const who = accLabel ? `（${accLabel}）` : "";
          this._log(`签到 ${adapter.name}${who}…`);
          try {
            if (!adapter.isConfigured(acc)) throw new Error("该账号尚未配置凭据");
            const r = await adapter.runCheckin(acc);
            await this._snapshotBalance(adapter, acc, { from: "checkin" }); // 签到成功后刷新余额快照（失败不致命）
            this._accumDailyReward(adapter, acc, r); // 非 NewAPI 系（flzt/right_forum/ypojie）当天签到奖励累计（0 点重置）
            this._snapshotHold(adapter, acc, r); // 非余额系当前持有量快照（hero 大数字，复用响应字段不触网）
            results.push({ site_key: key, account_id: acc.id, account: accLabel, ...r });
            this._store.schedCheckinSuccess(key, acc.id); // B18：签到成功即从今日失败集移除（补签列表翻转）
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
      // B4：整轮一次批量写入 history（单次读+写，替代 N 账号 → N×全文件 I/O）；失败单次捕获，
      // 仅记日志（含路径）并继续——存储失败绝不抹掉已算出的整轮结果，返回仍 success 并带 warnings。
      const warnings = [];
      try {
        this._store.appendHistoryBatch(history.reverse());
      } catch (e) {
        const hp = this._store.historyPath || "(history)";
        console.error(`签到 history 批量写入失败：${(e && e.message) || e}（${hp}）`);
        warnings.push("history 写入失败：签到记录未持久化");
      }
      // 账号对象落盘（一次全量，9KB 级）：_billingDo 401 续期只回写内存 cfg.session/session_ts，
      // 若不在此持久化，热更/重启后 session 回退磁盘旧值 → 保活断链需重新扫码。放循环外一次足够。
      // save 失败不应使签到结果报错（history 已落盘、结果已生成）——仅记日志（含路径）+ warnings。
      this._restoreInjectedProxy(); // 注入字段不落盘：先还原站点级 use_proxy 再保存
      this._store.recordCheckinResults(results); // 今日失败账号集（补签账号级定位；跨天自动重置）
      try { this._store.save(); } catch (e) {
        const cp = this._store.configPath || "(config)";
        console.error(`签到后配置落盘失败（session 续期未持久化）：${(e && e.message) || e}（${cp}）`);
        warnings.push("配置保存失败：会话/失败集变更未持久化");
      }
      const allOk = results.length > 0 && results.every((r) => r.status !== "执行失败");
      if (this._notifier && cfg.notify_enabled) {
        const text = this._notifier.buildNotifyText("签到工具", results);
        const sent = await this._notifier.sendText(cfg.feishu_webhook, text);
        if (sent) this._log("签到通知已发送");
      }
      this._lastResults = results;
      const payload = { results, summary: allOk ? "全部成功" : (results.length ? "部分成功" : "无启用的站点"), total: results.length, success_count: results.filter((r) => r.status !== "执行失败").length };
      if (warnings.length) payload.warnings = warnings;
      return ok(payload);
    } finally {
      this._restoreInjectedProxy(); // 异常逃逸兜底：确保注入字段不残留
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
      this._applySiteProxy(st, acc); // 站点级 use_proxy 兜底注入（内存合并，save 前还原）
      const accLabel = adapter.getAccountLabel(acc);
      const who = accLabel ? `（${accLabel}）` : "";
      this._log(`单账号签到 ${adapter.name}${who}…`);
      let result;
      let history;
      try {
        if (!adapter.isConfigured(acc)) throw new Error("该账号尚未配置凭据");
        const r = await adapter.runCheckin(acc);
        await this._snapshotBalance(adapter, acc, { from: "checkin" }); // 签到成功后刷新余额快照（失败不致命）
        this._accumDailyReward(adapter, acc, r); // 非 NewAPI 系当天签到奖励累计（0 点重置）
        this._snapshotHold(adapter, acc, r); // 非余额系当前持有量快照（hero 大数字，复用响应字段不触网）
        result = { site_key: site, account_id: acc.id, account: accLabel, ...r };
        history = { time: r.time, site, site_name: r.site_name, account_id: acc.id, account: accLabel, status: r.status, message: r.message, reward: r.reward ?? "", total: r.total ?? "", error: "" };
        this._log(`单账号签到 ${adapter.name} → ${r.status}`);
      } catch (err) {
        const msg = err.message || String(err);
        result = { site_key: site, account_id: acc.id, account: accLabel, site_name: adapter.name, status: "执行失败", error: msg };
        history = { time: new Date().toLocaleString("zh-CN", { hour12: false }), site, site_name: adapter.name, account_id: acc.id, account: accLabel, status: "执行失败", message: "", reward: "", total: "", error: msg };
        this._log(`单账号签到 ${adapter.name}${who} 失败：${msg}`);
      }
      if (result.status !== "执行失败") this._store.schedCheckinSuccess(site, acc.id); // B18：补签成功翻转今日失败标记
      // B4：history 写入失败仅记日志（含路径）并继续，返回仍 success 并带 warnings
      const warnings = [];
      try {
        this._store.appendHistory(history);
      } catch (e) {
        const hp = this._store.historyPath || "(history)";
        console.error(`单账号签到 history 写入失败：${(e && e.message) || e}（${hp}）`);
        warnings.push("history 写入失败：签到记录未持久化");
      }
      // 同 runOnce：单账号签到亦落盘账号对象（持久化 _billingDo 续期后的 session），save 失败不阻断结果。
      this._restoreInjectedProxy(); // 注入字段不落盘：先还原站点级 use_proxy 再保存
      this._store.recordCheckinResults([result]); // 单账号结果同步进今日失败集（补签据此只重跑失败账号）
      try { this._store.save(); } catch (e) {
        const cp = this._store.configPath || "(config)";
        console.error(`单账号签到后配置落盘失败（session 续期未持久化）：${(e && e.message) || e}（${cp}）`);
        warnings.push("配置保存失败：会话/失败集变更未持久化");
      }
      if (this._notifier && cfg.notify_enabled) {
        const text = this._notifier.buildNotifyText("签到工具", [result]);
        const sent = await this._notifier.sendText(cfg.feishu_webhook, text);
        if (sent) this._log("单账号签到通知已发送");
      }
      const okRun = result.status !== "执行失败";
      const payload = { result, success_count: okRun ? 1 : 0, total: 1 };
      if (warnings.length) payload.warnings = warnings;
      return ok(payload, okRun ? result.status : "执行失败");
    } finally {
      this._restoreInjectedProxy(); // 异常逃逸兜底：确保注入字段不残留
      this._running = false;
    }
  }

  async testLogin(siteKey, accountId) {
    const adapter = ADAPTERS[siteKey];
    if (!adapter) return fail(`未知站点：${siteKey}`);
    // F7-2：testLogin 纳入 _running 保护——签到/测试进行中拒绝并发（服务端兜底，前端按钮已防抖）
    if (this._running) return fail("签到/测试进行中，请稍候");
    this._running = true;
    try {
      const cfg = this._store.getConfig();
      const site = cfg.sites[siteKey];
      const accs = (site && Array.isArray(site.accounts) ? site.accounts : []).filter((a) => a.enabled !== false);
      const acc = accountId ? accs.find((a) => String(a.id) === String(accountId)) : accs[0];
      if (!acc || !adapter.isConfigured(acc)) return fail(accountId ? "该账号尚未配置凭据" : "该站点没有可用账号");
      this._applySiteProxy(site, acc); // 站点级 use_proxy 兜底注入（内存合并，save 前还原）
      const r = await adapter.testConnection(acc);
      await this._snapshotBalance(adapter, acc); // 测试连接成功后刷新余额快照（失败不致命）
      this._snapshotHold(adapter, acc, r); // 非余额系（flzt/ypojie）测试连接带回 hold_value 时快照进 acc.hold（hero 大数字）；此处 acc 已按 site+account_id 定位，纯平台无账号测试不会走到这里
      // testConnection 内部 _billingDo 401 续期同样只回写内存 session；_snapshotBalance 仅在余额查询
      // 成功时 save，查询失败则续期丢失。此处补一次落盘兜底（同类缺口），save 失败不阻断测试结果。
      this._restoreInjectedProxy(); // 注入字段不落盘：先还原站点级 use_proxy 再保存
      try { this._store.save(); } catch (e) { console.error(`测试连接后配置落盘失败（session 续期未持久化）：${(e && e.message) || e}`); }
      return ok({ ...r, account_id: acc.id, account: adapter.getAccountLabel(acc) });
    } catch (err) {
      return fail(err.message || "测试失败");
    } finally {
      this._restoreInjectedProxy(); // 异常/正常路径统一还原注入字段
      this._running = false;
    }
  }

  /**
   * 账号级余额快照：仅对声明了 queryBalance 的 adapter（workbuddy 积分 / anyrouter quota）生效。
   * 写入 acc.balance（原始数值）、acc.balance_delta（与上次快照差；无上次 → null）、acc.balance_ts。
   * opts.from === "checkin"（签到成功路径）且 workbuddy 时累计当日新增积分 daily_gain：
   *   先比对 daily_gain_date 与今天（本地日期，防 0 点滚动）——不同 → 归零重计；
   *   签到前后余额差值 gain = max(0, after_balance - before_balance) 累加（余额回落不冲减）。
   * 非签到快照（test_login / 扫码建号等）不累计；非 workbuddy 站点不受影响。
   * 与 balance/delta 一同落盘（已有 _store.save）。任何异常都吞掉——余额取不到绝不影响签到/测试结果。
   * 凭据/token 绝不返回，仅存数值。
   */
  async _snapshotBalance(adapter, acc, opts) {
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
      // 当日累计新增余额：workbuddy（积分）与 NewAPI 系（newapi/anyrouter 余额）签到成功路径累计；0 点滚动重置（daily_gain_date 撞日判定，防跨天串账）
      if (opts && opts.from === "checkin" && ["workbuddy", "newapi", "anyrouter"].includes(adapter.key)) {
        const today = localDateStr();
        if (acc.daily_gain_date !== today) {
          acc.daily_gain = 0;
          acc.daily_gain_date = today;
        }
        if (prev != null) {
          const gain = Math.max(0, next - prev); // 签到前后余额差值（无上次基线 / 余额回落 → 不累计）
          if (gain > 0) acc.daily_gain = Number(((Number(acc.daily_gain) || 0) + gain).toFixed(6));
        }
      }
      this._restoreInjectedProxy(); // 注入字段不落盘：余额快照 save 前同样先还原
      this._store.save();
      console.log(`${adapter.key} ${label}快照成功：${label}=${next}`);
    } catch (err) {
      // 失败记状态码/错误消息（adapter 抛出的消息不含 token/敏感值）
      console.error(`${adapter.key} ${label}查询失败：${(err && err.message) || err}`);
    }
  }

  /**
   * 非 NewAPI 系（flzt/right_forum/ypojie）当天签到奖励累计：仿 daily_gain 的撞日归零机制。
   * 仅在本次为「签到成功」（首次成功）时累计——「今日已签到」重试不重复计（避免调度重试串账）。
   * 累计源：adapter runCheckin 返回的 reward_value（数值）+ reward_unit（单位，如 flzt=MB）；
   *   无法解析（reward_value 非正数）→ 跳过。workbuddy/NewAPI 系走 daily_gain（余额），此处不涉及。
   * 写入账号级 daily_reward（数值）+ daily_reward_unit（单位）+ daily_reward_date（撞日判定）；
   * 与后续 save() 一同落盘（调用方在 snapshotBalance 后、save 前调用）。异常吞掉，绝不影响签到结果。
   */
  _accumDailyReward(adapter, acc, r) {
    try {
      if (!adapter || !acc || !r) return;
      if (!["flzt", "right_forum", "ypojie"].includes(adapter.key)) return;
      if (r.status !== "签到成功") return; // 仅首次成功累计；已签到重试跳过
      const val = Number(r.reward_value);
      if (!Number.isFinite(val) || val <= 0) return; // 无结构化奖励 → 不累计
      const unit = r.reward_unit ? String(r.reward_unit) : "";
      const today = localDateStr();
      if (acc.daily_reward_date !== today) { // 撞日归零（0 点滚动，防跨天串账）
        acc.daily_reward = 0;
        acc.daily_reward_date = today;
      }
      if (unit) acc.daily_reward_unit = unit;
      acc.daily_reward = Number(((Number(acc.daily_reward) || 0) + val).toFixed(6));
    } catch { /* 当天奖励累计失败绝不影响签到/测试结果 */ }
  }

  /**
   * 当前持有量快照（hero 大数字源）：非 queryBalance 系（flzt/ypojie 等声明 holdLabel 的 adapter）。
   * 数据源为 runCheckin 结果里已带的 hold_value（复用签到/已签到响应已抓取字段，绝不新增触网）；
   * 有限数值 → 写入 acc.hold + acc.hold_ts；无值（null/NaN，如恩山无稳定持有量字段）→ 不写，
   * 前端 hero 大数字显示「—」。queryBalance 系（workbuddy/newapi/anyrouter）走 balance 快照，此处不涉及。
   * 与后续 save() 一同落盘。异常吞掉，绝不影响签到结果。
   */
  _snapshotHold(adapter, acc, r) {
    try {
      if (!adapter || !acc || !r) return;
      if (typeof adapter.holdLabel !== "string") return;
      if (typeof adapter.queryBalance === "function") return; // 余额系走 _snapshotBalance
      if (r.hold_value === null || r.hold_value === undefined || r.hold_value === "") return; // 无值（如查询失败/无字段）→ 保留现值，绝不写 0（Number(null)===0 会误写，故先显式判空）
      const v = Number(r.hold_value);
      if (!Number.isFinite(v)) return; // 非数值（NaN）→ 保留现值，hero 显示旧值或「—」
      acc.hold = v;
      acc.hold_ts = Date.now();
    } catch { /* 当前持有量快照失败绝不影响签到/测试结果 */ }
  }

  /* ── 站点级 use_proxy 注入（内存合并，不落盘）────────────────────
   * adapter 请求统一读 cfg.use_proxy（cfg 即账号对象）决定走代理；账号对象本身无
   * → anyrouter EPROTO）。调用 adapter 前以站点开关兜底注入：
   *   - 账号无显式 use_proxy（字段不存在）→ 注入站点值（内存合并，不覆盖显式值）
   *   - 账号已有显式 use_proxy → 不动（未来支持账号级覆盖）
   * 注入字段在 store.save() 前统一还原（_restoreInjectedProxy），避免把运行时合并值
   * 持久化进 config.json（零残留）。 */

  /** 站点级 use_proxy 注入账号对象：账号无显式值时生效，仅记录本次注入的账号 */
  _applySiteProxy(site, acc) {
    if (!acc || !site) return;
    if (acc.use_proxy === undefined) {
      acc.use_proxy = !!site.use_proxy;
      this._injectedProxy.add(acc);
    }
  }

  /** 还原本次注入的 use_proxy 字段（delete 到无字段状态；账号显式值不受影响） */
  _restoreInjectedProxy() {
    for (const acc of this._injectedProxy) {
      if (acc && "use_proxy" in acc) delete acc.use_proxy;
    }
    this._injectedProxy.clear();
  }

  getHistory(limit) {
    return ok({ records: this._store.getHistory(Number(limit) || 50) });
  }

  /**
   * 签到历史统计（1.5.4 历史可视化服务端聚合）。
   * 数据源：store.getHistory(2000)（最多取最近 2000 条；store 持久化上限 500，实际为全量）。
   * 日期键：解析 rec.time（toLocaleString zh-CN 格式）→ 服务器本地日期 YYYY-MM-DD（Asia/Shanghai）。
   * 状态划分：含「失败」→ failed；含「成功」/「已签到」→ success；其余 → neutral。
   * 输出 data：
   *   - totals：{ records, success, failed, neutral, success_rate(成功率=成功/(成功+失败)，保留1位小数%),
   *               first_time(最早记录原始 time 串), last_time(最近一条) }
   *   - trend：近 30 天逐日 [{date, success, failed, neutral}]（0 记录日补齐为 0）
   *   - calendar：最近 3 个自然月逐日（含空日，供前端日历热力图取当月）
   *   - sites：分站点 [{site, site_name, success, failed, neutral}]
   *   - rewardByDay：近 14 天 success 记录 reward 首个数字按日累计 [{date, amount}]（解析不出记 0）
   * 安全：history 本身无 cookie/token 字段（仅 status/message/奖励文本），本端点不输出任何凭据。
   */
  historyStats() {
    const hist = this._store.getHistory(2000) || [];
    const today = new Date();
    const day = new Map();      // date -> { success, failed, neutral }
    const site = new Map();     // site 键 -> { site_name, success, failed, neutral }
    const reward = new Map();   // date -> number（reward 首数字按日累计）
    const totals = { success: 0, failed: 0, neutral: 0 };
    for (const h of hist) {
      if (!h || typeof h !== "object") continue;
      const date = historyDateKey(h.time);
      const cls = classifyStatus(h.status);
      totals[cls] += 1;
      if (date) {
        const g = day.get(date) || { success: 0, failed: 0, neutral: 0 };
        g[cls] += 1;
        day.set(date, g);
        // 积分曲线：仅 success 记录解析 reward 首个数字按日累计（如 "余额 $16.5" → 16.5；解析不出记 0）
        if (cls === "success") reward.set(date, (reward.get(date) || 0) + parseReward(h.reward));
      }
      const key = h.site;
      if (key) {
        const sg = site.get(key) || { site_name: h.site_name || key, success: 0, failed: 0, neutral: 0 };
        sg[cls] += 1;
        site.set(key, sg);
      }
    }
    // 近 30 天逐日（含 0 记录日）
    const trend = [];
    for (let i = 29; i >= 0; i--) {
      const date = localDateStr(new Date(today.getFullYear(), today.getMonth(), today.getDate() - i));
      const g = day.get(date) || { success: 0, failed: 0, neutral: 0 };
      trend.push({ date, success: g.success, failed: g.failed, neutral: g.neutral });
    }
    // 最近 3 个自然月逐日（含空日；前端只渲染当月，3 个月数据备用）
    const calendar = [];
    for (let off = 2; off >= 0; off--) {
      const y = today.getFullYear() + Math.floor((today.getMonth() - off) / 12);
      const m = (((today.getMonth() - off) % 12) + 12) % 12;
      const daysInMonth = new Date(y, m + 1, 0).getDate();
      for (let dd = 1; dd <= daysInMonth; dd++) {
        const date = `${y}-${String(m + 1).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
        const g = day.get(date) || { success: 0, failed: 0, neutral: 0 };
        calendar.push({ date, success: g.success, failed: g.failed, neutral: g.neutral });
      }
    }
    // 近 14 天积分曲线（rewardByDay：success 记录 reward 首数字按日累计）
    const rewardByDay = [];
    for (let i = 13; i >= 0; i--) {
      const date = localDateStr(new Date(today.getFullYear(), today.getMonth(), today.getDate() - i));
      rewardByDay.push({ date, amount: Number((reward.get(date) || 0).toFixed(4)) });
    }
    // 首/最近：history 数组最新在前 → 末位为最早记录
    const first_time = hist.length ? hist[hist.length - 1].time : "";
    const last_time = hist.length ? hist[0].time : "";
    const attempts = totals.success + totals.failed;
    const totalsOut = {
      records: hist.length,
      success: totals.success,
      failed: totals.failed,
      neutral: totals.neutral,
      success_rate: attempts ? Number(((totals.success / attempts) * 100).toFixed(1)) : 0, // 无尝试 → 0
      first_time,
      last_time,
    };
    return ok({
      totals: totalsOut,
      trend,
      calendar,
      sites: Array.from(site.entries()).map(([k, g]) => ({
        site: k, site_name: g.site_name,
        success: g.success, failed: g.failed, neutral: g.neutral,
      })),
      rewardByDay,
    });
  }

  /**
   * 全部签到历史 → UTF-8 BOM 开头 CSV 字符串（Excel 兼容）。
   * 列：time,site,site_name,account,status,message,reward,total,error；行序 = history 顺序（新→旧）。
   * 字段转义 CSV 引号/逗号（含内嵌引号翻倍与换行归一）；history 不含 token/cookie，可安全导出。
   */
  historyExportCsv() {
    const hist = this._store.getHistory(100000) || []; // 全量（store 持久化上限 500，实际全量）
    const escCsv = (v) => {
      const s = (v == null ? "" : String(v)).replace(/\r\n|\r|\n/g, " "); // 换行→空格，避免破行
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const head = ["time", "site", "site_name", "account", "status", "message", "reward", "total", "error"];
    const lines = [head.join(",")];
    for (const h of hist) {
      lines.push(head.map((k) => escCsv(h ? h[k] : "")).join(","));
    }
    return "\uFEFF" + lines.join("\r\n");
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

  /** 账号清单（脱敏）：id/enabled/remark/label/configured/has_session/last/points/balance；
   *  另含 field_values（非敏感字段明文，编辑页预填）与 field_masks（type=password 字段脱敏串，仅展示）。 */
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
          // 账号级今日判定（与站点级 today_ok 同一语义）：任一今日「执行失败」→ false；
          // 否则今日有成功/已签到 → true。字段加在 accounts 层，不与 status 的 sites.today_ok 冲突。
          let today_ok = false;
          let today_failed = false;
          for (const h of accHist) {
            if (!sameDayStr(h.time)) continue;
            if (h.status === "执行失败") { today_failed = true; break; }
            today_ok = true;
          }
          if (today_failed) today_ok = false;
          const last_date = last ? dateStrFromTime(last.time) : "";
          const points = Number(accHist.reduce((s, h) => s + parseReward(h.reward), 0).toFixed(4));
          // 余额快照（脱敏——纯数值/展示串，绝不含 token/cookie）：
          // supports_balance = adapter 是否声明 queryBalance（前端据此决定是否显示余额行）
          const supportsBalance = typeof adapter.queryBalance === "function";
          const rawBal = (a.balance == null) ? null : Number(a.balance);
          const rawDelta = (a.balance_delta == null) ? null : Number(a.balance_delta);
          // 当日累计新增积分（daily_gain，0 点滚动）：daily_gain_date 非今天视为 0——
          // 昨日累计不跨天展示（今日未发生签到 → null 日期 → 0）。仅 workbuddy 签到路径写入，数值非敏感。
          const rawDailyGain = Number.isFinite(Number(a.daily_gain)) ? Math.max(0, Number(a.daily_gain)) : 0;
          const dailyGain = (a.daily_gain_date === localDateStr()) ? rawDailyGain : 0;
          // 当日签到奖励累计（daily_reward，0 点滚动）：flzt/right_forum/ypojie 专用，非余额系。
          // daily_reward_date 非今天视为 0（昨日累计不跨天展示）。数值 + 单位（daily_reward_unit）非敏感。
          const rawDailyReward = Number.isFinite(Number(a.daily_reward)) ? Math.max(0, Number(a.daily_reward)) : 0;
          const dailyReward = (a.daily_reward_date === localDateStr()) ? rawDailyReward : 0;
          const dailyRewardUnit = a.daily_reward_unit || "";
          const fmt = (v) => (typeof adapter.fmtBalance === "function" ? adapter.fmtBalance(v) : String(v));
          // 当前持有量（hero 大数字，非余额系）：acc.hold 由 _snapshotHold 写入（flzt 流量 / ypojie 积分）。
          // 声明 holdLabel 但无 queryBalance 的 adapter 走此路；恩山无稳定持有量字段 → hold 恒 null → 「—」。
          const hasHold = typeof adapter.holdLabel === "string" && typeof adapter.queryBalance !== "function";
          const rawHold = (a.hold === null || a.hold === undefined || a.hold === "") ? null : Number(a.hold);
          const fmtHold = (v) => (typeof adapter.fmtHold === "function" ? adapter.fmtHold(v) : String(v));
          // 编辑页字段回显：非敏感文本字段回显明文，type=password 字段回显脱敏串。
          //   服务端计算 mask，绝不回吐明文；空值字段两个对象都不含该 key（前端留空显 placeholder）。
          const field_masks = {};
          const field_values = {};
          for (const f of (Array.isArray(adapter.fields) ? adapter.fields : [])) {
            const v = a[f.key];
            if (v == null || v === "") continue;
            if (f.type === "password") field_masks[f.key] = maskSecret(v);
            else field_values[f.key] = String(v);
          }
          return {
            id: a.id,
            enabled: a.enabled !== false,
            remark: a.remark || "",
            label: adapter.getAccountLabel(a),
            field_masks,
            field_values,
            site_name: adapter.name,
            configured: adapter.isConfigured(a),
            has_session: !!a.session,
            last: last ? { time: last.time, status: last.status } : null,
            today_ok,
            last_date,
            points,
            supports_balance: supportsBalance,
            balance_label: supportsBalance ? (adapter.balanceLabel || "余额") : "",
            balance: rawBal,
            balance_delta: rawDelta,
            balance_ts: Number(a.balance_ts) || 0,
            balance_display: (supportsBalance && rawBal != null) ? fmt(rawBal) : "",
            balance_delta_display: (supportsBalance && rawDelta != null && rawDelta !== 0)
              ? ((rawDelta > 0 ? "+" : "") + fmt(rawDelta)) : "",
            // 当日累计新增余额：数值为今日生效值（日期非今天 → 0）+ workbuddy/NewAPI 系展示串（+N；0 → 空）
            auth_mode: (["newapi", "anyrouter"].includes(key) && a)
              ? (a.access_token ? "token" : ((a.cookie || a.cookies) ? "cookie" : ((a.username || a.email) ? "password" : "none")))
              : "",
            daily_gain: dailyGain,
            daily_gain_date: a.daily_gain_date || null,
            daily_gain_display: (supportsBalance && ["workbuddy", "newapi", "anyrouter"].includes(key) && dailyGain > 0) ? ("+" + fmt(dailyGain)) : "",
            // 当天签到奖励累计展示（flzt/right_forum/ypojie）：+X 单位（如 "+50 MB"）；今日无 / 目标外站点 → 空
            daily_reward: dailyReward,
            daily_reward_unit: dailyRewardUnit,
            daily_reward_display: (["flzt", "right_forum", "ypojie"].includes(key) && dailyReward > 0) ? ("+" + fmtDailyReward(dailyReward, dailyRewardUnit)) : "",
            // 统一英雄大数字（所有站点）：hero_display=当前持有量（空 → 前端「—」）；hero_delta_display=当天签到收益（>0 才有值）。
            //   余额系（workbuddy/newapi/anyrouter）：hero=balance + 当天 daily_gain；
            //   持有量系（flzt/ypojie/right_forum）：hero=hold + 当天 daily_reward。
            ...(function () {
              if (supportsBalance) {
                return {
                  hero_label: adapter.balanceLabel || "余额",
                  hero_display: (rawBal != null) ? fmt(rawBal) : "",
                  hero_delta_display: (["workbuddy", "newapi", "anyrouter"].includes(key) && dailyGain > 0) ? ("+" + fmt(dailyGain)) : "",
                };
              }
              if (hasHold) {
                return {
                  hero_label: adapter.holdLabel,
                  hero_display: (rawHold != null && Number.isFinite(rawHold)) ? fmtHold(rawHold) : "",
                  hero_delta_display: (["flzt", "right_forum", "ypojie"].includes(key) && dailyReward > 0) ? ("+" + fmtDailyReward(dailyReward, dailyRewardUnit)) : "",
                };
              }
              return { hero_label: "", hero_display: "", hero_delta_display: "" };
            })(),
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
    const { site, account_id, provider, base_url } = body || {};
    const adapter = ADAPTERS[site];
    if (!adapter) return fail(`未知站点：${site}`);
    const flow = adapter.loginFlow;
    if (!flow) return fail("该站点不支持交互登录（请用 Cookie 配置）");

    // oauth 模式：body.provider（github/linuxdo）→ 探平台取授权 URL，前端浏览器授权后粘回调
    if (provider) {
      const caps = Array.isArray(adapter.login_caps) ? adapter.login_caps : [];
      if (!caps.includes("oauth_" + provider)) return fail(`该站点不支持 ${provider} OAuth 登录`);
      if (typeof flow.oauthInit !== "function") return fail("该站点未实现 OAuth 登录");
      try {
        const site_cfg = this._store.getConfig().sites[site] || {};
        const cfg = { use_proxy: !!site_cfg.use_proxy };
        if (base_url && String(base_url).trim()) cfg.base_url = String(base_url).trim();
        const r = await flow.oauthInit(provider, cfg);
        // 清理过期会话，避免内存累积
        const nowMs = Date.now();
        for (const [k, v] of this._loginSessions) if (v.expires_at <= nowMs) this._loginSessions.delete(k);
        const token = crypto.randomBytes(12).toString("hex");
        this._loginSessions.set(token, {
          site, account_id: account_id || null, oauth: true,
          provider, base: r.base, state: r.state,
          expires_at: nowMs + 10 * 60 * 1000, // OAuth 授权窗口 10 分钟
        });
        return ok({
          status: "oauth", state: "oauth", token,
          auth_url: r.auth_url, login_mode: "oauth", provider,
          message: "请在浏览器完成授权，然后把地址栏回调链接粘贴回来",
        });
      } catch (err) {
        return fail(err.message || "OAuth 发起失败");
      }
    }

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
    this._applySiteProxy(cfg.sites[site], acc); // 站点级 use_proxy 兜底注入（内存合并，save 前还原）
    try {
      const r = await adapter.loginFlow.init(acc);
      if (!r || !r.session) { this._restoreInjectedProxy(); return fail("登录未返回会话"); }
      acc.session = r.session;
      acc.session_ts = Date.now();
      this._restoreInjectedProxy(); // 注入字段不落盘：先还原站点级 use_proxy 再保存
      this._store.save();
      return ok({
        status: r.status || "ready",
        session_type: r.session.type,
        login_mode: "form",
        message: r.message || "登录成功",
        account: { id: acc.id, label: adapter.getAccountLabel(acc), has_session: true },
      });
    } catch (err) {
      this._restoreInjectedProxy(); // 异常路径兜底：确保注入字段不残留
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
        // 扫码建号即拉一次积分/余额快照（不必等签到；失败不致命，仅记日志）。P3-2：与 runOnce 一致先注入站点 use_proxy
        this._applySiteProxy(adapter, acc);
        await this._snapshotBalance(adapter, acc);
        this._restoreInjectedProxy();
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

  /**
   * OAuth 回调完成（oauth 模式）：前端粘贴授权回调链接（含 code/state）→ 解析 → adapter 换 token
   * → 产出 token 型 session → 落账号（token 存 acc.session，不写明文凭据字段）。
   * body: { site, token, callback_url }
   */
  async loginFlowOAuthComplete(body) {
    const { site, token, callback_url } = body || {};
    const adapter = ADAPTERS[site];
    if (!adapter) return fail(`未知站点：${site}`);
    const flow = adapter.loginFlow;
    if (!flow || typeof flow.oauthComplete !== "function") return fail("该站点不支持 OAuth 登录");
    if (!token) return fail("缺少 OAuth 会话 token，请重新发起授权");
    const entry = this._loginSessions.get(token);
    if (!entry || entry.site !== site || !entry.oauth) return fail("授权会话不存在或已失效，请重新发起授权");
    if (Date.now() > entry.expires_at) {
      this._loginSessions.delete(token);
      return fail("授权已超时，请重新发起授权");
    }
    // 解析回调链接：取 code / state（兼容整段 URL 或裸 query）
    const { code, state } = parseOAuthCallback(callback_url);
    if (!code) return fail("回调链接里没有 code 参数，请粘贴完整的授权回调地址");
    // B5 修复：entry.state 存在时强制相等——回调缺 state / 不相等均拒绝（原先缺失 state 被放行）。
    // 仅当 entry 本身未建 state（上游未下发）才放行。
    if (entry.state && state !== entry.state) {
      return fail("OAuth state 校验失败，请重试");
    }
    try {
      const site_cfg = this._store.getConfig().sites[site] || {};
      const cfg = { use_proxy: !!site_cfg.use_proxy, base_url: entry.base };
      const r = await flow.oauthComplete({ provider: entry.provider, code, state: state || entry.state, cfg });
      if (!r || !r.session) return fail("OAuth 登录未返回会话");
      const acc = this._upsertLoginAccount(site, adapter, r.account || {}, entry.account_id);
      // token 存 session（非明文字段），标签落 oauth_login（_upsertLoginAccount 不写非字段键，这里补写）
      acc.session = r.session;
      acc.session_ts = Date.now();
      if (r.account && r.account.oauth_login) acc.oauth_login = String(r.account.oauth_login);
      this._store.save();
      this._loginSessions.delete(token);
      // P3-2：OAuth 建号快照与 runOnce 一致先注入站点 use_proxy
      this._applySiteProxy(adapter, acc);
      await this._snapshotBalance(adapter, acc);
      this._restoreInjectedProxy();
      this._log(`OAuth 登录成功：${adapter.name}（${adapter.getAccountLabel(acc)}）`);
      return ok({
        status: "ready", login_mode: "oauth",
        message: r.message || "授权登录成功",
        account: { id: acc.id, label: adapter.getAccountLabel(acc), has_session: true },
      });
    } catch (err) {
      return fail(err.message || "OAuth 登录失败");
    }
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
 * 从用户粘贴的授权回调里提取 code / state。
 * 兼容：完整 URL（https://host/oauth/github?code=x&state=y）、带 # 的、或裸 query（code=x&state=y）。
 */
function parseOAuthCallback(input) {
  const raw = String(input || "").trim();
  if (!raw) return { code: "", state: "" };
  const pick = (qs) => {
    try {
      const sp = new URLSearchParams(qs);
      return { code: sp.get("code") || "", state: sp.get("state") || "" };
    } catch { return { code: "", state: "" }; }
  };
  // 完整 URL：取 search（+ hash 里的 query 作兜底）
  try {
    const u = new URL(raw);
    let r = pick(u.search.replace(/^\?/, ""));
    if (!r.code && u.hash) r = pick(u.hash.replace(/^#/, "").replace(/^.*\?/, ""));
    if (r.code || r.state) return r;
  } catch { /* 非完整 URL：按裸 query 处理 */ }
  // 裸 query：去掉可能的前导 ? 或 path?...
  const q = raw.includes("?") ? raw.slice(raw.indexOf("?") + 1) : raw;
  return pick(q);
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

/** 本地日期 YYYY-MM-DD（服务端本地时区；daily_gain 0 点滚动以此判定） */
function localDateStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 当天奖励展示：数值去尾零 + 单位；MB 单位 ≥1024 换算 GB（如 50→"50 MB"、2048→"2 GB"）。 */
function fmtDailyReward(v, unit) {
  const n = Number(v) || 0;
  const trim = (x) => String(Number(Number(x).toFixed(2)));
  if (unit === "MB") {
    if (n >= 1024) return trim(n / 1024) + " GB";
    return trim(n) + " MB";
  }
  return trim(n) + (unit ? " " + unit : "");
}

/** 判断 history 时间字符串（'2026/9/20 23:40:15'）是否为今天 */
function sameDayStr(t) {
  if (!t) return false;
  const todayPrefix = new Date().toLocaleDateString("zh-CN", { hour12: false });
  return String(t).startsWith(todayPrefix);
}

/** 从 history 时间字符串（'2026/9/20 23:40:15'）提取本地日期 YYYY-MM-DD（F2 账号卡「上次」日期展示） */
function dateStrFromTime(t) {
  const m = String(t || "").match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (!m) return "";
  return `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;
}

/**
 * history 时间串（'2026/9/23 01:00:33'，toLocaleString zh-CN 本地格式）→ 服务器本地日期键 YYYY-MM-DD。
 * 容错：解析失败 → ""（该记录不参与按日聚合，仍计入 totals/sites 全量统计）。
 */
function historyDateKey(t) {
  if (!t) return "";
  const d = new Date(t); // 非 ISO 字符串按服务器本地时区解析（Asia/Shanghai）
  if (Number.isNaN(d.getTime())) return "";
  return localDateStr(d);
}

/**
 * 状态三分类（签到历史可视化）：「失败」类文案统一含「失败」二字 → failed；
 * 含「成功」/「已签到」→ success；其余（登录事件等）→ neutral。
 */
function classifyStatus(status) {
  const s = String(status || "");
  if (s.includes("失败")) return "failed";
  if (s.includes("成功") || s.includes("已签到")) return "success";
  return "neutral";
}

module.exports = { Server, ADAPTERS };