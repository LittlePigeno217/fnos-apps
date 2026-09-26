"use strict";
/**
 * checkin 配置迁移回归测试（anyrouter → newapi 单站点合并「不吞账号」）。
 *
 * 背景：1.9.0 热更后发生 newapi 账号丢失事故（现场：sites.newapi.accounts 变空数组，
 *       newapi 原 a1/a2 + anyrouter a1 全部丢失）。本测试锁定迁移层不变量，防回归。
 *
 * 运行（零依赖，仅用 node 内置 assert）：
 *   node scripts/apps/checkin/store.migration.test.js
 *
 * 说明：本文件置于 scripts/ 下，不进入 runtime-manifest（server/*.js 自动发现）
 *       与 app.tgz（server/ 目录整体打包），不会随热更/安装包下发到真机。
 */
const assert = require("assert");
const os = require("os");
const fs = require("fs");
const path = require("path");

const STORE_PATH = path.join(__dirname, "../../../apps/checkin/fnos/app/server/store.js");
const { Store } = require(STORE_PATH);

// 迁移在构造函数 _load()→_mergeDefaults() 内完成：写入临时 config → new Store → 读 _cfg。
function migrate(rawConfig) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ck-mig-"));
  try {
    fs.writeFileSync(path.join(dir, "checkin_config.json"), JSON.stringify(rawConfig));
    const store = new Store(dir);
    // 深拷贝返回，隔离临时目录清理
    return JSON.parse(JSON.stringify(store._cfg));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function accIds(cfg) {
  return (cfg.sites.newapi.accounts || []).map((a) => a.id);
}
function accUsers(cfg) {
  // 归一后 anyrouter 的 email→username；用于「凭据未丢」断言（不输出敏感值本身，仅比较存在性）
  return (cfg.sites.newapi.accounts || []).map((a) => String(a.username || ""));
}

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log("checkin 迁移回归测试：");

// ── 用例 1：迁移不吞账号（并集 = newapi 原账号 + anyrouter 账号）─────────────
test("迁移=并集：newapi(2) + anyrouter(1) → newapi(3)，原账号全在、anyrouter 并入", () => {
  const cfg = migrate({
    sites: {
      newapi: {
        enabled: true,
        accounts: [
          { id: "a1", base_url: "https://n1.example", username: "user_n1", password: "p1" },
          { id: "a2", base_url: "https://n2.example", username: "user_n2", password: "p2" },
        ],
      },
      anyrouter: {
        enabled: true,
        accounts: [{ id: "a1", provider: "anyrouter", email: "user_any", password: "p3" }],
      },
    },
  });
  assert.deepStrictEqual(Object.keys(cfg.sites).includes("anyrouter"), false, "anyrouter 键应被移除");
  const users = accUsers(cfg);
  assert.strictEqual(cfg.sites.newapi.accounts.length, 3, "应为 3 个账号（2 newapi + 1 anyrouter）");
  assert.ok(users.includes("user_n1"), "newapi 原账号 user_n1 不得丢失");
  assert.ok(users.includes("user_n2"), "newapi 原账号 user_n2 不得丢失");
  assert.ok(users.includes("user_any"), "anyrouter 账号（email→username 归一）应并入");
  // id 冲突处理：anyrouter 原 id=a1 与 newapi a1 撞车 → 重分配，不覆盖 newapi a1
  const ids = accIds(cfg);
  assert.strictEqual(new Set(ids).size, ids.length, "id 必须站内唯一（撞车重分配，不覆盖 newapi 侧）");
  assert.ok(ids.includes("a1") && ids.includes("a2"), "newapi 原 id a1/a2 保留");
});

// ── 用例 2：幂等（二次迁移不重复、不丢）───────────────────────────────────
test("幂等：对已迁移结果再次迁移 → 账号数/凭据不变，无重复插入", () => {
  const first = migrate({
    sites: {
      newapi: { enabled: true, accounts: [{ id: "a1", base_url: "https://n1.example", username: "user_n1", password: "p1" }] },
      anyrouter: { enabled: true, accounts: [{ id: "a1", provider: "anyrouter", email: "user_any", password: "p3" }] },
    },
  });
  assert.strictEqual(first.sites.newapi.accounts.length, 2, "首次迁移应为 2 个账号");
  const second = migrate(first); // 已无 anyrouter 键，newapi 为多账号数组
  assert.strictEqual(second.sites.newapi.accounts.length, 2, "二次迁移账号数不得变化（不重复不丢）");
  assert.deepStrictEqual(accUsers(second).sort(), accUsers(first).sort(), "二次迁移凭据集合不变");
});

// ── 用例 3：空 anyrouter → newapi 原样（不误删、不清空）────────────────────
test("空 anyrouter：newapi 原账号原样保留", () => {
  const cfg = migrate({
    sites: {
      newapi: { enabled: true, accounts: [{ id: "a1", base_url: "https://n1.example", username: "user_n1" }, { id: "a2", base_url: "https://n2.example", username: "user_n2" }] },
      anyrouter: { enabled: false, accounts: [] },
    },
  });
  assert.strictEqual(cfg.sites.newapi.accounts.length, 2, "无 anyrouter 账号时 newapi 保持 2 个");
  assert.deepStrictEqual(accIds(cfg).sort(), ["a1", "a2"]);
});

// ── 用例 4：吞账号根因回归——空 accounts 数组 + 顶层 legacy 凭据 ──────────────
// 修复前 _collectSiteAccounts 对 `accounts: []`（空数组）直接 return []，会遮蔽同存的
// 顶层旧版 newapi 单账号凭据 → 该账号被静默丢弃（吞账号）。修复后空数组回落顶层扫描。
test("空 accounts 数组不得遮蔽顶层 legacy：newapi 顶层单账号 + anyrouter → 2 个", () => {
  const cfg = migrate({
    sites: {
      newapi: { enabled: true, accounts: [], base_url: "https://legacy.example", username: "user_legacy", password: "p1" },
      anyrouter: { enabled: true, accounts: [{ id: "a1", provider: "anyrouter", email: "user_any" }] },
    },
  });
  const users = accUsers(cfg);
  assert.strictEqual(cfg.sites.newapi.accounts.length, 2, "顶层 legacy newapi 账号不得被空数组吞掉");
  assert.ok(users.includes("user_legacy"), "newapi 顶层 legacy 账号必须被收集");
  assert.ok(users.includes("user_any"), "anyrouter 账号应并入");
});

console.log(`\n全部通过：${passed} 个用例。`);
