# FnOS-APP

面向飞牛 fnOS 的第三方应用统一维护仓库。本仓库为 115网盘助手（p115assistant）与签到工具（checkin）的
统一维护落点（原 FnOS-APP 仓库已并入；旧版归档 `Projects/archive/fnos-apps-20260920-184738/`，
只读参考不可修改），由**一份统一更新引擎** `scripts/update.sh` 维护所有应用的构建与热更清单。

## 应用一览

| App | slug | 功能版本 | 类型 | 说明 |
|---|---|---|---|---|
| [115网盘助手](apps/p115assistant/) | `p115assistant` | 1.2.7 | micro_app（原生） | 115 网盘浏览/上传/STRM/签到/302取链 |
| [自用签到](apps/checkin/) | `checkin` | 1.8.6 | micro_app（原生） | 多站点自动签到工具 |

功能版本单一事实源 = `apps/<slug>/VERSION`；FPK 安装包版本当前 `1.0.1`（发布模型=纯热更，不走 fpk 升级；若未来启用 fpk 升级通道按官方语义随发布递增）。

## 目录布局

```text
FnOS-APP/
├── apps/<slug>/        # 应用自身（fnos 包内容 + VERSION + runtime-manifest.json）
├── shared/             # 通用生命周期框架（cmd + wizard）
├── scripts/            # 统一引擎 + 打包器 + 公共库
│   ├── update.sh       # ★ 统一更新引擎（<app> | all | list）
│   ├── build-fpk.sh    # 通用 fpk 打包器
│   ├── gen_runtime_manifest.py  # 统一热更清单生成器（--app 参数化）
│   ├── lib/build-app.sh         # 公共 app.tgz 构建函数
│   └── apps/<slug>/meta.env     # 各应用构建合约（唯一差异承载点）
├── docs/               # architecture.md（权威结构） / migration-baseline.md / add-app.md
└── dist/               # 构建产物（.fpk，不入 Git）
```

完整目录/文件职责、命名规范、模板见 [`docs/architecture.md`](docs/architecture.md)。

## 快速开始

### 构建

```bash
./scripts/update.sh list          # 列出应用
./scripts/update.sh p115assistant # 构建单个应用 → dist/p115assistant_<fpk_version>_all.fpk
./scripts/update.sh checkin       # 构建单个应用 → dist/checkin_<fpk_version>_all.fpk
./scripts/update.sh all           # 构建全部
```

产物输出到 `dist/`；构建后自动重生成对应应用的 `runtime-manifest.json`。

### 功能热更发布

```bash
# 1. 完成代码改动后，递增功能版本并同步源码版本字面量
python3 scripts/gen_runtime_manifest.py --app p115assistant --bump
# 2. 构建（fpk + 重生成热更清单）
./scripts/update.sh p115assistant
# 3. 校验热更清单与仓库一致
python3 scripts/gen_runtime_manifest.py --app p115assistant --check
```

### 新增应用

```bash
./scripts/new-app.sh <slug> "<显示名>" <port>
```

操作指南见 [`docs/add-app.md`](docs/add-app.md)。

### 安装到 fnOS

1. 将 `dist/*.fpk` 拷贝到 NAS（如 `scp dist/*.fpk nas:/vol1/1000/`）。
2. fnOS 应用中心 → 手动安装 → 选择 `.fpk`。

## 项目结构权威文档

- [`docs/architecture.md`](docs/architecture.md)：仓库结构唯一权威文档。
- [`docs/migration-baseline.md`](docs/migration-baseline.md)：从 fnos-apps 迁移的基线与结果。
- [`AGENTS.md`](AGENTS.md)：AI 协作规范与项目强制规则。
- [`CONTRIBUTING.md`](CONTRIBUTING.md)：贡献指南。
