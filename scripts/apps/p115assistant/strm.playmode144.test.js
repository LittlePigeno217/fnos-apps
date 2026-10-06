"use strict";
// p115assistant 1.4.4「stream 302 改指 HTTP 中继（3667，服务端 ffmpeg 无自签问题）」验收单测。
// 用法：node --test scripts/apps/p115assistant/strm.playmode144.test.js

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SERVER_PATH = path.join(__dirname, "../../../apps/p115assistant/fnos/app/server/server.js");
const STORE_PATH = path.join(__dirname, "../../../apps/p115assistant/fnos/app/server/store.js");
const MAIN_PATH = path.join(__dirname, "../../../apps/p115assistant/fnos/app/server/main.js");
const { Server } = require(SERVER_PATH);
const { Store } = require(STORE_PATH);
const { TrimHandler } = require(MAIN_PATH);

function makeHandler(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p115-144-test-"));
  const store = new Store(dir);
  store.updateConfig({ ...overrides });
  const api = new Server(store);
  api.redirectTarget = async () => ({ code: 302, url: "https://cdnfhnfile.115cdn.net/fake.mp4?t=1" });
  const req = { socket: { remoteAddress: "127.0.0.1" } };
  const res = { writeHead: () => {}, end: () => {} };
  const h = new TrimHandler({ api }, req, res);
  return h;
}

function mockRes() {
  const captured = {};
  const res = {
    writeHead(status, reason, headers) {
      captured.status = status;
      captured.reason = reason;
      captured.headers = headers || {};
    },
    end(body) {
      captured.body = body;
    },
  };
  return { res, captured };
}

async function runRedirect(h, headers) {
  const { res, captured } = mockRes();
  h.res = res;
  await h._handleRedirect(
    new URL("http://x/api/v1/plugin/P115LiteAssistant/redirect?pickcode=pc&sign=zz&file_name=a.mp4&expires=1"),
    headers,
    "GET"
  );
  return captured;
}

test("1) 内网来源 + stream → Location 为 http 中继（非 https 3668）", async () => {
  const h = makeHandler({ strm_play_mode: "stream" });
  const c = await runRedirect(h, { host: "10.10.10.3:3667", "x-forwarded-for": "10.10.10.66" });
  assert.equal(c.status, 302);
  assert.ok(String(c.headers.Location).startsWith("http://10.10.10.3:3667/api/v1/plugin/P115LiteAssistant/stream?"), `实际: ${c.headers.Location}`);
  assert.ok(!String(c.headers.Location).includes(":3668"), "不应再指向 https 3668");
  assert.ok(String(c.headers.Location).includes("pickcode=pc"), "验签参数原样透传");
});

test("2) 远程来源（fnconnect 域名）+ stream → 自动退回 redirect（115 CDN）", async () => {
  const h = makeHandler({ strm_play_mode: "stream" });
  const c = await runRedirect(h, { host: "fnconnect.xxx.com", "x-forwarded-for": "172.16.0.1" });
  assert.equal(c.status, 302);
  assert.ok(String(c.headers.Location).startsWith("https://cdnfhnfile.115cdn.net/"), `实际: ${c.headers.Location}`);
});

test("3) relay_port 自定义生效", async () => {
  const h = makeHandler({ strm_play_mode: "stream", relay_port: 3999 });
  const c = await runRedirect(h, { host: "10.10.10.3:3999", "x-forwarded-for": "10.10.10.66" });
  assert.ok(String(c.headers.Location).startsWith("http://10.10.10.3:3999/"), `实际: ${c.headers.Location}`);
});

test("4) redirect 模式不变（内网也走 CDN 直链）", async () => {
  const h = makeHandler({ strm_play_mode: "redirect" });
  const c = await runRedirect(h, { host: "10.10.10.3:3667", "x-forwarded-for": "10.10.10.66" });
  assert.equal(c.status, 302);
  assert.ok(String(c.headers.Location).startsWith("https://cdnfhnfile.115cdn.net/"), `实际: ${c.headers.Location}`);
});