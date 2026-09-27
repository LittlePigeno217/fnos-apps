"use strict";
/**
 * checkin NEWAPI（anyrouter/agentrouter）provider 配置对齐回归测试。
 *
 * 事实源：上游 dctx-team/Regular-inspection（agentrouter.org + anyrouter.top 定时登录仓库）。
 *   - WAF：anyrouter.top 有阿里云盾 WAF（WAF_COOKIE_NAMES=acw_tc/cdn_sec_tc/acw_sc__v2）；
 *     agentrouter.org 上游明确跳过 WAF（checkin.py:340 `if provider != agentrouter: get_waf_cookies`）。
 *   - 签到：agentrouter 查询用户信息即完成（无手动 sign_in，__auto__/None 语义）；anyrouter 显式 /api/user/sign_in。
 *   - new-api-user 头：api_user 存在时随请求带上（2.0.1 修复，本测试锁定不回归）。
 *
 * 锁定不变量：provider 配置对齐 + 通用 newapi(custom) 零回归 + 2.0.1 共存。
 *
 * 运行（零依赖，仅 node 内置 assert）：
 *   node scripts/apps/checkin/newapi.provider.test.js
 *
 * 说明：置于 scripts/ 下，不进 runtime-manifest 与 app.tgz，不下发真机。
 */
const assert = require("assert");
const path = require("path");

const SITES_PATH = path.join(__dirname, "../../../apps/checkin/fnos/app/server/sites.js");
const { NEWAPI } = require(SITES_PATH);

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log("checkin NEWAPI provider 对齐回归测试：");

// ── WAF Cookie 名：对齐上游按 provider 内置默认 ─────────────────────
test("_wafCookieNames：anyrouter=阿里云盾三件套（对齐上游 WAF_COOKIE_NAMES）", () => {
  assert.deepStrictEqual(
    NEWAPI._wafCookieNames({ provider: "anyrouter" }),
    ["acw_tc", "cdn_sec_tc", "acw_sc__v2"],
  );
});
test("_wafCookieNames：agentrouter=[]（上游跳过 WAF，无人机验证）", () => {
  assert.deepStrictEqual(NEWAPI._wafCookieNames({ provider: "agentrouter" }), []);
});
test("_wafCookieNames：custom/通用 newapi 维持通用默认 acw_tc,acw_sc__v2（零回归）", () => {
  assert.deepStrictEqual(NEWAPI._wafCookieNames({ provider: "custom" }), ["acw_tc", "acw_sc__v2"]);
  assert.deepStrictEqual(NEWAPI._wafCookieNames({}), ["acw_tc", "acw_sc__v2"]);
});
test("_wafCookieNames：显式 waf_cookie_names 覆盖 provider 默认", () => {
  assert.deepStrictEqual(
    NEWAPI._wafCookieNames({ provider: "anyrouter", waf_cookie_names: "a, b，c" }),
    ["a", "b", "c"],
  );
});

// ── WAF 绕过预检：agentrouter 无 WAF → 不阻断；anyrouter 缺失 → 报错 ────
test("_assertWafCookies：agentrouter + waf_cookies + Cookie 无 acw_tc → 不抛（对齐上游跳过 WAF）", () => {
  assert.doesNotThrow(() =>
    NEWAPI._assertWafCookies({ provider: "agentrouter", bypass_method: "waf_cookies", cookie: "session=abc" }),
  );
});
test("_assertWafCookies：anyrouter + waf_cookies + Cookie 缺 acw_sc__v2 → 抛明确错误", () => {
  assert.throws(
    () => NEWAPI._assertWafCookies({ provider: "anyrouter", bypass_method: "waf_cookies", cookie: "acw_tc=1; cdn_sec_tc=2" }),
    /WAF 绕过校验失败/,
  );
});
test("_assertWafCookies：anyrouter + waf_cookies + Cookie 齐全 → 不抛", () => {
  assert.doesNotThrow(() =>
    NEWAPI._assertWafCookies({ provider: "anyrouter", bypass_method: "waf_cookies", cookie: "acw_tc=1; cdn_sec_tc=2; acw_sc__v2=3" }),
  );
});
test("_assertWafCookies：默认（bypass 关闭）任意 provider 不校验（零回归）", () => {
  assert.doesNotThrow(() => NEWAPI._assertWafCookies({ provider: "anyrouter", cookie: "session=x" }));
});

// ── base_url 推导 / provider 反推（_normalize，对齐上游 ProviderConfig 内置地址）──
test("_normalize：anyrouter 缺 base_url → anyrouter.top；agentrouter → agentrouter.org", () => {
  assert.strictEqual(NEWAPI._normalize({ provider: "anyrouter" }).base_url, "https://anyrouter.top");
  assert.strictEqual(NEWAPI._normalize({ provider: "agentrouter" }).base_url, "https://agentrouter.org");
});
test("_normalize：无 provider 但 base_url 命中域名 → 反推 provider（旧账号兼容）", () => {
  assert.strictEqual(NEWAPI._normalize({ base_url: "https://agentrouter.org" }).provider, "agentrouter");
  assert.strictEqual(NEWAPI._normalize({ base_url: "https://anyrouter.top" }).provider, "anyrouter");
});
test("_normalize：custom + 自填 base_url → 原样保留，不推导（通用 newapi 零回归）", () => {
  const n = NEWAPI._normalize({ provider: "custom", base_url: "https://my.example.com" });
  assert.strictEqual(n.base_url, "https://my.example.com");
  assert.strictEqual(n.provider, "custom");
});

// ── 签到路径：agentrouter 自动签到；anyrouter/custom 显式 sign_in ─────
test("_paths：agentrouter 默认 signIn=null（自动签到，对齐上游 sign_in_path=None）", () => {
  assert.strictEqual(NEWAPI._paths({ provider: "agentrouter" }).signIn, null);
});
test("_paths：anyrouter 默认 signIn=/api/user/sign_in（对齐上游 checkin_url）", () => {
  assert.strictEqual(NEWAPI._paths({ provider: "anyrouter" }).signIn, "/api/user/sign_in");
});
test("_paths：custom 默认 signIn=/api/user/sign_in（通用 newapi 零回归）", () => {
  assert.strictEqual(NEWAPI._paths({ provider: "custom" }).signIn, "/api/user/sign_in");
});
test("_paths：__auto__ 哨兵 → signIn=null（任意 provider）", () => {
  assert.strictEqual(NEWAPI._paths({ provider: "custom", sign_in_path: "__auto__" }).signIn, null);
});
test("_paths：显式 sign_in_path 覆盖（agentrouter 也可强制走接口）", () => {
  assert.strictEqual(NEWAPI._paths({ provider: "agentrouter", sign_in_path: "/x/sign" }).signIn, "/x/sign");
});
test("_paths：login/userInfo 默认对齐上游（/api/user/login、/api/user/self）", () => {
  const p = NEWAPI._paths({ provider: "anyrouter" });
  assert.strictEqual(p.login, "/api/user/login");
  assert.strictEqual(p.userInfo, "/api/user/self");
});

// ── 2.0.1 共存：new-api-user 头（api_user 存在时带上）不回归 ───────────
test("_headers：token 认证带 apiUser → 注入 new-api-user 头（2.0.1，不回归）", () => {
  const h = NEWAPI._headers({ type: "token", token: "T", apiUser: "12345", apiUserKey: "new-api-user" });
  assert.strictEqual(h.Authorization, "Bearer T");
  assert.strictEqual(h["new-api-user"], "12345");
});
test("_headers：token 无 apiUser → 不注入 new-api-user 头", () => {
  const h = NEWAPI._headers({ type: "token", token: "T" });
  assert.strictEqual(h.Authorization, "Bearer T");
  assert.ok(!("new-api-user" in h));
});
test("_headers：自定义 apiUserKey 覆盖头名（对齐上游 api_user_key）", () => {
  const h = NEWAPI._headers({ type: "token", token: "T", apiUser: "9", apiUserKey: "X-Api-User" });
  assert.strictEqual(h["X-Api-User"], "9");
});

// ── isConfigured：两平台各认证方式仍可用（不回归）────────────────────
test("isConfigured：agentrouter 邮箱密码 / anyrouter Cookie / 访问令牌均判已配置", () => {
  assert.ok(NEWAPI.isConfigured({ provider: "agentrouter", username: "a@b.com", password: "pw123456" }));
  assert.ok(NEWAPI.isConfigured({ provider: "anyrouter", cookie: "session=abc" }));
  assert.ok(NEWAPI.isConfigured({ provider: "custom", base_url: "https://x", access_token: "tok" }));
  assert.ok(!NEWAPI.isConfigured({ provider: "anyrouter" }));
});

console.log(`\n通过 ${passed} 项断言。`);
