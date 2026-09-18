"use strict";

/**
 * 115网盘助手 FPK —— 限流模块（Node.js 版）。
 *
 * 与 MoviePilot-Plugins p115liteassistant/limiter.py 算法一致：
 * - RateLimiter：预约式固定间隔 QPS 控制器（interval = 1/qps）
 * - CooldownSlot：首调立即，后续严格按 cooldown 预约
 * - RequestPacer：Open 总预算 + 端点族预算双层预约
 *
 * Node.js 单线程事件循环天然串行化所有 acquire；这里不再需要锁，
 * 等待用 setTimeout 实现（async），避免 busy-wait 冻结事件循环。
 */

const ROUTES = new Set([
  "auth",
  "directory",
  "metadata",
  "upload_control",
  "download_link",
  "life_ios",
  "life_web",
  "mutation",
  "other_open",
]);

// ───── RateLimitProfile ─────
const PROFILE_PRESETS = {
  conservative: {
    open_qps: 1,
    directory_qps: 2,
    directory_page_cooldown: 1.5,
    metadata_cooldown: 1.0,
    upload_cooldown: 1.0,
    mutation_cooldown: 1.0,
    life_ios_cooldown: 3.0,
    life_web_cooldown: 3.0,
    download_link_qps: 1,
  },
  balanced: {
    open_qps: 2,
    directory_qps: 4,
    directory_page_cooldown: 0.75,
    metadata_cooldown: 0.5,
    upload_cooldown: 0.5,
    mutation_cooldown: 0.5,
    life_ios_cooldown: 2.0,
    life_web_cooldown: 2.0,
    download_link_qps: 1,
  },
  fast: {
    open_qps: 3,
    directory_qps: 5,
    directory_page_cooldown: 0.25,
    metadata_cooldown: 0.25,
    upload_cooldown: 0.25,
    mutation_cooldown: 0.25,
    life_ios_cooldown: 1.0,
    life_web_cooldown: 1.0,
    download_link_qps: 1,
  },
};

function getRateLimitProfile(name) {
  const n = String(name || "").trim().toLowerCase();
  return PROFILE_PRESETS[n] || PROFILE_PRESETS.balanced;
}

// ───── 异步等待工具 ─────
/** 分段 sleep：每 0.1s 检查一次取消源，避免整段等待无法中止。 */
function sleepSegmented(seconds, cancelled) {
  return new Promise((resolve, reject) => {
    let remaining = Math.max(0, Number(seconds) || 0);
    if (remaining <= 0) {
      resolve();
      return;
    }
    const checkCancelled = () => {
      try {
        if (cancelled && cancelled()) {
          resolve();
          return true;
        }
      } catch {
        /* 忽略取消判断异常 */
      }
      return false;
    };
    const timer = setInterval(() => {
      if (checkCancelled()) {
        clearInterval(timer);
        resolve();
        return;
      }
      remaining -= 0.1;
      if (remaining <= 0) {
        clearInterval(timer);
        resolve();
      }
    }, 100);
  });
}

// ───── RateLimiter ─────
class RateLimiter {
  constructor(qps) {
    this.interval = qps <= 0 ? 0 : 1.0 / qps;
    this._nextAllowedAt = 0;
    this._reserved = false;
  }

  async acquire(cancelled) {
    if (cancelled && cancelled()) return;
    const now = Date.now() / 1000;
    let reservedAt;
    if (!this._reserved) {
      reservedAt = now;
      this._reserved = true;
    } else {
      reservedAt = Math.max(now, this._nextAllowedAt);
    }
    this._nextAllowedAt = reservedAt + this.interval;
    const delay = Math.max(0, reservedAt - now);
    if (delay > 0) {
      await sleepSegmented(delay, cancelled);
    }
  }
}

// ───── CooldownSlot ─────
class CooldownSlot {
  constructor(cooldown) {
    this.cooldown = Math.max(0, cooldown);
    this._nextAllowedAt = 0;
    this._reserved = false;
  }

  async acquire(cancelled) {
    if (cancelled && cancelled()) return;
    const now = Date.now() / 1000;
    let reservedAt;
    if (!this._reserved) {
      reservedAt = now;
      this._reserved = true;
    } else {
      reservedAt = Math.max(now, this._nextAllowedAt);
    }
    this._nextAllowedAt = reservedAt + this.cooldown;
    const delay = Math.max(0, reservedAt - now);
    if (delay > 0) {
      await sleepSegmented(delay, cancelled);
    }
  }

  async acquireAfter(cancelled) {
    if (cancelled && cancelled()) return;
    const now = Date.now() / 1000;
    const reservedAt = this._reserved ? Math.max(now, this._nextAllowedAt) : now;
    const target = reservedAt + this.cooldown;
    this._nextAllowedAt = target;
    this._reserved = true;
    const delay = Math.max(0, target - now);
    if (delay > 0) {
      await sleepSegmented(delay, cancelled);
    }
  }
}

// ───── RequestPacer ─────
class RequestPacer {
  constructor(profile = "balanced") {
    const p = typeof profile === "string" ? getRateLimitProfile(profile) : profile;
    this.openGlobal = new RateLimiter(p.open_qps);
    this.directoryPage = new CooldownSlot(p.directory_page_cooldown);
    this._routes = {
      auth: new CooldownSlot(p.metadata_cooldown),
      directory: new RateLimiter(p.directory_qps),
      metadata: new CooldownSlot(p.metadata_cooldown),
      upload_control: new CooldownSlot(p.upload_cooldown),
      download_link: new RateLimiter(p.download_link_qps),
      life_ios: new CooldownSlot(p.life_ios_cooldown),
      life_web: new CooldownSlot(p.life_web_cooldown),
      mutation: new CooldownSlot(p.mutation_cooldown),
      other_open: new CooldownSlot(p.metadata_cooldown),
    };
  }

  async acquire(route, opts = {}) {
    const normalized = String(route || "").trim().toLowerCase();
    let targetRoute = normalized;
    if (opts.isOpen && !ROUTES.has(normalized)) {
      targetRoute = "other_open";
    }
    if (opts.isOpen) {
      await this.openGlobal.acquire(opts.cancelled);
    }
    const slot = this._routes[targetRoute];
    if (slot) {
      await slot.acquire(opts.cancelled);
    }
  }

  async acquireDirectoryPage(cancelled) {
    await this.directoryPage.acquireAfter(cancelled);
  }
}

module.exports = {
  RateLimiter,
  CooldownSlot,
  RequestPacer,
  getRateLimitProfile,
  PROFILE_PRESETS,
  ROUTES,
  sleepSegmented,
};
