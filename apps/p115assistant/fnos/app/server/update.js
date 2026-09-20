// update.js — 115网盘助手 自更新模块
//
// 半自动更新流程（方案 2，2026-09-17 设计）：
//   1. checkUpdate()   — 请求 GitHub API 查询本仓库最新 Release（p115assistant/vX.Y.Z）
//   2. downloadUpdate()— 下载新 FPK 到应用数据目录 updates/（校验文件名与大小）
//   3. applyUpdate()   — 执行 trim-cli install-fpk（本地 FPK 更新，应用重启后生效）
//
// 更新执行依赖 NAS 上预装的 trim-cli：
//   - 首次使用时由用户在 fnOS 应用中心/SSH 安装 trim-cli（一次）
//   - 后端以 child_process 调用，命令与参数白名单校验，禁止 shell 拼接
//
// 敏感值不入库：不保存任何 GitHub token；只读公开 Release API。

"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { URL } = require("url");

// GitHub 仓库信息（发布侧）
const UPDATE_REPO = "LittlePigeno217/fnos-apps";
const UPDATE_REPO_API = `https://api.github.com/repos/${UPDATE_REPO}/releases`;
// raw 版本清单（构建产物入库 dist/latest.json）：国内可达性与速度优于 api.github.com
const RAW_MANIFEST_URL = `https://raw.githubusercontent.com/${UPDATE_REPO}/main/dist/latest.json`;
const FPK_PREFIX = "p115assistant_";

// 当前版本：编译时由 build.sh 注入（缺省读 manifest）
const CURRENT_VERSION = process.env.P115ASSISTANT_VERSION || "1.0.6";

// 更新目录：应用数据目录 updates/
function updateDir(dataDir) {
  return path.join(dataDir || "/vol1/@appdata/p115assistant", "updates");
}

// trim-cli 路径：优先用应用同卷的预装路径，回退常见位置
function trimCliPath() {
  const candidates = [
    "/usr/local/bin/trim-cli",
    "/usr/bin/trim-cli",
    "/vol1/1000/trim-cli",
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return "";
}

/** 简单 HTTPS GET，返回 JSON（GitHub API 需要 UA）。 */
function httpsGetJson(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "http:" ? http : https;
    const req = mod.get(
      u,
      { headers: { "User-Agent": "p115assistant-updater/1.0", Accept: "application/vnd.github+json" }, timeout: timeoutMs },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`JSON 解析失败: ${e.message}`));
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("请求超时")));
    req.on("error", reject);
  });
}

/** 解析 GitHub Releases，返回最新的 p115assistant release 信息。 */
function parseLatestRelease(releases) {
  if (!Array.isArray(releases)) return null;
  let best = null;
  let bestVersion = "";
  for (const r of releases) {
    const tag = String(r.tag_name || "");
    if (!tag.startsWith("p115assistant/v")) continue;
    const version = tag.replace("p115assistant/v", "");
    const asset = (r.assets || []).find((a) => String(a.name).startsWith(FPK_PREFIX) && String(a.name).endsWith(".fpk"));
    if (!asset) continue;
    if (!best || semverGt(version, bestVersion)) {
      bestVersion = version;
      best = {
        version,
        tag,
        url: asset.browser_download_url,
        // 下载优先走 API assets 端点：国内网络 github.com 直连常被墙，
        // api.github.com 与 release-assets.githubusercontent.com 可达（2026-09-17 真机验证）
        api_asset_url: asset.url || "",
        asset_id: asset.id || 0,
        name: asset.name,
        size: asset.size,
        published_at: r.published_at,
        html_url: r.html_url,
        body: String(r.body || "").slice(0, 2000),
      };
    }
  }
  return best;
}

/** 解析 raw 版本清单（dist/latest.json，由发布 workflow 生成）。 */
function parseRawManifest(m) {
  if (!m || typeof m !== "object") return null;
  const version = String(m.version || "");
  if (!/^\d+\.\d+\.\d+$/.test(version)) return null;
  const file = String(m.file || `p115assistant_${version}_all.fpk`);
  return {
    version,
    tag: String(m.tag || `p115assistant/v${version}`),
    url: String(m.rawUrl || ""), // 直链兜底
    raw_url: String(m.rawUrl || ""), // raw 加速主通道
    api_asset_url: String(m.apiAssetUrl || ""),
    name: file,
    size: Number(m.size) || 0,
    md5: String(m.md5 || ""),
    sha256: String(m.sha256 || ""),
    published_at: String(m.publishedAt || ""),
    html_url: `https://github.com/LittlePigeno217/fnos-apps/releases/tag/p115assistant/v${version}`,
    body: "",
  };
}

/** 流式计算文件 SHA-256（避免大文件同步读盘阻塞事件循环）。 */
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

/** 1. 检查更新（只读 GitHub/raw，无副作用）。 */
async function checkUpdate(dataDir, currentVersionOverride) {
  const current = currentVersionOverride || CURRENT_VERSION;
  let latest = null;
  // 1) 优先 raw 版本清单（国内可达性优于 api.github.com，2026-09-18 实测）
  try {
    const manifest = await httpsGetJson(RAW_MANIFEST_URL, 10000);
    latest = parseRawManifest(manifest);
  } catch (err) {
    latest = null;
  }
  // 2) 回退 GitHub API releases
  if (!latest) {
    try {
      const releases = await httpsGetJson(UPDATE_REPO_API + "?per_page=10");
      latest = parseLatestRelease(releases);
    } catch (err) {
      return { success: false, message: `检查更新失败: ${err.message}` };
    }
  }
  if (!latest) {
    return { success: true, has_update: false, current, latest: null, message: "仓库暂无发布版本" };
  }
  // 版本比较：简单语义化比较（相同视为最新；v1.0.0 < v1.1.0）
  const hasUpdate = semverGt(latest.version, current);
  return {
    success: true,
    has_update: hasUpdate,
    current,
    latest: hasUpdate
      ? latest
      : { ...latest, is_current: true },
    message: hasUpdate ? `发现新版本 v${latest.version}` : "已是最新版本",
  };
}

/** 语义化版本比较：a > b 返回 true（容错解析）。 */
function semverGt(a, b) {
  const pa = String(a || "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b || "").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

/** 2. 下载新 FPK 到 updates/。payload: { url, name, size, api_asset_url }。 */
function downloadUpdate(payload, dataDir) {
  return new Promise((resolve) => {
    const dir = updateDir(dataDir);
    fs.mkdirSync(dir, { recursive: true });
    const rawUrl = String(payload && payload.raw_url || "");
    const url = String(payload && payload.url || "");
    const apiAssetUrl = String(payload && payload.api_asset_url || "");
    const name = String(payload && payload.name || "");
    if (!rawUrl && !apiAssetUrl && (!url || !/^https:\/\//.test(url))) {
      resolve({ success: false, message: "无效的下载参数" });
      return;
    }
    // 文件名必须与 manifest 版本严格一致，防下载任意 .fpk 落盘（越界写入）
    const expectName = `p115assistant_${String((payload && payload.version) || "")}_all.fpk`;
    if (!name || name !== expectName) {
      resolve({ success: false, message: "无效的 FPK 文件名" });
      return;
    }
    const filePath = path.join(dir, name);
    const tmpPath = filePath + ".part";
    // 下载顺序：raw 直链（raw.githubusercontent.com 加速）→ API assets（302）→ release 直链
    const targetUrl = rawUrl || apiAssetUrl || url;
    const headers = { "User-Agent": "p115assistant-updater/1.0" };
    if (apiAssetUrl && !rawUrl) headers.Accept = "application/octet-stream";
    const u = new URL(targetUrl);
    const mod = u.protocol === "http:" ? http : https;
    const req = mod.get(u, { headers, timeout: 60000 }, (res) => {
      // 处理 302 重定向（API assets → CDN）
      if (res.statusCode && [301, 302, 303, 307, 308].includes(res.statusCode)) {
        const loc = String(res.headers.location || "");
        res.resume();
        if (!loc) {
          resolve({ success: false, message: "下载重定向缺少 Location" });
          return;
        }
        downloadFollow(tmpPath, filePath, loc, name, Number(payload.size) || 0, String(payload.sha256 || ""), resolve);
        return;
      }
      if (res.statusCode && res.statusCode >= 400) {
        resolve({ success: false, message: `下载失败: HTTP ${res.statusCode}` });
        res.resume();
        return;
      }
      const out = fs.createWriteStream(tmpPath);
      res.pipe(out);
      out.on("finish", () => {
        out.close(async () => {
          const st = fs.statSync(tmpPath);
          const expected = Number(payload.size) || 0;
          if (expected && st.size !== expected) {
            fs.unlink(tmpPath, () => {});
            resolve({ success: false, message: `文件大小不符（期望 ${expected}，实际 ${st.size}）` });
            return;
          }
          // 下载完整性校验：sha256（latest.json 已提供；缺失时退回仅 size）
          const expectedSha = String(payload.sha256 || "").toLowerCase();
          if (expectedSha) {
            let actual = "";
            try {
              actual = await sha256File(tmpPath);
            } catch (err) {
              fs.unlink(tmpPath, () => {});
              resolve({ success: false, message: `校验失败: ${err.message}` });
              return;
            }
            if (actual !== expectedSha) {
              fs.unlink(tmpPath, () => {});
              resolve({ success: false, message: `SHA-256 校验失败（期望 ${expectedSha.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）` });
              return;
            }
          }
          fs.renameSync(tmpPath, filePath);
          resolve({ success: true, message: `已下载 ${name}`, file: filePath, size: st.size, sha256: expectedSha });
        });
      });
      out.on("error", (err) => {
        fs.unlink(tmpPath, () => {});
        resolve({ success: false, message: `写入失败: ${err.message}` });
      });
    });
    req.on("timeout", () => req.destroy(new Error("下载超时")));
    req.on("error", (err) => {
      fs.unlink(tmpPath, () => {});
      resolve({ success: false, message: `下载失败: ${err.message}` });
    });
  });
}

/** 跟随一次重定向下载（避免递归过深）。 */
function downloadFollow(tmpPath, filePath, targetUrl, name, expected, expectedSha, resolve) {
  const u = new URL(targetUrl);
  const mod = u.protocol === "http:" ? http : https;
  const req = mod.get(u, { headers: { "User-Agent": "p115assistant-updater/1.0" }, timeout: 60000 }, (res) => {
    if (res.statusCode && res.statusCode >= 400) {
      resolve({ success: false, message: `下载失败: HTTP ${res.statusCode}` });
      res.resume();
      return;
    }
    const out = fs.createWriteStream(tmpPath);
    res.pipe(out);
    out.on("finish", () => {
      out.close(async () => {
        const st = fs.statSync(tmpPath);
        if (expected && st.size !== expected) {
          fs.unlink(tmpPath, () => {});
          resolve({ success: false, message: `文件大小不符（期望 ${expected}，实际 ${st.size}）` });
          return;
        }
        const expectedShaNorm = String(expectedSha || "").toLowerCase();
        if (expectedShaNorm) {
          let actual = "";
          try {
            actual = await sha256File(tmpPath);
          } catch (err) {
            fs.unlink(tmpPath, () => {});
            resolve({ success: false, message: `校验失败: ${err.message}` });
            return;
          }
          if (actual !== expectedShaNorm) {
            fs.unlink(tmpPath, () => {});
            resolve({ success: false, message: `SHA-256 校验失败（期望 ${expectedShaNorm.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）` });
            return;
          }
        }
        fs.renameSync(tmpPath, filePath);
        resolve({ success: true, message: `已下载 ${name}`, file: filePath, size: st.size, sha256: expectedShaNorm });
      });
    });
    out.on("error", (err) => {
      fs.unlink(tmpPath, () => {});
      resolve({ success: false, message: `写入失败: ${err.message}` });
    });
  });
  req.on("timeout", () => req.destroy(new Error("下载超时")));
  req.on("error", (err) => {
    fs.unlink(tmpPath, () => {});
    resolve({ success: false, message: `下载失败: ${err.message}` });
  });
}

/** 3. 执行更新：会话自适配 → 预检 → 安装（10236 硬限制时转一步引导）。 */

/** trim-cli 执行环境：会话隔离到应用数据目录（升级保留，勿写全局 HOME）。 */
function trimEnv(dataDir) {
  const sessionDir = path.join(dataDir, "trimclip");
  try {
    fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(sessionDir, 0o700);
  } catch (e) {
    /* ignore */
  }
  return {
    ...process.env,
    HOME: process.env.HOME || "/vol1/@apphome/p115assistant",
    TRIM_CLI_CONFIG_DIR: sessionDir,
    TRIM_CLI_SESSION_STORAGE: "file",
  };
}

function trimArgs(...rest) {
  return ["--host", "127.0.0.1", "--port", "53892", "--scheme", "ws", "--allow-insecure-ws", "--profile", "app", ...rest];
}

function runTrimCli(args, env) {
  return new Promise((resolve) => {
    const cli = trimCliPath();
    if (!cli) {
      resolve({ code: -1, out: "", err: "未找到 trim-cli，请在 NAS 安装后重试" });
      return;
    }
    const child = spawn(cli, args, { stdio: ["ignore", "pipe", "pipe"], env });
    let out = "";
    let errOut = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (errOut += String(d)));
    child.on("error", (err) => resolve({ code: -2, out, err: err.message }));
    child.on("close", (code) => resolve({ code: code == null ? -3 : code, out, err: errOut }));
  });
}

/** 探测是否已有可用会话（app list 无 session 时报 saved session is required）。 */
async function trimHasSession(dataDir) {
  const env = trimEnv(dataDir);
  const r = await runTrimCli(trimArgs("app", "list"), env);
  if (r.code === 0 && r.out && r.err.indexOf("saved session is required") < 0 && r.out.indexOf("list") >= 0) {
    return true;
  }
  return false;
}

/** 用内置凭据登录 trim-cli（会话写应用数据目录）。 */
async function trimCliLogin(dataDir, username, password) {
  if (!username || !password) return { code: -1, err: "缺少凭据" };
  const env = trimEnv(dataDir);
  return runTrimCli(trimArgs("login", "-u", username, "-p", password), env);
}

/** 错误分类：fnOS 升级硬限制 → 引导 UI；缺会话 → 登录。 */
function classifyCliError(text) {
  const t = String(text || "");
  if (/10236/.test(t)) return { need_ui: true, code: "UI_ONLY", message: "fnOS 限制：已安装应用升级只能在应用中心手动安装" };
  if (/saved session is required/.test(t)) return { code: "NEED_SESSION", message: "trim-cli 会话已失效，请重新登录" };
  if (/10030/.test(t)) return { code: "ALREADY_INSTALLED", message: "目标版本已安装或无法从当前源安装" };
  if (/not found|No such file/i.test(t)) return { code: "FILE_ERROR", message: "安装文件不可用或路径无效" };
  return { code: "UNKNOWN", message: t.slice(0, 300) || "未知错误" };
}

/** 执行更新：路径白名单 → 会话（自动登录）→ dry-run 预检 → 正式安装/引导。 */
function applyUpdate(payload, dataDir, creds) {
  return new Promise(async (resolve) => {
    const dir = updateDir(dataDir);
    const raw = String((payload && payload.file) || (payload && payload.name) || "");
    if (!raw) {
      resolve({ success: false, message: "缺少 FPK 文件" });
      return;
    }
    const name = path.basename(raw);
    if (!/^p115assistant_[0-9a-zA-Z._-]+\.fpk$/.test(name)) {
      resolve({ success: false, message: "无效的 FPK 文件名" });
      return;
    }
    const resolved = path.resolve(raw);
    const dirResolved = path.resolve(dir);
    if (resolved !== path.join(dirResolved, name) || !resolved.startsWith(dirResolved + path.sep)) {
      resolve({ success: false, message: "FPK 必须位于应用更新目录" });
      return;
    }
    if (!fs.existsSync(resolved)) {
      resolve({ success: false, message: `FPK 不存在: ${resolved}` });
      return;
    }
    if (!trimCliPath()) {
      resolve({ success: false, message: "未找到 trim-cli，请确认 NAS 已安装 fnOS CLI" });
      return;
    }
    // 1) 会话：无 → 有凭据自动登录；无凭据 → 交前端收集
    let sessionOk = await trimHasSession(dataDir);
    if (!sessionOk) {
      const u = creds && creds.username;
      const p = creds && creds.password;
      if (u && p) {
        const lg = await trimCliLogin(dataDir, u, p);
        if (lg.code === 0) {
          sessionOk = true;
        } else {
          resolve({ success: false, need_login: true, code: "NEED_LOGIN", message: `自动登录失败: ${lg.err.trim().slice(0, 200) || "请检查账号密码"}` });
          return;
        }
      } else {
        resolve({ success: false, need_login: true, code: "NEED_CREDS", message: "需要 fnOS 账号密码用于自动安装，请先配置" });
        return;
      }
    }
    const env = trimEnv(dataDir);
    // 2) a. dry-run 预检（确认 fpk 有效、可升级）
    const dryArgs = trimArgs("app", "install-fpk", resolved, "--custom-parameters", "[]", "--volume-id", "1", "--data-volume-id", "1", "--yes", "--dry-run");
    const dry = await runTrimCli(dryArgs, env);
    if (dry.code !== 0) {
      const cls = classifyCliError(dry.err + dry.out);
      resolve({ success: false, code: cls.code, message: cls.message, need_ui: cls.need_ui || false });
      return;
    }
    const dryJson = dry.out.trim();
    // 2) b. 正式安装；fnOS 10236 硬限制 → 返回一步引导（文件就绪 + 路径 + 指引）
    const instArgs = trimArgs("app", "install-fpk", resolved, "--custom-parameters", "[]", "--volume-id", "1", "--data-volume-id", "1", "--yes");
    const inst = await runTrimCli(instArgs, env);
    if (inst.code === 0) {
      resolve({ success: true, message: "更新已提交，应用即将重启", output: inst.out.trim().slice(0, 300) });
      return;
    }
    const cls = classifyCliError(inst.err + inst.out);
    if (cls.need_ui) {
      resolve({
        success: true,
        need_ui: true,
        code: "UI_ONLY",
        file: resolved,
        sha256: (payload && payload.sha256) || "",
        message: "安装包已验证，fnOS 需在应用中心完成最后一步",
        steps: ["打开「应用中心」→「已安装」→ 115网盘助手", "点击「手动安装」，选择上一步下载的安装包", "同意并确认，应用自动升级"],
      });
      return;
    }
    resolve({ success: false, code: cls.code, message: cls.message });
  });
}

module.exports = { checkUpdate, downloadUpdate, applyUpdate, updateDir, trimCliPath, trimHasSession, trimCliLogin, classifyCliError, CURRENT_VERSION };
