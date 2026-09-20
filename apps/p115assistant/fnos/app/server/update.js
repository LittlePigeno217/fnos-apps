// update.js — 115网盘助手 trim-cli 会话辅助（供 hotfix.js 功能热更调用）
//
// FPK 自更新（checkUpdate/downloadUpdate/applyUpdate）已于 2026-09-21 下线（FP-4）：
// fpk 升级唯一通道是 App Center UI，应用内自更新已被 hotfix 功能热更取代。
// 本模块只保留 hotfix.js 需要的 trim-cli 会话探测/登录能力，不复存在更新下载逻辑。

"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

/** trim-cli 路径：优先用应用同卷的预装路径，回退常见位置。 */
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

module.exports = { trimHasSession, trimCliLogin };