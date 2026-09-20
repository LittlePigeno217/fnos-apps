# FnOS-APP 仓库规范（AI 协作）

本仓库是 115网盘助手（p115assistant）与 签到工具（checkin）的 fnOS 应用统一维护仓库，
由 `scripts/update.sh` 统一引擎驱动。结构权威文档见 `docs/architecture.md`。

## 目录架构（与 fnos-apps 的关键差异）

```
FnOS-APP/
├── apps/<slug>/            # 应用自身：fnos/ 包内容 + VERSION + runtime-manifest.json
│   ├── VERSION             # 功能版本单一事实源（--bump 递增）
│   ├── runtime-manifest.json # 热更清单（gen_runtime_manifest.py 生成，不手工改）
│   └── fnos/
│       ├── manifest        # appname/display_name/version(=FPK 版本恒 1.0.0)/...
│       ├── app/server/     # 后端运行时（打包进 app.tgz → server/）
│       ├── app/ui/         # 前端运行时（打包进 app.tgz → www/）
│       ├── ui/             # 桌面入口配置（config + images）
│       ├── cmd/ config/ wizard/ ICON*.PNG
├── shared/cmd/ + shared/wizard/  # 通用生命周期框架（build-fpk.sh 打底）
├── scripts/
│   ├── update.sh           # ★ 统一更新引擎（<app> | all | list）
│   ├── build-fpk.sh        # 通用 fpk 打包器
│   ├── gen_runtime_manifest.py  # ★ 统一热更清单生成器（--app <slug> 参数化）
│   ├── lib/build-app.sh    # 公共 app.tgz 构建函数
│   └── apps/<slug>/meta.env    # 构建合约（唯一差异承载点）
└── dist/                   # 构建产物（.fpk），不入 Git
```

**每应用不再有** `update_<app>.sh`、`scripts/apps/<app>/build.sh`、
`scripts/apps/<app>/gen_runtime_manifest.py` —— 全部收敛进统一引擎/公共脚本。

## 版本体系（双版本，沿用 fnos-apps）

| 版本 | 位置 | 语义 | 变化时机 |
|---|---|---|---|
| FPK 版本 | `fnos/manifest` `version` | fnOS 安装/升级包版本 | **恒 1.0.0**，功能更新不走 fpk 升级 |
| 功能版本 | `apps/<app>/VERSION` + 热更清单 `version` | 前端左下角显示的功能版本 | **每次功能热更发布递增** |

- 运行时源码中 store.js 的 `version` 与 update.js 的 `CURRENT_VERSION` 默认值
  必须与 VERSION 一致（`--bump` 自动同步，保证热更下载 sha 校验通过）。
- 构建流程**不向源码注入版本**（保证清单 sha 与源码一致）。

## 统一引擎用法

```bash
./scripts/update.sh list            # 列出应用
./scripts/update.sh <app>           # 构建单个应用 → dist/<app>_1.0.0_all.fpk
./scripts/update.sh all             # 构建全部
```

## 功能热更发布流程（必须执行）

```bash
# 1. 完成代码改动后，递增功能版本并生成清单（自动同步源码版本字面量）
python3 scripts/gen_runtime_manifest.py --app <app> --bump
# 2. 构建
./scripts/update.sh <app>
# 3. 校验清单与仓库一致
python3 scripts/gen_runtime_manifest.py --app <app> --check
# 4. 提交推送（本轮纯本地，不 push）
git add apps/<app> scripts/apps/<app> scripts/gen_runtime_manifest.py scripts/update.sh
git commit
```

注意：发布前必须 `--check` 通过。

## 构建 FPK

```bash
./scripts/update.sh all      # 构建全部 → dist/*.fpk + 自动重生成清单
```

## 设备验证

- 部署到 NAS：`scp dist/*.fpk nas:/vol1/1000/` + trim-cli `app install-fpk --remote-path`
- 应用数据：`/vol1/@appdata/<app>/`（config / 上传记录 / 日志 / patches 热更记录）
- UI 资源：`/vol1/@appcenter/<app>/ui/`；后端 API：Unix socket `/vol1/@appcenter/<app>/app.sock`
- 打开应用 404 排查：网关以 `/app/<app>` 前缀转发，后端须剥离前缀（main.js handle）

## 安全

- `dist/`、`app.tgz`、`*.fpk`、`*.env`、`Backups/`、`backups/` 不入 Git
- 展示配置和日志时必须隐藏密码、令牌、密钥、Cookie、连接串凭据等敏感值
- 未经用户明确要求，不创建提交、不推送远程仓库
