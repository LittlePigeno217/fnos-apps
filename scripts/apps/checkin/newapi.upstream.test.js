"use strict";
/**
 * checkin NEWAPI 上游对齐（2.0.7）回归测试 —— 事实源 aceHubert/newapi-ai-check-in。
 *
 * 锁定本次重构新增/对齐的三件事，且不打印任何明文凭据：
 *   1. system_access_token 读取别名：上游把「系统访问令牌」叫 system_access_token，
 *      本应用存储键沿用 access_token；_normalize 应把上游键名折叠进 access_token（仅补空，不覆盖已有值）。
 *   2. execute_check_in 成功判定（checkin.py:758）：HTTP 200 但响应体非 JSON，正文含 "success" → 判签到成功。
 *   3. quota_awarded 奖励展示（NewApiCheckInRecord）：签到响应 data.quota_awarded 优先作为本次奖励。
 *
 * 网络通过替换 httpc.Session 原型方法做纯内存打桩（不发真实请求）。
 * 运行：node scripts/apps/checkin/newapi.upstream.test.js
 * 说明：置于 scripts/ 下，不进 runtime-manifest 与 app.tgz，不下发真机。
 */
const assert = require("assert");
const path = require("path");

const BASE = path.join(__dirname, "../../../apps/checkin/fnos/app/server");
const httpc = require(path.join(BASE, "httpc.js"));
const { NEWAPI } = require(path.join(BASE, "sites.js"));

let passed = 0;
function test(name, fn) { return fn().then(() => { passed++; console.log(`  ✓ ${name}`); }); }

// ── 打桩：按 URL 子串路由到脚本化响应 {status, text} ──────────────────
let ROUTES = {};
function stub(routes) { ROUTES = routes; }
function pick(url) {
  for (const key of Object.keys(ROUTES)) if (url.includes(key)) return ROUTES[key];
  return { status: 404, text: "not found" };
}
httpc.Session.prototype.get = async function (url) { const r = pick(url); return typeof r === "function" ? r() : r; };
httpc.Session.prototype.postRaw = async function (url) { const r = pick(url); return typeof r === "function" ? r() : r; };
httpc.Session.prototype.postJson = async function (url) { const r = pick(url); return typeof r === "function" ? r() : r; };

console.log("checkin NEWAPI 上游对齐（2.0.7）回归测试：");

// ── 1. system_access_token 读取别名 ─────────────────────────────────
(async () => {
  await test("_normalize：system_access_token 折叠进 access_token（上游键名可直接导入）", async () => {
    const n = NEWAPI._normalize({ provider: "custom", base_url: "https://x.example", system_access_token: "sk-alias" });
    assert.strictEqual(n.access_token, "sk-alias");
    assert.ok(NEWAPI.isConfigured({ provider: "custom", base_url: "https://x.example", system_access_token: "sk-alias" }));
  });
  await test("_normalize：已有 access_token 时别名不覆盖（不动用户已存值）", async () => {
    const n = NEWAPI._normalize({ access_token: "sk-real", system_access_token: "sk-alias" });
    assert.strictEqual(n.access_token, "sk-real");
  });

  // ── 2. 成功判定：非 JSON 正文含 "success" → 签到成功 ─────────────────
  await test("runCheckin：签到接口回纯文本 'Check-in success' → 判签到成功（对齐 execute_check_in）", async () => {
    stub({
      "/api/user/self": { status: 200, text: JSON.stringify({ data: { quota: 0 } }) },
      "/api/user/sign_in": { status: 200, text: "Check-in success!" },
    });
    const res = await NEWAPI.runCheckin({ provider: "custom", base_url: "https://x.example", access_token: "sk" });
    assert.strictEqual(res.status, "签到成功");
  });

  // ── 3. quota_awarded 奖励展示优先 ───────────────────────────────────
  await test("runCheckin：签到响应 data.quota_awarded=500000 → 奖励显示 +$1.00", async () => {
    stub({
      "/api/user/self": { status: 200, text: JSON.stringify({ data: { quota: 0 } }) },
      "/api/user/sign_in": { status: 200, text: JSON.stringify({ ret: 1, data: { quota_awarded: 500000 } }) },
    });
    const res = await NEWAPI.runCheckin({ provider: "custom", base_url: "https://x.example", access_token: "sk" });
    assert.strictEqual(res.status, "签到成功");
    assert.ok(String(res.reward).includes("+$1.00"), `奖励应含 +$1.00，实际 ${res.reward}`);
  });

  // ── 4. 已签到关键词判定（不回归）─────────────────────────────────────
  await test("runCheckin：签到响应 message='已经签到' → 今日已签到（不判失败）", async () => {
    stub({
      "/api/user/self": { status: 200, text: JSON.stringify({ data: { quota: 500000 } }) },
      "/api/user/sign_in": { status: 200, text: JSON.stringify({ success: false, message: "已经签到" }) },
    });
    const res = await NEWAPI.runCheckin({ provider: "custom", base_url: "https://x.example", access_token: "sk" });
    assert.strictEqual(res.status, "今日已签到");
  });

  console.log(`\n通过 ${passed} 项断言。`);
})().catch((e) => { console.error("测试失败：", e && e.message); process.exit(1); });
