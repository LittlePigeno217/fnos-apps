"use strict";
// p115assistant 1.4.5「strm_base_url 支持完整 URL（https 反代/自定义端口/网关子路径）」验收单测。
// 用法：node --test scripts/apps/p115assistant/strm.playmode145.test.js

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SERVER_PATH = path.join(__dirname, "../../../apps/p115assistant/fnos/app/server/server.js");
const STORE_PATH = path.join(__dirname, "../../../apps/p115assistant/fnos/app/server/store.js");
const { Server } = require(SERVER_PATH);
const { Store } = require(STORE_PATH);

function makeServer(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p115-145-test-"));
  const store = new Store(dir);
  store.updateConfig({ ...overrides });
  const srv = new Server(store);
  return srv;
}

// 直接调用 Server._resolveStrmBaseUrl()。
function resolve(strm_base_url, relay_port) {
  const srv = makeServer({ strm_base_url: strm_base_url || "", ...(relay_port ? { relay_port } : {}) });
  return srv._resolveStrmBaseUrl();
}

test("1) 裸 host → http://host:3667（默认中继端口）", () => {
  assert.equal(resolve("10.10.10.3"), "http://10.10.10.3:3667");
});

test("2) https 完整 URL → 原样，不带 :3667", () => {
  assert.equal(resolve("https://nas.example.com"), "https://nas.example.com");
});

test("3) http + 自定义端口 → 保留 :8080", () => {
  assert.equal(resolve("http://nas.example.com:8080"), "http://nas.example.com:8080");
});

test("4) 带路径 → 原样保留（无尾斜杠）", () => {
  assert.equal(resolve("https://nas.example.com/p115"), "https://nas.example.com/p115");
  assert.equal(resolve("https://nas.example.com/p115/"), "https://nas.example.com/p115");
});

test("5) 非法 scheme ftp → 回退裸 host 逻辑", () => {
  // 回退到自动检测的 host（非 ftp 前缀），且端口为 relay 默认 3667。
  const v = resolve("ftp://x");
  assert.ok(v.startsWith("http://"), `实际: ${v}`);
  assert.ok(v.endsWith(":3667"), `实际: ${v}`);
});

test("6) 空/未配置 → 自动检测 host + :3667", () => {
  const v = resolve("");
  assert.ok(v.startsWith("http://"), `实际: ${v}`);
  assert.ok(v.endsWith(":3667"), `实际: ${v}`);
});

test("7) 前后空白被去除", () => {
  assert.equal(resolve("  https://nas.example.com/p115  "), "https://nas.example.com/p115");
  // 裸 host 也去除空白后按裸 host 处理
  const bare = resolve("  10.10.10.3  ");
  assert.equal(bare, "http://10.10.10.3:3667");
});

test("8) scheme 大小写 + 默认端口省略", () => {
  assert.equal(resolve("HTTPS://nas.example.com"), "https://nas.example.com");
  // 显式 http 默认端口 80 省略
  assert.equal(resolve("http://nas.example.com:80"), "http://nas.example.com");
});