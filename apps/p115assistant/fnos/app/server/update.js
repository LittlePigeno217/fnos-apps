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
const { spawn } = require("child_process");
const { URL } = require("url");

// GitHub 仓库信息（发布侧）
const UPDATE_REPO = "LittlePigeno217/fnos-apps";
const UPDATE_REPO_API = `https://api.github.com/repos/${UPDATE_REPO}/releases`;
// raw 版本清单（构建产物入库 dist/latest.json）：国内可达性与速度优于 api.github.com
const RAW_MANIFEST_URL = `https://raw.githubusercontent.com/${UPDATE_REPO}/main/dist/latest.json`;
const FPK_PREFIX = "p115assistant_";

// 当前版本：编译时由 build.sh 注入（缺省读 manifest）
const CURRENT_VERSION = process.env.P115ASSISTANT_VERSION || "1.0.0";

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
    if (!/\.fpk$/.test(name)) {
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
        downloadFollow(tmpPath, filePath, loc, name, Number(payload.size) || 0, resolve);
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
        out.close(() => {
          const st = fs.statSync(tmpPath);
          const expected = Number(payload.size) || 0;
          if (expected && st.size !== expected) {
            fs.unlink(tmpPath, () => {});
            resolve({ success: false, message: `文件大小不符（期望 ${expected}，实际 ${st.size}）` });
            return;
          }
          fs.renameSync(tmpPath, filePath);
          resolve({ success: true, message: `已下载 ${name}`, file: filePath, size: st.size });
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
function downloadFollow(tmpPath, filePath, targetUrl, name, expected, resolve) {
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
      out.close(() => {
        const st = fs.statSync(tmpPath);
        if (expected && st.size !== expected) {
          fs.unlink(tmpPath, () => {});
          resolve({ success: false, message: `文件大小不符（期望 ${expected}，实际 ${st.size}）` });
          return;
        }
        fs.renameSync(tmpPath, filePath);
        resolve({ success: true, message: `已下载 ${name}`, file: filePath, size: st.size });
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

/** 3. 执行更新：trim-cli install-fpk <本地文件>（白名单校验）。 */
function applyUpdate(payload, dataDir) {
  return new Promise((resolve) => {
    const dir = updateDir(dataDir);
    const raw = String(payload && payload.file || payload && payload.name || "");
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
    // 路径安全检查：必须位于应用 updates/ 目录内，防目录穿越
    const dirResolved = path.resolve(dir);
    if (resolved !== path.join(dirResolved, name) || !resolved.startsWith(dirResolved + path.sep)) {
      resolve({ success: false, message: "FPK 必须位于应用更新目录" });
      return;
    }
    const filePath = resolved;
    if (!fs.existsSync(filePath)) {
      resolve({ success: false, message: `FPK 不存在: ${filePath}` });
      return;
    }
    const cli = trimCliPath();
    if (!cli) {
      resolve({ success: false, message: "未找到 trim-cli，请在 NAS 安装后重试" });
      return;
    }
    // 更新执行依赖 NAS 上已配置的 trim-cli session（一次登录，加密存储，免密调用）
    // 连接参数与本机部署约定一致；HOME 指向应用 home 以加载 profile
    const args = [
      "--host", "127.0.0.1",
      "--port", "53892",
      "--scheme", "ws",
      "--allow-insecure-ws",
      "--profile", "app",
      "app", "install-fpk",
      filePath,
      "--custom-parameters", "[]",
      "--volume-id", "1",
      "--data-volume-id", "1",
      "--yes",
    ];
    const env = { ...process.env, HOME: process.env.HOME || "/vol1/@apphome/p115assistant" };
    const child = spawn(cli, args, { stdio: ["ignore", "pipe", "pipe"], env });
    let out = "";
    let errOut = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (errOut += String(d)));
    child.on("error", (err) => resolve({ success: false, message: `执行失败: ${err.message}` }));
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ success: true, message: "更新已提交，应用即将重启", output: out.trim().slice(0, 300) });
      } else {
        resolve({ success: false, message: `trim-cli 退出码 ${code}: ${errOut.trim().slice(0, 300)}` });
      }
    });
  });
}

module.exports = { checkUpdate, downloadUpdate, applyUpdate, updateDir, trimCliPath, CURRENT_VERSION };
