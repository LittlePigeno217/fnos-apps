# 新增应用操作指南

本文档描述如何向本仓库（fnos-apps，115网盘助手/签到工具统一维护点，原 FnOS-APP 已并入）新增一个 fnOS 应用，并接入统一更新引擎。
结构规范以 [`architecture.md`](architecture.md) 为准。

## 1. 前提

- 具备应用的可运行 Node 后端（`fnos/app/server/`）与前端（`fnos/app/ui/`）。
- 了解双版本体系：FPK 版本（`fnos/manifest` `version`，当前 1.0.1，随 fpk 发布递增；当前发布模型=纯热更不走 fpk 升级）；功能版本（`VERSION` 文件）走热更递增。
- 仓库为本地仓库，本轮**不配置 remote、不 push**；发布通道约定见 architecture.md §6.2。

## 2. 脚手架

```bash
./scripts/new-app.sh <slug> "<显示名>" <port>
# 示例
./scripts/new-app.sh jellyfin "Jellyfin 媒体服务器" 8096
```

生成结构：

```text
apps/<slug>/
├── VERSION                  # 功能版本单一事实源（初始 0.0.1）
├── fnos/
│   ├── manifest             # appname/display_name/version=<fpk_version>/...
│   ├── app/server/          # 后端运行时（入口 main.js）
│   ├── app/ui/              # 前端运行时（打包进 www/）
│   ├── ui/config + images/  # 桌面入口配置
│   ├── cmd/                 # 生命周期覆盖（可留空，由 shared/cmd 打底）
│   ├── config/{privilege,resource}
│   ├── wizard/              # 向导（可留空，由 shared/wizard 打底）
│   └── ICON.PNG / ICON_256.PNG   # 待放置
├── README.md
└── CHANGELOG.md
scripts/apps/<slug>/
└── meta.env                 # 构建合约（唯一差异承载点）
```

## 3. 填充清单

### 3.1 图标

- 放置 `apps/<slug>/fnos/ICON.PNG` 与 `ICON_256.PNG`（构建时自动生成 `ui/images/256.png`）。
- 可参照 `apps/p115assistant/icon/`（`icon.svg` + `render-icon.sh`）维护矢量源。

### 3.2 运行时

- `fnos/app/server/`：Node 后端源码，入口 `main.js`，需处理 fnOS 网关 `/app/<slug>` 前缀剥离。
- `fnos/app/ui/`：前端运行时（`index.html` 等），构建打包为 `www/`。
- 可选：`fnos/cmd/` 覆盖生命周期脚本（否则用 `shared/cmd/` 打底）；
  `fnos/wizard/` 覆盖向导（否则用 `shared/wizard/` 打底）。

### 3.3 manifest

按 architecture.md §3.2 规范填写。关键字段：

| 字段 | 值 |
|---|---|
| `appname` | = slug |
| `version` | FPK 版本（取 manifest 实值，随 fpk 发布递增；当前发布模型=纯热更，维持 1.0.1 勿降级） |
| `platform` | `all` |
| `distributor_url` | `https://github.com/LittlePigeno217/fnos-apps`（当前统一仓库远端） |
| `desktop_applaunchname` | `<slug>.main`（须与后端微应用名一致） |
| `service_port` | 按需（0 = 不暴露端口） |

### 3.4 meta.env

按 architecture.md §4.2 模板。必填 `FILE_PREFIX`（默认 = slug）、`RELEASE_TITLE`；
`CATEGORY`、`POST_INSTALL_NOTE`、`HOMEPAGE_URL` 按需。
若版本 env 变量名与默认 `<SLUG_UPPER>_VERSION` 不同，用 `VERSION_ENV` 覆盖。

## 4. 构建与校验

```bash
./scripts/update.sh <slug>        # 构建 → dist/<file_prefix>_<fpk_version>_all.fpk + 重生成清单
python3 scripts/gen_runtime_manifest.py --app <slug> --check   # 清单一致性
```

构建前确认：

- `apps/<slug>/VERSION` 存在且为 `x.y.z`（构建流程只读，不写）。
- manifest `version` = 取实值（`build-fpk.sh` 原样使用；引擎不强制 1.0.0，见 architecture.md §5.2）。
- `fnos/app/server`、`fnos/app/ui`、`fnos/ui` 三个目录存在（公共构建函数要求）。

## 5. 功能热更发布（接入统一引擎后）

```bash
# 1. 改代码
# 2. 递增功能版本 + 同步 store.js/update.js 字面量
python3 scripts/gen_runtime_manifest.py --app <slug> --bump
# 3. 构建
./scripts/update.sh <slug>
# 4. 校验
python3 scripts/gen_runtime_manifest.py --app <slug> --check
# 5. 提交
git add -A && git commit
```

## 6. 应用内更新 URL 与 tag 前缀（重要）

- 应用内 `update.js` 的 `UPDATE_REPO` 与热更 tag 前缀 `<slug>/v<版本>` 由应用自身维护。
- **接入本仓库后严禁改动**（本轮发布通道仍指向 `LittlePigeno217/fnos-apps`）。
- 未来在新仓库启用 GitHub 发布时，需同步更新 `UPDATE_REPO` 与 tag 约定（见 architecture.md §6.2）。

## 7. 安全提醒

- 不得提交：`dist/`、`*.fpk`、`app.tgz`、`*.env`（meta.env 例外，必须入库）、`Backups/`。
- 应用配置中的凭据（如 115 cookie/tokens）必须加密落盘，不得明文入库。
