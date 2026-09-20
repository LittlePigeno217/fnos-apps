# FnOS-APP 迁移基线快照

> 本文件记录从只读源仓库 `fnos-apps` 迁移到新仓库 `FnOS-APP` 前的源快照，
> 以及迁移完成后的对比结果。源仓库只读，迁移全程不修改其中任何文件。

## 1. 源仓库（只读参考源）

- 路径：`/home/LittlePigeno/WorkSpace/Projects/fnos-apps`
- 快照时间：2026-09-20（本仓库创建当日）

### 1.1 源仓库总体数据（不含 .git）

| 指标 | 值 |
|---|---|
| 文件总数（`find . -path ./.git -prune -o -type f -print \| wc -l`） | 279 |
| `git ls-files` 已跟踪数 | 143 |
| `git status --porcelain` 未提交改动行数 | 11 |
| 未提交改动性质 | 构建/清单产物（`dist/`、`runtime-manifest.json` 等），可忽略 |

### 1.2 关键文件基线 sha256

| 文件 | sha256 |
|---|---|
| `apps/p115assistant/fnos/app/server/main.js` | `f7165ee69f72193522704ef6f4f9e3f0afe30fd8ac95ab90d91ef19dafd2caca` |
| `apps/checkin/fnos/app/server/main.js` | `2d2f988b9f8d6a841cfa8e97eb245a451c91bbccf2afd81382343cbef3fc33a1` |
| `scripts/build-fpk.sh` | `cb1bb1e24e84f16306177afc3ce1dbac75fc6e4b4598519a3ea8790947d61387` |
| `scripts/apps/p115assistant/build.sh` | `a15addbbb322224a62f67c2667babca4b6ff7e7e057a45cf35a00d09b75c19ea` |

### 1.3 功能版本（VERSION 单一事实源）

| 应用 | VERSION | 说明 |
|---|---|---|
| p115assistant | `1.0.3` | 115网盘助手，FPK 版本恒 `1.0.0` |
| checkin | `1.0.5` | 自用签到，FPK 版本恒 `1.0.0` |

### 1.4 运行时源码版本字面量（与 VERSION 对齐）

| 应用 | store.js `version` | update.js `CURRENT_VERSION` |
|---|---|---|
| p115assistant | `"1.0.3"` | `process.env.P115ASSISTANT_VERSION \|\| "1.0.3"` |
| checkin | `"1.0.5"` | `process.env.CHECKIN_VERSION \|\| "1.0.5"` |

### 1.5 源仓库热更清单现状

| 应用 | runtime-manifest version | 校验 |
|---|---|---|
| p115assistant | `1.0.3`（15 个文件） | ✅ `gen_runtime_manifest.py --check` 通过 |
| checkin | `1.0.5`（9 个文件） | ✅ `gen_runtime_manifest.py --check` 通过 |

### 1.6 应用内更新通道（新仓库严禁改动）

| 应用 | UPDATE_REPO | 热更 tag 前缀 |
|---|---|---|
| p115assistant | `LittlePigeno217/fnos-apps` | `p115assistant/v` |
| checkin | `LittlePigeno217/fnos-apps` | `checkin/v` |

> 新仓库本轮不建立 GitHub 发布通道，`update.js` / `store.js` 中指向
> `LittlePigeno217/fnos-apps` 的发布通道与 tag 前缀**原样保留**。

## 2. 迁移范围与允许差异

从源复制到新仓库的内容：

- `shared/`（cmd + wizard）原样复制，逐文件 sha256 一致。
- `apps/p115assistant/`（fnos/、icon/、VERSION、runtime-manifest.json、README.md、CHANGELOG.md）。
- `apps/checkin/`（fnos/、VERSION、runtime-manifest.json、README.md）。
- `scripts/build-fpk.sh` 原样复制。
- `scripts/apps/p115assistant/{meta.env, get-latest-version.sh, release-notes.tpl}`。
- `scripts/apps/checkin/meta.env`。

允许差异（迁移时的刻意适配，见下）：
1. **删除**新仓库中每应用的 `update_<app>.sh`（由统一引擎 `scripts/update.sh` 替代）。
2. **删除**每应用的 `scripts/apps/<app>/build.sh` 与 `gen_runtime_manifest.py`（逻辑收敛进
   `scripts/update.sh` + `scripts/lib/build-app.sh` + `scripts/gen_runtime_manifest.py`）。
3. **URL 适配**：`fnos/manifest` 的 `distributor_url` 与 `scripts/apps/<app>/meta.env` 的
   `HOMEPAGE_URL` 改为新仓库占位 `https://github.com/LittlePigeno217/FnOS-APP`。
   `maintainer_url`（用户主页 `https://github.com/LittlePigeno217`）保留原值。
4. 新增根级文档与 `docs/` 规划文档（架构/基线/新增应用指南）。

其余文件与源逐文件 sha256 一致。

## 3. 迁移完成对比结果

（完成于 2026-09-20，Step 8 回填）

### 3.1 文件数与目录自洽

- 新仓库文件总数（不含 .git）：**114**（含 `dist/` 2 个 fpk 产物；git 已跟踪 111）
- 与源 `apps/p115assistant/` 的 `diff -r` 结论：仅允许差异
  （`fnos/manifest` 的 `distributor_url` 改 FnOS-APP 占位 + `update_p115assistant.sh` 已删除）
- 与源 `apps/checkin/` 的 `diff -r` 结论：仅允许差异（同上）
- 与源 `shared/` 的 `diff -r` 结论：**IDENTICAL**（13 个文件，逐文件 sha256 一致）
- `scripts/build-fpk.sh`：**IDENTICAL**
- 逐文件 sha256 比对：**94 个迁移文件与源 byte-identical**（排除允许差异）
- 两应用的 `update.js` / `store.js`：**原样保留**（指向 `LittlePigeno217/fnos-apps` 的
  `UPDATE_REPO` 与 tag 前缀 `p115assistant/v`、`checkin/v` 未改动）

### 3.2 保留差异清单

| # | 文件 | 差异类型 | 说明 |
|---|---|---|---|
| 1 | `apps/p115assistant/update_p115assistant.sh` | 删除 | 由统一引擎 `scripts/update.sh p115assistant` 替代 |
| 2 | `apps/checkin/update_checkin.sh` | 删除 | 由统一引擎 `scripts/update.sh checkin` 替代 |
| 3 | `scripts/apps/{p115assistant,checkin}/build.sh` | 删除 | 收敛进 `scripts/lib/build-app.sh`（公共构建函数） |
| 4 | `scripts/apps/{p115assistant,checkin}/gen_runtime_manifest.py` | 删除 | 收敛进 `scripts/gen_runtime_manifest.py`（`--app` 参数化） |
| 5 | `apps/{p115assistant,checkin}/fnos/manifest` | URL 字段 | `distributor_url` → `https://github.com/LittlePigeno217/FnOS-APP`（占位）；`maintainer_url` 保留 |
| 6 | `scripts/apps/{p115assistant,checkin}/meta.env` | URL 字段 | `HOMEPAGE_URL` → `https://github.com/LittlePigeno217/FnOS-APP`（占位） |
| 7 | `.gitignore` | 增强 | 追加 `!**/meta.env`：源仓库 `*.env` 规则把 meta.env 忽略（源仓库未跟踪），
      但新仓库 meta.env 是统一引擎的应用注册/构建合约（唯一差异承载点），**必须入库** |
| 8 | （新增） | 文档/脚本 | `docs/architecture.md`、`docs/migration-baseline.md`、`docs/add-app.md`、
      `README.md`、`AGENTS.md`、`CLAUDE.md`、`CONTRIBUTING.md`、
      `scripts/update.sh`、`scripts/lib/build-app.sh`、`scripts/gen_runtime_manifest.py`、
      `scripts/new-app.sh` |

另注：按允许差异之外的字节比对，`runtime-manifest.json` 经 `update.sh` 重建后仅
`generated_at` 变化，`version` 与 `files` 全量 sha 不变；提交时保留与源 byte-identical 版本。

### 3.3 构建验证

| 应用 | dist 产物（大小） | 产物 sha256 | fpk 内 server/main.js 与源一致 |
|---|---|---|---|
| p115assistant | `dist/p115assistant_1.0.0_all.fpk`（407189 B） | `72431fb4f47bc3e174bb4c6226ad5e38a5d9d2cf7b58710d4df41f18b421f8db` | ✅ `f7165e…2caca` |
| checkin | `dist/checkin_1.0.0_all.fpk`（126945 B） | `d2b8dd6224d984ac9ddeec3bdc21bd51f24fee17731970e12d0c4d2d9e15853b` | ✅ `2d2f988…33a1` |

- 统一引擎验证：`./scripts/update.sh list` / `p115assistant` / `checkin` / `all` 全部真跑通过；
  构建后 `apps/<slug>/runtime-manifest.json` version 与 `VERSION` 一致（1.0.3 / 1.0.5）。
- 热更清单校验：`gen_runtime_manifest.py --app <slug> --check` 两应用均 ✅。
- fpk 解包抽查：两 fpk 内 `server/main.js` sha256 与源逐字一致；`config/bootstrap/`
  `<slug>-version.env` 内容为 `<SLUG>_VERSION=1.0.0`，与源构建行为一致。
- 仓库根无 `app.tgz` 残留；`git status` 干净（`dist/` 被忽略）。
