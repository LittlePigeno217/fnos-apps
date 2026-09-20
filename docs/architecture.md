# FnOS-APP 架构规划

> 本文档是 FnOS-APP 仓库结构的**唯一权威文档**。实现与本文档不一致时，以本文档为准；
> 若实现有合理理由偏离，必须改本文档并记录原因。
> 建立日期：2026-09-20。

## 0. 背景与目标

参照 `fnos-apps` 现有应用更新机制，建立统一维护与更新 fnOS 应用功能的新仓库。
两个已确认决策（不可改）：

1. **全新独立仓库**：`FnOS-APP` 与 `fnos-apps` 并存；应用代码整体复制过去；
   `fnos-apps` 保持现状完全不动（只读参考源）。
2. **统一单一更新引擎**：一份 `scripts/update.sh` 管所有应用（单应用 + all 两种模式），
   各应用仅保留 meta/配置差异（单一事实源），不再每应用一份重复的 update/build 脚本。

迁移的存量应用：
- `p115assistant`（115网盘助手，功能版本 1.0.3）
- `checkin`（自用签到，功能版本 1.0.5）

## 1. 顶层目录树

```text
FnOS-APP/
├── apps/                        # 应用目录：只含应用自身与 meta 差异
│   ├── p115assistant/           # 115网盘助手
│   │   ├── VERSION              # 功能版本单一事实源（--bump 递增）
│   │   ├── runtime-manifest.json# 热更新清单（gen_runtime_manifest.py 生成，不手工改）
│   │   ├── README.md            # 应用说明（保真复制）
│   │   ├── CHANGELOG.md         # 变更记录（保真复制）
│   │   ├── fnos/                # FPK 包内容（manifest / app / cmd / config / ui / wizard / ICON*.PNG）
│   │   └── icon/                # 图标矢量源（icon.svg + render-icon.sh）
│   └── checkin/                 # 签到工具（结构同上，无 CHANGELOG/icon）
├── shared/                      # 通用生命周期框架（cmd + wizard，原样复制自 fnos-apps）
│   ├── cmd/                     # install/upgrade/uninstall/config 生命周期回调
│   └── wizard/                  # 向导模板
├── scripts/                     # 统一引擎 + 打包器 + 公共库
│   ├── update.sh                # ★ 统一更新引擎（<app> | all | list）
│   ├── build-fpk.sh             # 通用 fpk 打包器（shared 打底 + app 覆盖；原样复制）
│   ├── gen_runtime_manifest.py  # ★ 统一热更清单生成器（--app 参数化，唯一事实源）
│   ├── new-app.sh               # 新应用脚手架（适配统一引擎的新结构）
│   ├── lib/
│   │   └── build-app.sh         # ★ 公共构建函数：生成 app.tgz（server+www+ui+config+bootstrap env）
│   └── apps/
│       ├── p115assistant/
│       │   ├── meta.env         # 构建合约（唯一差异承载点）
│       │   ├── get-latest-version.sh   # 保留参考（旧式上游解析；统一引擎不使用）
│       │   └── release-notes.tpl       # 保留参考（旧式发布模板；统一引擎不使用）
│       └── checkin/
│           └── meta.env         # 构建合约
├── docs/                        # 规划与记录
│   ├── architecture.md          # ★ 本文件
│   ├── migration-baseline.md    # 迁移基线快照 + 迁移结果对比
│   └── add-app.md               # 新增应用操作指南
├── dist/                        # 构建产物（.fpk），不入 Git
├── README.md                    # 仓库总览 + 快速开始
├── AGENTS.md                    # AI 协作规范
├── CLAUDE.md                    # 项目强制规则（设备/备份/安全约定）
└── CONTRIBUTING.md              # 贡献指南（指向 docs/add-app.md）
```

## 2. 目录/文件职责表

### 2.1 `apps/<slug>/`（应用目录）

| 目录/文件 | 职责 | 该放什么 | 不该放什么 |
|---|---|---|---|
| `apps/<slug>/fnos/` | FPK 包内容 | `manifest`、`app/{server,ui}` 运行时、`cmd/` 生命周期覆盖、`config/` 权限声明、`ui/` 桌面配置、`wizard/` 向导、`ICON*.PNG` | 构建脚本、临时文件 |
| `apps/<slug>/VERSION` | **功能版本单一事实源** | 纯版本号 `x.y.z`（无换行后空白），`--bump` 递增 | 其他任何内容 |
| `apps/<slug>/runtime-manifest.json` | 热更新清单 | 由 `gen_runtime_manifest.py` 生成 | 手工修改 |
| `apps/<slug>/README.md` / `CHANGELOG.md` | 应用说明与变更记录 | 应用自身文档 | 仓库级文档 |
| `apps/<slug>/icon/` | 图标矢量源 | `icon.svg` + `render-icon.sh` | 构建产物 |
| `apps/<slug>/update_<slug>.sh` | ❌ 不允许存在 | — | 每应用更新脚本（统一引擎替代） |

### 2.2 `shared/`（通用生命周期框架）

| 目录 | 职责 | 该放什么 | 不该放什么 |
|---|---|---|---|
| `shared/cmd/` | fnOS 生命周期回调（install/upgrade/uninstall/config 的 init 与 callback、main、common、installer） | 通用脚本，`build-fpk.sh` 打底 | 应用私有逻辑 |
| `shared/wizard/` | 向导模板 | 通用安装向导（uninstall） | 应用定制向导（放 `apps/<slug>/fnos/wizard/`） |

### 2.3 `scripts/`（引擎与工具）

| 目录/文件 | 职责 | 该放什么 | 不该放什么 |
|---|---|---|---|
| `scripts/update.sh` | **统一更新引擎**：`<app> \| all \| list` | 公共流程编排（见 §5） | 应用构建逻辑 |
| `scripts/build-fpk.sh` | 通用 fpk 打包器 | shared 打底 + app 覆盖 → `.fpk` | 版本管理逻辑 |
| `scripts/gen_runtime_manifest.py` | 统一热更清单生成器（`--app <slug>` 参数化） | 清单 sha/size 计算、VERSION 读写、源码字面量同步 | 应用私有常量 |
| `scripts/new-app.sh` | 新应用脚手架 | 生成符合本架构的目录与 meta.env 模板 | 生成 update/build 脚本 |
| `scripts/lib/build-app.sh` | 公共 app.tgz 构建函数 | 由 `update.sh` source 调用 | 独立执行入口 |
| `scripts/apps/<slug>/meta.env` | **各应用构建合约（唯一差异承载点）** | FILE_PREFIX / RELEASE_TITLE / DEFAULT_PORT / HOMEPAGE_URL / CATEGORY / POST_INSTALL_NOTE / VERSION_ENV（可选） | 构建逻辑 |
| `scripts/apps/<slug>/` 其他 | 应用私有无逻辑差异 | get-latest-version.sh / release-notes.tpl 等保留参考 | build.sh / gen 脚本（已收敛） |

### 2.4 `docs/` 与根文档

| 文件 | 职责 |
|---|---|
| `docs/architecture.md` | 仓库结构唯一权威文档（本文件） |
| `docs/migration-baseline.md` | 迁移基线快照 + 迁移后对比结果 |
| `docs/add-app.md` | 新增应用操作指南 |
| `README.md` | 仓库总览、目录布局、快速开始（构建/更新/新增应用/发布流程） |
| `AGENTS.md` / `CLAUDE.md` | AI 协作规范与项目强制规则 |
| `CONTRIBUTING.md` | 贡献指南（指向 add-app.md） |

### 2.5 `dist/`

| 目录 | 职责 |
|---|---|
| `dist/` | 构建产物 `.fpk`，**不入 Git**（.gitignore 忽略）；保留当前构建结果 |

## 3. 命名规范

### 3.1 应用 slug

- 小写字母数字 + 连字符：`^[a-z0-9]+(-[a-z0-9]+)*$`。
- 目录名与 slug 一致：`apps/<slug>/`、`scripts/apps/<slug>/`。
- 存量应用 slug：`p115assistant`、`checkin`（已确认，不可改）。

### 3.2 manifest 字段规范（`apps/<slug>/fnos/manifest`）

| 字段 | 语义 | 规范 |
|---|---|---|
| `appname` | 安装包应用名 | = slug，`^[a-z0-9-]+$` |
| `display_name` | 桌面显示名 | 人类可读中文名 |
| `version` | **FPK 版本**（安装包维度） | 随 fpk 发布递增，**非强制 `1.0.0`**（fpk 升级只认「版本号高于已安装」）；功能热更走功能版本，不走 fpk 升级 |
| `platform` | 目标平台 | `all` |
| `distributor_url` | 分发渠道 | 本轮为新仓库占位 `https://github.com/LittlePigeno217/FnOS-APP` |
| `maintainer_url` | 维护者主页 | `https://github.com/LittlePigeno217`（保留） |
| `checksum` | app.tgz 校验 | 构建时由 build-fpk.sh 写入 |

### 3.3 fpk 文件名模式

- 由 `build-fpk.sh` 生成：`<appname>_<manifest_version>_<platform>.fpk`
- `manifest_version` 直接取应用自身 `fnos/manifest` 的 `version`，随 fpk 发布递增，
  **不强制 `1.0.0`**（`scripts/update.sh` 读 manifest 实值并原样传入 `build-fpk.sh`）。
- 本仓库 file_prefix 与 slug 一致（`FILE_PREFIX=<slug>`）；若某应用需要不同前缀，
  在 meta.env 的 `FILE_PREFIX` 声明，dist 产物命名遵循 `<file_prefix>_<ver>_all.fpk`。

### 3.4 热更 tag 前缀模式（未来 GitHub Release 约定）

- 格式：`<slug>/v<feature_version>`，例如 `p115assistant/v1.0.4`、`checkin/v1.0.6`。
- 应用内 `update.js` 的 `UPDATE_REPO` 与 tag 前缀由应用自身维护，**本轮严禁改动**。

### 3.5 VERSION 与 runtime-manifest.json 约定

- `apps/<slug>/VERSION`：功能版本单一事实源（热更发布 `--bump` 递增）。
- `apps/<slug>/runtime-manifest.json`：热更清单，`version` 字段与 VERSION 一致，
  由 `gen_runtime_manifest.py` 生成与校验。
- 运行时源码字面量：`store.js` 的 `version` 与 `update.js` 的 `CURRENT_VERSION`
  必须与 VERSION 一致（`--bump`/显式版本自动同步，保证热更 sha 校验收敛）。

## 4. 通用模板

### 4.1 新应用脚手架（`scripts/new-app.sh` 输出结构）

```text
apps/<slug>/
├── VERSION                  # 初始 0.0.1
├── fnos/
│   ├── manifest             # appname/display_name/version=<fpk_version>/...（见 3.2）
│   ├── app/server/          # 后端运行时（Node 源码，入口 main.js）
│   ├── app/ui/              # 前端运行时（打包进 www/）
│   ├── ui/config + images/  # 桌面入口配置
│   ├── cmd/                 # 生命周期覆盖（可留空由 shared 打底）
│   ├── config/{privilege,resource}
│   ├── wizard/              # 向导（可留空由 shared 打底）
│   └── ICON.PNG / ICON_256.PNG
├── README.md                # 应用说明
└── CHANGELOG.md             # 变更记录
scripts/apps/<slug>/
└── meta.env                 # 构建合约
```

### 4.2 meta.env 模板与字段含义

```bash
# <slug> 构建合约（本地项目，无外部上游 release）
FILE_PREFIX=<slug>                          # dist 产物文件名前缀（默认 = slug）
RELEASE_TITLE="应用显示名"                   # 发布标题
DEFAULT_PORT=0                              # 默认端口（0 = 不暴露端口，micro_app）
HOMEPAGE_URL=https://github.com/LittlePigeno217/FnOS-APP
CATEGORY=media                              # 应用分类（media/utility/tool…）
POST_INSTALL_NOTE="安装后的操作提示"          # 安装完成引导文案
# VERSION_ENV=<SLUG>_VERSION                # 可选：版本 env 变量名，默认 `<SLUG_UPPER>_VERSION`
```

### 4.3 manifest 模板

```text
appname         = <slug>
version         = <fpk_version>    # FPK 版本：随 fpk 发布递增，非强制 1.0.0
display_name    = <display_name>
platform        = all
maintainer      = LittlePigeno
maintainer_url  = https://github.com/LittlePigeno217
distributor     = LittlePigeno
distributor_url = https://github.com/LittlePigeno217/FnOS-APP
os_min_version  = 1.2.0401
desktop_uidir   = ui
desktop_applaunchname = <slug>.main
service_port    = 0
checkport       = false
ctl_stop        = true
micro_app       = true
desc            = <应用描述>
source          = thirdparty
checksum        =
```

### 4.4 新增应用操作指南

见 `docs/add-app.md`（也是 CONTRIBUTING.md 的主体）。

## 5. 统一更新引擎设计（`scripts/update.sh`）

### 5.1 用法

```bash
./scripts/update.sh list          # 列出已注册应用（apps/<slug>/fnos/manifest 存在）
./scripts/update.sh <slug>        # 构建单个应用
./scripts/update.sh all           # 构建全部应用
./scripts/update.sh help          # 帮助
```

### 5.2 版本来源（单一事实源）

| 版本 | 来源 | 用途 |
|---|---|---|
| FPK 版本 | `apps/<slug>/fnos/manifest` `version` | 构建 fpk 时直接采用 manifest 实值（**非强制 `1.0.0`**） |
| 功能版本 | `apps/<slug>/VERSION` | 生成热更清单（**不**覆盖 VERSION 文件） |

> 与旧 `update_<app>.sh` 的差异：旧脚本把 manifest 的 FPK 版本（1.0.0）直接传给
> `gen_runtime_manifest.py`，会把功能版本**误覆盖为 1.0.0**（潜在回归 bug）。
> 新引擎构建流程只读 VERSION 文件生成清单，绝不写 VERSION；递增只能通过
> `gen_runtime_manifest.py --bump`（发布流程）。

### 5.3 公共流程（单应用）

```text
1. 校验应用注册（apps/<slug>/fnos/manifest 存在；scripts/apps/<slug>/meta.env 存在）
2. 读取 meta.env（FILE_PREFIX 等）
3. 读取 FPK 版本（manifest version，直接采用，不强制 1.0.0）
4. 读取功能版本（apps/<slug>/VERSION）
5. 调 scripts/lib/build-app.sh 的 build_app_tgz()：
      server ← fnos/app/server;  www ← fnos/app/ui
      ui ← fnos/ui;  config ← fnos/config
      写 config/bootstrap/<slug>-version.env（<SLUG>_VERSION=<fpk_version>）
      不向源码注入版本；node --check 语法自检（node 在 PATH 时）
      → 仓库根 app.tgz（用完即删）
6. cd 仓库根 → scripts/build-fpk.sh <app_dir> app.tgz <fpk_version>
      → 产出 <slug>_<fpk_version>_all.fpk（build-fpk.sh 自取 appname/platform 命名）
7. mv 产物 → dist/<file_prefix>_<ver>_all.fpk
8. rm app.tgz（中间产物不留在仓库根）
9. python3 scripts/gen_runtime_manifest.py --app <slug>   # 用 VERSION 文件重新生成清单
10. 校验 runtime-manifest.json 的 version == VERSION 文件
```

### 5.4 各应用差异如何表达（meta.env）

- FILE_PREFIX / RELEASE_TITLE / CATEGORY / POST_INSTALL_NOTE → meta.env 字段。
- 版本 env 变量名（`P115ASSISTANT_VERSION` / `CHECKIN_VERSION`）默认由 slug 推导
  （`<SLUG_UPPER>_VERSION`），如有个别差异用 meta.env `VERSION_ENV` 覆盖。
- 其余全部收敛进引擎/公共库，per-app 只留 meta.env（与可选参考脚本）。

### 5.5 脚本收敛边界（保留 per-app 的理由）

- **build.sh 已完全收敛**：两个应用的 build.sh 差异（p115 固定 1.0.0 强校验 vs checkin
  可覆盖版本；p115 不注入源码版本 vs checkin 注入）统一为「FPK 版本取 manifest 实值（非强制
  1.0.0）+ 不注入源码版本」的规范行为（对照 fnos-apps 现有机制要点中「不再向源码注入版本」的
  既定结论）。
  注意：这是对 checkin 旧行为的有意修正——旧 checkin build.sh 把 FPK 版本（1.0.0）sed
  进 store.js/update.js，导致**安装后源码与 runtime-manifest（按源码原样 sha）永久不一致**，
  热更永远提示「有更新」；统一后以仓库源码字面量（= 功能版本）为准，热更可收敛。
- **gen_runtime_manifest.py 已收敛为单一公共脚本**（`--app` 参数化）。四个应用私有常量
  （ROOT / MANIFEST_PATH / VERSION_FILE / VERSION_ENV）均可由 slug 推导，无需 per-app 副本。
- **保留 per-app 参考脚本**：`scripts/apps/p115assistant/{get-latest-version.sh,
  release-notes.tpl}` 为旧式上游解析/发布模板参考，统一引擎不使用，仅存档参考（不重复逻辑）。

## 6. 统一发布流程设计（`docs/update-flow.md` 并入本文）

### 6.1 功能热更发布全链路

```text
改代码 → gen_runtime_manifest.py --bump
       → （VERSION +1，同步 store.js/update.js 字面量）
       → update.sh <slug>（构建 fpk + 重生成清单）
       → gen_runtime_manifest.py --check
       → 提交推送 → 应用内「检查功能更新」
```

对应命令：

```bash
# 1. 完成代码改动后，递增功能版本并同步源码字面量
python3 scripts/gen_runtime_manifest.py --app p115assistant --bump
# 2. 构建（fpk + 清单重生成）
./scripts/update.sh p115assistant
# 3. 校验清单与仓库一致
python3 scripts/gen_runtime_manifest.py --app p115assistant --check
# 4. 提交推送（本轮不 push，纯本地）
git add -A && git commit
```

### 6.2 未来 GitHub Release 接入约定（本轮只设计，不落地）

- **tag 前缀**：`<slug>/v<feature_version>`（应用内 update.js 已按此前缀过滤 Release）。
- **latest.json**：`dist/latest.json` 聚合各应用最新 fpk 下载地址（参照旧仓库命名）。
- **Actions 参数化设计**：workflow 输入 `<app>`，复用引擎公共流程
  `./scripts/update.sh <app>` → 上传 `dist/<file_prefix>_<ver>_all.fpk` →
  打 tag `<slug>/v<feature_version>` → 生成 `dist/latest.json`。
- **发布通道仍指向 `LittlePigeno217/fnos-apps`**：在新仓库启用 GitHub 发布前，应用内
  `UPDATE_REPO` 与 tag 前缀一律不变；切换发布通道需单独评估并同步改 update.js。

## 7. 安全与纪律（延续 fnos-apps）

- `dist/`、`app.tgz`、`*.fpk`、`*.env`（含 `!*.env.example`）、`Backups/`、`backups/` 不入 Git。
- 展示配置和日志时隐藏密码、令牌、密钥、Cookie、连接串凭据。
- 未经用户明确要求，不创建提交、不推送远程仓库。
- 修改远程设备前强制备份到 `设备/业务/Backups/`（含时间戳），生成 SHA-256 清单。
