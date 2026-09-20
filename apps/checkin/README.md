# 自用签到（checkin）— fnOS 应用

自用站点统一签到：**FLZT**（账号密码）、**恩山无线论坛**（Cookie）、**易破解**（账号密码）。
核心能力移植自 [MoviePilot-Plugins/plugins/checkin](https://github.com/LittlePigeno217/MoviePilot-Plugins) v1.7.0。

仓库路径：`apps/checkin/`（结构对齐 p115assistant，热更新机制同源）。

## 功能

- 三个站点独立启用 / 配置凭据 / 测试连接 / 手动签到
- 每日定时自动签到（`HH:MM`）+ 每 30 分钟补签巡检（当天最多 5 次，防漏签）
- 签到结果飞书机器人通知（可选）
- 签到历史记录（最近 500 条，前端展示最近 20 条）
- 免 fpk 热更新：UI 左下角「检查功能更新」

## 版本语义（注意与 p115assistant 相反）

| 版本 | 含义 |
|---|---|
| **左下角版本徽标 = 功能版本** | `runtime-manifest.json` 的 version（热更清单），初始 1.0.0，功能更新递增 |
| fpk 版本 | `fnos/manifest`（安装包版本），稳定后统一发布 |

## 开发与构建

```bash
# 构建（自动生成 fpk + 热更新清单）
./apps/checkin/update_checkin.sh            # 产物 dist/checkin_<VERSION>_all.fpk

# 清单一致性校验（发布前）
python3 scripts/apps/checkin/gen_runtime_manifest.py --check
```

## 发布流程（功能热更新）

1. 修改 `fnos/app/server/*.js` 或 `fnos/app/ui/*`（新增文件自动进清单）
2. `./apps/checkin/update_checkin.sh <VERSION>`（新功能版本号，如 1.0.1）
3. 提交并推送（runtime-manifest.json 必须随代码提交）
4. 等 CDN 传播（约 5-10 分钟），应用内「检查功能更新」→ 应用 → 自动重启

## 部署到 NAS

```bash
scp dist/checkin_1.0.0_all.fpk nas:/vol1/1000/
ssh nas "trim-cli app install-fpk --remote-path /vol1/1000/checkin_1.0.0_all.fpk --accept-license --yes --custom-parameters '[]'"
```

## 构建合约（scripts/apps/checkin/）

| 脚本 | 作用 |
|---|---|
| `build.sh` | 组装 app.tgz（server + www + ui + config），版本注入，Node 语法自检 |
| `gen_runtime_manifest.py` | 生成/校验热更新清单（自动发现 + 注入 sha + `--check`） |
| `meta.env` | 构建合约元数据 |
