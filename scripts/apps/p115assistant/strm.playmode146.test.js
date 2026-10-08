"use strict";
// p115assistant 1.4.6「strm 播放回退至 1.3.9」验收单测。
// 覆盖：
//   1) redirect 302 = 115 CDN 直链（无 stream 分支/无远程判定）
//   2) 播放器 UA 与浏览器 UA 都走缓存（回退后无 UA 豁免——两次请求仅取链 1 次）
//   3) _resolveStrmBaseUrl 仅裸 host 形态（完整 URL 支持已回退）
//   4) 中转端口不再放行 /stream 路径（仅 redirect）

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
const { TrimHandler, createRedirectServer } = require(MAIN_PATH);

function makeApi() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p115-146-test-"));
  const store = new Store(dir);
  const api = new Server(store);
  let takes = 0;
  api._fetchRedirectUrlWithRetry = async () => { takes += 1; return "https://cdnfhnfile.115cdn.net/movie.mp4?t=999"; };
  api._takeCount = () => takes;
  return api;
}

function mockRes() {
  const captured = {};
  return {
    res: {
      writeHead(status, reason, headers) { captured.status = status; captured.headers = headers || {}; },
      end(body) { captured.body = body; },
    },
    captured,
  };
}

async function callRedirect(api, headers, method = "GET", opts = {}) {
  const sign = opts.sign || api.buildRedirectSignature("pk1", opts.expires || "1");
  const expires = opts.expires || "1";
  const req = { socket: { remoteAddress: "127.0.0.1" } };
  const { res, captured } = mockRes();
  const h = new TrimHandler({ api }, req, res);
  await h._handleRedirect(
    new URL(`http://x/api/v1/plugin/P115LiteAssistant/redirect?pickcode=pk1&sign=${encodeURIComponent(sign)}&file_name=a.mp4&expires=${expires}`),
    headers, method
  );
  return captured;
}

test("1) 302 Location 恒为 115 CDN 直链（无 stream/远程判定）", async () => {
  const api = makeApi();
  const expires = String(Math.floor(Date.now() / 1000) + 3600);
  const sign = api.buildRedirectSignature("pk1", expires);
  const c = await callRedirect(api, { host: "10.10.10.3:3667", "x-forwarded-for": "10.10.10.66" }, "GET", { sign, expires });
  assert.equal(c.status, 302);
  assert.ok(c.headers.Location.startsWith("https://cdnfhnfile.115cdn.net/"), c.headers.Location);
  assert.ok(!c.headers.Location.includes("p115assistant/stream"), "不应出现 stream 路径");
});

test("2) 播放器 UA 也走缓存（回退：无 UA 豁免，两次请求仅取链 1 次）", async () => {
  const api = makeApi();
  const expires = String(Math.floor(Date.now() / 1000) + 3600);
  const sign = api.buildRedirectSignature("pk1", expires);
  const hdrs = { host: "10.10.10.3:3667", "user-agent": "VLC/3.0.20 LibVLC/3.0.20" };
  const r1 = await callRedirect(api, hdrs, "GET", { sign, expires });
  const r2 = await callRedirect(api, hdrs, "GET", { sign, expires });
  assert.equal(r1.status, 302); assert.equal(r2.status, 302);
  assert.equal(api._takeCount(), 1, "1.4.6 回退：播放器 UA 不再每次取新链");
  assert.equal(r1.headers.Location, r2.headers.Location);
});

test("3) 浏览器 UA 缓存不变", async () => {
  const api = makeApi();
  const expires = String(Math.floor(Date.now() / 1000) + 3600);
  const sign = api.buildRedirectSignature("pk1", expires);
  const hdrs = { host: "10.10.10.3:3667", "user-agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/120.0" };
  const r1 = await callRedirect(api, hdrs, "GET", { sign, expires });
  const r2 = await callRedirect(api, hdrs, "GET", { sign, expires });
  assert.equal(api._takeCount(), 1);
  assert.equal(r1.headers.Location, r2.headers.Location);
});

test("4) _resolveStrmBaseUrl 与 1.3.9 一致（仅取 host，scheme 固定 http，端口用 relay_port）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p115-146b-test-"));
  const store = new Store(dir);
  store.updateConfig({ strm_base_url: "https://nas.example.com/p115", relay_port: 3677 });
  const api = new Server(store);
  const url = api._resolveStrmBaseUrl();
  assert.equal(url, "http://nas.example.com:3677", `1.3.9 语义：host 提取、scheme http、端口 3677——实际 ${url}`);
});

test("5) 中转端口不再放行 /stream 路径（仅 redirect）", () => {
  const api = makeApi();
  return new Promise((resolve) => {
    const server = createRedirectServer(api);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const http = require("node:http");
      const req = http.request({ host: "127.0.0.1", port, path: "/api/v1/plugin/P115LiteAssistant/stream", method: "GET", headers: { host: "127.0.0.1:" + port } }, (res) => {
        const buf = [];
        res.on("data", (d) => buf.push(d));
        res.on("end", () => {
          assert.equal(res.statusCode, 404, "孤立 /stream 应 404（白名单仅 redirect）");
          server.close(); resolve();
        });
      });
      req.end();
    });
  });
});