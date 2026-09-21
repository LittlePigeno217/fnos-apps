"use strict";

/**
 * 115网盘助手 FPK —— API 层（Node.js 版）。
 *
 * 把 MoviePilot-Plugins p115liteassistant 里 115 相关的核心能力重写为
 * 独立进程可调用的方法：登录（扫码）、浏览、上传（秒传/增量）、签到、
 * 302 取链、日志与飞书通知。方法签名对齐插件 Api 的语义：统一返回
 * { success, message, data }；错误一律捕获异常并返回 success=false，
 * 绝不向上抛。
 *
 * Python 版用线程与锁（threading.RLock / threading.Lock）；Node.js 单线程
 * 事件循环天然串行化这些互斥点，这里用简单布尔/自旋标记替代，语义一致。
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const { U115Client, U115AccessLimitError, U115AuthError, sleep } = require("./client");
const { Notifier } = require("./notify");
const { Store } = require("./store");
// 媒体账本子系统已于 2026-09-21 下线（FP-2）：ledger/ledger_verify/library_drop 三个 action、
// server/ledger.js 与正文字段删除；仅保留 posixDirname 供 STRM 记录生成云目录使用。
// 删除前已 grep 全仓库确认无其他引用（含 server.js 内 store/history 联动，无读点）。

// 路径小工具：取 POSIX 云路径的父目录（STRM 记录生成 cloud_dir 用），以 '/' 分隔。
// 原 ledger.js 一并下线（FP-2），此处内联唯一仍被核心 STRM 使用的小函数。
function posixDirname(value) {
  const text = String(value || "").replace(/\\/g, "/").replace(/\/+$/, "");
  const index = text.lastIndexOf("/");
  if (index < 0) return "";
  return text.slice(0, index);
}

function ok(data, message) {
  return { success: true, message: message || "", data: data === undefined ? {} : data };
}

function error(message, extra) {
  return Object.assign({ success: false, message, data: {} }, extra || {});
}

function okResponse() {
  return ok;
}

/** 网关层错误信封：与 Server 方法返回结构一致。 */
function gatewayError(message) {
  return error(message);
}

// 前端可安全接收配置字段的白名单（隐藏 cookie/tokens 等敏感值）。
const PUBLIC_CONFIG_FIELDS = new Set([
  "enabled",
  "version",
  "rate_limit_profile",
  "login_client_type",
  "upload_mappings",
  "upload_include_sidecars",
  "upload_generate_strm",
  "upload_delete_source",
  "upload_conflict_policy",
  "upload_media_extensions",
  "upload_sidecar_extensions",
  "upload_risk_profile",
  "watch_enabled",
  "strm_mappings",
  "strm_incremental",
  "strm_add_subtitles",
  "strm_base_url",
  "relay_port",
  "checkin_enabled",
  "checkin_time_range",
  "checkin_notify",
  "feishu_enabled",
  "feishu_webhook",
]);

// 只允许用户从界面改这些键。
const EDITABLE_CONFIG_FIELDS = new Set([
  "enabled",
  "rate_limit_profile",
  "upload_mappings",
  "upload_include_sidecars",
  "upload_generate_strm",
  "upload_delete_source",
  "upload_conflict_policy",
  "upload_media_extensions",
  "upload_sidecar_extensions",
  "checkin_enabled",
  "checkin_time_range",
  "checkin_notify",
  "feishu_enabled",
  "feishu_webhook",
  "upload_risk_profile",
  "strm_mappings",
  "strm_incremental",
  "strm_add_subtitles",
  "strm_base_url",
  "relay_port",
]);

function mask(value) {
  if (typeof value === "string" && value.length > 8) {
    return value.slice(0, 4) + "****" + value.slice(-4);
  }
  return value;
}

class FileWatcher {
  constructor(server) {
    this._server = server;
    this._interval = null;
    this._intervalMs = 30000;          // 轮询间隔
    this._stabilityMs = 60000;         // 文件稳定等待期（需保持 size 不变）
    this._snapshots = new Map();       // mappingId → { ts, snapshot: Map<relPath,size>, pending: Map<relPath,{firstSeen,stabilizing,size}> }
    this._started = false;
    // 持久化监听状态：区分「真正首次配置（只建基线）」与「重启恢复（补传未记录文件）」
    this._statePath = path.join(this._server.store._dir || ".", "watcher_state.json");
    this._state = this._loadState();
  }

  _loadState() {
    try { return JSON.parse(fs.readFileSync(this._statePath, "utf8")) || {}; }
    catch { return {}; }
  }

  _saveState() {
    try { fs.writeFileSync(this._statePath, JSON.stringify(this._state)); }
    catch { /* 状态保存失败不影响监听 */ }
  }

  start() {
    if (this._interval) return;
    this._interval = setInterval(() => this._tick(), this._intervalMs);
    this._started = true;
    setImmediate(() => this._tick());  // 立即跑第一轮
    console.log(`[FileWatcher] 已启动，轮询间隔 ${this._intervalMs / 1000}s`);
  }

  stop() {
    if (this._interval) { clearInterval(this._interval); this._interval = null; }
    this._snapshots.clear();
    this._started = false;
    console.log("[FileWatcher] 已停止");
  }

  status() {
    const entries = [];
    for (const [mappingId, snap] of this._snapshots) {
      const status = this._watcherMappingStatus(mappingId, snap);
      entries.push(status);
    }
    return { running: this._started, interval_ms: this._intervalMs, mappings: entries };
  }

  _watcherMappingStatus(mappingId, snap) {
    const config = this._server.store.getConfig();
    const mapping = (config.upload_mappings || []).find(m => String(m.id || "") === mappingId);
    const pending = [];  // {path, firstSeen}
    for (const [relPath, p] of snap.pending) pending.push({ path: relPath, first_seen: p.firstSeen });
    return {
      id: mappingId,
      name: mapping ? mapping.name : "?",
      source: mapping ? mapping.source : "?",
      enabled: mapping ? mapping.enabled !== false : false,
      files: snap.snapshot.size,
      pending: pending.length,
      pending_details: pending.slice(0, 5),
    };
  }

  async _tick() {
    if (!this._started) return;
    if (this._server._riskLimited()) { console.log("[FileWatcher] 风控冷却中，跳过本轮扫描"); return; }
    const config = this._server.store.getConfig();
    const mappings = (config.upload_mappings || []).filter(m => m.enabled !== false);
    for (const mapping of mappings) {
      const mappingId = String(mapping.id || "");
      if (!mappingId) continue;
      try { await this._scanMapping(mapping, config); } catch (err) {
        console.warn(`[FileWatcher] 扫描映射 ${mapping.name} 异常：${err.message}`);
      }
    }
  }

  async _scanMapping(mapping, config) {
    const mappingId = String(mapping.id || "");
    const [source, sourceErr] = this._server._authorizedLocalPath(mapping.source);
    if (source === null) return;  // 无效路径跳过
    if (!fs.existsSync(source)) return;

    // 创建当前快照
    const now = Date.now();
    const currentSnapshot = new Map();
    const mediaExts = extensionSet(config.upload_media_extensions);
    const sidecarExts = extensionSet(config.upload_sidecar_extensions);
    const includeSidecars = config.upload_include_sidecars !== false;

    this._scanDir(source, source, (relPath, stat) => {
      const suffix = path.extname(relPath).toLowerCase();
      if (!suffix) return;
      if (!mediaExts.has(suffix) && !(includeSidecars && sidecarExts.has(suffix))) return;
      currentSnapshot.set(relPath, stat.size);
    });

    // 获取或初始化该映射的快照状态
    if (!this._snapshots.has(mappingId)) {
      this._snapshots.set(mappingId, { ts: now, snapshot: new Map(), pending: new Map(), baseline: true });
    }
    const snap = this._snapshots.get(mappingId);
    const prevSnapshot = snap.snapshot;
    const pending = snap.pending;
    const isBaseline = snap.baseline;
    let hasNewFiles = false;

    if (isBaseline) {
      // 基线：区分首次配置与重启恢复。
      //  - 首次配置（watcher_state 无该映射）→ 只建快照，避免把目录历史文件突击上传
      //  - 重启恢复（watcher_state 已 active）→ 用持久化上传记录核对，把「无记录」文件
      //    视为待上传（补传），防止上传任务执行期间应用重启后剩余文件被基线吞掉
      const stateEntry = this._state[mappingId];
      const isFirst = !stateEntry || !stateEntry.active;
      if (!isFirst) {
        const records = this._server.store.getUploadRecords();
        const targetCid = String(mapping.target_cid || "0");
        for (const [relPath, size] of currentSnapshot) {
          try {
            if (!records.hasChanged(relPath, targetCid)) continue; // 已有记录：已上传过，跳过
          } catch {
            /* 记录异常按待上传处理 */
          }
          if (!pending.has(relPath)) {
            pending.set(relPath, { firstSeen: now, size });
          }
        }
      }
      // 本轮基线后标记已监听，重启后即为「恢复」而非「首次」
      this._state[mappingId] = { active: true, ts: now };
      this._saveState();
    } else {
      // diff：新增/修改文件 → pending（等稳定）
      for (const [relPath, size] of currentSnapshot) {
        if (prevSnapshot.has(relPath)) {
          const prevSize = prevSnapshot.get(relPath);
          if (prevSize !== size && !pending.has(relPath)) {
            // 文件被修改：重置稳定期
            pending.set(relPath, { firstSeen: now, size });
          }
          continue;
        }
        // 新文件：首次发现
        if (!pending.has(relPath)) {
          pending.set(relPath, { firstSeen: now, size });
        }
      }
    }

    // 稳定性检查：pending 里的大小连续不变且超过稳定期 → 触发上传
    for (const [relPath, p] of pending) {
      const size = currentSnapshot.get(relPath);
      if (size === undefined) {
        // 文件已消失（被移动/删除），放弃追踪
        pending.delete(relPath);
        continue;
      }
      if (p.size !== size) {
        // 还在写：重置
        p.firstSeen = now;
        p.size = size;
        continue;
      }
      if (now - p.firstSeen >= this._stabilityMs) {
        // 稳定 → 触发上传
        pending.delete(relPath);
        hasNewFiles = true;
      }
    }

    // 更新快照（基线扫描后标记完成）
    snap.ts = now;
    snap.snapshot = currentSnapshot;
    snap.baseline = false;

    // 有稳定新文件 → 触发一次扫描
    if (hasNewFiles) {
      console.log(`[FileWatcher] 映射 ${mapping.name} 检测到新增文件，触发上传扫描`);
      this._server._uploadWorker.submit(mappingId);
    }
  }

  _scanDir(baseDir, directory, callback) {
    let names;
    try {
      names = fs.readdirSync(directory, { withFileTypes: true });
    } catch { return; }
    names.sort();
    for (const dirent of names) {
      if (dirent.name.startsWith(".")) continue;  // 跳过隐藏文件/目录
      const fullPath = path.join(directory, dirent.name);
      const relPath = path.relative(baseDir, fullPath);
      if (dirent.isDirectory()) {
        this._scanDir(baseDir, fullPath, callback);
      } else if (dirent.isFile()) {
        try {
          const stat = fs.statSync(fullPath);
          callback(relPath, stat);
        } catch { continue; }
      }
    }
  }
}

class UploadWorker {
  /** 后台上传：串行消费一次扫描请求，避免与 HTTP 请求互相阻塞。 */
  constructor(runOnce, onIdle) {
    this._runOnce = runOnce;
    this._onIdle = onIdle || null;
    this._queue = [];
    this._running = false;
    this._cancelRequested = false;
  }

  submit(scope) {
    this._queue.push(scope);
    if (this._running) return;
    this._running = true;
    // Node 单线程事件循环天然串行：这里不能同步跑完整个队列（会阻塞网关），
    // 用微任务/Promise 链让出事件循环，真正的工作逐项执行。
    this._drain();
  }

  cancel() {
    // 协作取消：只置标记，让扫描在文件安全检查点停下来；不强杀正在执行的请求。
    this._cancelRequested = true;
  }

  cancelled() {
    return this._cancelRequested;
  }

  async _drain() {
    let completed = true;
    try {
      while (this._queue.length) {
        if (this._cancelRequested) {
          completed = false;
          break;
        }
        const scope = this._queue.shift();
        try {
          await this._runOnce(scope);
        } catch (err) {
          console.error(`上传扫描异常：${err.message}`);
        }
      }
    } finally {
      this._running = false;
      this._cancelRequested = false;
      // 队列自然清空（未被取消）→ 通知整轮上传完成（供「上传后生成 STRM」接线）
      if (completed && typeof this._onIdle === "function") {
        try {
          this._onIdle();
        } catch (err) {
          console.error(`上传完成回调异常：${err.message}`);
        }
      }
    }
  }

  active() {
    return this._running;
  }

  pending() {
    return this._queue.length;
  }
}

class Server {
  constructor(store) {
    this.store = store;
    this._notifier = new Notifier(() => store.getConfig());
    this._client = null;
    this._clientSignature = null;
    this._browseCache = new Map();
    this._checkinBusy = false;
    this._checkinToday = null;
    this._checkinCheckedDate = "";
    this._uploadWorker = new UploadWorker(
      (job) => this._runWorkerJob(job),
      null
    );
    this._fileWatcher = new FileWatcher(this);
    this._riskState = {
      limited: false,          // 风控触发
      limitedAt: 0,            // 触发时间戳
      limitedUntil: 0,         // 冷却截止时间戳（epoch ms）
      limitedMessage: "",      // 错误描述
      consecutiveFailures: 0,  // 连续失败计数（非风控）
    };
    this._logTail = [];
    this._strmBusy = false;          // STRM 生成的并发闸（同步与一次性任务共用）
    this._uploadStrmSyncTimer = null; // 「上传后生成 STRM」防抖定时器（上传空闲回调触发）
    this._redirectUrlCache = new Map();   // 匿名 302 取链 URL 缓存（pickcode|ua → {url, expireAt}）
    this._redirectInflight = new Map();   // 匿名 302 singleflight 并发去重（同 key 共享一次取链）
    this._redirectCacheMax = 2048;        // 缓存容量上限（超限裁剪最旧）
    // 统一日志管道：console 输出（上传/STRM/监听/风控/签到等执行日志）同步写入
    // 内存日志环（前端「日志」面板读取），2026-09-18。只包装一次。
    // 级别映射：log→INFO、warn→WARN、error→ERROR；类型由文本关键字推断（_inferType）。
    if (!this._consoleHooked) {
      this._consoleHooked = true;
      const self = this;
      const originals = { log: console.log.bind(console), warn: console.warn.bind(console), error: console.error.bind(console) };
      console.log = (...args) => { self.recordLog(args.map(String).join(" "), "INFO"); originals.log(...args); };
      console.warn = (...args) => { self.recordLog(`⚠ ${args.map(String).join(" ")}`, "WARN"); originals.warn(...args); };
      console.error = (...args) => { self.recordLog(`✗ ${args.map(String).join(" ")}`, "ERROR"); originals.error(...args); };
    }
  }

  // ── 风控预设（参考 115 轻量助手插件：请求级限速 + 任务级 abort + 冷却恢复）──
  static RISK_PROFILES = {
    conservative: { fileIntervalMs: 6000, instantIntervalMs: 2000, batchSize: 5, batchPauseMs: 30000, cooldownMs: 70 * 1000 },
    balanced:     { fileIntervalMs: 3000, instantIntervalMs: 1000, batchSize: 10, batchPauseMs: 15000, cooldownMs: 70 * 1000 },
    aggressive:   { fileIntervalMs: 1500, instantIntervalMs: 500,  batchSize: 20, batchPauseMs: 5000,  cooldownMs: 70 * 1000 },
  };

  _riskProfileConfig() {
    const config = this.store.getConfig();
    const profileName = String(config.upload_risk_profile || "conservative").toLowerCase();
    return Server.RISK_PROFILES[profileName] || Server.RISK_PROFILES.conservative;
  }

  _riskLimited() {
    const state = this._riskState;
    if (!state.limited) return false;
    if (Date.now() >= state.limitedUntil) {
      state.limited = false;
      state.limitedMessage = "";
      console.log("【风控】冷却期结束，恢复上传");
      this.store.appendHistory({
        ts: Date.now(), type: "upload", title: "风控冷却结束",
        detail: "已恢复上传能力", ok: true,
      });
      return false;
    }
    return true;
  }

  _riskPause(message) {
    const profile = this._riskProfileConfig();
    const state = this._riskState;
    state.limited = true;
    state.limitedAt = Date.now();
    state.limitedUntil = Date.now() + profile.cooldownMs;
    state.limitedMessage = String(message || "115 触发风控/访问上限");
    state.consecutiveFailures = 0;
    console.log(`【风控】${state.limitedMessage}，暂停上传 ${Math.round(profile.cooldownMs / 1000)} 秒`);
    this.store.appendHistory({
      ts: Date.now(), type: "upload", title: "风控触发",
      detail: `${state.limitedMessage}；已暂停上传 ${Math.round(profile.cooldownMs / 1000)} 秒`, ok: false,
    });
  }

  _riskCooldownRemaining() {
    if (!this._riskState.limited) return 0;
    return Math.max(0, this._riskState.limitedUntil - Date.now());
  }

  _riskStatus() {
    return {
      limited: this._riskState.limited,
      remaining_ms: this._riskCooldownRemaining(),
      message: this._riskState.limited ? this._riskState.limitedMessage : "",
      consecutive_failures: this._riskState.consecutiveFailures,
      profile: this._riskProfileConfig(),
      profile_name: String(this.store.getConfig().upload_risk_profile || "conservative"),
    };
  }

  async _riskSleep(ms) {
    if (ms > 0) {
      // 分片等待，风控冷却中可提前退出
      const step = 250;
      let waited = 0;
      while (waited < ms) {
        if (this._riskLimited()) return;
        const chunk = Math.min(step, ms - waited);
        await sleep(chunk / 1000);
        waited += chunk;
      }
    }
  }

  // ── 客户端工厂：配置变化后自动重建，保持与插件「改完即生效」一致 ──
  _clientSignatureFromConfig() {
    const config = this.store.getConfig();
    return [
      String(config.cookie || ""),
      String(config.rate_limit_profile || "balanced"),
      String((config.tokens || {}).access_token || ""),
      String((config.tokens || {}).refresh_token || ""),
    ].join("\n");
  }

  _getClient() {
    const signature = this._clientSignatureFromConfig();
    if (this._client === null || signature !== this._clientSignature) {
      const config = this.store.getConfig();
      this._client = new U115Client({
        cookie: String(config.cookie || ""),
        tokens: Object.assign({}, config.tokens || {}),
        client_type: String(config.login_client_type || ""),
        rate_limit_profile: String(config.rate_limit_profile || "balanced"),
        tokenSaver: (tokens) => this._onTokensChanged(tokens),
      });
      this._clientSignature = signature;
    }
    return this._client;
  }

  _onTokensChanged(tokens) {
    try {
      const config = this.store.getConfig();
      config.tokens = Object.assign({}, tokens);
      if (this._client && this._client.clientType) {
        config.login_client_type = this._client.clientType;
      }
      this.store.saveConfig(config);
    } catch (err) {
      console.warn(`回写 115 token 失败：${err.message}`);
    }
  }

  _invalidateBrowseCache() {
    this._browseCache.clear();
  }

  // ── 配置 ──
  // fpk 安装版本：读 fnOS 构建注入的 config/bootstrap/p115assistant-version.env
  _fpkVersion() {
    try {
      const envPath = path.join(__dirname, "..", "config", "bootstrap", "p115assistant-version.env");
      const txt = fs.readFileSync(envPath, "utf8");
      const m = txt.match(/P115ASSISTANT_VERSION=([0-9.]+)/);
      if (m) return m[1];
    } catch { /* 读不到则回退 config.version */ }
    return "";
  }

  // 功能版本：最近一次热更新应用的清单版本（patches/current.json）；从未热更新则 = fpk 初始版本
  _functionVersion(configVersion) {
    try {
      const p = path.join(this.store._dir || "", "patches", "current.json");
      if (require("fs").existsSync(p)) {
        const j = JSON.parse(require("fs").readFileSync(p, "utf8"));
        if (j && /^\d+\.\d+\.\d+$/.test(String(j.version || ""))) return j.version;
      }
    } catch { /* 读不到视为未热更 */ }
    return configVersion || "";
  }

  getConfig() {
    try {
      const config = this.store.getConfig();
      const publicConfig = {};
      for (const key of PUBLIC_CONFIG_FIELDS) {
        publicConfig[key] = config[key];
      }
      // fnos 凭据仅通过 fnos_status 告知「是否已配置」，不暴露值
      publicConfig.fnos_configured = !!(config.fnos_username && config.fnos_password);
      // fpk 安装版本（fnOS 构建注入 env；与热更新功能版本区分）
      publicConfig.fpk_version = this._fpkVersion() || publicConfig.version || "";
      // 功能版本（热更清单版本；左下角显示用）
      publicConfig.function_version = this._functionVersion(publicConfig.version || "1.0.0");
      if (publicConfig.feishu_webhook) {
        publicConfig.feishu_webhook = mask(publicConfig.feishu_webhook);
      }
      return ok(publicConfig);
    } catch (err) {
      console.error(`读取配置失败：${err.message}`);
      return error("读取配置失败");
    }
  }

  async saveConfig(payload) {
    payload = payload || {};
    const updates = {};
    for (const [key, value] of Object.entries(payload)) {
      if (EDITABLE_CONFIG_FIELDS.has(key)) updates[key] = value;
    }
    // feishu_webhook 为 password 类型，fnOS 表单不回显当前值；空值表示“保持当前”，
    // 避免用户在运行设置修改其他项后误清空已有 Webhook（2026-09-18）。
    if (Object.prototype.hasOwnProperty.call(updates, "feishu_webhook") && !String(updates.feishu_webhook).trim()) {
      delete updates.feishu_webhook;
    }
    // relay_port 唯一权威（FP-1）：302 监听与 STRM URL 都以 config.relay_port 为准。
    // 留空视为恢复默认 3667；非 1-65535 整数直接拒绝，绝不落库非法端口。
    if (Object.prototype.hasOwnProperty.call(updates, "relay_port")) {
      const raw = String(updates.relay_port === undefined ? "" : updates.relay_port).trim();
      let port;
      if (raw === "") {
        port = 3667;
      } else {
        if (!/^\d+$/.test(raw)) return error("中转端口必须为 1-65535 的整数");
        port = parseInt(raw, 10);
        if (!Number.isFinite(port) || port < 1 || port > 65535) return error("中转端口必须为 1-65535 的整数");
      }
      updates.relay_port = port;
    }
    if (!Object.keys(updates).length) {
      return error("没有可保存的配置项");
    }
    try {
      // 联动：STRM 基础连接变更 → 防抖 2s 自动触发一次同步重写（免等 watch）
      const before = this.store.getConfig();
      this.store.updateConfig(updates);
      const after = this.store.getConfig();
      const relayChanged = String(before.relay_port) !== String(after.relay_port);
      const linkChanged = ["strm_base_url", "relay_port"].some(
        (k) => String(before[k] === undefined ? "" : before[k]) !== String(after[k] === undefined ? "" : after[k])
      );
      this._client = null;
      this._clientSignature = null;
      this.recordLog(`配置已保存：${Object.keys(updates).join(", ")}`, "INFO", "CONFIG");
      if (linkChanged) {
        clearTimeout(this._strmSyncTimer);
        this._strmSyncTimer = setTimeout(() => {
          this.strmSync({})
            .then((res) => {
              this.recordLog(
                `STRM 基础连接变更，自动同步：${res && res.success ? res.message : (res && res.message ? res.message : "无启用的映射或无需更新")}`,
                "INFO",
                "STRM"
              );
            })
            .catch((err) => console.warn(`自动 STRM 同步失败：${err.message}`));
        }, 2000);
      }
      // relay_port 变更 → 立即动态重绑 302 监听（relistener 由 main.js 注册）。
      // 新端口绑定失败时回退「新端口需重启生效」提示，配置保持已保存状态。
      if (relayChanged && typeof this._relistener === "function") {
        try {
          await this._relistener(after.relay_port);
          this.recordLog(`302 中转端口已切换：${after.relay_port}`, "INFO", "LINK");
          return ok(undefined, `配置已保存，中转端口已切换到 ${after.relay_port}`);
        } catch (err) {
          console.warn(`302 中转端口重绑失败：${err.message}`);
          this.recordLog(`302 中转端口重绑失败：${err.message}（新端口 ${after.relay_port} 将在应用重启后生效）`, "WARN", "LINK");
          return ok(undefined, `配置已保存；中转端口 ${after.relay_port} 绑定失败（可能被占用），将在应用重启后生效`);
        }
      }
      return ok(undefined, "配置已保存");
    } catch (err) {
      console.error(`保存配置失败：${err.message}`);
      return error("保存配置失败");
    }
  }

  // ── 登录 ──
  status() {
    try {
      const client = this._getClient();
      const config = this.store.getConfig();
      const authMode = client.tokens.access_token
        ? "open"
        : client.cookie
          ? "cookie"
          : "none";
      return ok({
        authenticated: Boolean(client.isAuthenticated()),
        auth_mode: authMode,
        client_type: client.clientType,
        login_client_type: config.login_client_type || "",
        user_id: cookieUserIdText(client),
      });
    } catch (err) {
      console.error(`读取登录状态失败：${err.message}`);
      return error("读取登录状态失败");
    }
  }

  async qrcode(payload) {
    try {
      const clientType = String((payload || {}).client_type || "alipaymini");
      const result = await this._getClient().generateQrcode(clientType);
      if (!result.success) {
        return error(result.message || "获取二维码失败");
      }
      const content = String((result.data || {}).code_content || "");
      if (!content) {
        return error("115 未返回二维码内容");
      }
      return ok({
        content,
        client_type: (result.data || {}).client_type || clientType,
      });
    } catch (err) {
      console.error(`获取二维码失败：${err.message}`);
      return error(`获取二维码失败: ${err.message}`);
    }
  }

  async checkLogin() {
    try {
      const client = this._getClient();
      const result = await client.checkLogin();
      if (!result.success) {
        return error(result.message || "检查登录状态失败");
      }
      const data = result.data || {};
      if (data.status === 2) {
        const config = this.store.getConfig();
        config.tokens = client.exportTokens();
        config.login_client_type = client.clientType;
        if (client.cookie) config.cookie = client.cookie;
        this.store.saveConfig(config);
        this._invalidateBrowseCache();
        this._checkinToday = null;
      }
      return ok(data);
    } catch (err) {
      // 扫码浮层每 3s 轮询会频繁命中这里（超时/网络抖动属预期中间态），
      // 按 debug 级别记录，避免无意义的 error 刷屏；真实故障仍可从 app.log 排查。
      console.debug(`检查登录状态失败：${err.message}`);
      return error("检查登录状态失败");
    }
  }

  logout() {
    try {
      const config = this.store.getConfig();
      config.cookie = "";
      config.tokens = {};
      config.login_client_type = "";
      this.store.saveConfig(config);
      this._client = null;
      this._clientSignature = null;
      this._invalidateBrowseCache();
      return ok(undefined, "已退出登录");
    } catch (err) {
      console.error(`退出登录失败：${err.message}`);
      return error("退出登录失败");
    }
  }

  // ── 网盘浏览与管理 ──
  async diskList(cid) {
    try {
      const target = String(cid === undefined || cid === null ? "0" : (typeof cid === "object" ? cid.cid || "0" : cid));
      if (this._browseCache.has(target)) {
        return ok({
          cid: target,
          items: JSON.parse(JSON.stringify(this._browseCache.get(target))),
        });
      }
      const items = [];
      for (const raw of await this._getClient().getDirList(target)) {
        if (!raw || typeof raw !== "object") continue;
        const name = String(U115Client._itemName(raw) || "").trim();
        const itemId = U115Client._itemId(raw);
        if (!name || !itemId) continue;
        const isDir = U115Client._isDirectory(raw);
        items.push({
          id: itemId,
          name,
          is_dir: isDir,
          size: isDir ? 0 : parseInt(U115Client._itemSize(raw) || 0, 10),
          mtime: parseInt(U115Client._itemMtime(raw) || 0, 10),
          pickcode: String(
            raw.pc || raw.pickcode || raw.pick_code || ""
          ),
        });
      }
      items.sort((a, b) => {
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
        return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1;
      });
      this._browseCache.set(target, JSON.parse(JSON.stringify(items)));
      return ok({ cid: target, items });
    } catch (err) {
      console.error(`列目录失败：${err.message}`);
      return error(`列目录失败: ${err.message}`);
    }
  }

  async dirsOnly(cid) {
    try {
      const target = String(cid === undefined || cid === null ? "0" : (typeof cid === "object" ? cid.cid || "0" : cid));
      const result = await this.diskList(target);
      if (!result.success) return result;
      const items = result.data.items
        .filter((item) => item.is_dir)
        .map((item) => ({ name: item.name, cid: item.id }));
      items.sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1));
      return ok({ cid: target, items });
    } catch (err) {
      console.error(`浏览目录失败：${err.message}`);
      return error(`浏览目录失败: ${err.message}`);
    }
  }

  async diskMkdir(payload) {
    const data = payload || {};
    const name = String(data.name || "").trim();
    if (!name) return error("目录名不能为空");
    if (name.includes("/") || name === "." || name === "..") {
      return error("目录名里不能带路径分隔符");
    }
    try {
      await this._getClient().createChildDir(String(data.cid || "0"), name);
    } catch (err) {
      console.error(`新建目录失败：${err.message}`);
      return error(`新建目录失败: ${err.message}`);
    }
    this._invalidateBrowseCache();
    return ok(undefined, `已新建目录 ${name}`);
  }

  async diskRename(payload) {
    const data = payload || {};
    const fileId = String(data.file_id || "").trim();
    const name = String(data.name || "").trim();
    if (!fileId) return error("缺少要改名的文件 ID");
    if (!name) return error("新名字不能为空");
    try {
      await this._getClient().renameItem(fileId, name);
    } catch (err) {
      console.error(`改名失败：${err.message}`);
      return error(`改名失败: ${err.message}`);
    }
    this._invalidateBrowseCache();
    return ok(undefined, `已改名为 ${name}`);
  }

  async diskDelete(payload) {
    const data = payload || {};
    let rawIds = data.file_ids || data.ids;
    if (typeof rawIds === "string" || typeof rawIds === "number") {
      rawIds = [rawIds];
    }
    if (!Array.isArray(rawIds) || !rawIds.length) {
      return error("没有要删的文件");
    }
    const ids = [...new Set(rawIds.map((value) => String(value || "").trim()).filter(Boolean))];
    if (!ids.length) return error("没有要删的文件");
    try {
      await this._getClient().deleteFile(ids);
    } catch (err) {
      console.error(`删除失败：${err.message}`);
      return error(`删除失败: ${err.message}`);
    }
    this._invalidateBrowseCache();
    return ok(undefined, `已删除 ${ids.length} 项`);
  }

  // ── 本地路径授权检查 ──
  browseLocal(query) {
    try {
      const roots = this._accessibleRoots();
      if (!roots.length) {
        return error("没有可用的本地可访问目录（TRIM_DATA_ACCESSIBLE_PATHS 未配置）");
      }
      const requested = String((query || {}).path || "");
      const base = roots[0];
      let current = path.resolve(base);
      if (requested) {
        const candidate = path.resolve(base, requested);
        if (candidate === base || candidate.startsWith(base + path.sep)) {
          current = candidate;
        } else {
          return error("目录超出应用可访问根目录");
        }
      }
      let stat;
      try {
        stat = fs.statSync(current);
      } catch {
        return error(`目录不存在或不可读: ${current}`);
      }
      if (!stat.isDirectory()) {
        return error(`不是目录: ${current}`);
      }
      let names = [];
      try {
        names = fs.readdirSync(current);
      } catch {
        /* 保持空 */
      }
      names.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
      const items = [];
      for (const name of names) {
        if (name.startsWith(".")) continue;
        let st;
        try {
          st = fs.statSync(path.join(current, name));
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          items.push({ name, path: path.relative(base, path.join(current, name)).split(path.sep).join("/") });
        }
      }
      return ok({
        base: String(base),
        current: current === base ? "" : path.relative(base, current).split(path.sep).join("/"),
        items,
      });
    } catch (err) {
      console.error(`浏览本地目录失败：${err.message}`);
      return error(`浏览本地目录失败: ${err.message}`);
    }
  }

  // ── 本地路径授权检查 ──
  _accessibleRoots() {
    const raw =
      process.env.TRIM_DATA_ACCESSIBLE_PATHS || process.env.TRIM_DATA_SHARE_PATHS;
    if (!raw) return [];
    const roots = [];
    for (const part of String(raw).split(":")) {
      if (!part.trim()) continue;
      try {
        const root = path.resolve(part.trim());
        if (!roots.includes(root)) roots.push(root);
      } catch {
        /* 忽略不可解析的路径 */
      }
    }
    return roots;
  }

  /** 把配置里的本地路径规范化并检查边界；返回 [path, ""] 或 [null, 错误信息]。 */
  _authorizedLocalPath(value) {
    let candidate;
    try {
      candidate = path.resolve(String(value || ""));
    } catch (err) {
      return [null, `本地路径无效: ${err.message}`];
    }
    if (candidate === "/" || path.parse(candidate).root === candidate) {
      return [null, "不允许使用文件系统根目录作为映射"];
    }
    let stat;
    try {
      stat = fs.statSync(candidate);
    } catch {
      return [null, `目录不存在或不可读: ${candidate}`];
    }
    if (!stat.isDirectory()) {
      return [null, `目录不存在或不可读: ${candidate}`];
    }
    const roots = this._accessibleRoots();
    let inRoots = false;
    if (roots.length) {
      for (const root of roots) {
        if (candidate === root || candidate.startsWith(root + path.sep)) {
          inRoots = true; break;
        }
      }
    }
    // 不在静态白名单但运行时 ACL 允许（用户用 pickUserFile 已实时授权），也放行
    if (roots.length && !inRoots) {
      try { fs.accessSync(candidate, fs.constants.R_OK); inRoots = true; }
      catch { /* 无权限，保持 false */ }
    }
    if (roots.length && !inRoots) {
      return [null, `目录不在应用可访问范围内: ${candidate}`];
    }
    return [candidate, ""];
  }

  // ── 上传映射管理 ──
  uploadMappings() {
    const config = this.store.getConfig();
    const mappings = JSON.parse(JSON.stringify(config.upload_mappings || []));
    return ok({ mappings });
  }

  saveUploadMapping(payload) {
    const data = payload || {};
    const item = Object.assign({}, data);
    if (!String(item.name || "").trim()) {
      return error("映射名称不能为空");
    }
    const [source, errText] = this._authorizedLocalPath(item.source);
    if (source === null) return error(errText);
    item.source = String(source);
    const target = String(item.target_cid || "0").trim() || "0";
    item.target_cid = target;
    if (item.enabled === undefined) item.enabled = true;
    if (!String(item.id || "").trim()) {
      item.id = `${Math.floor(Date.now() / 1000)}-${Math.abs(hashString(source)) % 100000}`;
    }
    try {
      const config = this.store.getConfig();
      const mappings = (config.upload_mappings || []).filter((m) => m && typeof m === "object");
      const existing = mappings.find(
        (m) => String(m.id || "") === String(item.id || "")
      );
      if (existing) {
        Object.assign(existing, item);
      } else {
        mappings.push(item);
      }
      this.store.updateConfig({ upload_mappings: mappings });
      return ok({ id: item.id }, "上传映射已保存");
    } catch (err) {
      console.error(`保存上传映射失败：${err.message}`);
      return error(`保存上传映射失败: ${err.message}`);
    }
  }

  deleteUploadMapping(payload) {
    const mappingId = String((payload || {}).id || "").trim();
    if (!mappingId) return error("缺少映射 ID");
    try {
      const config = this.store.getConfig();
      const mappings = (config.upload_mappings || []).filter(
        (m) => !(m && typeof m === "object" && String(m.id || "") === mappingId)
      );
      this.store.updateConfig({ upload_mappings: mappings });
      return ok(undefined, "上传映射已删除");
    } catch (err) {
      console.error(`删除上传映射失败：${err.message}`);
      return error(`删除上传映射失败: ${err.message}`);
    }
  }

  // ---- 上传失败清单（1.2.1：失败文件可单条重试）----
  _recordUploadFailure(mapping, filePath, errorMessage) {
    try {
      const failures = this.store.getUploadFailures();
      failures[filePath] = {
        name: path.basename(filePath),
        mapping: String(mapping && mapping.name || ""),
        error: String(errorMessage || "").slice(0, 200),
        ts: Date.now(),
      };
      const keys = Object.keys(failures);
      if (keys.length > 200) {
        // 防膨胀：超出上限丢弃最旧的
        const drop = keys.sort((a, b) => failures[a].ts - failures[b].ts).slice(0, keys.length - 200);
        for (const k of drop) delete failures[k];
      }
      this.store.saveUploadFailures(failures);
    } catch (err) {
      console.warn(`记录上传失败清单异常：${err.message}`);
    }
  }

  _clearUploadFailure(filePath) {
    try {
      const failures = this.store.getUploadFailures();
      if (failures && Object.prototype.hasOwnProperty.call(failures, filePath)) {
        delete failures[filePath];
        this.store.saveUploadFailures(failures);
      }
    } catch (err) {
      console.warn(`清理上传失败清单异常：${err.message}`);
    }
  }

  // GET 上传失败清单
  uploadFailures() {
    const failures = this.store.getUploadFailures();
    const items = Object.keys(failures).map((p) => Object.assign({ path: p }, failures[p]))
      .sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return ok({ count: items.length, items });
  }

  // POST 单文件重试：从失败清单移除 → 重新提交所属映射上传扫描（增量跳过已上传，效果=只重传该文件）
  retryUploadFailure(payload) {
    const data = payload || {};
    const filePath = String(data.filePath || data.path || "").trim();
    if (!filePath) return error("缺少要重试的文件路径");
    const failures = this.store.getUploadFailures();
    if (!Object.prototype.hasOwnProperty.call(failures, filePath)) {
      return error("该文件不在失败清单中（可能已重试成功）");
    }
    const config = this.store.getConfig();
    const sep = path.sep;
    const mapping = (config.upload_mappings || []).find((m) => {
      const src = String(m.source || "").replace(/\/+$/, "");
      return filePath === src || filePath.startsWith(src + sep);
    });
    if (!mapping) return error("找不到该文件所属的上传映射");
    delete failures[filePath];
    this.store.saveUploadFailures(failures);
    const mappingId = String(mapping.id || mapping.name || "");
    this._uploadWorker.submit(mappingId);
    this.recordLog(`已重试上传：${path.basename(filePath)}`, "INFO", "UPLOAD");
    return ok({ filePath, mapping: mapping.name }, "已重新提交上传，结果见上传状态");
  }

  uploadStatus() {
    return ok({
      active: this._uploadWorker.active(),
      pending: this._uploadWorker.pending(),
      risk: this._riskStatus(),
    });
  }

  // ── 实时文件监听 ──
  watcherStart(payload) {
    try {
      const config = this.store.getConfig();
      // 总开关由运行设置唯一权威；不再隐式开启（2026-09-18）。
      if (!config.enabled) {
        return error("应用未启用，请在应用设置 → 运行设置开启「启用」后再启动监听");
      }
      const mappings = (config.upload_mappings || []).filter(
        (m) => m && typeof m === "object" && m.enabled !== false && m.source
      );
      if (!mappings.length) {
        return error("没有启用且配置了源目录的上传映射");
      }
      this.store.updateConfig({ watch_enabled: true });
      this._fileWatcher.start();
      const status = this._fileWatcher.status();
      this.recordLog(`文件监听已启动（${status.mappings.length} 个映射）`, "INFO", "WATCH");
      return ok({ mappings: status.mappings.length }, "文件监听已启动，新增文件将自动上传");
    } catch (err) {
      console.error(`启动文件监听失败：${err.message}`);
      return error(`启动文件监听失败: ${err.message}`);
    }
  }

  watcherStop() {
    try {
      this.store.updateConfig({ watch_enabled: false });
      this._fileWatcher.stop();
      this.recordLog("文件监听已停止", "INFO", "WATCH");
      return ok(undefined, "文件监听已停止");
    } catch (err) {
      console.error(`停止文件监听失败：${err.message}`);
      return error(`停止文件监听失败: ${err.message}`);
    }
  }

  watcherStatus() {
    try {
      const config = this.store.getConfig();
      const running = Boolean(config.watch_enabled) && this._fileWatcher.status().running;
      return ok({
        enabled: Boolean(config.watch_enabled),
        running,
        watch: this._fileWatcher.status(),
        risk: this._riskStatus(),
      });
    } catch (err) {
      console.error(`读取文件监听状态失败：${err.message}`);
      return error(`读取文件监听状态失败: ${err.message}`);
    }
  }

  // 协作取消：上传任务只响应安全检查点，不强杀正在执行的请求
  taskCancel(payload) {
    const kind = String((payload || {}).kind || "").trim();
    if (kind && kind !== "upload") {
      return error(`暂不支持取消任务类型: ${kind}`);
    }
    this._uploadWorker.cancel();
    return ok(undefined, "已请求上传任务在下一个安全检查点停止");
  }

  uploadSweep(payload) {
    try {
      const config = this.store.getConfig();
      // 总开关由运行设置唯一权威；不再隐式开启（2026-09-18）。
      if (!config.enabled) {
        return error("应用未启用，请在应用设置 → 运行设置开启「启用」后再上传");
      }
      const mappings = config.upload_mappings || [];
      const enabled = mappings.filter((m) => m && typeof m === "object" && m.enabled !== false);
      if (!enabled.length) {
        return error("没有启用的上传映射");
      }
      for (const mapping of enabled) {
        const mappingId = String(mapping.id || "default");
        this._uploadWorker.submit(mappingId);
      }
      this.recordLog(`上传扫描已开始（${enabled.length} 个映射入队）`, "INFO", "UPLOAD");
      return ok({ queued: enabled.length }, "上传扫描已开始");
    } catch (err) {
      console.error(`开始上传扫描失败：${err.message}`);
      return error(`开始上传扫描失败: ${err.message}`);
    }
  }

  async _runUploadScanOnce(mappingId) {
    const config = this.store.getConfig();
    const mapping = (config.upload_mappings || []).find(
      (m) => m && typeof m === "object" && String(m.id || "") === mappingId
    );
    if (!mapping) return `映射不存在: ${mappingId}`;
    return this._runUploadMapping(mapping, config);
  }

  /**
   * 上传一条映射。配置里的映射与「指定目录上传一次」共用这一条路径 —— 单一事实源：
   * 增量判断、秒传、风控节流、身份冲突处理全在这一个循环里，别处不再复制第二套上传实现。
   */
  async _runUploadMapping(mapping, config) {
    config = config || this.store.getConfig();
    const [source, sourceErr] = this._authorizedLocalPath(mapping.source);
    if (source === null) {
      return `映射 ${mapping.name} 无效：${sourceErr}`;
    }
    const targetCid = String(mapping.target_cid || "0");
    const includeSidecars = config.upload_include_sidecars !== false;
    const mediaExts = extensionSet(config.upload_media_extensions);
    const sidecarExts = extensionSet(config.upload_sidecar_extensions);

    console.log(`开始上传扫描：${source} -> ${targetCid}`);
    try {
      const client = this._getClient();
      const targetDir =
        targetCid !== "0"
          ? await client.getItemById(targetCid)
          : { fileid: "0", path: "/", type: "dir" };
      if (!targetDir || typeof targetDir !== "object" || targetDir.type !== "dir") {
        return `映射 ${mapping.name} 目标目录无效`;
      }
      const records = this.store.getUploadRecords();
      let uploaded = 0;
      let reused = 0;
      let failed = 0;
      let unchanged = 0;
      let conflicts = 0;
      const filesToUpload = [];

      const walk = (directory) => {
        let names;
        try {
          names = fs.readdirSync(directory);
        } catch {
          return;
        }
        names.sort();
        for (const name of names) {
          const filePath = path.join(directory, name);
          let stat;
          try {
            stat = fs.statSync(filePath);
          } catch {
            continue;
          }
          if (stat.isDirectory()) {
            walk(filePath);
            continue;
          }
          if (!stat.isFile()) continue;
          const suffix = path.extname(name).toLowerCase();
          if (suffix === "") {
            // 无扩展名文件按非媒体处理
            continue;
          }
          if (mediaExts.has(suffix)) {
            filesToUpload.push(filePath);
          } else if (includeSidecars && sidecarExts.has(suffix)) {
            filesToUpload.push(filePath);
          } else {
            continue;
          }
        }
      };
      walk(source);

      const profile = this._riskProfileConfig();
      let batchCount = 0;
      for (const filePath of filesToUpload) {
        if (this._uploadWorker.cancelled()) break;
        if (this._riskLimited()) { console.log("【风控】风控冷却中，中止本次上传扫描"); break; }
        if (!records.hasChanged(filePath, targetCid)) {
          // 增量未变化：仍要校验记录与云端身份是否一致（参考插件同款语义）。
          // 记录里没有 pickcode 就无从校验，直接跳过。
          const record = records.get(filePath);
          const recordedPickcode = String(record.pickcode || "").trim();
          unchanged += 1;
          if (!recordedPickcode) continue;
          const fileTarget = remapRelativePath(filePath, source, targetDir).replace(/\/+$/, "") + "/" + path.basename(filePath);
          try {
            const remote = await client.getItem(fileTarget);
            const remotePickcode = remote ? String(remote.pickcode || "") : "";
            if (remote && remotePickcode && remotePickcode !== recordedPickcode) {
              conflicts += 1;
              await this._handleIdentityConflict(
                null, filePath, fileTarget, record, { pickcode: remotePickcode }
              );
            }
          } catch (err) {
            // getItem 对不存在的路径返回 null；其余异常（限流/授权等）按参考插件
            // 的兜底挂清单，不中断整个扫描。
            conflicts += 1;
            await this._handleIdentityConflict(
              err, filePath, fileTarget, record, null
            );
          }
          continue;
        }
        try {
          const parentCloudPath = remapRelativePath(filePath, source, targetDir);
          const parentDir = await client.ensureRemoteDir(parentCloudPath);
          const result = await client.uploadFile(parentDir, filePath);
          if (result.success) {
            if (result.reused) {
              reused += 1;
            } else {
              uploaded += 1;
            }
            records.markUploaded(filePath, targetCid, undefined, {
              method: result.reused ? "reused" : "upload",
              pickcode: String((result.fileItem && result.fileItem.pickcode) || ""),
              name: path.basename(filePath),
            });
            console.log(`已上传 ${path.basename(filePath)}（${result.reused ? "秒传" : "上传"}）`);
            this._riskState.consecutiveFailures = 0;
            this._clearUploadFailure(filePath);
            // 上传后生成 STRM（单文件粒度）：媒体落盘后立即生成对应 .strm
            // relPath 用本地相对源目录路径（remap 保持相对结构，云端/本地一致）
            this._maybeAutoStrmForFile(mapping, path.relative(source, filePath), {
              name: path.basename(filePath),
              pickcode: String((result.fileItem && result.fileItem.pickcode) || ""),
            });
            // upload_delete_source：上传成功后删除本地源文件（只删成功项）
            if (config.upload_delete_source) {
              try {
                fs.unlinkSync(filePath);
                console.log(`已删除源文件 ${path.basename(filePath)}（upload_delete_source）`);
              } catch (delErr) {
                console.warn(`删除源文件失败 ${path.basename(filePath)}：${delErr.message}`);
              }
            }
          } else {
            failed += 1;
            this._riskState.consecutiveFailures += 1;
            console.warn(`上传失败 ${path.basename(filePath)}：${result.message}`);
          }
          // 风控冷却：上传后等待文件级间隔
          const delayMs = result.reused ? profile.instantIntervalMs : profile.fileIntervalMs;
          await this._riskSleep(delayMs);
          // 批间暂停
          batchCount += 1;
          if (batchCount % profile.batchSize === 0) {
            console.log(`【风控】已上传 ${batchCount} 个文件，批间暂停 ${Math.round(profile.batchPauseMs / 1000)} 秒`);
            await this._riskSleep(profile.batchPauseMs);
          }
        } catch (err) {
          if (err instanceof U115AccessLimitError) {
            // 参考插件 abort_on 模式：风控/授权错误立即中止整个扫描，不重试
            failed += 1;
            this._recordUploadFailure(mapping, filePath, `风控中止：${err.message}`);
            this._riskPause(err.message);
            this.store.saveUploadRecords(records);
            const summary = `因风控中止：新增 ${uploaded}，秒传 ${reused}，失败 ${failed + 1}，冲突 ${conflicts}，未变更 ${unchanged}`;
            console.log(`映射 ${mapping.name} 扫描中止：${err.message}`);
            this.store.appendHistory({
              ts: Date.now(), type: "upload", title: `上传扫描中止：${mapping.name}`,
              detail: summary, ok: false,
            });
            return summary;
          } else if (err instanceof U115AuthError) {
            // 授权失效也中止
            failed += 1;
            console.error(`上传授权失效 ${path.basename(filePath)}：${err.message}`);
            this.store.saveUploadRecords(records);
            const summary = `因授权失效中止：新增 ${uploaded}，秒传 ${reused}，失败 ${failed}，冲突 ${conflicts}，未变更 ${unchanged}`;
            this.store.appendHistory({
              ts: Date.now(), type: "upload", title: `上传扫描中止：${mapping.name}`,
              detail: summary, ok: false,
            });
            return summary;
          }
          // 其他异常仅计数，不中断（参照插件支持：普通上传失败不中止扫描）
          failed += 1;
          this._riskState.consecutiveFailures += 1;
          this._recordUploadFailure(mapping, filePath, err.message);
          console.warn(`上传异常 ${path.basename(filePath)}：${err.message}`);
          await this._riskSleep(profile.fileIntervalMs);
        }
      }
      this.store.saveUploadRecords(records);
      const summary = this._uploadWorker.cancelled()
        ? `已按请求停止：新增 ${uploaded}，秒传 ${reused}，失败 ${failed}，冲突 ${conflicts}，未变更 ${unchanged}`
        : `新增 ${uploaded}，秒传 ${reused}，失败 ${failed}，冲突 ${conflicts}，未变更 ${unchanged}`;
      console.log(`映射 ${mapping.name} 扫描完成：${summary}`);
      this.store.appendHistory({
        ts: Date.now(),
        type: "upload",
        title: `上传扫描：${mapping.name}`,
        detail: summary,
        ok: failed === 0,
      });
      return summary;
    } catch (err) {
      console.error(`上传扫描异常：${err.message}`);
      this.store.appendHistory({
        ts: Date.now(),
        type: "upload",
        title: `上传扫描：${mapping.name}`,
        detail: err.message,
        ok: false,
      });
      return `上传扫描异常: ${err.message}`;
    }
  }

  // ── 上传身份冲突（与插件 upload_conflicts / resolve_upload_conflicts 对齐）──
  uploadConflicts() {
    try {
      const conflicts = this.store.getUploadConflicts();
      const config = this.store.getConfig();
      const items = Object.values(conflicts)
        .filter((item) => item && typeof item === "object")
        .sort((a, b) =>
          String(a.first_seen || "").localeCompare(String(b.first_seen || ""))
        );
      return ok({
        policy: String(config.upload_conflict_policy || "ask"),
        count: items.length,
        items,
      });
    } catch (err) {
      console.error(`读取上传冲突失败：${err.message}`);
      return error(`读取上传冲突失败: ${err.message}`);
    }
  }

  resolveUploadConflicts(payload) {
    payload = payload || {};
    const action = String(payload.action || "").trim();
    const actionLabels = { adopt: "采用远端", reupload: "重传覆盖", dismiss: "先不管" };
    if (!actionLabels[action]) return error("未知的处理方式");
    const paths = (payload.paths || [])
      .map((value) => String(value || "").trim())
      .filter(Boolean);
    if (!paths.length) return error("没有选择要处理的冲突");
    let records;
    const conflicts = this.store.getUploadConflicts();
    try {
      records = this.store.getUploadRecords();
    } catch (err) {
      return error(`读取上传记录失败: ${err.message}`);
    }
    // 单个动作完成后再统一写回（插件语义：先处理完每个路径再持久化）。
    const processPath = async (p) => {
      const conflict = conflicts[p];
      if (!conflict || typeof conflict !== "object") {
        return { failed: { path: p, message: "冲突不存在或已处理" } };
      }
      const target = String(conflict.target || "");
      try {
        if (action === "adopt") {
          const record = records.get(p);
          if (!record || !Object.keys(record).length) {
            throw new Error("上传记录不存在，无法采用远端");
          }
          const remotePickcode = String(conflict.remote_pickcode || "").trim();
          if (!remotePickcode) {
            throw new Error("冲突里没有远端 Pickcode，请用重传覆盖或等下一轮上传");
          }
          records.updateMetadata(p, { pickcode: remotePickcode });
        } else if (action === "reupload") {
          const fileItem = target ? (await this._getClient().getItem(target)) : null;
          const fileId = fileItem && String(fileItem.fileid || "").trim();
          if (fileId) {
            await this._getClient().deleteFile(fileId);
          }
          records.remove(p);
        }
        // dismiss 不需要任何动作：只把条目摘掉
      } catch (err) {
        return { failed: { path: p, message: String(err.message || err) } };
      }
      delete conflicts[p];
      return { resolved: p };
    };
    const run = async () => {
      const resolved = [];
      const failed = [];
      for (const p of paths) {
        const outcome = await processPath(p);
        if (outcome.failed) failed.push(outcome.failed);
        else if (outcome.resolved) resolved.push(outcome.resolved);
      }
      this.store.saveUploadRecords(records);
      this.store.saveUploadConflicts(conflicts);
      const label = actionLabels[action];
      if (failed.length) {
        return ok(
          { resolved, failed },
          `${label}完成 ${resolved.length} 个，${failed.length} 个没成`
        );
      }
      return ok({ resolved, failed: [] }, `${label}完成 ${resolved.length} 个`);
    };
    return run().catch((err) => error(`处理上传冲突失败: ${String(err.message || err)}`));
  }

  // 记录一条身份冲突（本地路径 → 冲突详情）；新发现返回 true。
  _recordIdentityConflict(filePath, target, reason, recordedPickcode, remotePickcode, recordedSize) {
    const conflicts = this.store.getUploadConflicts();
    const now = new Date().toISOString().slice(0, 19);
    const isNew = !conflicts[filePath];
    const entry = Object.assign({}, conflicts[filePath] || {});
    entry.path = filePath;
    entry.target = String(target || "");
    entry.reason = String(reason || "");
    entry.recorded_pickcode = String(recordedPickcode || "");
    entry.remote_pickcode = String(remotePickcode || "");
    entry.recorded_size = recordedSize;
    entry.last_seen = now;
    if (isNew) entry.first_seen = now;
    conflicts[filePath] = entry;
    // 顺手清掉本地文件已经消失的旧冲突：文件都没了，分歧自然不存在。
    const alive = {};
    for (const [p, item] of Object.entries(conflicts)) {
      if (p === filePath || fs.existsSync(p)) alive[p] = item;
    }
    this.store.saveUploadConflicts(alive);
    return isNew;
  }

  // 身份冲突默认策略处理（与插件 _handle_upload_conflict 对齐）：
  // ask 挂清单等拍板；adopt 认远端；reupload 删远端重传。
  async _handleIdentityConflict(err, filePath, target, record, remote) {
    filePath = String(filePath || "");
    const policy = String(
      this.store.getConfig().upload_conflict_policy || "ask"
    ).trim();
    const remotePickcode = String(remote && (remote.pickcode || "")).trim();
    const recordedPickcode = String((record && record.pickcode) || "").trim();
    const recordedSize = record && record.size;
    const reason = err
      ? String(err.message || err)
      : "上传记录对不上网盘文件（网盘上这个位置的文件曾被替换）";
    try {
      if (policy === "adopt" && filePath) {
        // 远端是权威：把记录的 Pickcode 改成远端现状。
        const adrecords = this.store.getUploadRecords();
        adrecords.updateMetadata(filePath, { pickcode: remotePickcode });
        this.store.saveUploadRecords(adrecords);
        console.warn(`【目录上传】身份冲突已按默认策略采用远端：${target}，下一轮增量会自动重新校验`);
        return;
      }
      if (policy === "reupload" && filePath && target) {
        // 本地是权威：删掉远端那份（进回收站）、清掉本地记录，下一轮增量重新上传。
        const fileItem = (await this._getClient().getItem(target)) || {};
        const fileId = String(fileItem.fileid || "").trim();
        if (fileId) {
          await this._getClient().deleteFile(fileId);
        }
        const rurecords = this.store.getUploadRecords();
        rurecords.remove(filePath);
        this.store.saveUploadRecords(rurecords);
        console.warn(`【目录上传】身份冲突已按默认策略删除远端并重传：${target}（远端文件进了 115 回收站，下一轮增量重新上传）`);
        return;
      }
    } catch (handlerErr) {
      console.error(`【目录上传】身份冲突自动处理失败，改为挂清单：${target}，原因：${handlerErr.message}`);
    }
    const isNew = this._recordIdentityConflict(
      filePath, target, reason, recordedPickcode, remotePickcode, recordedSize
    );
    if (isNew) {
      console.warn(`【目录上传】发现上传身份冲突，已挂到清单待处理：${target}，原因：${reason}`);
    }
  }

  // 从上传记录里的 pickcode 恢复远端文件 ID。
  _itemIdFromRecord(record) {
    return String(record.pickcode_identity_fileid || record.fileid || "").trim();
  }

  // ── 功能热更数据目录 ──
  // FPK 自更新（check_update/download_update/apply_update）已于 2026-09-21 下线（FP-4），
  // fpk 升级唯一通道为 App Center UI；本方法仅供 applyHotfix 落 patches/ 备份与 current.json。
  _updateDataDir() {
    return this.store._dir || "/vol1/@appdata/p115assistant";
  }

  // fnOS 账号凭据（仅用于自动登录 trim-cli 执行安装预检；密码不进前端/日志）
  async fnosLogin(payload) {
    payload = payload || {};
    const username = String(payload.username || "").trim();
    const password = String(payload.password || "");
    if (!username || !password) return error("请填写 fnOS 账号和密码");
    this.store.updateConfig({ fnos_username: username, fnos_password: password });
    this.recordLog("已保存 fnOS 凭据（用于自动安装预检）", "INFO", "CONFIG");
    return ok({ username }, "已保存");
  }

  async fnosForget() {
    this.store.updateConfig({ fnos_username: "", fnos_password: "" });
    this.recordLog("已清除 fnOS 凭据", "INFO", "CONFIG");
    return ok(undefined, "已清除");
  }

  // ── 功能热更新（不更新 fpk，直接热更运行时文件）──
  _appDir() {
    return process.env.TRIM_APPDEST || "/vol1/@appcenter/p115assistant";
  }

  async checkHotfix() {
    try {
      const hotfix = require("./hotfix");
      const res = await hotfix.checkHotfix(this._appDir());
      return ok(res);
    } catch (err) {
      console.error(`检查功能更新失败：${err.message}`);
      return error(`检查功能更新失败: ${err.message}`);
    }
  }

  async applyHotfix() {
    if (this._hotfixBusy) {
      return error("功能更新正在执行中，请稍候");
    }
    this._hotfixBusy = true;
    try {
      const hotfix = require("./hotfix");
      const cfg = this.store.getConfig();
      const res = await hotfix.applyHotfix(
        this._appDir(),
        this._updateDataDir(),
        {
          username: String(cfg.fnos_username || ""),
          password: String(cfg.fnos_password || ""),
        }
      );
      if (res && res.applied && res.applied.length) {
        this.recordLog(`功能热更新：应用 ${res.applied.length} 个文件（v${res.version || ""}）`, "INFO", "SYSTEM");
      }
      if (res && res.restarting) {
        // 由 fnOS 进程管理器拉起（trim-cli 重启失败也走此路径，无需配置 fnOS 凭据）
        setTimeout(() => process.exit(0), 2500);
      }
      return ok(res, (res && res.message) || "");
    } catch (err) {
      console.error(`功能热更新失败：${err.message}`);
      return error(`功能热更新失败: ${err.message}`);
    } finally {
      this._hotfixBusy = false;
    }
  }

  // ── 签到 ──
  async checkinNow() {
    if (this._checkinBusy) return error("签到正在执行中，请稍候");
    this._checkinBusy = true;
    try {
      const result = await this._getClient().checkin();
      this._checkinToday = true;
      if (result.already) {
        const detail = `今日已签到（跳过），连续 ${result.continuous_day || 0} 天，已获 ${result.points_num || 0} 点`;
        console.log(`签到完成：${detail}`);
        this.store.appendHistory({
          ts: Date.now(),
          type: "checkin",
          title: "每日签到",
          detail,
          skipped: true,
          ok: true,
        });
        return ok(result, result.message || "今日已签到");
      }
      const detail = `连续 ${result.continuous_day || 0} 天，获得 ${result.points_num || 0} 点`;
      console.log(`签到完成：${detail}`);
      if (this.store.getConfig().checkin_notify === true) {
        await this._notifier.notify("每日签到", detail);
      }
      this.store.appendHistory({
        ts: Date.now(),
        type: "checkin",
        title: "每日签到",
        detail,
        ok: true,
      });
      return ok(result, result.message || "签到完成");
    } catch (err) {
      console.error(`签到失败：${err.message}`);
      this.store.appendHistory({
        ts: Date.now(),
        type: "checkin",
        title: "每日签到",
        detail: err.message,
        ok: false,
      });
      return error(`签到失败: ${err.message}`);
    } finally {
      this._checkinBusy = false;
    }
  }

  // ── STRM 映射管理 ──
  strmMappings() {
    const config = this.store.getConfig();
    const mappings = JSON.parse(JSON.stringify(config.strm_mappings || []));
    return ok({ mappings });
  }

  saveStrmMapping(payload) {
    payload = payload || {};
    try {
      const config = this.store.getConfig();
      const mappings = Array.isArray(config.strm_mappings) ? JSON.parse(JSON.stringify(config.strm_mappings)) : [];
      const entryId =
        String(payload.id || "").trim() ||
        `${Date.now()}-${Math.floor(Math.random() * 90000 + 10000)}`;
      const sourceCid = String(payload.source_cid || "").trim();
      const targetDir = String(payload.target_dir || "").trim();
      if (!sourceCid) return error("115 源目录不能为空");
      if (!targetDir) return error("STRM 输出目录不能为空");
      // 输出目录必须可访问
      const [targetResolved, targetErr] = this._authorizedLocalPath(targetDir);
      if (targetResolved === null) return error(targetErr);
      const existingIndex = mappings.findIndex((m) => String(m.id || "") === entryId);
      const entry = {
        id: entryId,
        name: String(payload.name || "STRM 映射").trim() || "STRM 映射",
        source_cid: sourceCid,
        source_name: String(payload.source_name || "").trim(),
        target_dir: targetResolved,
        enabled: payload.enabled !== false,
      };
      if (existingIndex >= 0) mappings[existingIndex] = entry;
      else mappings.push(entry);
      this.store.updateConfig({ strm_mappings: mappings });
      return ok({ id: entryId }, "STRM 映射已保存");
    } catch (err) {
      console.error(`保存 STRM 映射失败：${err.message}`);
      return error(`保存 STRM 映射失败: ${err.message}`);
    }
  }

  deleteStrmMapping(payload) {
    payload = payload || {};
    const entryId = String(payload.id || "").trim();
    if (!entryId) return error("缺少映射 ID");
    try {
      const config = this.store.getConfig();
      const mappings = Array.isArray(config.strm_mappings) ? config.strm_mappings : [];
      const next = mappings.filter((m) => String(m.id || "") !== entryId);
      if (next.length === mappings.length) return error("映射不存在");
      this.store.updateConfig({ strm_mappings: next });
      return ok(undefined, "STRM 映射已删除");
    } catch (err) {
      console.error(`删除 STRM 映射失败：${err.message}`);
      return error(`删除 STRM 映射失败: ${err.message}`);
    }
  }

  strmStatus() {
    return ok({
      incremental: this.store.getConfig().strm_incremental !== false,
      base_url: this._resolveStrmBaseUrl(),
      relay_port: this._relayPort(),
      manual_base_url: this.store.getConfig().strm_base_url || "",
      // 自动推导状态：true=未配置 strm_base_url（全部自动），false=用户手动填写了基础地址
      auto_base_url: !this.store.getConfig().strm_base_url,
    });
  }

  // ── STRM 基础地址：独立 302 播放中转端口（2026-09-18）──
  // 绕开 fnOS 网关对 /app/* 的强制认证；播放器直连本端口匿名取链。
  // 基础地址（strm_base_url）可由用户手动填写，仅取 host；端口自动补充 relay_port。
  _resolveStrmBaseUrl() {
    const host = this._relayHost();
    const port = this._relayPort();
    return `http://${host}:${port}`;
  }

  _relayPort() {
    // 应用设置（wizard 运行设置 / 前端 save_config）优先，其次环境变量，最后默认 3667
    const cfg = parseInt(this.store.getConfig().relay_port, 10);
    if (Number.isFinite(cfg) && cfg > 0 && cfg < 65536) return cfg;
    const p = parseInt(process.env.P115_RELAY_PORT || "3667", 10);
    return Number.isFinite(p) && p > 0 ? p : 3667;
  }

  // 302 监听端口唯一权威（FP-1）：main.js 启动与 save_config 动态重绑都经它取当前值。
  relayPort() {
    return this._relayPort();
  }

  _relayHost() {
    // 优先用已配置的 strm_base_url 里的 IP（用户手动填写，支持 http(s):// 前缀或裸 host）；
    // 否则取本机默认路由网卡 IP
    const configured = String(this.store.getConfig().strm_base_url || "").trim().replace(/\/+$/, "");
    if (configured) {
      try {
        const u = new URL(/^https?:\/\//i.test(configured) ? configured : `http://${configured}`);
        if (u.hostname) return u.hostname;
      } catch { /* 非法配置忽略，回退自动检测 */ }
    }
    const ifaces = require("node:os").networkInterfaces();
    // 优先真实网卡：跳过虚拟/容器/隧道网卡（docker0/bridge/tailscale 等），
    // 避免自动检测选中 docker0 等导致 STRM 地址不可达（2026-09-19 优化）
    const skip = /^(docker|veth|br-|virbr|kube|tailscale|tun|utun|tap|vnic|lo)/i;
    for (const name of Object.keys(ifaces)) {
      for (const info of ifaces[name] || []) {
        if (info.family === "IPv4" && !info.internal && !skip.test(name)) return info.address;
      }
    }
    // 兜底：全是虚拟网卡时退回到任意非内网 IPv4
    for (const name of Object.keys(ifaces)) {
      for (const info of ifaces[name] || []) {
        if (info.family === "IPv4" && !info.internal) return info.address;
      }
    }
    return "127.0.0.1";
  }

  // ── STRM 同步：扫描 115 目录树 -> 生成 .strm 文件（对齐插件 strm.py 语义）──
  async strmSync(payload) {
    payload = payload || {};
    const config = this.store.getConfig();
    const baseUrl = this._resolveStrmBaseUrl();
    if (!baseUrl) return error("无法确定 STRM 基础地址（请通过应用页面访问后再同步）");
    let mappings = Array.isArray(config.strm_mappings) ? config.strm_mappings : [];
    const mappingId = String(payload.mapping_id || "").trim();
    if (mappingId) {
      mappings = mappings.filter((m) => String(m.id || "") === mappingId);
    }
    mappings = mappings.filter((m) => m && typeof m === "object" && m.enabled !== false);
    if (!mappings.length) return error("没有启用的 STRM 映射");
    if (this._strmBusy) return error("已有 STRM 任务在执行中，请稍候");
    const incremental = config.strm_incremental !== false;
    const mediaExts = extensionSet(config.upload_media_extensions);
    const totals = { added: 0, updated: 0, removed: 0, skipped: 0, errors: 0 };
    this._strmBusy = true;
    try {
      const client = this._getClient();
      for (const mapping of mappings) {
        if (this._uploadWorker.cancelled()) break;
        const sourceCid = String(mapping.source_cid || "");
        const targetDir = String(mapping.target_dir || "");
        const [targetResolved, targetErr] = this._authorizedLocalPath(targetDir);
        if (targetResolved === null || !sourceCid) {
          totals.errors += 1;
          console.warn(`[STRM] 映射 ${mapping.name} 无效：${targetErr || "源目录缺失"}`);
          continue;
        }
        console.log(`[STRM] 开始同步 ${mapping.name}: ${sourceCid} -> ${targetDir}`);
        try {
          const result = await this._runStrmMapping(client, mapping, sourceCid, targetResolved, baseUrl, incremental, mediaExts);
          totals.added += result.added;
          totals.updated += result.updated;
          totals.removed += result.removed;
          totals.skipped += result.skipped;
          totals.errors += result.errors;
        } catch (err) {
          if (err instanceof U115AccessLimitError) {
            this._riskPause(err.message);
            break;
          }
          totals.errors += 1;
          console.warn(`[STRM] 映射 ${mapping.name} 同步异常：${err.message}`);
        }
      }
      this.store.appendHistory({
        ts: Date.now(), type: "strm", title: "STRM 同步",
        detail: `新增 ${totals.added}，更新 ${totals.updated}，删除 ${totals.removed}，跳过 ${totals.skipped}，错误 ${totals.errors}`,
        ok: totals.errors === 0,
      });
      this.recordLog(`STRM 同步完成：新增 ${totals.added}，更新 ${totals.updated}，删除 ${totals.removed}，跳过 ${totals.skipped}，错误 ${totals.errors}`, totals.errors === 0 ? "INFO" : "WARN", "STRM");
      return ok(totals, `STRM 同步完成：新增 ${totals.added}，更新 ${totals.updated}，删除 ${totals.removed}，跳过 ${totals.skipped}，错误 ${totals.errors}`);
    } catch (err) {
      console.error(`STRM 同步异常：${err.message}`);
      return error(`STRM 同步异常: ${err.message}`);
    } finally {
      this._strmBusy = false;
    }
  }

  async _runStrmMapping(client, mapping, sourceCid, targetDir, baseUrl, incremental, mediaExts) {
    const counts = { added: 0, updated: 0, removed: 0, skipped: 0, errors: 0, subtitles: 0, subtitles_skipped: 0, subtitles_errors: 0 };
    const mappingId = String(mapping.id || sourceCid || "default");
    // 源目录的云路径：账本核对要靠它把本地 .strm 对回云上的目录
    const sourcePath = await this._resolveSourcePath(client, mapping, sourceCid);
    // 1) 递归收集 115 目录树中的媒体文件（不依赖 cache，直接走 getDirList）
    const cloudFiles = [];   // { relPath, pickcode, name, size, mtime, cloudPath, cloudDir }
    const subtitleMap = new Map(); // dirPrefix -> [{ name, pickcode, size }]
    const SUBTITLE_EXT = new Set([".srt", ".ass", ".ssa", ".sup", ".vtt"]);
    const seenDirs = new Set();
    const stack = [{ cid: sourceCid, prefix: "" }];
    seenDirs.add(String(sourceCid));
    while (stack.length) {
      if (this._uploadWorker.cancelled()) break;
      const current = stack.pop();
      const items = await client.getDirList(current.cid);
      for (const raw of items) {
        if (!raw || typeof raw !== "object") continue;
        const name = String(U115Client._itemName(raw) || "").trim();
        if (!name) continue;
        const itemId = U115Client._itemId(raw);
        if (U115Client._isDirectory(raw)) {
          if (itemId && !seenDirs.has(itemId)) {
            seenDirs.add(itemId);
            stack.push({ cid: itemId, prefix: current.prefix ? `${current.prefix}/${name}` : name });
          }
          continue;
        }
        const pickcode = String(raw.pc || raw.pickcode || raw.pick_code || "").trim();
        if (!pickcode) continue;
        const suffix = path.extname(name).toLowerCase();
        // 字幕文件单独收集：生成 STRM 时按同目录同名匹配，下载到本地供播放器加载
        if (SUBTITLE_EXT.has(suffix)) {
          const dirKey = current.prefix || "";
          if (!subtitleMap.has(dirKey)) subtitleMap.set(dirKey, []);
          subtitleMap.get(dirKey).push({
            name,
            pickcode,
            size: parseInt(U115Client._itemSize(raw) || 0, 10) || 0,
          });
          continue;
        }
        if (!suffix || !mediaExts.has(suffix)) continue;
        const relPath = current.prefix ? `${current.prefix}/${name}` : name;
        const cloudPath = sourcePath
          ? (sourcePath === "/" ? `/${relPath}` : `${sourcePath}/${relPath}`)
          : "";
        cloudFiles.push({
          relPath,
          name,
          pickcode,
          size: parseInt(U115Client._itemSize(raw) || 0, 10) || 0,
          mtime: parseInt(U115Client._itemMtime(raw) || 0, 10) || 0,
          cloudPath,
          cloudDir: cloudPath ? posixDirname(cloudPath) : "",
        });
      }
    }

    // 2) 生成 STRM 内容并写入目标目录（保持相对路径、.iso 特例对齐插件）
    const expectedByRel = new Map();
    for (const file of cloudFiles) {
      const rel = file.relPath.replace(/\\/g, "/");
      const outName = rel.toLowerCase().endsWith(".iso") ? `${rel}.strm` : rel.replace(/\.[^.]+$/, "") + ".strm";
      const outputPath = path.join(targetDir, outName);
      const sign = this.buildRedirectSignature(file.pickcode);
      const qs = new URLSearchParams({ pickcode: file.pickcode, file_name: file.name, sign });
      // STRM 内容完全对齐插件 115 轻量助手（strm.py build_strm_url）：
      //   {base}/api/v1/plugin/P115LiteAssistant/redirect?pickcode=..&file_name=..&sign=..
      const content = `${baseUrl}/api/v1/plugin/P115LiteAssistant/redirect?${qs.toString()}\n`;
      expectedByRel.set(outName, { content, outputPath, sign, file });
    }

    // 3) 写文件（增量：内容一致跳过）
    for (const [outName, target] of expectedByRel) {
      if (this._uploadWorker.cancelled()) break;
      try {
        fs.mkdirSync(path.dirname(target.outputPath), { recursive: true });
        let current = "";
        try {
          const stat = fs.statSync(target.outputPath);
          if (stat.isFile() && stat.size < 8192) current = fs.readFileSync(target.outputPath, "utf8");
        } catch { /* 不存在 */ }
        if (current === target.content) {
          counts.skipped += 1;
          continue;
        }
        if (incremental && current) counts.updated += 1;
        else if (!current) counts.added += 1;
        const tmp = `${target.outputPath}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, target.content);
        fs.renameSync(tmp, target.outputPath);
        // 附带同名字幕：云端同目录同名 .srt/.ass/.ssa/.sup/.vtt → 下载到 STRM 同目录（播放器自动加载）
        if (this.store.getConfig().strm_add_subtitles !== false) {
          const relOut = String(outName).replace(/\\/g, "/");
          const dirKey = path.posix.dirname(relOut);
          const subs = subtitleMap.get(dirKey === "." ? "" : dirKey) || [];
          if (subs.length) {
            const base = path.basename(relOut).replace(/\.strm$/i, "").toLowerCase();
            for (const sub of subs) {
              if (path.basename(sub.name).replace(/\.[^.]+$/, "").toLowerCase() !== base) continue;
              const subOut = path.join(path.dirname(target.outputPath), sub.name);
              let skip = false;
              try {
                const st = fs.statSync(subOut);
                if (st.isFile() && st.size === sub.size) skip = true;
              } catch { /* 不存在则下载 */ }
              if (skip) {
                counts.subtitles_skipped += 1;
                continue;
              }
              try {
                await client.downloadFile(sub.pickcode, subOut, true);
                counts.subtitles += 1;
              } catch (err) {
                counts.subtitles_errors += 1;
                console.warn(`[STRM] 字幕下载失败 ${sub.name}: ${err.message}`);
              }
            }
          }
        }
      } catch (err) {
        counts.errors += 1;
        console.warn(`[STRM] 写入失败 ${target.outputPath}：${err.message}`);
      }
    }

    // 4) 增量清理：删除目标目录中本映射产生的、云端已不存在的 .strm。
    //    只碰「本映射拥有」的文件（记录里没有，或记录就属于本映射）：多条映射共用一个输出
    //    目录时，不能把别人生成的 STRM 当失效删掉。
    const records = this._getStrmRecords();
    const ownedByOthers = new Set();
    for (const record of Object.values(records)) {
      if (!record || typeof record !== "object") continue;
      if (String(record.mapping_id || "") === mappingId) continue;
      const owned = String(record.path || "").trim();
      if (owned) ownedByOthers.add(owned);
    }
    if (incremental) {
      const walkRemove = (directory) => {
        let names;
        try { names = fs.readdirSync(directory); } catch { return; }
        for (const name of names) {
          const fullPath = path.join(directory, name);
          let st;
          try { st = fs.statSync(fullPath); } catch { continue; }
          if (st.isDirectory()) { walkRemove(fullPath); continue; }
          if (!st.isFile()) continue;
          if (!name.toLowerCase().endsWith(".strm")) continue;
          const relPart = path.relative(targetDir, fullPath).split(path.sep).join("/");
          if (expectedByRel.has(relPart)) continue;
          if (ownedByOthers.has(fullPath)) continue;   // 别的映射的地盘，不碰
          try {
            fs.unlinkSync(fullPath);
            counts.removed += 1;
            console.log(`[STRM] 删除失效 STRM：${relPart}`);
          } catch (err) {
            counts.errors += 1;
            console.warn(`[STRM] 删除失败 ${relPart}：${err.message}`);
          }
        }
      };
      walkRemove(targetDir);
    }

    // 5) 记账：每个生成出来的 .strm 一条记录，媒体账本与云端核对都读它。
    //    文件没换过（同一 pickcode）就保留上一轮的核对结果，不必重问 115。
    const nowSec = Math.floor(Date.now() / 1000);
    for (const [outName, target] of expectedByRel) {
      const key = `${mappingId}:${outName}`;
      const previous = records[key];
      const sameFile = previous && String(previous.pickcode || "") === String(target.file.pickcode || "");
      records[key] = {
        mapping_id: mappingId,
        mapping_name: String(mapping.name || ""),
        rel: outName,
        path: target.outputPath,
        name: target.file.name,
        size: target.file.size,
        mtime: target.file.mtime,
        pickcode: target.file.pickcode,
        cloud_path: target.file.cloudPath,
        cloud_dir: target.file.cloudDir,
        source_cid: String(sourceCid),
        target_dir: String(targetDir),
        synced_at: nowSec,
        verify_state: sameFile ? String(previous.verify_state || "") : "",
        verify_at: sameFile ? (parseInt(previous.verify_at || 0, 10) || 0) : 0,
      };
    }
    // 磁盘上已经不存在的记录顺手清掉，别让账本留着幽灵条目
    for (const key of Object.keys(records)) {
      const record = records[key];
      if (!record || typeof record !== "object") { delete records[key]; continue; }
      if (String(record.mapping_id || "") !== mappingId) continue;
      const owned = String(record.path || "");
      if (owned && !fs.existsSync(owned)) delete records[key];
    }
    this._saveStrmRecords(records);
    return counts;
  }

  /**
   * 源 115 目录的云路径。映射里存了面包屑就直接用；没存就现场问一次
   * （每次同步只多一个请求，换来记录里带上云目录 —— 云端核对全靠它）。
   */
  async _resolveSourcePath(client, mapping, sourceCid) {
    const stored = String((mapping && (mapping.source_path || mapping.source_name)) || "").trim();
    if (stored.startsWith("/")) return stored.replace(/\/+$/, "") || "/";
    if (String(sourceCid) === "0") return "/";
    try {
      const item = await client.getItemById(String(sourceCid));
      const resolved = item ? String(item.path || "").trim() : "";
      if (resolved.startsWith("/")) return resolved.replace(/\/+$/, "") || "/";
    } catch (err) {
      console.warn(`[STRM] 解析源目录云路径失败（${sourceCid}）：${err.message}`);
    }
    return "";
  }

  // ── STRM 记录读写 ──
  _getStrmRecords() {
    try {
      return this.store.getStrmRecords();
    } catch (err) {
      console.warn(`[STRM] 读取记录失败：${err.message}`);
      return {};
    }
  }

  _saveStrmRecords(records) {
    try {
      this.store.saveStrmRecords(records);
    } catch (err) {
      console.warn(`[STRM] 保存记录失败：${err.message}`);
    }
  }

  // ── 一次性任务台 ──
  /** 对指定的 115 目录立即生成一批 STRM，不落映射配置（记录照写，mapping_id 用 once:<cid>）。 */
  async strmOnce(payload) {
    const data = payload || {};
    try {
      const sourceCid = String(data.source_cid || "").trim();
      if (!sourceCid) return error("先选一个 115 源目录");
      const [targetResolved, targetErr] = this._authorizedLocalPath(data.target_dir);
      if (targetResolved === null) return error(`STRM 输出目录不可用：${targetErr}`);
      const config = this.store.getConfig();
      const baseUrl = this._resolveStrmBaseUrl();
      if (!baseUrl) return error("无法确定 STRM 基础地址（请通过应用页面访问后再同步）");
      if (this._strmBusy) return error("已有 STRM 任务在执行中，请稍候");

      const label = String(data.source_name || "").trim() || sourceCid;
      const mapping = {
        id: `once:${sourceCid}`,
        name: `一次性生成 ${label}`,
        source_cid: sourceCid,
        source_name: String(data.source_name || "").trim(),
        target_dir: targetResolved,
        enabled: true,
      };
      this._strmBusy = true;
      console.log(`[STRM] 一次性生成：${sourceCid} -> ${targetResolved}`);
      const counts = await this._runStrmMapping(
        this._getClient(), mapping, sourceCid, targetResolved, baseUrl,
        true, extensionSet(config.upload_media_extensions)
      );
      const summary = `一次性 STRM：新增 ${counts.added}，更新 ${counts.updated}，删除 ${counts.removed}，跳过 ${counts.skipped}，错误 ${counts.errors}`;
      console.log(`[STRM] ${summary}`);
      this.store.appendHistory({
        ts: Date.now(), type: "strm", title: `STRM 一次性生成：${label}`,
        detail: summary, ok: counts.errors === 0,
      });
      return ok(counts, summary);
    } catch (err) {
      if (err instanceof U115AccessLimitError) this._riskPause(err.message);
      console.error(`一次性 STRM 生成失败：${err.message}`);
      this.store.appendHistory({
        ts: Date.now(), type: "strm", title: "STRM 一次性生成",
        detail: err.message, ok: false,
      });
      return error(`一次性 STRM 生成失败: ${err.message}`);
    } finally {
      this._strmBusy = false;
    }
  }

  /**
   * 把指定的本地目录传到指定的 115 目录一次，不落映射配置。
   * 走的是与配置映射完全相同的上传循环（_runUploadMapping），只是映射对象是临时拼的。
   * 入队执行：单个文件之间有风控冷却，同步等会把网关请求挂死。
   */
  uploadOnce(payload) {
    const data = payload || {};
    try {
      const [source, sourceErr] = this._authorizedLocalPath(data.source);
      if (source === null) return error(`本地源目录不可用：${sourceErr}`);
      const targetCid = String(data.target_cid || "").trim() || "0";
      const targetPath = String(data.target_path || "").trim();
      const mapping = {
        id: `once-upload:${hashString(`${source}|${targetCid}`)}`,
        name: `一次性上传 ${path.basename(source)}`,
        source,
        target_cid: targetCid,
        target_path: targetPath || "/",
        enabled: true,
      };
      this._uploadWorker.submit({ kind: "upload-once", mapping });
      return ok(
        { queued: true, source, target_cid: targetCid },
        `已开始把 ${source} 上传到 ${targetPath || "115 根目录"}，完成后可在「历史」查看结果`
      );
    } catch (err) {
      console.error(`一次性上传启动失败：${err.message}`);
      return error(`一次性上传启动失败: ${err.message}`);
    }
  }

  /** 后台队列的任务分发：字符串＝配置映射的 id；对象＝一次性任务。 */
  async _runWorkerJob(job) {
    if (typeof job === "string") return this._runUploadScanOnce(job);
    if (job && typeof job === "object" && job.kind === "upload-once") {
      return this._runUploadMapping(job.mapping);
    }
    return `未知任务: ${JSON.stringify(job)}`;
  }

  /** 单文件 STRM 生成（1.1.5）：媒体文件上传成功后立即生成对应 .strm，
   *  不打全量同步。匹配 STRM 映射：映射源云端目录 == 上传目标云端目录，
   *  输出到映射 target_dir（多映射=多目录）。秒传/上传均触发；非媒体扩展名、
   *  未开开关、无匹配映射、输出目录无效 → 静默跳过。 */
  _maybeAutoStrmForFile(uploadMapping, cloudRelPath, fileInfo) {
    try {
      if (this.store.getConfig().upload_generate_strm !== true) return;
      const config = this.store.getConfig();
      const targetCid = String(uploadMapping.targetCid || uploadMapping.target_cid || "");
      if (!targetCid) return;
      const mappings = Array.isArray(config.strm_mappings) ? config.strm_mappings : [];
      const mapping = mappings.find(
        (m) => m.enabled !== false && String(m.sourceCid || m.source_cid || "") === targetCid
      );
      if (!mapping) return;
      const targetDir = String(mapping.target_dir || mapping.targetDir || "").trim();
      if (!targetDir) return;
      const [dirOK, dirErr] = this._authorizedLocalPath(targetDir);
      if (dirOK === null) {
        console.warn(`上传后生成 STRM 失败：输出目录无效 ${targetDir}：${dirErr}`);
        return;
      }
      const name = String(fileInfo.name || "");
      const suffix = path.extname(name).toLowerCase();
      const mediaExts = extensionSet(config.upload_media_extensions);
      if (suffix === "" || !mediaExts.has(suffix)) return; // 只对媒体文件生成
      const baseUrl = this._resolveStrmBaseUrl();
      if (!baseUrl) {
        console.warn("上传后生成 STRM 失败：无法确定 STRM 基础地址");
        return;
      }
      const rel = String(cloudRelPath || "").replace(/\\/g, "/");
      if (!rel) return;
      const outName = rel.toLowerCase().endsWith(".iso") ? `${rel}.strm` : rel.replace(/\.[^.]+$/, "") + ".strm";
      const outPath = path.join(dirOK, outName);
      const sign = this.buildRedirectSignature(String(fileInfo.pickcode || ""));
      const qs = new URLSearchParams({ pickcode: fileInfo.pickcode, file_name: name, sign });
      // STRM 内容完全对齐插件（strm.py build_strm_url）与全量同步 _runStrmMapping
      const content = `${baseUrl}/api/v1/plugin/P115LiteAssistant/redirect?${qs.toString()}\n`;
      const outDir = path.dirname(outPath);
      if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(outPath, content);
      this.recordLog(`上传完成，生成 STRM：${outName}`, "INFO", "STRM");
    } catch (err) {
      console.warn(`上传后生成 STRM 失败：${err.message}`);
    }
  }


  // ── 302 取链 ──
  async link(payload) {
    const data = payload || {};
    const pickcode = String(data.pickcode || "").trim();
    if (!pickcode) return error("缺少 pickcode");
    const userAgent = String(data.ua || data.user_agent || "").trim() || undefined;
    const mode = String(data.mode || "").trim() || undefined;
    try {
      const url = await this._getClient().getDownloadUrl(pickcode, userAgent, mode);
      if (!url) return error("取链失败，115 未返回下载地址");
      const sign = this.buildRedirectSignature(pickcode);
      const redirectUrl = `/app/${this._appName || "p115assistant"}/redirect?pickcode=${encodeURIComponent(pickcode)}&sign=${sign}`;
      return ok({ url, pickcode, redirect_url: redirectUrl });
    } catch (err) {
      console.error(`取链失败：${err.message}`);
      return error(`取链失败: ${err.message}`);
    }
  }

  // ── 302 匿名跳转签名（对齐插件 strm.py 的 build_redirect_signature）──
  buildRedirectSignature(pickcode) {
    const secret = this.store.getRedirectSecret();
    // pickcode 归一（对齐插件 normalize_pickcode：小写化），防止大小写变异导致验签失败
    const normalized = String(pickcode || "").trim().toLowerCase();
    const payload = `p115liteassistant:v1:${normalized}`;
    return crypto.createHmac("sha256", String(secret)).update(payload).digest("hex");
  }

  verifyRedirectSignature(pickcode, sign) {
    const candidate = String(sign || "").trim().toLowerCase();
    const normalized = String(pickcode || "").trim().toLowerCase();
    const expected = this.buildRedirectSignature(normalized);
    if (!candidate || !pickcode) return false;
    if (candidate.length !== expected.length) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(expected));
    } catch {
      return false;
    }
  }

  // ── 匿名 302 目标：验签通过后按播放器 UA 取链 ──
  // 对齐插件 api.py redirect：URL 缓存（TTL=链接寿命-300s 安全窗口）、
  // singleflight 并发去重、取链失败重试 3 次（限流/认证错误不重试）。
  async redirectTarget(pickcode, sign, file_name, userAgent) {
    const normalized = String(pickcode || "").trim();
    if (!normalized || !sign) return { code: 400, message: "缺少 pickcode 或签名" };
    if (!this.verifyRedirectSignature(normalized, sign)) {
      return { code: 403, message: "无效播放签名" };
    }
    const ua = String(userAgent || "").trim();
    const cacheKey = `${normalized}|${ua}`;
    // 1) 缓存命中
    const cached = this._redirectUrlCache && this._redirectUrlCache.get(cacheKey);
    if (cached && cached.expireAt > Date.now()) {
      return { code: 302, url: cached.url, file_name: String(file_name || "").trim() };
    }
    // 2) singleflight：同 pickcode 并发共享同一次取链
    if (this._redirectInflight && this._redirectInflight.has(cacheKey)) {
      try {
        const url = await this._redirectInflight.get(cacheKey);
        return { code: 302, url, file_name: String(file_name || "").trim() };
      } catch (err) {
        return { code: 502, message: `取链失败: ${err.message}` };
      }
    }
    const inflightPromise = this._fetchRedirectUrlWithRetry(normalized, ua)
      .then((url) => {
        if (url && this._redirectUrlCache) {
          const ttlMs = this._redirectUrlTtlMs(url);
          this._redirectUrlCache.set(cacheKey, { url, expireAt: Date.now() + ttlMs });
          // 容量裁剪：清过期 + 超上限删最旧
          if (this._redirectUrlCache.size > (this._redirectCacheMax || 2048)) {
            const now = Date.now();
            for (const [k, v] of this._redirectUrlCache) {
              if (v.expireAt <= now) this._redirectUrlCache.delete(k);
            }
            while (this._redirectUrlCache.size > (this._redirectCacheMax || 2048)) {
              const oldestKey = this._redirectUrlCache.keys().next().value;
              this._redirectUrlCache.delete(oldestKey);
            }
          }
        }
        return url;
      })
      .finally(() => {
        if (this._redirectInflight) this._redirectInflight.delete(cacheKey);
      });
    if (this._redirectInflight) this._redirectInflight.set(cacheKey, inflightPromise);
    try {
      const url = await inflightPromise;
      if (!url) return { code: 502, message: "取链失败，115 未返回下载地址" };
      return { code: 302, url, file_name: String(file_name || "").trim() };
    } catch (err) {
      console.error(`匿名取链失败：${err.message}`);
      return { code: 502, message: `取链失败: ${err.message}` };
    }
  }

  // 取链 + 重试 3 次（对齐插件 retry_call；限流/认证错误不重试）
  async _fetchRedirectUrlWithRetry(pickcode, ua) {
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await this._getClient().getDownloadUrl(pickcode, ua || undefined);
      } catch (err) {
        lastErr = err;
        const msg = String((err && err.message) || "");
        // 限流/认证类错误不重试（重试也无意义且加剧限流）
        if (/限流|Access|认证|登录|Auth|Rate|frequency|频繁/i.test(msg)) {
          throw err;
        }
        if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 1000));
      }
    }
    throw lastErr || new Error("取链失败");
  }

  // 从 115 下载链接的 t 参数计算缓存 TTL：剩余寿命 - 300s 安全窗口；无 t 参数兜底 15 分钟
  _redirectUrlTtlMs(url) {
    try {
      const u = new URL(url);
      const t = u.searchParams.get("t");
      if (t) {
        const remaining = parseInt(t, 10) * 1000 - Date.now() - 300 * 1000;
        if (remaining > 0) return remaining;
      }
    } catch { /* 非 URL 或解析失败，走兜底 */ }
    return 15 * 60 * 1000;
  }

  // ── 执行历史 ──
  history() {
    try {
      const items = this.store.getHistory();
      return ok({ items });
    } catch (err) {
      console.error(`读取执行历史失败：${err.message}`);
      return error(`读取执行历史失败: ${err.message}`);
    }
  }

  // ── 清空执行历史（保留今日签到成功记录，防止重启后签到窗口内重复签到）──
  clearHistory() {
    try {
      const removed = this.store.clearHistory();
      return ok({ removed });
    } catch (err) {
      console.error(`清空执行历史失败：${err.message}`);
      return error(`清空执行历史失败: ${err.message}`);
    }
  }

  // ── 日志 ──
  // 结构化日志：每条 {t:时间, l:等级, y:类型, x:文本}。前端按等级/类型筛选着色。
  // 等级: INFO | WARN | ERROR；类型: UPLOAD | STRM | WATCH | CHECKIN | RISK | CONFIG | LINK | SYSTEM
  logTail(offset, limit) {
    limit = Math.min(parseInt(limit || 300, 10) || 300, 500);
    offset = parseInt(offset || 0, 10) || 0;
    let lines = this._logTail.slice();
    if (offset) lines = lines.slice(offset);
    return ok({ lines: lines.slice(-limit) });
  }

  // 按文本关键字推断日志类型（console hook 兜底用；显式 _log 调用不依赖它）
  _inferType(text) {
    const s = String(text || "");
    if (/\[STRM\]|STRM/.test(s)) return "STRM";
    if (/FileWatcher|监听|watch_enabled/i.test(s)) return "WATCH";
    if (/签到|checkin/i.test(s)) return "CHECKIN";
    if (/风控|限流|冷却/i.test(s)) return "RISK";
    if (/上传|秒传|目录上传|upload/i.test(s)) return "UPLOAD";
    if (/配置|设置|已保存|config/i.test(s)) return "CONFIG";
    if (/取链|redirect|link/i.test(s)) return "LINK";
    return "SYSTEM";
  }

  recordLog(text, level = "INFO", type = "") {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const lvl = /^(INFO|WARN|ERROR)$/.test(level) ? level : "INFO";
    const typ = /^(UPLOAD|STRM|WATCH|CHECKIN|RISK|CONFIG|LINK|SYSTEM)$/.test(type)
      ? type
      : this._inferType(text);
    this._logTail.push({
      t: `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
      l: lvl,
      y: typ,
      x: String(text),
    });
    if (this._logTail.length > 2000) {
      this._logTail = this._logTail.slice(-2000);
    }
  }

  // ── 通知测试 ──
  async testNotify() {
    try {
      const message = await this._notifier.test();
      return ok(undefined, message);
    } catch (err) {
      return error(err.message);
    }
  }

  // ── 定时调度（由 main.js 的周期定时器调用）──
  // 今日是否已签到：以当日 history 记录为准（持久化判据），
  // 进程在签到窗口内重启也不会重复签到。
  _checkinDoneToday() {
    const today = new Date();
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    const endOfDay = startOfDay + 24 * 60 * 60 * 1000;
    const items = this.store.getHistory();
    if (!Array.isArray(items)) return false;
    return items.some(
      (item) =>
        item &&
        item.type === "checkin" &&
        item.ok === true &&
        typeof item.ts === "number" &&
        item.ts >= startOfDay &&
        item.ts < endOfDay
    );
  }

  async schedulerTick() {
    const config = this.store.getConfig();
    if (!config.enabled || !config.checkin_enabled) {
      this._checkinToday = null;
      return;
    }
    const today = new Date();
    const dateKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    if (this._checkinCheckedDate === dateKey && this._checkinToday !== null) {
      return;
    }
    if (!inCheckinWindow(String(config.checkin_time_range || "06:00-09:00"))) {
      return;
    }
    this._checkinCheckedDate = dateKey;
    // 持久化判据优先：history 已有今日成功记录则跳过（重启不重复签到）。
    if (this._checkinDoneToday()) {
      this._checkinToday = true;
      this.recordLog("每日签到：今日已签到，跳过");
      return;
    }
    const result = await this.checkinNow();
    this._checkinToday = Boolean(result.success);
    this.recordLog(`每日签到：${result.message || "完成"}`);
  }
}

// ── 模块级辅助 ──
function cookieUserIdText(client) {
  if (!client.cookie) return "";
  for (const part of String(client.cookie).split(";")) {
    const idx = part.indexOf("=");
    const key = (idx >= 0 ? part.slice(0, idx) : part).trim().toUpperCase();
    const value = idx >= 0 ? part.slice(idx + 1) : "";
    if (key === "UID") {
      return value.split("_")[0];
    }
  }
  return "";
}

function extensionSet(value) {
  if (typeof value === "string") {
    return new Set(
      value
        .split(",")
        .map((ext) => ext.trim().toLowerCase())
        .filter(Boolean)
    );
  }
  return new Set();
}

function remapRelativePath(filePath, source, target) {
  const relative = path.relative(source, filePath);
  const parts = relative.split(path.sep);
  parts.pop(); // 去掉文件名
  const relParts = parts.filter((p) => p && p !== ".");
  const base = String((target && target.path) || "/");
  if (!relParts.length) return base || "/";
  return `${base.replace(/\/+$/, "")}/${relParts.join("/")}`;
}

/** 稳定字符串散列（替代 Python 内置 hash 的跨进程不确定性）。 */
function hashString(text) {
  let h = 5381;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

/** 检查当前时间是否在给定的 HH:MM-HH:MM 窗口内（支持跨天）。 */
function inCheckinWindow(text) {
  try {
    const [start, end] = String(text || "").trim().split("-", 2);
    const [startH, startM] = start.trim().split(":", 2).map(Number);
    const [endH, endM] = end.trim().split(":", 2).map(Number);
    const now = new Date();
    const current = now.getHours() * 60 + now.getMinutes();
    const begin = startH * 60 + startM;
    const finish = endH * 60 + endM;
    if (finish < begin) return current >= begin || current < finish;
    return begin <= current && current <= finish;
  } catch {
    return false;
  }
}

module.exports = {
  Server,
  UploadWorker,
  PUBLIC_CONFIG_FIELDS,
  EDITABLE_CONFIG_FIELDS,
  ok,
  error,
  gatewayError,
  mask,
  hashString,
  inCheckinWindow,
};
