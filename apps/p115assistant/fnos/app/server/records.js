"use strict";

/**
 * 115网盘助手 FPK —— 上传增量记录（Node.js 版）。
 *
 * 与 MoviePilot-Plugins p115liteassistant/records.py 的
 * IncrementalRecordStore 一致：基于本地文件大小与修改时间判断是否已上传，
 * 额外校验 target（云端目录）与 metadata 是否变化。
 */

const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

class IncrementalRecordStore {
  constructor(records) {
    this._records = records && typeof records === "object" && !Array.isArray(records)
      ? records
      : {};
  }

  static fingerprint(p) {
    // 必须带 { bigint: true } 才能拿到 mtimeNs；否则 mtimeNs 恒为 undefined，
    // 增量检测退化为仅比 size，同尺寸改写永不重传。
    // BigInt 无法直接 JSON 序列化，故 size 收敛为 Number、mtime_ns 收敛为字符串。
    const stat = fs.statSync(p, { bigint: true });
    return { size: Number(stat.size), mtime_ns: stat.mtimeNs.toString() };
  }

  /** 只用于比较的路径键；兼容分隔符，统一 casefold。 */
  static pathKey(p) {
    let raw = String(p);
    try {
      raw = path.resolve(os.homedir ? os.homedir() : "", raw);
      raw = path.normalize(raw);
    } catch {
      /* 保留原串 */
    }
    return raw.replace(/\\/g, "/").toLowerCase();
  }

  _storedKey(p) {
    const raw = String(p);
    if (raw in this._records) return raw;
    const wanted = IncrementalRecordStore.pathKey(raw);
    for (const key of Object.keys(this._records)) {
      if (IncrementalRecordStore.pathKey(key) === wanted) return key;
    }
    return null;
  }

  hasChanged(p, target, metadata) {
    const current = IncrementalRecordStore.fingerprint(p);
    const previous = this._records[this._storedKey(p) || ""];
    if (!previous) return true;
    for (const [key, value] of Object.entries(current)) {
      if (String(previous[key]) !== String(value)) return true;
    }
    if (target !== undefined && previous.target !== target) return true;
    if (metadata) {
      for (const [key, value] of Object.entries(metadata)) {
        if (previous[key] !== value) return true;
      }
    }
    return false;
  }

  /** 是否存在指向 target 的上传记录（用于判断该映射是否已有上传历史，重启恢复时用） */
  someFor(target) {
    for (const key of Object.keys(this._records)) {
      const r = this._records[key];
      if (r && String(r.target || "") === String(target || "")) return true;
    }
    return false;
  }

  markUploaded(p, target, uploadedAt, metadata) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const iso = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    this._records[String(p)] = Object.assign(
      {
        size: IncrementalRecordStore.fingerprint(p).size,
        mtime_ns: IncrementalRecordStore.fingerprint(p).mtime_ns,
        target: target,
        uploaded_at: uploadedAt || iso,
      },
      metadata || {}
    );
  }

  updateMetadata(p, metadata) {
    const key = this._storedKey(p);
    const record = this._records[key || ""];
    if (!record) throw new Error(`上传记录不存在: ${p}`);
    Object.assign(record, metadata);
  }

  getByKey(key) {
    const record = this._records[this._storedKey(key) || ""];
    return record ? Object.assign({}, record) : {};
  }

  upsertByKey(key, record) {
    const stored = this._storedKey(key);
    if (stored !== null && stored !== String(key)) delete this._records[stored];
    this._records[String(key)] = Object.assign({}, record);
  }

  deleteByKey(key) {
    const stored = this._storedKey(key);
    if (stored !== null) delete this._records[stored];
  }

  get(p) {
    const record = this._records[this._storedKey(p) || ""];
    return record ? Object.assign({}, record) : {};
  }

  remove(p) {
    const key = this._storedKey(p);
    if (key !== null) delete this._records[key];
  }

  toDict() {
    return JSON.parse(JSON.stringify(this._records));
  }

  recentMedia(mediaExtensions, limit) {
    limit = limit || 12;
    const items = [];
    for (const [p, record] of Object.entries(this._records)) {
      const ext = path.extname(p).toLowerCase();
      if (!mediaExtensions.has(ext)) continue;
      const uploadedAt = String(record.uploaded_at || "");
      if (!uploadedAt) continue;
      items.push({
        name: path.basename(p),
        path: p,
        target: String(record.target || ""),
        uploaded_at: uploadedAt,
        method: String(record.method || "upload"),
      });
    }
    items.sort((a, b) => (a.uploaded_at < b.uploaded_at ? 1 : -1));
    return items.slice(0, limit);
  }
}

class TaskHistory {
  constructor(items, limit) {
    this.limit = limit || 50;
    this.items = (items ? [...items] : []).slice(0, this.limit);
  }

  add(item) {
    this.items.unshift(item);
    this.items = this.items.slice(0, this.limit);
  }
}

module.exports = {
  IncrementalRecordStore,
  TaskHistory,
};
