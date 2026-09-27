"use strict";
/**
 * checkin 编辑账号「完全同步加载已保存配置」回归测试（2.0.6）。
 *
 * 背景：用户反馈「点击编辑时要完全同步该账号使用的配置进行加载」。2.0.5 仅修复了认证方式(auth)预选；
 *   本测试逐字段锁定「编辑弹窗渲染值 == 保存值」的数据契约，并回归「留空不覆盖」，防止任一已保存配置项
 *   在编辑弹窗被漏填 / 被默认值顶替 / 保存时被空串抹掉。
 *
 * 覆盖：
 *   1. 数据源完整性：Server.accountsList 的 field_values + field_masks + auth 覆盖 NEWAPI.fields 全集
 *      （非敏感字段明文回显、敏感字段脱敏 mask、auth 显式暴露），不漏任一字段。
 *   2. 渲染回填：复刻前端 accountEditEl.renderField 取值链，断言每字段渲染值 == 保存值
 *      （敏感字段 → 「已配置」badge）；高级项存在 → 折叠区默认展开(advOpen)。
 *   3. 留空不覆盖：编辑弹窗把某字段留空 → 送空串 → store.saveConfig 保留原值（不抹掉已存配置）。
 *
 * 运行（零依赖，仅 node 内置 assert）：
 *   node scripts/apps/checkin/editor.roundtrip.test.js
 *
 * 说明：置于 scripts/ 下，不进 runtime-manifest 与 app.tgz，不下发真机。敏感值仅在内存断言存在性/脱敏，
 *       不打印明文。
 */
const assert = require("assert");
const os = require("os");
const fs = require("fs");
const path = require("path");

const BASE = path.join(__dirname, "../../../apps/checkin/fnos/app/server");
const { Store } = require(path.join(BASE, "store.js"));
const { Server, ADAPTERS } = require(path.join(BASE, "server.js"));
const { NEWAPI } = require(path.join(BASE, "sites.js"));

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }

// 全量配置的 newapi 账号（每个 NEWAPI.fields 键 + auth + remark + enabled 均有值）。
// 敏感值仅用于校验「有值→mask」，测试内不打印明文。
const FULL = {
  id: "a1", enabled: true, remark: "主号", auth: "cookie",
  provider: "custom", base_url: "https://custom.example.com",
  cookie: "sess=abc123def456", api_user: "42",
  access_token: "tok_xyz_secret", username: "user@example.com",
  password: "p@ssw0rd", totp: "JBSWY3DPEHPK3PXP",
  sign_in_path: "/api/user/sign_in", delta_ok: "off", use_proxy: "on",
  domain: "https://adv.example.com", login_path: "/api/user/login",
  user_info_path: "/api/user/self", api_user_key: "new-api-user",
  bypass_method: "waf_cookies", waf_cookie_names: "acw_tc,cdn_sec_tc",
};

function withServer(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ck-edit-"));
  try {
    const store = new Store(dir);
    const server = new Server(store, null, () => {});
    return fn(store, server);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// PLACEHOLDER_APPEND

// 复刻前端 accountEditEl.renderField 取值链（index.html）——纯逻辑，无 DOM 依赖。
//   secret(password) → 只判「已配置」；select/text → 解析回填值。acc=SITE_DATA hit（仅 id/enabled/remark）。
function resolveRender(f, vals, masks, acc) {
  if (f.type === "password") return { kind: "secret", configured: !!masks[f.key] };
  if (f.type === "select") {
    let val = (vals[f.key] != null && vals[f.key] !== "") ? vals[f.key]
      : (acc[f.key] != null && acc[f.key] !== "") ? acc[f.key]
      : (f.key === "provider" && (vals.base_url || acc.base_url)) ? "custom"
      : (f.options && f.options[0] ? f.options[0].value : "");
    return { kind: "select", value: val || "" };
  }
  const val = vals[f.key] != null ? vals[f.key] : (acc[f.key] || "");
  return { kind: "text", value: val };
}
// 复刻 accountEditEl 的 advOpen 计算（高级项有值 → 折叠区默认展开）。
function computeAdvOpen(fields, vals, masks) {
  return fields.some((f) => f.group === "advanced" && (
    (vals[f.key] != null && vals[f.key] !== "") || !!masks[f.key]));
}

console.log("checkin 编辑账号完全同步加载 回归测试：");

withServer((store, server) => {
  store.saveConfig({ sites: { newapi: { enabled: true, use_proxy: false, accounts: [FULL] } } });
  const res = server.accountsList();
  assert.ok(res && res.success, "accountsList 应成功");
  const accs = res.data.sites.newapi.accounts;
  const detail = accs.find((a) => a.id === "a1");
  assert.ok(detail, "应能取到 a1 明细");
  const vals = detail.field_values || {};
  const masks = detail.field_masks || {};
  const acc = { id: "a1", enabled: true, remark: "主号" }; // SITE_DATA hit（不含字段值）

  // 1. 数据源完整性 + 2. 渲染回填：逐字段核对。
  const report = [];
  for (const f of NEWAPI.fields) {
    const r = resolveRender(f, vals, masks, acc);
    if (f.type === "password") {
      assert.ok(masks[f.key], `字段 ${f.key}（敏感）应出现在 field_masks（已配置）`);
      assert.strictEqual(r.configured, true, `字段 ${f.key} 编辑应显示「已配置」badge`);
      report.push(`  ${f.key.padEnd(18)} secret  masks:是  渲染:已配置✓`);
    } else {
      assert.ok(Object.prototype.hasOwnProperty.call(vals, f.key),
        `字段 ${f.key}（非敏感）应出现在 field_values`);
      assert.strictEqual(String(r.value), String(FULL[f.key]),
        `字段 ${f.key} 渲染值应 == 保存值`);
      report.push(`  ${f.key.padEnd(18)} ${String(f.type).padEnd(6)}  field_values  渲染:${r.value}✓`);
    }
  }
  // auth 显式暴露（编辑据此预选认证 tab）。
  assert.strictEqual(detail.auth, "cookie", "auth 应显式暴露为 cookie");
  // remark / enabled 回填。
  assert.strictEqual(detail.remark, "主号", "remark 应回填");
  assert.strictEqual(detail.enabled, true, "enabled 应回填");
  test("逐字段回填：NEWAPI.fields 全集 → 编辑弹窗渲染值 == 保存值（含 auth/remark/enabled）", () => {});
  console.log(report.join("\n"));

  // 3. 高级项存在 → 折叠区默认展开。
  test("高级项已配置 → advOpen=true（编辑弹窗默认展开高级折叠区，避免已存配置被隐藏）", () => {
    assert.strictEqual(computeAdvOpen(NEWAPI.fields, vals, masks), true);
  });
});

// 4. 留空不覆盖：编辑时把全部字段留空（送空串）+ 不带 auth → store 保留原值，不抹掉已存配置。
withServer((store, server) => {
  store.saveConfig({ sites: { newapi: { enabled: true, use_proxy: false, accounts: [FULL] } } });
  // 模拟「编辑弹窗留空提交」：collectModalAccounts 对所有字段送空串，remark 沿用、enabled 沿用、无 auth。
  const blanked = { id: "a1", enabled: true, remark: "主号" };
  for (const f of NEWAPI.fields) blanked[f.key] = "";
  store.saveConfig({ sites: { newapi: { enabled: true, use_proxy: false, accounts: [blanked] } } });
  const saved = store.getConfig().sites.newapi.accounts.find((a) => a.id === "a1");
  test("留空不覆盖：编辑弹窗留空提交 → 所有已存字段 + auth 保持原值（不被空串抹掉）", () => {
    for (const f of NEWAPI.fields) {
      assert.strictEqual(String(saved[f.key] || ""), String(FULL[f.key]),
        `字段 ${f.key} 留空提交后应保留原值`);
    }
    assert.strictEqual(saved.auth, "cookie", "auth 未带应保留原值 cookie");
  });
});

console.log(`\n全部 ${passed} 个用例通过。`);

