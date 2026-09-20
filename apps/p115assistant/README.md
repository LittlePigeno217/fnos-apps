# 115网盘助手（p115assistant）— fnOS 应用

本地自研 fnOS 应用：115 网盘上传、STRM 生成、签到、302 中转播放、飞书通知。

仓库路径：`apps/p115assistant/`（打包内容在 `fnos/` 下，结构与 conversun/fnos-apps 对齐）。

## 版本双轨制（重要）

| 版本 | 位置 | 含义 |
|---|---|---|
| **fpk 版本** | `fnos/manifest` → 构建注入 `config/bootstrap/p115assistant-version.env` | 安装包版本；应用中心与 UI 左下角显示（`get_config.fpk_version`） |
| **功能版本** | `runtime-manifest.json` 的 `version` | 应用内功能热更新版本；「检查功能更新」使用 |

**规则**：功能版本 ≤ fpk 版本时表示功能已收敛（无热更差异）。日常功能开发只提功能版本（改代码 → 生成清单 → 推送 → 热更），无需频繁发 fpk；fpk 版本在功能版本稳定后统一发布。

## 热更新机制

- **清单**：`apps/p115assistant/runtime-manifest.json`（version / generated_at / files{安装相对路径: sha256, size}）
- **映射规则**（hotfix.js `rawRel` 与 gen 脚本同源）：
  - 安装 `server/*.js` ← 仓库 `apps/p115assistant/fnos/app/server/*.js`
  - 安装 `www/*` ← 仓库 `apps/p115assistant/fnos/app/ui/*`
- **下载源**：raw.githubusercontent.com 直连，失败自动回退 ghproxy.net / ghproxy.com 镜像（公开只读代码，无敏感）
- **安全**：路径白名单（仅 server/ www/）+ 拒绝路径穿越；下载后 SHA-256 校验（与清单不符不落盘）
- **回滚**：替换前备份到 `Backups/`（应用数据目录），SHA-256 校验失败自动回滚
- **生效**：应用功能文件后自动重启（后端）或刷新（前端）；UI 左下角「检查功能更新」入口

## 发布流程（热更新）

```bash
# 1. 修改 fnos/app/server|ui 下运行时文件
# 2. 构建（自动生成 fpk + 热更新清单，同版本）
./apps/p115assistant/update_p115assistant.sh
# 3. 推送仓库（runtime-manifest.json 必须随代码一起提交）
git add apps/p115assistant && git commit && git push
# 4. 等 CDN 传播（约 5-10 分钟），NAS 上「检查功能更新」收敛为「已是最新」
```

> 新增运行时文件：server/*.js 或 app/ui/* 自动被清单发现（gen 脚本自动扫描），无需手动注册；
> 唯一例外是 `server/package.json`（依赖清单，不属于热更文件）。

## 发布流程（fpk 安装包）

```bash
./apps/p115assistant/update_p115assistant.sh     # 产物 dist/p115assistant_<VERSION>_all.fpk
scp dist/*.fpk nas:/tmp/
trim-cli app install-fpk /tmp/p115assistant_<VERSION>_all.fpk --accept-license --yes --custom-parameters "[]"
```

## 安全边界（威胁模型）

> 以下描述的是当前**实际**具备的安全属性，供部署与风险评估参考，非承诺性保证。

- **凭据加密 = 混淆而非防护**：cookie / tokens / fnos_password 用 Fernet
  （AES-128-CBC + HMAC-SHA256）加密落盘，但密钥种子（`p115liteassistant_redirect_secret.json`，
  经 PBKDF2 派生密钥）与密文**同在一个数据目录**。对能读取该目录的本地攻击者，种子与密文
  同时可得，「加密存储」不构成实质保护。它只防「意外读取 / 备份被拖走明文」这类场景；
  真正的部署侧防护是数据目录权限最小化（`0o700`）与运行账号 root 化。
- **302 播放中转暴露面**：`/redirect` 中转监听绑定 `0.0.0.0:<relay_port>`（默认 `3667`），对
  所在网段全部网卡开放。请求靠 **HMAC 签名 + 每 IP 60 req/60s 限流**保护，无用户名/密码认证
  （播放器直连取链的用例所需）。它不是开放代理（无有效签名不转发生效），但可被局域网内端口
  扫描探测。若 NAS 直连不可信网段（客用 Wi-Fi / 公网），建议在防火墙或路由器层面把
  `<relay_port>` 的入站访问限制到受信 VLAN / 网段。
- **`get_config` 不泄露敏感值**：响应只下发 `PUBLIC_CONFIG_FIELDS` 白名单字段，cookie /
  tokens / fnos_password 永不下发，feishu_webhook 掩码显示（真机验证）。

## 本地校验

```bash
# 清单与仓库一致性校验（发布前跑）
python3 scripts/apps/p115assistant/gen_runtime_manifest.py --check
```

## 构建合约（scripts/apps/p115assistant/）

| 脚本 | 作用 |
|---|---|
| `build.sh` | 组装 app.tgz（server + www + ui + config），版本注入（store.js/update.js/version.env），Node 语法自检 |
| `gen_runtime_manifest.py` | 生成/校验热更新清单（自动发现 + 双向映射校验；`--check` 模式供 CI） |
| `update_p115assistant.sh` | 一键：build.sh → build-fpk.sh → dist/ 输出 → 自动生成热更新清单 |
