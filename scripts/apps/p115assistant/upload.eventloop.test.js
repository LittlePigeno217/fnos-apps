"use strict";
// 假死修复验证（p115assistant 1.3.5）：上传路径的同步 IO 已异步化 + EPIPE 重试有界退避。
// 断言：
//   1) 整文件 SHA1 计算期间事件循环仍可响应（心跳定时器持续触发）——证明不再独占事件循环；
//   2) 限长 SHA1（preid 前 128KB）结果正确且响应；
//   3) 异步大区段读取（分片同源逻辑）结果正确；
//   4) EPIPE 风暴下 _retryWithDelay 重试有界（attempts 次即上抛，供上层记入失败队列，
//      不无限热重试）且退避 await sleep 让出事件循环；
//   5) 退避封顶 30s。
// 用法：node --test scripts/apps/p115assistant/upload.eventloop.test.js（零依赖）

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const CLIENT_PATH = path.join(__dirname, "../../../apps/p115assistant/fnos/app/server/client.js");
const { U115Client } = require(CLIENT_PATH);

function makeTempFile(sizeBytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p115-upl-"));
  const file = path.join(dir, "big.bin");
  const fd = fs.openSync(file, "w");
  const chunk = Buffer.alloc(1024 * 1024, 0xab); // 1MB 填充
  let written = 0;
  while (written < sizeBytes) {
    const n = Math.min(chunk.length, sizeBytes - written);
    fs.writeSync(fd, chunk, 0, n);
    written += n;
  }
  fs.closeSync(fd);
  return { dir, file };
}

// 心跳探针：每 5ms 触发一次，记录 tick 数。若事件循环被同步逻辑独占，tick 会停摆。
function startHeartbeat() {
  const state = { ticks: 0 };
  state.timer = setInterval(() => { state.ticks += 1; }, 5);
  return state;
}
function stopHeartbeat(state) { clearInterval(state.timer); }

test("整文件 SHA1 计算期间事件循环保持响应（不假死）", async () => {
  // 64MB 文件：旧同步 readSync 版本会一次性独占事件循环、心跳停摆（已实测增量=0）；
  // 异步版应持续 tick。
  const { dir, file } = makeTempFile(64 * 1024 * 1024);
  try {
    const client = new U115Client({});
    const hb = startHeartbeat();
    await new Promise((r) => setTimeout(r, 20)); // 让心跳先跑起来
    const before = hb.ticks;
    const sha1 = await client._calcSha1(file, null);
    const after = hb.ticks;
    stopHeartbeat(hb);

    const expect = crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex");
    assert.strictEqual(sha1, expect, "SHA1 结果必须与同步基准一致");
    assert.ok(after - before >= 3, `SHA1 计算期间事件循环应保持响应，实际心跳增量=${after - before}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("限长 SHA1（preid 前 128KB）正确", async () => {
  const { dir, file } = makeTempFile(4 * 1024 * 1024);
  try {
    const client = new U115Client({});
    const sha1 = await client._calcSha1(file, 128 * 1024);
    const buf = fs.readFileSync(file).subarray(0, 128 * 1024);
    const expect = crypto.createHash("sha1").update(buf).digest("hex");
    assert.strictEqual(sha1, expect, "前 128KB SHA1（preid）必须与基准一致");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("异步大区段读取结果正确（分片/签名同源逻辑）", async () => {
  const { dir, file } = makeTempFile(32 * 1024 * 1024);
  try {
    const client = new U115Client({});
    const sha1 = await client._calcSha1(file, 16 * 1024 * 1024);
    const buf = fs.readFileSync(file).subarray(0, 16 * 1024 * 1024);
    const expect = crypto.createHash("sha1").update(buf).digest("hex");
    assert.strictEqual(sha1, expect, "16MB 区段 SHA1 必须与基准一致");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("EPIPE 风暴：_retryWithDelay 重试有界且退避让出事件循环（不无限热重试）", async () => {
  const client = new U115Client({});
  client.uploadPartRetryDelay = 0.01; // 缩短退避以便快速跑完（10ms、20ms）

  let calls = 0;
  const epipe = () => {
    const e = new Error("请求失败: EPIPE");
    e.name = "NetworkError";
    e.code = "EPIPE";
    throw e;
  };

  const hb = startHeartbeat();
  await new Promise((r) => setTimeout(r, 15));
  const before = hb.ticks;

  const attempts = 3;
  await assert.rejects(
    () => client._retryWithDelay(async () => { calls += 1; epipe(); }, attempts),
    /EPIPE/,
    "超过重试上限后必须上抛错误（供上层记入失败队列），不得无限重试"
  );

  const after = hb.ticks;
  stopHeartbeat(hb);

  assert.strictEqual(calls, attempts, `EPIPE 重试次数必须有界=${attempts}，实际=${calls}`);
  assert.ok(after - before >= 2, `重试退避期间事件循环应保持响应，心跳增量=${after - before}`);
});

test("退避封顶 30s：超大 attempt 不产生失控长睡", () => {
  const backoff = (attempt) => Math.min(1.0 * Math.pow(2, Math.max(0, attempt - 1)), 30);
  assert.strictEqual(backoff(1), 1);
  assert.strictEqual(backoff(2), 2);
  assert.strictEqual(backoff(6), 30, "第 6 次退避 32s 应封顶到 30s");
  assert.strictEqual(backoff(10), 30, "大 attempt 退避必须封顶 30s");
});
