# 自用签到（checkin）— fnOS 应用

自用站点统一签到：**FLZT**（账号密码）、**恩山无线论坛**（Cookie）、**易破解**（账号密码）、**AnyRouter / NewAPI 通用**（Cookie / 账号，兼容 NewAPI、OneAPI 平台）。
核心能力移植自 [MoviePilot-Plugins/plugins/checkin](https://github.com/LittlePigeno217/MoviePilot-Plugins) v1.7.0 与 [anyrouter-check-in](https://github.com/LittlePigeno217/anyrouter-check-in)。

仓库路径：`apps/checkin/`（结构对齐 p115assistant，热更新机制同源）。

## 功能

- 四个站点独立启用 / 配置凭据 / 测试连接 / 手动签到
- 每日定时自动签到（`HH:MM`）+ 每 30 分钟补签巡检（当天最多 5 次，防漏签）
- 签到结果飞书机器人通知（可选）
- 签到历史记录（最近 500 条，前端展示最近 20 条）
- 免 fpk 热更新：UI 左下角「检查功能更新」

## 版本语义

| 版本 | 位置 | 含义 |
|---|---|---|
| **功能版本（左下角版本徽标）** | `apps/checkin/VERSION`（单一事实源）→ `runtime-manifest.json` 的 version | 热更清单版本；「检查功能更新」与左下角徽标使用，功能更新递增 |
| **fpk 版本** | `fnos/manifest` `version` | 安装包版本；当前 `1.0.1`。发布模型=纯热更，不走 fpk 升级（FPK 版本不随功能热更递增） |

## 开发与构建

```bash
# 构建（自动生成 fpk + 重生成热更新清单）
./scripts/update.sh checkin             # 产物 dist/checkin_<fpk_version>_all.fpk

# 清单一致性校验（发布前）
python3 scripts/gen_runtime_manifest.py --app checkin --check
```

## 发布流程（功能热更新）

1. 修改 `fnos/app/server/*.js` 或 `fnos/app/ui/*`（新增文件自动进清单）
2. `python3 scripts/gen_runtime_manifest.py --app checkin --bump`（递增功能版本 + 同步字面量）
3. 构建（可选；纯热更可不构建 fpk）：`./scripts/update.sh checkin`
4. 校验：`python3 scripts/gen_runtime_manifest.py --app checkin --check`
5. 提交并推送（runtime-manifest.json 必须随代码提交）
6. 等 CDN 传播（1-3 分钟），应用内「检查功能更新」→ 应用 → 自动重启

## 部署到 NAS

```bash
scp dist/checkin_<fpk_version>_all.fpk nas:/vol1/1000/
ssh nas "trim-cli app install-fpk --remote-path /vol1/1000/checkin_<fpk_version>_all.fpk --accept-license --yes --custom-parameters '[]'"
```

## 构建合约（scripts/apps/checkin/）

| 脚本 | 作用 |
|---|---|
| `meta.env` | 构建合约（唯一差异承载点：FILE_PREFIX / RELEASE_TITLE / DEFAULT_PORT / HOMEPAGE_URL / CATEGORY / POST_INSTALL_NOTE） |
| （统一引擎）`scripts/update.sh` | 构建 → `dist/<file_prefix>_<fpk_version>_all.fpk` + 自动重生成热更清单 |
| （统一引擎）`scripts/gen_runtime_manifest.py` | 生成/校验热更新清单（自动发现 + 注入 sha + `--check`） |
