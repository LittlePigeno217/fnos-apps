# fnos-apps 仓库规范

本仓库是 115网盘助手（p115assistant）与 签到工具（checkin）的 fnOS 应用仓库，
结构对齐 [conversun/fnos-apps](https://github.com/conversun/fnos-apps)。

## 目录架构

```
fnos-apps/
├── apps/
│   ├── p115assistant/            # 115网盘助手
│   │   ├── VERSION               # 功能版本（热更发布单一事实源，--bump 递增）
│   │   ├── runtime-manifest.json # 热更新清单（由 gen_runtime_manifest.py 生成，不入手工改）
│   │   ├── fnos/                 # FPK 包内容
│   │   │   ├── manifest          # 应用清单（display_name / version=FPK 版本 / install_dep_apps=nodejs_v24）
│   │   │   ├── app/
│   │   │   │   ├── server/       # 后端运行时（打包进 app.tgz → server/）
│   │   │   │   └── ui/           # 前端运行时（打包进 app.tgz → www/）
│   │   │   ├── ui/               # 桌面入口配置（config + images）
│   │   │   ├── cmd/              # fnOS 生命周期脚本（覆盖 shared/cmd 同名文件）
│   │   │   ├── config/           # privilege / resource 权限声明
│   │   │   ├── wizard/           # install/upgrade/config/uninstall 向导
│   │   │   └── ICON.PNG / ICON_256.PNG
│   │   └── icon/                 # 图标矢量源（icon.svg + render-icon.sh）
│   ├── checkin/                  # 签到工具（结构同上）
│   └── ...（后续应用照此模板）
├── shared/cmd/ + shared/wizard/  # 通用生命周期框架（build-fpk.sh 打底）
├── scripts/apps/<app>/           # 构建合约（meta.env / build.sh / get-latest-version.sh）
│   └── gen_runtime_manifest.py   # 热更清单生成（版本管理核心，见下）
└── dist/                         # 构建产物（.fpk），不入 Git
```

## 版本体系（双版本）

| 版本 | 位置 | 语义 | 变化时机 |
|---|---|---|---|
| FPK 版本 | `fnos/manifest` `version` | fnOS 安装/升级包版本 | 重装/升级 fpk |
| 功能版本 | `apps/<app>/VERSION` + 热更清单 `version` | 前端左下角显示的功能版本 | **每次功能热更发布递增** |

- FPK 版本与功能版本相互独立；热更新只推进功能版本，不动 fpk 版本
- 运行时源码中 store.js 的 `version` 与 update.js 的 `CURRENT_VERSION` 默认值
  必须与 VERSION 一致（--bump 自动同步，保证热更下载 sha 校验通过）

## 功能热更发布流程（必须执行）

```bash
# 1. 完成代码改动后，递增功能版本并生成清单（自动同步源码版本字面量）
python3 scripts/apps/<app>/gen_runtime_manifest.py --bump
# 2. 校验清单与仓库一致
python3 scripts/apps/<app>/gen_runtime_manifest.py --check
# 3. 提交推送（清单 + VERSION + 源码）
git add apps/<app> scripts/apps/<app>
git commit && git push
# 4. 等 CDN 传播（约 1-3 分钟）后，应用内「检查功能更新」→「应用」→ 自动重启
```

注意：发布前必须 `--check` 通过；CDN 传播窗口内应用热更新可能报
「SHA-256 校验失败」，等 1-2 分钟重试即可（代码已带换源重试）。

## 构建 FPK

```bash
./apps/p115assistant/update_p115assistant.sh   # 构建 → dist/*.fpk + 自动生成清单
./apps/checkin/update_checkin.sh
```

## 设备验证

- 部署到 NAS：`scp dist/*.fpk nas:/vol1/1000/` + trim-cli `app install-fpk --remote-path`
- 应用数据：`/vol1/@appdata/<app>/`（config / 上传记录 / 日志 / patches 热更记录）
- UI 资源：`/vol1/@appcenter/<app>/ui/`；后端 API：Unix socket `/vol1/@appcenter/<app>/app.sock`
- 打开应用 404 排查：网关以 `/app/<app>` 前缀转发，后端须剥离前缀（main.js handle）

## 安全

- `Backups/`、`.env*`、数据库转储、密钥、令牌及包含敏感信息的清单不得提交 Git
- 展示配置和日志时必须隐藏密码、令牌、密钥、Cookie、连接串凭据等敏感值
- 未经用户明确要求，不创建提交、不推送远程仓库
