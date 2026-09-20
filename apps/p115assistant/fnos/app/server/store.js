"use strict";

/**
 * 115网盘助手 FPK —— 本地 JSON 持久化存储（Node.js 版）。
 *
 * 把 MoviePilot 插件的 Store 重写为直接读写 TRIM_PKGVAR 下的 JSON 文件。
 * 加密边界保持一致：config 里的 cookie / tokens 用由 302 取链随机 secret
 * 派生的 Fernet 密钥加密落盘（AES-128-CBC + HMAC-SHA256，Python cryptography
 * Fernet 互操作格式），密钥只在后端内存中被缓存，绝不写入磁盘。
 * 其余状态（历史、记录等）为明文 JSON。
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const TRIM_PKGVAR = process.env.TRIM_PKGVAR || "/tmp/p115assistant_data";

// 与插件同源的默认配置骨架；更新时只接受 DEFAULT_CONFIG 里已存在的键。
const DEFAULT_CONFIG = {
  enabled: false,
  version: "1.0.8",
  rate_limit_profile: "balanced",
  cookie: "",
  tokens: {},
  login_client_type: "",
  fnos_username: "",
  fnos_password: "",
  link_redirect_mode: "cookie",
  upload_mappings: [],
  upload_include_sidecars: true,
  upload_generate_strm: false,
  upload_delete_source: false,
  upload_conflict_policy: "ask",
  upload_media_extensions:
    ".mp4,.mkv,.ts,.iso,.rmvb,.avi,.mov,.mpeg,.mpg,.wmv,.3gp,.asf,.m4v,.flv,.m2ts,.tp,.f4v",
  upload_sidecar_extensions: ".nfo,.jpg,.jpeg,.png,.webp,.srt,.ass,.ssa,.sup",
  strm_mappings: [],
  strm_incremental: true,
  strm_add_subtitles: true,
  strm_base_url: "",
  relay_port: 3667,
  strm_delete_cloud_on_missing: false,
  strm_delete_sweep_cron: "",
  strm_delete_watch: false,
  strm_delete_confirm_threshold: 16,
  strm_notify: false,
  checkin_enabled: false,
  checkin_time_range: "06:00-09:00",
  checkin_notify: false,
  life_monitor_enabled: false,
  feishu_webhook: "",
  feishu_enabled: false,
  watch_enabled: false,
  upload_risk_profile: "conservative",
};

const ENCRYPTION_SALT = "p115liteassistant_v1";
const ENCRYPTED_FIELDS = ["cookie", "tokens", "fnos_password"];
const REDIRECT_SECRET_KEY = "p115liteassistant_redirect_secret";
const CONFIG_KEY = "p115assistant_config";
const HISTORY_KEY = "p115assistant_history";
const UPLOAD_CONFLICTS_KEY = "p115assistant_upload_conflicts";
const STRM_RECORDS_KEY = "p115assistant_strm_records";

// ───── Fernet（与 cryptography.Fernet 互操作）─────
// 格式：0x80 | 8 字节时间戳 | 16 字节 IV | AES-128-CBC 密文 | 32 字节 HMAC-SHA256
const FERNET_SIGN = Buffer.from([0x80]);
const FERNET_IV = Buffer.alloc(16);
const FERNET_KEY = Buffer.alloc(32);

function fernetEncrypt(plaintext, key) {
  if (plaintext === "") return "";
  const signing = hmacKey(key);
  const encKey = aesKey(key);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const timestamp = Buffer.alloc(8);
  timestamp.writeBigUInt64BE(now);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-128-cbc", encKey, iv);
  cipher.setAutoPadding(true);
  let ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const part = Buffer.concat([FERNET_SIGN, timestamp, iv, ct]);
  const hmac = crypto.createHmac("sha256", signing);
  hmac.update(part);
  const token = Buffer.concat([part, hmac.digest()]);
  return token.toString("base64url");
}

function fernetDecrypt(tokenText, key) {
  if (!tokenText) return null;
  let token;
  try {
    token = Buffer.from(String(tokenText), "base64url");
  } catch {
    return null;
  }
  if (token.length < 1 + 8 + 16 + 32) return null;
  const signing = hmacKey(key);
  const encKey = aesKey(key);
  const part = token.subarray(0, token.length - 32);
  const hmac = crypto.createHmac("sha256", signing);
  hmac.update(part);
  const expected = hmac.digest();
  const received = token.subarray(token.length - 32);
  if (!crypto.timingSafeEqual(expected, received)) return null;
  const iv = token.subarray(1 + 8, 1 + 8 + 16);
  const ct = token.subarray(1 + 8 + 16, token.length - 32);
  try {
    const decipher = crypto.createDecipheriv("aes-128-cbc", encKey, iv);
    decipher.setAutoPadding(true);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

function hmacKey(key) {
  // Python cryptography.Fernet：key[:16] 是签名密钥（HMAC-SHA256）。
  if (Buffer.isBuffer(key) && key.length === 32) return key.subarray(0, 16);
  return crypto.pbkdf2Sync(String(key), ENCRYPTION_SALT, 100000, 32, "sha256").subarray(0, 16);
}

function aesKey(key) {
  // Python cryptography.Fernet：key[16:] 是加密密钥（AES-128-CBC）。
  if (Buffer.isBuffer(key) && key.length === 32) return key.subarray(16);
  return crypto.pbkdf2Sync(String(key), ENCRYPTION_SALT, 100000, 32, "sha256").subarray(16);
}

function encryptTokens(data, key) {
  if (!data || Object.keys(data).length === 0) return "";
  return fernetEncrypt(JSON.stringify(data), key);
}

function decryptTokens(ciphertext, key) {
  const plaintext = fernetDecrypt(ciphertext, key);
  if (plaintext === null) return null;
  try {
    const parsed = JSON.parse(plaintext);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

class Store {
  constructor(dataDir) {
    this._dir = dataDir || TRIM_PKGVAR;
    fs.mkdirSync(this._dir, { recursive: true });
    this._encryptionKeyCache = null;
  }

  // ---- 通用 JSON 读写 ----
  _readJson(name) {
    const filePath = path.join(this._dir, `${name}.json`);
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      return null;
    }
  }

  _writeJson(name, value) {
    const filePath = path.join(this._dir, `${name}.json`);
    const tmp = path.join(this._dir, `${name}.json.tmp`);
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeSync(fd, JSON.stringify(value));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, filePath);
  }

  // ---- 302 取链 secret 与加密密钥 ----
  getRedirectSecret() {
    const secret = this._readJson(REDIRECT_SECRET_KEY);
    if (typeof secret === "string" && secret.length >= 32) return secret;
    const generated = crypto.randomBytes(32).toString("hex");
    this._writeJson(REDIRECT_SECRET_KEY, generated);
    return generated;
  }

  _encryptionKey() {
    if (this._encryptionKeyCache === null) {
      const secret = this.getRedirectSecret();
      this._encryptionKeyCache = crypto.pbkdf2Sync(
        secret,
        ENCRYPTION_SALT,
        100000,
        32,
        "sha256"
      );
    }
    return this._encryptionKeyCache;
  }

  // ---- config（加密敏感字段）----
  getConfig() {
    const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    const saved = this._readJson(CONFIG_KEY);
    if (saved && typeof saved === "object" && !Array.isArray(saved)) {
      for (const [key, value] of Object.entries(saved)) {
        // version 不参与持久化合并：版本始终反映当前代码常量（DEFAULT_CONFIG.version），
        // 避免升级后 config.json 中旧版本号覆盖实际运行版本（2026-09-17 修复）
        if (key in DEFAULT_CONFIG && key !== "version") config[key] = value;
      }
    }
    return this._decryptConfig(config);
  }

  saveConfig(config) {
    this._writeJson(CONFIG_KEY, this._encryptConfig(config));
  }

  updateConfig(updates) {
    const config = this.getConfig();
    for (const [key, value] of Object.entries(updates || {})) {
      if (key in DEFAULT_CONFIG) config[key] = value;
    }
    this.saveConfig(config);
    return config;
  }

  _encryptConfig(config) {
    const key = this._encryptionKey();
    const result = Object.assign({}, config);
    for (const field of ENCRYPTED_FIELDS) {
      const value = result[field];
      if (field === "tokens") {
        if (value && typeof value === "object" && !Array.isArray(value)) {
          result[field] = encryptTokens(value, key);
        }
      } else if (typeof value === "string" && value) {
        result[field] = fernetEncrypt(value, key);
      }
    }
    return result;
  }

  _decryptConfig(config) {
    const key = this._encryptionKey();
    const result = Object.assign({}, config);
    for (const field of ENCRYPTED_FIELDS) {
      const value = result[field];
      if (typeof value !== "string" || !value) continue;
      if (field === "tokens") {
        const parsed = decryptTokens(value, key);
        result[field] = parsed !== null ? parsed : {};
      } else {
        const plaintext = fernetDecrypt(value, key);
        if (plaintext !== null) result[field] = plaintext;
      }
    }
    return result;
  }

  // ---- 上传增量记录 ----
  getUploadRecords() {
    const records = this._readJson("p115assistant_upload_records");
    const IncrementalRecordStore = require("./records").IncrementalRecordStore;
    return new IncrementalRecordStore(
      records && typeof records === "object" && !Array.isArray(records) ? records : {}
    );
  }

  saveUploadRecords(records) {
    this._writeJson("p115assistant_upload_records", records.toDict());
  }

  // ---- 上传身份冲突 ----
  getUploadConflicts() {
    const conflicts = this._readJson(UPLOAD_CONFLICTS_KEY);
    return conflicts && typeof conflicts === "object" && !Array.isArray(conflicts)
      ? conflicts
      : {};
  }

  saveUploadConflicts(conflicts) {
    this._writeJson(UPLOAD_CONFLICTS_KEY, conflicts);
  }

  // ---- STRM 记录 ----
  // 每生成一个 .strm 就记一条：云端媒体大小/pickcode/云目录/本地输出路径，外加一次
  // 云端核对的结果（verify_state）。媒体账本与失效清理都以它为准，两者都不打 115 请求。
  getStrmRecords() {
    const records = this._readJson(STRM_RECORDS_KEY);
    return records && typeof records === "object" && !Array.isArray(records) ? records : {};
  }

  saveStrmRecords(records) {
    this._writeJson(STRM_RECORDS_KEY, records && typeof records === "object" ? records : {});
  }

  // ---- 历史 ----
  getHistory() {
    const items = this._readJson(HISTORY_KEY);
    return Array.isArray(items) ? items : [];
  }

  // 清空执行历史：保留今日签到成功记录（scheduler 以 history 为「今日已签到」持久化判据，
  // 全清会导致清空后重启在签到窗口内重复签到）。返回删除条数。
  clearHistory() {
    const items = this.getHistory();
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const endOfDay = startOfDay + 24 * 60 * 60 * 1000;
    const kept = items.filter(
      (it) =>
        it &&
        it.type === "checkin" &&
        it.ok === true &&
        typeof it.ts === "number" &&
        it.ts >= startOfDay &&
        it.ts < endOfDay
    );
    this._writeJson(HISTORY_KEY, kept);
    return items.length - kept.length;
  }

  appendHistory(item) {
    const TaskHistory = require("./records").TaskHistory;
    const history = new TaskHistory(this.getHistory());
    history.add(item);
    this._writeJson(HISTORY_KEY, history.items);
  }
}

module.exports = {
  Store,
  DEFAULT_CONFIG,
  fernetEncrypt,
  fernetDecrypt,
  encryptTokens,
  decryptTokens,
};
