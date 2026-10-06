"use strict";
// p115assistant 1.4.2「STRM 播放模式开关 + stream 端点 https 化」验收单测（零依赖，node --test）。
//
// 覆盖：
//   1) 默认配置 strm_play_mode = redirect（等价 1.4.0，零回归保底）
//   2) redirect 模式：302 Location = 115 CDN 直链（result.url，https），且不指向本地 3668
//   3) stream 模式：302 Location = https://<host>:3668/.../api/v1/plugin/.../stream?<同参>
//   4) HEAD：两种模式下 302 Location 一致，body 为空
//   5) hostnameFromRelayHost 从 Host 头（含端口）正确提取裸主机名
//   6) HTTPS_STREAM_PORT = 3668
// 既有 streamProxy 6 用例由 strm.stream.test.js 保持（本文件对其零改动）。
//
// 用法：node --test scripts/apps/p115assistant/strm.playmode.test.js

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
const { TrimHandler, hostnameFromRelayHost, HTTPS_STREAM_PORT } = require(MAIN_PATH);

// 构造带 mock 302 取链的 handler；playMode 决定 strm_play_mode 配置，cdnUrl 为取链返回值。
function makeHandler(playMode, cdnUrl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p115-playmode-"));
  const store = new Store(dir);
  const api = new Server(store);
  if (playMode) store.updateConfig({ strm_play_mode: playMode });
  api.redirectTarget = async () => ({ code: 302, url: cdnUrl, file_name: "a.mp4" });
  const captured = { status: 0, reason: "", headers: {}, body: "" };
  const res = {
    writeHead(status, reason, headers) {
      captured.status = status;
      captured.reason = reason || "";
      captured.headers = Object.assign({}, headers || {});
    },
    end(body) { captured.body = String(body || ""); },
  };
  const req = { socket: { remoteAddress: "10.0.0.1" } };
  const handler = new TrimHandler({ api }, req, res);
  handler._capture = () => captured;
  return handler;
}

// 直接触发中转 _handleRedirect（302 取链已 stub，不走网络/115）。
function callRedirect(handler, hostHeader, method) {
  const parsed = new URL(
    "http://localhost/api/v1/plugin/P115LiteAssistant/redirect?pickcode=pk1&file_name=a.mp4&expires=9999999999&sign=abc"
  );
  const headers = { host: hostHeader, "user-agent": "VLC/3.0.20", "x-forwarded-for": "" };
  return handler._handleRedirect(parsed, headers, method || "GET").then(() => handler._capture());
}

test("1) 默认配置 strm_play_mode = redirect（等价 1.4.0）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p115-playmode-def-"));
  const store = new Store(dir);
  assert.equal(store.getConfig().strm_play_mode, "redirect");
});

test("2) redirect 模式：302 Location = 115 CDN 直链（https），不指向本地 3668", async () => {
  const cdn = "https://cdnfhnfile.115cdn.net/movie/movie.mp4?t=9999999999";
  const handler = makeHandler("redirect", cdn);
  const cap = await callRedirect(handler, "10.10.10.3:3667");
  assert.equal(cap.status, 302);
  assert.equal(cap.headers.Location, cdn, "redirect 模式 Location 应为 115 CDN 直链原文");
  assert.ok(cap.headers.Location.startsWith("https://cdnfhnfile.115cdn.net/"));
  assert.ok(!cap.headers.Location.includes(`:${HTTPS_STREAM_PORT}`), "redirect 模式不应指向本地 3668");
  const body = JSON.parse(cap.body);
  assert.equal(body.url, cdn);
});

test("3) stream 模式：302 Location = https://<host>:3668/.../stream?<同参>", async () => {
  const cdn = "https://cdnfhnfile.115cdn.net/movie/movie.mp4?t=9999999999";
  const handler = makeHandler("stream", cdn);
  const cap = await callRedirect(handler, "10.10.10.3:3667");
  assert.equal(cap.status, 302);
  const expectLocation =
    `https://10.10.10.3:${HTTPS_STREAM_PORT}/api/v1/plugin/P115LiteAssistant/stream` +
    "?pickcode=pk1&file_name=a.mp4&expires=9999999999&sign=abc";
  assert.equal(cap.headers.Location, expectLocation);
  assert.ok(cap.headers.Location.startsWith("https://"), "stream 模式 Location 必须是 https");
  assert.ok(!cap.headers.Location.includes("http://"), "stream 模式 JSON body 也应为 https");
  assert.equal(JSON.parse(cap.body).url, expectLocation);
});

test("4) HEAD：两种模式 302 Location 与 body 一致，body 为空", async () => {
  const cdn = "https://cdnfhnfile.115cdn.net/movie/movie.mp4?t=9999999999";
  const redirect = await callRedirect(makeHandler("redirect", cdn), "10.10.10.3:3667", "HEAD");
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.Location, cdn);
  assert.equal(redirect.body, "", "HEAD 不应有 body");

  const stream = await callRedirect(makeHandler("stream", cdn), "10.10.10.3:3667", "HEAD");
  assert.equal(stream.status, 302);
  assert.ok(stream.headers.Location.startsWith(`https://10.10.10.3:${HTTPS_STREAM_PORT}/`));
  assert.equal(stream.body, "", "HEAD 不应有 body");
});

test("5) hostnameFromRelayHost 从 Host 头（含端口/前缀/多值）正确提取裸主机名", () => {
  assert.equal(hostnameFromRelayHost("10.10.10.3:3667"), "10.10.10.3");
  assert.equal(hostnameFromRelayHost("10.10.10.3"), "10.10.10.3");
  assert.equal(hostnameFromRelayHost("nas.local:3667"), "nas.local");
  assert.equal(hostnameFromRelayHost("8.8.8.8:3667, 1.2.3.4:1"), "8.8.8.8");
  assert.equal(hostnameFromRelayHost("http://10.10.10.3:3667"), "10.10.10.3");
  assert.equal(hostnameFromRelayHost(""), "127.0.0.1");
});

test("6) HTTPS_STREAM_PORT = 3668", () => {
  assert.equal(HTTPS_STREAM_PORT, 3668);
});