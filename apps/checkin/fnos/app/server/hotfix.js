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
const MANIFEST_URL = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main/apps/checkin/runtime-manifest.json`;
const RAW_BASE = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main/apps/checkin/fnos`;
const APP_NAME = "checkin";

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
    const req = https.get(u, { headers: { "User-Agent": "checkin-hotfix/1.0", "Cache-Control": "no-cache" }, timeout: 8000 }, (res) => {
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

/** 双源拉取：raw 与 GitHub 代理镜像并行发起，最快成功者胜。
 * 串行（raw 失败才走镜像）在 raw 慢时会把总耗时拖到网关超时；并行通常 <5s 返回。 */
const GH_PROXIES = ["https://ghproxy.net/", "https://ghproxy.com/"];
async function fetchWithMirror(primaryUrl) {
  const candidates = [primaryUrl, ...GH_PROXIES.map((p) => p + primaryUrl)];
  let remaining = candidates.map((u) => httpsGet(u));
  let lastErr = null;
  while (remaining.length) {
    const result = await Promise.race(
      remaining.map((p, i) => p.then((b) => ({ ok: true, b, i }), (e) => ({ ok: false, e, i })))
    );
    if (result.ok) return result.b;
    lastErr = result.e;
    remaining = remaining.filter((_, i) => i !== result.i);
  }
  throw lastErr;
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
  // B8：逐文件替换（先备份 → 下载 → 替换 → 记录），任一失败自动回滚已替换文件。
  // downloader 注入下载（raw + 镜像 + 缓存破坏）；CDN 窗口不一致在 loop 内重试一次。
  const downloader = async (rel) => fetchWithMirror(bust(`${RAW_BASE}/${rawRel(rel)}`));
  const appliedRes = await applyFileUpdates(appDir, dataDir, changedAll, downloader);
  if (!appliedRes.success) return appliedRes; // B8：失败信封含「已回滚 N 个文件」；不写 version、不触发重启
  const applied = appliedRes.applied;
  // 记录（仅全部替换成功后才写 current.json）
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
  return { success: true, applied, message: `功能已更新，需手动重启后生效（自动重启不可用：${restart.err}；请在应用中心重启应用）`, need_manual_restart: true, version: manifest.version };
}

/**
 * B8：逐文件应用热更——每文件「先备份现状 → downloader → SHA-256 校验（CDN 未同步时换源重试一次）→
 * 原子替换 → 记录 applied」。任一文件失败：catch 内用已写备份逐文件恢复已替换文件（原文件不存在 →
 * 删除本次替换产物），返回失败信封（含已回滚文件数），杜绝批量替换中途失败留下「混合版本代码」。
 * 独立导出以便可注入 downloader / 令写入失败做回滚验证（mock）。
 * @param {string} appDir  安装目录
 * @param {string} dataDir 应用数据目录（备份落在 dataDir/patches/backup/<时间戳>/，升级保留不回写安装目录）
 * @param {Array<{rel:string, info:Object}>} changedAll 待更新清单项
 * @param {(rel:string)=>Promise<Buffer>} downloader 文件下载器
 * @returns {Promise<{success:true, applied:string[], backupDir:string} | {success:false, message:string, applied:[], rolled_back:number}>}
 */
async function applyFileUpdates(appDir, dataDir, changedAll, downloader) {
  const now = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(dataDir, "patches", "backup", now); // 备份目录名含时间戳
  const applied = [];
  try {
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
      let buf = await downloader(rel);
      if (sha256Hex(buf) !== String(info.sha256 || "")) {
        // CDN 传播窗口：清单与文件异步传播时可能短暂不一致 → 换源重试一次
        buf = await downloader(rel);
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
  } catch (err) {
    // 回滚已替换文件：用写盘备份逐文件恢复（保持一致性），失败逐个记日志不中断其余回滚
    let rolledBack = 0;
    for (const rel of applied) {
      const p = path.join(appDir, rel);
      const bak = path.join(backupDir, rel);
      try {
        if (fs.existsSync(bak)) {
          fs.copyFileSync(bak, p); // 备份覆盖回安装目录
          rolledBack += 1;
        } else if (fs.existsSync(p)) {
          fs.unlinkSync(p); // 原文件本来不存在 → 删除本次替换产物
          rolledBack += 1;
        }
      } catch (e) {
        console.error(`热更回滚失败（${rel}）：${(e && e.message) || e}`);
      }
    }
    console.error(`热更应用失败：${(err && err.message) || err}（已回滚 ${rolledBack} 个文件）`);
    return { success: false, message: `${(err && err.message) || err}（已回滚 ${rolledBack} 个文件）`, applied: [], rolled_back: rolledBack };
  }
  return { success: true, applied, backupDir };
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
    HOME: process.env.HOME || "/vol1/@apphome/checkin",
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

module.exports = { checkHotfix, applyHotfix, applyFileUpdates, MANIFEST_URL, sha256File };