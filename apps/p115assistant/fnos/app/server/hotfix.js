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
    const req = https.get(u, { headers: { "User-Agent": "p115assistant-hotfix/1.0", "Cache-Control": "no-cache" }, timeout: 8000 }, (res) => {
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

/** 串行拉取（安全）：主源（raw.githubusercontent.com）成功即返回；失败才依次尝试镜像——
 * 镜像仅作主源失败兜底，被攻陷的镜像也无法先于主源（GitHub）注入恶意内容。
 * 此前的 Promise.race 并行拉取会让「更快的」镜像抢先返回，等同把信任交给第三方镜像。 */
const GH_PROXIES = ["https://ghproxy.net/", "https://ghproxy.com/"];
async function fetchWithMirror(primaryUrl) {
  let lastErr = null;
  try { return await httpsGet(primaryUrl); } catch (e) { lastErr = e; }
  for (const p of GH_PROXIES) {
    try { return await httpsGet(p + primaryUrl); } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

/** 十六进制 sha256（64 位）严格校验 */
function isSha256Hex(s) {
  return typeof s === "string" && /^[0-9a-f]{64}$/i.test(s);
}

/** 版本线校验（addVersionLine 语义）：x.y.z 且每段 0-9；patch 达 9 进位 minor，
 * 永不出现 .10+。热更清单 version 若越过版本线（如 1.2.10）直接拒收。 */
function isVersionLine(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v || "").trim());
  if (!m) return false;
  return Number(m[1]) <= 9 && Number(m[2]) <= 9 && Number(m[3]) <= 9;
}

/** 清单是热更的信任根（无签名）：只信任 GitHub raw 主源，绝不接受镜像提供的清单——
 * 文件内容可走镜像（有清单里的 sha256 兜底校验），但清单本身若来自被攻陷的镜像，
 * 攻击者即可注入任意 files+sha256 → 数据目录级代码替换。故清单固定走 raw，且严格校验字段。 */
async function fetchManifest() {
  const buf = await httpsGet(bust(MANIFEST_URL)); // 仅 raw 主源，不走镜像
  let m;
  try {
    m = JSON.parse(buf.toString("utf8"));
  } catch {
    throw new Error("清单解析失败");
  }
  if (!m || typeof m.version !== "string" || !isVersionLine(m.version)) {
    throw new Error("清单格式错误（version 需为 x.y.z 且每段 ≤9）");
  }
  if (!m.files || typeof m.files !== "object" || Array.isArray(m.files)) {
    throw new Error("清单格式错误（files）");
  }
  // 严格逐项校验：路径白名单（safeRel）+ sha256 十六进制 + size 非负整数
  for (const [rel0, info] of Object.entries(m.files)) {
    safeRel(rel0); // 非白名单/含穿越片段直接抛错
    if (!info || typeof info !== "object" || !isSha256Hex(info.sha256)) {
      throw new Error(`清单字段非法（sha256）：${rel0}`);
    }
    if (!Number.isInteger(Number(info.size)) || Number(info.size) < 0) {
      throw new Error(`清单字段非法（size）：${rel0}`);
    }
  }
  return m;
}

/** 缓存破坏：raw.githubusercontent.com CDN 可能强缓存，加时间戳参数绕过 */
function bust(url) {
  return url + (url.includes("?") ? "&" : "?") + "t=" + Date.now();
}

/** 检查差异：返回 { version, has_update, changed: [{rel, size}] } */
let hotfixLastOk = null; // 最近一次成功检查结果（仅 raw 拉取失败时兜底返回，不拦截实时检查）

async function checkHotfix(appDir) {
  try {
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
    const payload = {
      version: manifest.version,
      generated_at: manifest.generated_at || "",
      has_update: changed.length > 0,
      changed,
    };
    hotfixLastOk = payload;
    return payload;
  } catch (err) {
    // raw 拉取失败时兜底返回最近一次成功检查结果（陈旧可用），避免前端解析失败
    if (hotfixLastOk) return hotfixLastOk;
    throw err;
  }
}

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
    let buf = await fetchWithMirror(rawUrl);
    if (sha256Hex(buf) !== String(info.sha256 || "")) {
      // CDN 传播窗口：清单与文件异步传播时可能短暂不一致 → 换源重试一次
      buf = await fetchWithMirror(bust(`${RAW_BASE}/${rawRel(rel)}`));
    }
    if (sha256Hex(buf) !== String(info.sha256 || "")) {
      try { fs.unlinkSync(bak); } catch { /* ignore */ }
      throw new Error(`SHA-256 校验失败：${rel}（CDN 缓存未同步，请稍后重试）`);
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

  // 重启：优先 trim-cli（登录 session）请求系统级重启。
  // ⚠️ fnOS 采用 cmd/main 脚本进程管理模式，进程退出后不会被自动拉起——
  // 严禁使用「进程自杀」方案（真机验证：checkin 自杀后应用停止）。
  // trim-cli 失败/无凭据时提示手动重启。
  let restart = { ok: false, err: "trim-cli 不可用" };
  try {
    restart = await restartApp(dataDir, creds);
  } catch (e) {
    restart = { ok: false, err: e.message };
  }
  if (restart.ok) {
    return { success: true, applied, message: `功能已更新并自动重启（v${manifest.version}，${applied.length} 文件）`, restarting: true, version: manifest.version };
  }
  return { success: true, applied, message: `功能已更新，自动重启未生效（未配置 fnOS 凭据；请在应用中心重启应用）`, need_manual_restart: true, version: manifest.version };
}

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** 请求系统重启（应用以 root 运行时优先 appcenter-cli 免凭据；否则 trim-cli 登录重启） */
async function restartApp(dataDir, creds) {
  // 1) appcenter-cli（fnOS 本地工具；root 身份可直接调用，无需任何凭据）
  const APP_CLI = "/usr/local/bin/appcenter-cli";
  try {
    if (fs.existsSync(APP_CLI)) {
      // appcenter-cli 提供 stop/start（无 restart 命令）：detached 脚本先 stop 后 start，
      // stop 会杀掉本进程，start 由 appcenter 后台服务以 root 拉起（本进程被杀不影响脚本）
      const script = `"${APP_CLI}" stop ${APP_NAME} >/dev/null 2>&1; sleep 2; "${APP_CLI}" start ${APP_NAME} >/dev/null 2>&1`;
      const child = spawn("sh", ["-c", script], { detached: true, stdio: "ignore" });
      child.unref();
      return { ok: true, out: "appcenter-cli" };
    }
  } catch (e) {
    /* 回退 trim-cli */
  }
  // 2) trim-cli（登录 session，凭据自动登录）
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

module.exports = { checkHotfix, applyHotfix, fetchManifest, isVersionLine, isSha256Hex, MANIFEST_URL, sha256File };