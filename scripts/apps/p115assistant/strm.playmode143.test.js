"use strict";
// p115assistant 1.4.3「远程自动 redirect + 播放器 UA 不缓存直链」验收单测（node --test）。
//
// 覆盖：
//   1) isPrivateIp：内网/公网 IPv4、IPv6 判定
//   2) isLocalHostname：Host 域名（fnconnect 等）→ 远程；内网 IP/.local → 内网
//   3) _isPrivateSource：x-forwarded-for / x-real-ip / socket 兜底 + Host 域名优先判远程
//   4) redirectTarget：播放器 UA 不缓存（连续两次取链次数=2）；浏览器 UA 缓存（次数=1）
//
// 用法：node --test scripts/apps/p115assistant/strm.playmode143.test.js

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SERVER_PATH = path.join(__dirname, "../../../apps/p115assistant/fnos/app/server/server.js");
const STORE_PATH = path.join(__dirname, "../../../apps/p115assistant/fnos/app/server/store.js");
const MAIN_PATH = path.join(__dirname, "../../../apps/p115assistant/fnos/app/server/main.js");
const { Server, isPlayerUA } = require(SERVER_PATH);
const { Store } = require(STORE_PATH);
const { TrimHandler, isPrivateIp, isLocalHostname } = require(MAIN_PATH);

function makeApi() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p115-143-test-"));
  const store = new Store(dir);
  const api = new Server(store);
  let n = 0;
  api._fetchRedirectUrlWithRetry = async () => {
    n += 1;
    return `https://cdnfhnfile.115cdn.net/fake-${n}.mp4?t=9999999999`;
  };
  api._fetchCount = () => n;
  api._makeSign = (pc, expires) => api.buildRedirectSignature(pc, expires);
  return api;
}

test("1) isPrivateIp 内网/公网判定", () => {
  assert.equal(isPrivateIp("10.10.10.3"), true);
  assert.equal(isPrivateIp("192.168.1.5"), true);
  assert.equal(isPrivateIp("172.16.0.1"), true);
  assert.equal(isPrivateIp("172.31.255.255"), true);
  assert.equal(isPrivateIp("127.0.0.1"), true);
  assert.equal(isPrivateIp("169.254.1.1"), true);
  assert.equal(isPrivateIp("::1"), true);
  assert.equal(isPrivateIp("fc00::1"), true);
  assert.equal(isPrivateIp("fe80::1"), true);
  assert.equal(isPrivateIp("8.8.8.8"), false);
  assert.equal(isPrivateIp("114.114.114.114"), false);
  assert.equal(isPrivateIp("172.32.0.1"), false);
  assert.equal(isPrivateIp("2408:8256::1"), false);
});

test("2) isLocalHostname 域名判定", () => {
  assert.equal(isLocalHostname("10.10.10.3:3667"), true);
  assert.equal(isLocalHostname("192.168.1.5"), true);
  assert.equal(isLocalHostname("nas.local:3667"), true);
  assert.equal(isLocalHostname("nas.lan"), true);
  assert.equal(isLocalHostname("fnconnect.xxx.com"), false);
  assert.equal(isLocalHostname("my-nas.example.org:3667"), false);
  assert.equal(isLocalHostname("8.8.8.8:3667"), false);
});

test("3) _isPrivateSource 综合判定（Host 域名优先远程）", () => {
  // 内网来源（x-forwarded-for 内网 + Host 内网 IP）→ private
  const h1 = new TrimHandler({ api: {} }, {}, {});
  assert.equal(h1._isPrivateSource({ "x-forwarded-for": "10.10.10.66", host: "10.10.10.3:3667" }), true);
  // 远程 Host（fnconnect 域名）即使 x-forwarded-for 内网/fnconnect 中继 → 远程
  assert.equal(h1._isPrivateSource({ "x-forwarded-for": "172.16.0.1", host: "fnconnect.xxx.com" }), false);
  // 公网来源 IP → 远程
  assert.equal(h1._isPrivateSource({ "x-forwarded-for": "8.8.8.8", host: "10.10.10.3:3667" }), false);
  // x-real-ip 兜底
  assert.equal(h1._isPrivateSource({ "x-real-ip": "10.10.10.66", host: "10.10.10.3:3667" }), true);
  assert.equal(h1._isPrivateSource({ "x-real-ip": "114.114.114.114", host: "10.10.10.3:3667" }), false);
  // 无任何来源信息 → 保守内网
  assert.equal(h1._isPrivateSource({}), true);
});

test("4) 播放器 UA 不缓存直链（取链 2 次）", async () => {
  const api = makeApi();
  const pc = "pk-player";
  const expires = String(Math.floor(Date.now() / 1000) + 3600);
  const sign = api._makeSign(pc, expires);
  const r1 = await api.redirectTarget(pc, sign, "a.mp4", "VLC/3.0.20 LibVLC/3.0.20", expires);
  const r2 = await api.redirectTarget(pc, sign, "a.mp4", "VLC/3.0.20 LibVLC/3.0.20", expires);
  assert.equal(r1.code, 302);
  assert.equal(r2.code, 302);
  assert.equal(api._fetchCount(), 2, "播放器 UA 每次取新链（不缓存）");
  assert.notEqual(r1.url, r2.url, "两次直链应不同（新取链）");
});

test("5) 浏览器 UA 缓存直链（取链 1 次）", async () => {
  const api = makeApi();
  const pc = "pk-browser";
  const expires = String(Math.floor(Date.now() / 1000) + 3600);
  const sign = api._makeSign(pc, expires);
  const r1 = await api.redirectTarget(pc, sign, "a.mp4", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0", expires);
  const r2 = await api.redirectTarget(pc, sign, "a.mp4", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0", expires);
  assert.equal(r1.code, 302);
  assert.equal(r2.code, 302);
  assert.equal(api._fetchCount(), 1, "浏览器 UA 命中缓存（只取链 1 次）");
  assert.equal(r1.url, r2.url);
});

test("6) isPlayerUA 判定", () => {
  assert.equal(isPlayerUA("VLC/3.0.20 LibVLC/3.0.20"), true);
  assert.equal(isPlayerUA("Lavf60.16.100"), true);
  assert.equal(isPlayerUA("ExoPlayer/2.18.5 (Linux; Android 14)"), true);
  assert.equal(isPlayerUA("okhttp/4.12.0"), true);
  assert.equal(isPlayerUA("Mozilla/5.0 Chrome/120.0"), false);
  assert.equal(isPlayerUA("curl/8.0"), false);
  assert.equal(isPlayerUA(""), false);
});