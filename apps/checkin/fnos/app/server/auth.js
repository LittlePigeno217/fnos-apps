"use strict";
/**
 * checkin — 面板鉴权会话（阶段3 B，可选，默认关闭）。
 *
 * 语义：口令（auth_token）在 store 明文持久化（本地防护，非强加密——store.js 无加密字段机制，
 * 依赖 fnOS 应用数据目录权限），登录成功后仅在内存中签发短期会话 token（30 分钟过期）。
 * 进程重启会清空全部会话（用户需重新登录），符合「轻量本地防护」定位。
 *
 * 绝不把 auth_token 值写进日志/报告：本模块只做「明文口令比对 → 内存会话」，不落盘、不打印。
 */
const crypto = require("crypto");

const SESSION_TTL_MS = 30 * 60 * 1000; // 会话有效期 30 分钟

/** 定长安全比较：长度不同直接 false，避免 timingSafeEqual 抛异常 */
function safeEq(a, b) {
  const ba = Buffer.from(String(a == null ? "" : a), "utf8");
  const bb = Buffer.from(String(b == null ? "" : b), "utf8");
  if (ba.length !== bb.length) return false;
  try {
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

class AuthSessions {
  constructor(ttlMs = SESSION_TTL_MS) {
    this._ttl = ttlMs;
    this._sessions = new Map(); // token -> 过期时间戳(ms)
  }

  /** 签发一个新会话 token，返回 { token, expires_in(秒) } */
  issue() {
    this._sweep();
    const token = crypto.randomBytes(24).toString("hex");
    this._sessions.set(token, Date.now() + this._ttl);
    return { token, expires_in: Math.floor(this._ttl / 1000) };
  }

  /** 会话是否有效（过期即清理并判否） */
  valid(token) {
    if (!token) return false;
    const exp = this._sessions.get(token);
    if (!exp) return false;
    if (Date.now() > exp) {
      this._sessions.delete(token);
      return false;
    }
    return true;
  }

  /** 主动注销一个会话（登出） */
  revoke(token) {
    if (token) this._sessions.delete(token);
  }

  /** 清理已过期会话（懒清理，签发时触发） */
  _sweep() {
    const now = Date.now();
    for (const [t, e] of this._sessions) {
      if (now > e) this._sessions.delete(t);
    }
  }
}

module.exports = { AuthSessions, SESSION_TTL_MS, safeEq };
