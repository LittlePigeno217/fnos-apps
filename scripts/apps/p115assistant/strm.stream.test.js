"use strict";
// p115assistant 1.4.1「STRM 播放 403 根治（本地流代理）」验收单测（零依赖，node --test）。
//
// 覆盖：
//   1) streamProxy 完整 GET（无 Range）两次 → 每次都强制取新直链（取链次数 = 请求次数）
//   2) streamProxy Range 请求 → 复用缓存直链（连续 Range 只取链 1 次）
//   3) streamProxy HEAD → 复用缓存直链（不强制新链）
//   4) 验签失败 → 403（与 redirectTarget 同一签名校验）
//   5) 缺参（无 pickcode/sign）→ 400
//   6) 取链失败 → 502
//   7) 115 转发透传 Range（_proxyHttpRequest 传入 rangeHeader）
//
// 用法：node --test scripts/apps/p115assistant/strm.stream.test.js

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SERVER_PATH = path.join(__dirname, "../../../apps/p115assistant/fnos/app/server/server.js");
const STORE_PATH = path.join(__dirname, "../../../apps/p115assistant/fnos/app/server/store.js");
const { Server } = require(SERVER_PATH);
const { Store } = require(STORE_PATH);

function makeApi(fetchImpl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p115-stream-test-"));
  const store = new Store(dir);
  const api = new Server(store);
  // 接管取链（每次调用计数；默认返回递增直链）
  let n = 0;
  api._fetchRedirectUrlWithRetry = async () => {
    n += 1;
    return fetchImpl ? fetchImpl(n) : `https://cdnfhnfile.115cdn.net/fake/file-${n}.mp4?t=9999999999`;
  };
  api._fetchCount = () => n;
  // 生成有效签名（直接用 server 的签名实现，避免算法漂移）
  api._makeSign = (pc, expires) => api.buildRedirectSignature(pc, expires);
  return api;
}

test("1) 完整 GET 两次 → 每次强制新直链，均 200", async () => {
  const api = makeApi();
  const pc = "pk-full-get";
  const expires = String(Math.floor(Date.now() / 1000) + 3600);
  const sign = api._makeSign(pc, expires);
  // mock 115 转发：记录收到的 Range，返回 200
  const seenRanges = [];
  api._proxyHttpRequest = async (url, rangeHeader) => {
    seenRanges.push(String(rangeHeader || ""));
    return { statusCode: 200, headers: { "content-type": "video/mp4", "content-length": "1000" }, pipe: () => {} };
  };
  const r1 = await api.streamProxy(pc, sign, "a.mp4", "VLC/3.0.20", expires, "", false);
  const r2 = await api.streamProxy(pc, sign, "a.mp4", "VLC/3.0.20", expires, "", false);
  assert.equal(r1.code, 200);
  assert.equal(r2.code, 200);
  assert.equal(api._fetchCount(), 2, "完整 GET 每次都应强制新直链（取链 2 次）");
  assert.deepEqual(seenRanges, ["", ""], "完整 GET 不透传 Range");
});

test("2) Range 连续请求 → 复用缓存直链（只取链 1 次）", async () => {
  const api = makeApi();
  const pc = "pk-range";
  const expires = String(Math.floor(Date.now() / 1000) + 3600);
  const sign = api._makeSign(pc, expires);
  const seenRanges = [];
  api._proxyHttpRequest = async (url, rangeHeader) => {
    seenRanges.push(String(rangeHeader || ""));
    return { statusCode: 206, headers: { "content-type": "video/mp4", "content-range": "bytes 0-1048575/10000000", "content-length": "1048576" }, pipe: () => {} };
  };
  await api.streamProxy(pc, sign, "a.mp4", "VLC/3.0.20", expires, "bytes=0-1048575", false);
  const r2 = await api.streamProxy(pc, sign, "a.mp4", "VLC/3.0.20", expires, "bytes=1048576-2097151", false);
  assert.equal(r2.code, 200);
  assert.equal(r2.status, 206);
  assert.equal(api._fetchCount(), 1, "Range 请求应复用缓存，只取链 1 次");
  assert.deepEqual(seenRanges, ["bytes=0-1048575", "bytes=1048576-2097151"], "Range 原样透传");
});

test("3) HEAD → 走缓存分支，不强制新链", async () => {
  const api = makeApi();
  const pc = "pk-head";
  const expires = String(Math.floor(Date.now() / 1000) + 3600);
  const sign = api._makeSign(pc, expires);
  api._proxyHttpRequest = async () => ({ statusCode: 200, headers: { "content-type": "video/mp4" }, pipe: () => {} });
  await api.streamProxy(pc, sign, "a.mp4", "VLC/3.0.20", expires, "", true);
  const r2 = await api.streamProxy(pc, sign, "a.mp4", "VLC/3.0.20", expires, "", true);
  assert.equal(r2.code, 200);
  assert.equal(api._fetchCount(), 1, "HEAD 复用缓存，不额外取链");
});

test("4) 验签失败 → 403", async () => {
  const api = makeApi();
  const r = await api.streamProxy("pk-bad", "deadbeef", "a.mp4", "VLC", "0", "", false);
  assert.equal(r.code, 403);
});

test("5) 缺参 → 400", async () => {
  const api = makeApi();
  const r = await api.streamProxy("", "", "a.mp4", "VLC", "", "", false);
  assert.equal(r.code, 400);
});

test("6) 取链失败 → 502", async () => {
  const api = makeApi();
  api._fetchRedirectUrlWithRetry = async () => { throw new Error("115 未返回"); };
  const pc = "pk-fail";
  const expires = String(Math.floor(Date.now() / 1000) + 3600);
  const sign = api._makeSign(pc, expires);
  const r = await api.streamProxy(pc, sign, "a.mp4", "VLC", expires, "", false);
  assert.equal(r.code, 502);
});
