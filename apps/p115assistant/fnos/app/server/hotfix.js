/**
 * hotfix.js — 应用内"功能热更新"（不更新 fpk）
 *
 * 原理：应用运行时文件（server/*.js、www/index.html）属主为应用用户，
 * 进程可自行改写安装目录文件；配合 trim-cli 登录（fnOS 凭据）触发系统级重启，
 * 即可在不动应用中心（不走 10236 安装/升级通道）的前提下完成业务功能更新。
 *
 * 清单：runtime-manifest.json（GitHub 仓库根），字段：
 *   { "version": "1.0.4", "files": { "server/server.js": {sha256, size}, ... } }
 */
const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { trimHasSession, trimCliLogin } = require("./update");

const REPO_OWNER = "LittlePigeno217";
const REPO_NAME = "fnos-apps";
const MANIFEST_URL = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main/apps/p115assistant/runtime-manifest.json`;
const RAW_BASE = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main/apps/p115assistant/fnos`;
const APP_NAME = "p115assistant";

/** 安装路径 → 仓库路径（清单里的 rel 是安装路径：server/、www/） */
function rawRel(installRel) {
  if (installRel.startsWith("server/")) return "app/server/" + installRel.slice("server/".length);
  if (installRel.startsWith("www/")) return "app/ui/" + installRel.slice("www/".length);
  return installRel;
}

/** 白名单校验：仅允许 server/ 与 www/ 下的相对路径，杜绝路径穿越（rel 完全来自远程清单） */
function safeRel(rel) {
  const r = String(rel || "");
  if (!r.startsWith("server/") && !r.startsWith("www/")) throw new Error(`非法热更路径（不在白名单内）：${r}`);
  for (const seg of r.split("/")) {
    if (seg === ".." || seg === "." || seg.includes("\u0000")) throw new Error(`非法热更路径（含危险片段）：${r}`);
  }
  if (path.isAbsolute(r)) throw new Error(`非法热更路径（绝对路径）：${r}`);
  return r;
}

/** sha256（流式） */
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.get(u, { headers: { "User-Agent": "p115assistant-hotfix/1.0", "Cache-Control": "no-cache" }, timeout: 20000 }, (res) => {
      if (res.statusCode >= 400) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("timeout", () => req.destroy(new Error("请求超时")));
    req.on("error", reject);
  });
}

/** 带重试的 GET：瞬时网络抖动自动重试（最多 2 次，间隔 1.2s） */
async function httpsGetRetry(url, tries) {
  let last;
  for (let i = 0; i < (tries || 2); i++) {
    try {
      return await httpsGet(url);
    } catch (err) {
      last = err;
      if (i < (tries || 2) - 1) await new Promise((r) => setTimeout(r, 1200));
    }
  }
  throw last;
}

/** 双源拉取：raw 为主，失败依次回退 GitHub 代理镜像（仅公开只读清单/代码，无敏感） */
const GH_PROXIES = ["https://ghproxy.net/", "https://ghproxy.com/"];
async function fetchWithMirror(primaryUrl) {
  try {
    return await httpsGetRetry(primaryUrl, 2);
  } catch (err) {
    for (const p of GH_PROXIES) {
      try {
        return await httpsGetRetry(p + primaryUrl, 1);
      } catch { /* 尝试下一个镜像 */ }
    }
    throw err;
  }
}

async function fetchManifest() {
  const buf = await fetchWithMirror(bust(MANIFEST_URL));
  const m = JSON.parse(buf.toString("utf8"));
  if (!m || typeof m.version !== "string" || !m.files || typeof m.files !== "object") {
    throw new Error("清单格式错误");
  }
  return m;
}

/** 缓存破坏：raw.githubusercontent.com CDN 可能强缓存，加时间戳参数绕过 */
function bust(url) {
  return url + (url.includes("?") ? "&" : "?") + "t=" + Date.now();
}

/** 检查差异：返回 { version, has_update, changed: [{rel, size}] } */
async function checkHotfix(appDir) {
  const manifest = await fetchManifest();
  const changed = [];
  for (const [rel0, info] of Object.entries(manifest.files)) {
    const rel = safeRel(rel0); // 白名单校验（防路径穿越）
    // 安装目录文件哈希对比
    const p = path.join(appDir, rel);
    let current = "";
    try {
      current = await sha256File(p);
    } catch {
      /* 文件缺失视为待更新 */
    }
    if (current !== String(info.sha256 || "")) {
      changed.push({ rel, size: Number(info.size) || 0 });
    }
  }
  return {
    version: manifest.version,
    generated_at: manifest.generated_at || "",
    has_update: changed.length > 0,
    changed,
  };
}

/** 应用热更新：下载差异 → sha256 校验 → 替换（备份旧文件）→ 记录 → 重启 */
async function applyHotfix(appDir, dataDir, creds) {
  const manifest = await fetchManifest();
  const changedAll = [];
  for (const [rel0, info] of Object.entries(manifest.files)) {
    const rel = safeRel(rel0); // 白名单校验（防路径穿越）
    const p = path.join(appDir, rel);
    let current = "";
    try {
      current = await sha256File(p);
    } catch {
      /* 待更新 */
    }
    if (current !== String(info.sha256 || "")) changedAll.push({ rel, info });
  }
  if (!changedAll.length) {
    return { success: true, applied: [], message: "已是最新功能版本" };
  }
  const now = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(dataDir, "patches", "backup", now);
  const applied = [];
  for (const item of changedAll) {
    const { rel, info } = item;
    const p = path.join(appDir, rel);
    // 备份旧文件（到应用数据目录，升级保留且不回写安装目录）
    const bak = path.join(backupDir, rel);
    fs.mkdirSync(path.dirname(bak), { recursive: true });
    try {
      fs.copyFileSync(p, bak);
    } catch {
      /* 原文件不存在则不备份 */
    }
    // 下载新文件（raw 直链，安装路径→仓库路径；带缓存破坏参数；raw 失败回退镜像）
    const rawUrl = bust(`${RAW_BASE}/${rawRel(rel)}`);
    const buf = await fetchWithMirror(rawUrl);
    if (sha256Hex(buf) !== String(info.sha256 || "")) {
      try { fs.unlinkSync(bak); } catch { /* ignore */ }
      throw new Error(`SHA-256 校验失败：${rel}`);
    }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + ".hotfix.tmp";
    fs.writeFileSync(tmp, buf);
    fs.chmodSync(tmp, 0o744);
    fs.renameSync(tmp, p);
    applied.push(rel);
  }
  // 记录
  fs.mkdirSync(path.join(dataDir, "patches"), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "patches", "current.json"),
    JSON.stringify({ version: manifest.version, applied_at: new Date().toISOString(), files: applied }, null, 2)
  );

  // 重启：trim-cli（登录 session）请求系统重启应用
  const restart = await restartApp(dataDir, creds);
  if (!restart.ok) {
    return { success: true, applied, message: `文件已更新，但自动重启失败：${restart.err}（请手动重启应用）`, need_manual_restart: true };
  }
  return { success: true, applied, message: `功能已更新并自动重启（v${manifest.version}，${applied.length} 文件）`, restarting: true };
}

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** 请求系统重启（trim-cli app restart，凭据自动登录） */
async function restartApp(dataDir, creds) {
  const cli = trimCliPath();
  if (!cli) return { ok: false, err: "未找到 trim-cli" };
  // 会话环境必须与 update.js trimEnv 一致：TRIM_CLI_CONFIG_DIR 指向应用数据目录下的 trimclip
  const env = {
    ...process.env,
    HOME: process.env.HOME || "/vol1/@apphome/p115assistant",
    TRIM_CLI_CONFIG_DIR: path.join(dataDir, "trimclip"),
    TRIM_CLI_SESSION_STORAGE: "file",
  };
  let sessionOk = await trimHasSession(dataDir);
  if (!sessionOk && creds && creds.username && creds.password) {
    const lg = await trimCliLogin(dataDir, creds.username, creds.password);
    sessionOk = lg && lg.code === 0;
  }
  if (!sessionOk) return { ok: false, err: "trim-cli 会话不可用（请先配置 fnOS 凭据或手动重启应用）" };
  return runCli(cli, [
    "--host", "127.0.0.1", "--port", "53892", "--scheme", "ws", "--allow-insecure-ws", "--profile", "app",
    "app", "restart", APP_NAME, "--yes",
  ], env);
}

function trimCliPath() {
  for (const p of ["/usr/local/bin/trim-cli", "/usr/bin/trim-cli"]) {
    try {
      if (fs.existsSync(p)) return p;
    } catch { /* ignore */ }
  }
  return "";
}

function runCli(cli, args, env) {
  return new Promise((resolve) => {
    const child = spawn(cli, args, { stdio: ["ignore", "pipe", "pipe"], env });
    let out = "";
    let errOut = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (errOut += String(d)));
    child.on("error", (err) => resolve({ ok: false, err: err.message }));
    child.on("close", (code) => {
      if (code === 0) resolve({ ok: true, out });
      else resolve({ ok: false, err: errOut.trim().slice(0, 300) });
    });
  });
}

module.exports = { checkHotfix, applyHotfix, MANIFEST_URL, sha256File };