"use strict";

/**
 * 115网盘助手 FPK —— 飞书 webhook 通知（Node.js 版）。
 *
 * 向用户配置的 webhook URL POST 一段纯文本。通知永远是附加动作，
 * 任何异常都吞掉记日志，不能把任务本身搞挂。
 */

const https = require("node:https");

class NotifyError extends Error {}

class Notifier {
  constructor(configProvider, titlePrefix) {
    this._configProvider = configProvider;
    this._titlePrefix = titlePrefix || "115网盘助手";
  }

  _webhook() {
    const config = this._configProvider() || {};
    if (!config.feishu_enabled) return "";
    return String(config.feishu_webhook || "").trim();
  }

  async notify(headline, ...lines) {
    const webhook = this._webhook();
    if (!webhook) return;
    const body = [String(headline), ...lines.map(String)].join("\n");
    const text = `**${this._titlePrefix}**\n${body}`;
    try {
      await postJson(webhook, { msg_type: "text", content: { text } }, 10000);
    } catch (err) {
      console.warn(`飞书通知发送失败：${err.message}`);
    }
  }

  async test() {
    const webhook = this._webhook();
    if (!webhook) throw new NotifyError("飞书通知未启用或未配置 webhook");
    await this.notify("通知测试");
    return "已发送测试通知，请到飞书群确认";
  }
}

/** 通用 POST JSON，返回解析后的响应对象（不抛非 HTTP 错误以外的异常）。 */
function postJson(url, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (err) {
      reject(err);
      return;
    }
    const data = Buffer.from(JSON.stringify(payload));
    const options = {
      hostname: target.hostname,
      port: target.port || 443,
      path: target.pathname + target.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": data.length,
      },
      timeout: timeoutMs || 10000,
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let parsed = null;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = raw;
        }
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 200)}`));
          return;
        }
        resolve(parsed);
      });
    });
    req.on("timeout", () => req.destroy(new Error("通知请求超时")));
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

module.exports = { Notifier, NotifyError, postJson };
