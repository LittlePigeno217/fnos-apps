# FnOS-APP 项目强制规则

本规则适用于本仓库（`/home/LittlePigeno/WorkSpace/Projects/fnos-apps`）中的所有构建、更新、备份、迁移、清理、脚本和文档操作。受 WorkSpace 根项目规则约束。

## 仓库边界

- **本仓库是活跃统一开发仓库**（115网盘助手 p115assistant + 签到工具 checkin 的统一维护点），可正常修改、提交、推送。
- 旧版/归档仓库位于 `Projects/archive/fnos-apps-20260920-184738/`（含 .git），**该归档目录只读参考，不得修改**。
- GitHub 远端：`LittlePigeno217/fnos-apps`（默认分支 main）。发布需用户显式确认。

## 目录分类原则

所有文件按以下顺序存放：

`应用(slug) → 业务/子系统 → 文件功能 → 文件`

- `apps/<slug>/`：应用自身（fnos/ 包内容、VERSION、runtime-manifest.json、README）。
- `scripts/apps/<slug>/`：应用构建合约 meta.env（唯一差异承载点）与可选参考脚本。
- `shared/`：通用生命周期框架（cmd + wizard），跨应用共用，不放入应用私有逻辑。
- `docs/`：架构与设计文档；`dist/`：构建产物（.fpk，不入 Git）。

## 版本体系（双版本，统一规则）

| 版本 | 位置 | 语义 | 变化时机 |
|---|---|---|---|
| FPK 版本 | `fnos/manifest` `version` | fnOS 安装/升级包版本 | 随 fpk 发布递增（当前 1.0.1，勿降级） |
| 功能版本 | `apps/<app>/VERSION` + 热更清单 | 前端左下角功能版本 | 每次功能热更递增 |

- 版本号永不出现 `.10+`：patch 达 9 进位 minor（1.0.9 → 1.1.0）。
- 运行时 store.js `version` 与 index.html 占位必须与 VERSION 一致（`--bump` 自动同步）。
- 构建流程不向源码注入版本（清单 sha 与源码一致）。

## 热更发布流程（必须执行）

```bash
python3 scripts/gen_runtime_manifest.py --app <app> --bump   # 1. 递增并同步字面量
./scripts/update.sh <app>                                     # 2. 构建（可选，纯热更可不做）
python3 scripts/gen_runtime_manifest.py --app <app> --check  # 3. 校验清单一致
git add apps/<app> && git commit -m "简体中文总结"             # 4. 提交（中文提交约定）
git push origin main                                          # 5. 推送（用户要求时）
# 6. NAS 热更：等 CDN 传播（1-3 分钟）→ POST /apply_hotfix → 自动重启（root + appcenter-cli）
```

## 纪律

- 修改 NAS 运行文件前先备份到本地 `WorkSpace/Nas/<app>/Backups/<TS>/` 并校验 SHA-256。
- 展示配置和日志时隐藏密码、令牌、密钥、Cookie、连接串凭据等敏感值。
- 未经用户明确要求不创建提交、不推送远程仓库；提交信息一律简体中文。
- 远程清理前核对挂载/引用；无法确认的目录先记录 Inventory/Reports。
