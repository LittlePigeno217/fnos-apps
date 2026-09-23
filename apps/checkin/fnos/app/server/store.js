"use strict";
/**
 * checkin — 配置存储（config.json 持久化，fnOS 应用数据目录）。
 * 敏感值（站点密码/Cookie）以明文存于 config.json，目录权限由 fnOS 保证（应用数据目录）。
 */
const fs = require("fs");
const path = require("path");
const { ADAPTERS } = require("./sites");   // ADAPTERS 单一事实源（本地不再维护拷贝）
const { setGlobalProxy } = require("./httpc"); // 全局代理配置注入（proxy_enabled + proxy_url）

// 全局代理地址格式：http(s):// 或 socks5(h):// 开头（socks5 当前仅做校验，HTTPS 隧道暂不支持）
const PROXY_URL_RE = /^(https?|socks5h?):\/\//i;

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
  version: "1.6.0",        // 功能版本（UI 左下角显示；热更后递增）
  cron: "08:10",           // 每日签到时刻 HH:MM
  notify_enabled: true,    // 飞书通知开关
  retry_count: 3,          // 站点失败重试次数
  feishu_webhook: "",      // 飞书机器人 Webhook
  proxy_enabled: false,    // 全局代理开关（勾选「走代理」的站点统一走 proxy_url）
  proxy_url: "",           // 全局代理地址（http(s):// 或 socks5://）
  sites: DEFAULT_SITES,
  // ── 调度内部状态（不暴露前端字段；saveConfig 白名单外；供调度器持久化）──
  sched_last_full: "",     // 上次「定时首跑」全量签到的本地日期（YYYY-MM-DD）
  sched_catchup_count: 0,  // 当日补签轮次数（每日 5 次上限；0 点跨天归零）
  sched_today_fail: {},    // 今日失败账号集：{ "site/account_id": true }（补签账号级定位）
  sched_fail_date: "",     // sched_today_fail 所属本地日期（0 点滚动据此重置）
};

class Store {
  constructor(dataDir) {
    this._dataDir = dataDir;
    this._path = path.join(dataDir, "checkin_config.json");
    this._historyPath = path.join(dataDir, "checkin_history.json");
    this._cfg = this._load();
    this._syncProxy(); // 启动即把持久化的全局代理配置注入 httpc（后续 saveConfig 变更时再同步）
  }

  /** 把当前全局代理配置注入 httpc 模块单例（启动加载 + 保存配置后调用） */
  _syncProxy() {
    setGlobalProxy(this._cfg.proxy_enabled, this._cfg.proxy_url);
  }

  _load() {
    let rawText = null;
    try {
      rawText = fs.readFileSync(this._path, "utf8");
    } catch (err) {
      // 文件不存在（首次运行）→ 正常回落默认；文件存在但读取失败（权限/IO）→ 同样走损坏备份
      if (err && err.code !== "ENOENT") this._backupCorruptConfig(err);
      return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    }
    try {
      return this._mergeDefaults(JSON.parse(rawText));
    } catch (err) {
      // 1.5.0 修复：JSON 解析失败 → 先把损坏原件原样复制备份（保留原始字节供人工恢复），
      // 再回落默认配置；否则下次 save（原子写 tmp+rename）会覆盖损坏文件，账号凭据全丢。
      this._backupCorruptConfig(err);
      return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    }
  }

  /** 本地时间戳 YYYYMMDD-HHMMSS（损坏备份文件名时间锚） */
  _corruptTs() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  /** B2 修复：config 损坏（解析失败/读取异常）时把损坏原件原样复制备份到
   *  <config-path>.corrupt-<YYYYMMDD-HHMMSS>，返回是否已备份；备份失败仅警告不阻断。
   *  损坏备份保留原始字节（含凭据明文，本地最小权限保存，不回传），供人工恢复。 */
  _backupCorruptConfig(err) {
    const reason = (err && err.message) || String(err);
    try {
      if (!fs.existsSync(this._path)) return false;
      const dst = `${this._path}.corrupt-${this._corruptTs()}`;
      fs.copyFileSync(this._path, dst);
      console.log(`checkin config 损坏（${reason}），原始文件已原样备份至 ${dst}，本次以默认配置启动（账号需人工恢复）`);
      return true;
    } catch (e) {
      console.warn(`checkin config 损坏（${reason}），且损坏备份失败：${(e && e.message) || e}（本次以默认配置启动）`);
      return false;
    }
  }

  _mergeDefaults(raw) {
    const cfg = { ...DEFAULT_CONFIG, ...raw };
    // 版本永远反映当前代码常量（DEFAULT_CONFIG.version，由 --bump 同步）：
    // 不参与持久化合并，避免 config 文件旧版本号在「fpk 升级 / 热更未回写」时
    // 覆盖新字面量，导致重启后版本号不变（对齐 p115assistant 已验证机制）。
    cfg.version = DEFAULT_CONFIG.version;
    // 全局代理配置类型收敛（防止手改 config 写入异常类型）；非法 URL 视为空（不启用）
    cfg.proxy_enabled = !!raw.proxy_enabled;
    cfg.proxy_url = (typeof raw.proxy_url === "string" && PROXY_URL_RE.test(raw.proxy_url.trim())) ? raw.proxy_url.trim() : "";
    // 调度内部状态类型收敛（内部字段，前端不可写；防手改 config 写入异常类型导致调度异常）
    cfg.sched_last_full = (typeof raw.sched_last_full === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.sched_last_full)) ? raw.sched_last_full : "";
    cfg.sched_catchup_count = Number.isFinite(Number(raw.sched_catchup_count))
      ? Math.max(0, Math.min(99, Math.floor(Number(raw.sched_catchup_count))))
      : 0;
    cfg.sched_today_fail = (raw.sched_today_fail && typeof raw.sched_today_fail === "object" && !Array.isArray(raw.sched_today_fail)) ? raw.sched_today_fail : {};
    cfg.sched_fail_date = (typeof raw.sched_fail_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.sched_fail_date)) ? raw.sched_fail_date : "";
    // 面板鉴权已移除：存量 config 中的 auth_enabled/auth_token 不再读取（物理值可残留，运行时忽略）
    delete cfg.auth_enabled;
    delete cfg.auth_token;
    cfg.sites = {};
    // anyrouter / newapi 拆分迁移（一次性、幂等）：旧统一适配器 anyrouter 站点的账号按
    // base_url host 归位——anyrouter.top / agentrouter / 空 base（默认）留在 anyrouter，
    // 其余 host（NewAPI/OneAPI/Sub2API 自建等）移入 newapi。迁移结果记日志（仅 host 与数量，无敏感值）。
    const split = this._migrateAnyNew(raw);
    for (const k of SITE_KEYS) {
      if (k === "anyrouter" || k === "newapi") {
        const part = split[k];
        cfg.sites[k] = { enabled: part.enabled, use_proxy: part.use_proxy, accounts: part.accounts };
      } else {
        const rawSite = (raw.sites || {})[k] || {};
        cfg.sites[k] = { enabled: !!rawSite.enabled, use_proxy: !!rawSite.use_proxy, accounts: this._migrateAccounts(rawSite, k) };
      }
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
        // daily_gain：当日累计新增积分（当天 0 点起签到奖励累计，≥0；0 点自动归零重计）。
        // daily_gain_date：累计所在本地日期（YYYY-MM-DD）。旧文件无此字段 → 0 / null。
        daily_gain: Number.isFinite(Number(a.daily_gain)) ? Math.max(0, Number(a.daily_gain)) : 0,
        daily_gain_date: (typeof a.daily_gain_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(a.daily_gain_date)) ? a.daily_gain_date : null,
      };
      // 字段按 adapter.fields 动态遍历（新站点类型新字段无需改白名单）
      for (const f of accountFieldKeys(slug)) {
        base[f] = String(a[f] || "");
      }
      return base;
    });
  }

  /* ── anyrouter → newapi 站点拆分迁移 ───────────────────────── */

  /** 账号 base_url → 纯 host（小写）；空 base_url → "" */
  _hostOf(acc) {
    const base = String(((acc && acc.base_url) || "")).trim().replace(/\/+$/, "");
    const m = base.match(/^https?:\/\/([^/]+)/i);
    return (m ? m[1] : base).toLowerCase();
  }

  /** 账号归属 anyrouter 系平台判定：空 host（缺省回落 anyrouter.top）或 anyrouter.top / agentrouter */
  _isAnyRouterHost(acc) {
    const h = this._hostOf(acc);
    if (!h) return true; // 空 base_url → 默认 anyrouter.top，留 anyrouter
    return h.includes("anyrouter.top") || h.includes("agentrouter");
  }

  /** 收集 anyrouter 站点账号：兼容多账号数组与旧版顶层单账号凭据格式（原始克隆，保留 session/npm 等非表单字段） */
  _collectAnyrouterAccounts(rawSite) {
    const site = rawSite || {};
    if (Array.isArray(site.accounts)) {
      return site.accounts.filter((a) => a && typeof a === "object").map((a) => ({ ...a }));
    }
    // 旧版顶层格式（单账号）：扫描旧统一适配器全部字段
    const legacy = {};
    let has = false;
    const OLD_FIELDS = ["base_url", "username", "password", "cookie", "api_user", "access_token", "email", "remark"];
    for (const f of OLD_FIELDS) {
      if (site[f] !== undefined && site[f] !== "") {
        legacy[f] = site[f];
        has = true;
      }
    }
    if (has) return [{ enabled: true, remark: String(site.remark || ""), ...legacy }];
    return [];
  }

  /** anyrouter / newapi 站点拆分迁移（一次性、幂等）：
   *  anyrouter 站点账号按 base_url host 归位——anyrouter.top / agentrouter / 空 base 留 anyrouter，
   *  其余 host 移入 newapi；移入账号字段按 newapi 白名单收敛（旧统一适配器字段与 newapi 白名单一致，
   *  无字段丢失），session/balance 等非表单字段随 `_migrateAccounts` 保留；id 冲突统一重分配。
   *  迁移结果记日志（仅数量与 host 名，不含凭据）。返回双方站点对象 + 统计。 */
  _migrateAnyNew(raw) {
    const rawSites = (raw && raw.sites) || {};
    const anyRaw = rawSites.anyrouter || {};
    const newRaw = rawSites.newapi || {};

    const keep = [];
    const moved = [];
    const movedHosts = [];
    for (const acc of this._collectAnyrouterAccounts(anyRaw)) {
      if (this._isAnyRouterHost(acc)) {
        const a = { ...acc };
        // 旧统一适配器用 username 作登录名；anyrouter 新表单为 email——只填 username 未填 email 时补位
        if (!String(a.email || "").trim() && String(a.username || "").trim()) {
          a.email = String(a.username).trim();
        }
        keep.push(a);
      } else {
        const h = this._hostOf(acc);
        if (h && !movedHosts.includes(h)) movedHosts.push(h);
        moved.push({ ...acc });
      }
    }

    // newapi 侧：已有 newapi 账号数组 + 移入账号（移入 id 统一重分配，避免与现有 id 撞车）
    const newAccs = Array.isArray(newRaw && newRaw.accounts) ? newRaw.accounts.slice() : [];
    const allocId = this._createIdAllocator(newAccs);
    for (const macc of moved) {
      const clone = { ...macc };
      delete clone.id; // id 重分配（站内唯一）
      newAccs.push({ id: allocId(), ...clone });
    }

    const movedCount = moved.length;
    const stayCount = keep.length;
    if (movedCount > 0) {
      console.log(`[checkin] 配置迁移：anyrouter 站点 ${stayCount} 个账号留在 anyrouter；${movedCount} 个账号按平台 host 移入 newapi（${movedHosts.join("、")}）`);
    }
    return {
      anyrouter: {
        enabled: !!anyRaw.enabled,
        use_proxy: !!anyRaw.use_proxy,
        accounts: this._migrateAccounts({ accounts: keep }, "anyrouter"),
      },
      // 收到移入账号：newapi 站点自动启用并继承 anyrouter 的 use_proxy（原 anyrouter 站点已启用时，
      // 避免移入后静默不签到）；仅当原 anyrouter 站点停用且 newapi 本为停用时 newapi 才保持停用。
      newapi: {
        enabled: !!newRaw.enabled || (movedCount > 0 && !!anyRaw.enabled),
        use_proxy: !!newRaw.use_proxy || (movedCount > 0 && !!anyRaw.use_proxy),
        accounts: this._migrateAccounts({ accounts: newAccs }, "newapi"),
      },
      movedCount,
      stayCount,
      movedHosts,
    };
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

  /** 本地日期 YYYY-MM-DD（调度内部状态跨天重置判定；0 点滚动） */
  _schedLocalDate() {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${m}-${day}`;
  }

  /* ── 调度内部状态：今日账号成功/失败集（补签账号级定位）────────────
   * sched_today_fail 记录今日签到「执行失败」的账号（键 site/account_id），供调度器
   * 补签时逐个重跑；站点级 today_ok/today_failed 仍由 history 派生（本集合不重复计算）。
   * 跨天（sched_fail_date ≠ 今日）自动视为空，首次记录时整体重置。 */

  /** 今日失败账号集 { "site/account_id": true }；跨天自动视为空（0 点滚动，不信任过期数据） */
  schedFailAccounts() {
    const cfg = this._cfg;
    return (cfg.sched_fail_date === this._schedLocalDate() && cfg.sched_today_fail && typeof cfg.sched_today_fail === "object")
      ? cfg.sched_today_fail
      : {};
  }

  /** 记录一次/一批账号签到结果：执行失败 → 入今日失败集；成功/已签到 → 清除。
   *  仅变更内存（落盘由调用方 runOnce/runAccount 的已有 store.save() 统一完成）；
   *  结果跨天首次记录时先把昨日集合整体重置。 */
  recordCheckinResults(results) {
    if (!Array.isArray(results) || !results.length) return;
    const cfg = this._cfg;
    const today = this._schedLocalDate();
    if (cfg.sched_fail_date !== today) {
      cfg.sched_today_fail = {};
      cfg.sched_fail_date = today;
    }
    for (const r of results) {
      if (!r || r.site_key == null || r.account_id == null) continue;
      const k = `${String(r.site_key)}/${String(r.account_id)}`; // 键统一 String 归一，防数字/字符串不一致
      // 封锁类失败（如易破解出口 IP 防爆破）：IP 级不可抗，封锁窗口（约 10 分钟）内补签必然再失败且延长封锁 → 当日不补签
      if (r.status === "执行失败" && String(r.error || r.message || "").includes("封锁")) continue;
      if (r.status === "执行失败") cfg.sched_today_fail[k] = true;
      else if (cfg.sched_today_fail[k]) delete cfg.sched_today_fail[k];
    }
  }

  /** B18 修复：账号签到成功 → 从今日失败集移除（撤销失败标记，补签列表不再重跑）。
   *  幂等（不在集合中则无副作用）；仅变更内存，落盘由调用方 runOnce/runAccount 的 save() 完成。
   *  与 recordCheckinResults 的成功分支同语义，供成功路径显式调用。 */
  schedCheckinSuccess(site, accountId) {
    if (site == null || accountId == null) return;
    const cfg = this._cfg;
    if (cfg.sched_today_fail && typeof cfg.sched_today_fail === "object") {
      delete cfg.sched_today_fail[`${String(site)}/${String(accountId)}`];
    }
  }

  save() {
    fs.mkdirSync(this._dataDir, { recursive: true });
    const tmp = this._path + ".tmp";
    try {
      fs.writeFileSync(tmp, JSON.stringify(this._cfg, null, 2));
      fs.renameSync(tmp, this._path);
    } catch (err) {
      // 1.5.0 修复：保存失败保留 tmp 文件（不清理，供人工排查/恢复）并提示路径；
      // 原子写失败未触碰原文件（存在仍为旧版有效配置）。继续向外抛，维持既有调用方语义
      // （runOnce/runAccount 已捕获记日志；saveConfig 由 Server 层包成 fail 返回前端）。
      console.error(`checkin config 保存失败：${(err && err.message) || err}。临时文件保留于 ${tmp}，本次未覆盖原文件`);
      throw err;
    }
  }

  getConfig() {
    return this._cfg;
  }

  /** 保存配置（白名单键，敏感值允许写入） */
  saveConfig(patch) {
    const cfg = this._cfg;
    // 先校验全局代理地址（非法直接抛错，避免部分字段已改入内存却因后续报错未落盘导致内存/磁盘不一致）
    if (patch.proxy_url !== undefined) {
      const v = String(patch.proxy_url || "").trim();
      if (v && !PROXY_URL_RE.test(v)) {
        throw new Error("代理地址格式非法：需以 http://、https:// 或 socks5:// 开头");
      }
    }
    if (patch.enabled !== undefined) cfg.enabled = !!patch.enabled;
    if (patch.cron !== undefined) {
      const v = String(patch.cron || "").trim();
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) {
        throw new Error("每日签到时刻格式应为 HH:MM（00:00-23:59）");
      }
      cfg.cron = v;
    }
    if (patch.notify_enabled !== undefined) cfg.notify_enabled = !!patch.notify_enabled;
    if (patch.retry_count !== undefined) {
      const raw = String(patch.retry_count).trim();
      if (!/^\d+$/.test(raw)) throw new Error("失败重试次数应为 1-99 的数字");
      const n = parseInt(raw, 10);
      if (n < 1 || n > 99) throw new Error("失败重试次数应在 1-99 之间");
      cfg.retry_count = n;
    }
    if (patch.feishu_webhook !== undefined) {
      const v = String(patch.feishu_webhook || "").trim();
      // F6 修复：空串 / "__clear__"（前端「留空保存」显式清除）→ 清除字段；有值 → 更新
      if (v === "" || v === "__clear__") cfg.feishu_webhook = "";
      else cfg.feishu_webhook = v;
    }
    // 全局代理（无敏感值，允许显式清空——留空即关闭代理地址）
    if (patch.proxy_enabled !== undefined) cfg.proxy_enabled = !!patch.proxy_enabled;
    if (patch.proxy_url !== undefined) cfg.proxy_url = String(patch.proxy_url || "").trim();
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
              // daily_gain 非 UI 表单字段（只由签到快照写入）：patch 未带则保留现值（0 点重置由快照逻辑负责）
              merged.daily_gain = Number.isFinite(Number(a.daily_gain))
                ? Math.max(0, Number(a.daily_gain))
                : Number.isFinite(Number(prev.daily_gain))
                  ? Math.max(0, Number(prev.daily_gain))
                  : 0;
              merged.daily_gain_date = (a.daily_gain_date === undefined || a.daily_gain_date === null || a.daily_gain_date === "")
                ? (prev.daily_gain_date == null ? null : prev.daily_gain_date)
                : String(a.daily_gain_date);
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
    this._syncProxy(); // 代理配置变更即时生效（后续出站请求读到新值，无需重启）
    return this._cfg;
  }

  setVersion(v) {
    this._cfg.version = String(v || "1.0.0");
    this.save();
  }

  /** 配置/history 文件绝对路径（B4 失败日志含路径，便于人工排查） */
  get configPath() {
    return this._path;
  }

  get historyPath() {
    return this._historyPath;
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

  /** B4/B13：整轮一次批量追加写入（单次读 + 单次写，替代 N 账号 → N×全文件 I/O）。
   *  语义与「按 records 顺序逐个 appendHistory」完全一致（records 末尾记录最终排在最前）；
   *  任一条失败整体单次抛出（由调用方捕获记日志，不抹掉已算出的整轮结果）。 */
  appendHistoryBatch(records) {
    if (!Array.isArray(records) || !records.length) return;
    let arr = [];
    try {
      arr = JSON.parse(fs.readFileSync(this._historyPath, "utf8"));
      if (!Array.isArray(arr)) arr = [];
    } catch {
      arr = [];
    }
    for (const rec of records) arr.unshift(rec);
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
