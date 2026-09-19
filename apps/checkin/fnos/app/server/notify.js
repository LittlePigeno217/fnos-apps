"use strict";
/**
 * checkin — 飞书机器人通知（复用 p115assistant 通知语义）。
 */
const https = require("https");
const { URL } = require("url");

function postJson(url, obj, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      u,
      { method: "POST", headers: { "Content-Type": "application/json" }, timeout },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          let j = null;
          try { j = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* ignore */ }
          resolve(j);
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("超时")));
    req.on("error", reject);
    req.write(JSON.stringify(obj));
    req.end();
  });
}

/** 发送文本消息；失败不抛（通知失败不影响签到主流程） */
async function sendText(webhook, text) {
  if (!webhook) return false;
  try {
    const r = await postJson(webhook, { msg_type: "text", content: { text } });
    return !!(r && r.code === 0);
  } catch {
    return false;
  }
}

/** 组装签到结果通知（含站点逐行 + 汇总行） */
function buildNotifyText(title, results) {
  const lines = [`【${title}】`];
  for (const r of results) {
    if (r.error) {
      lines.push(`✗ ${r.site_name}：${String(r.error).slice(0, 60)}`);
    } else {
      lines.push(`${r.status === "签到成功" ? "✓" : "○"} ${r.site_name}：${r.message}`);
    }
  }
  return lines.join("\n");
}

module.exports = { sendText, buildNotifyText };
