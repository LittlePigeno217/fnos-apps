# 115网盘助手 fnOS App 仓库

面向飞牛 fnOS 的第三方应用打包仓库（结构对齐
[conversun/fnos-apps](https://github.com/conversun/fnos-apps)）。

## 应用一览

| App | 类型 | 说明 | 构建 |
| --- | --- | --- | --- |
| [115网盘助手](apps/p115assistant/) | micro_app（原生）| 115 网盘浏览/上传/STRM/签到/302取链 | `./apps/p115assistant/update_p115assistant.sh` |

## 安装

1. 下载 [Release](https://github.com/LittlePigeno217/fnos-apps/releases) 中的 `.fpk` 文件
2. 在 fnOS 应用中心选择「手动安装」
3. 上传 `.fpk` 并完成安装（依赖 `nodejs_v24`，安装时自动就绪）

## 本地构建

```bash
cd apps/p115assistant && ./update_p115assistant.sh
```

构建产物统一输出到仓库根目录 `dist/`。

## 项目结构

```text
fnos-apps/
├── apps/                      # 各应用的 fnOS 包定义与构建脚本
│   └── p115assistant/
│       ├── fnos/              # FPK 内容（manifest / cmd / config / ui / wizard / app 运行时）
│       ├── update_p115assistant.sh
│       ├── README.md / CHANGELOG.md
│       └── var/               # 种子数据（可选）
├── shared/                    # 通用生命周期脚本与向导模板
├── scripts/
│   ├── build-fpk.sh           # 通用 fpk 打包器（shared 打底 + app 覆盖）
│   ├── new-app.sh             # 新应用脚手架
│   ├── apps/<app>/            # 每个应用的构建合约（meta.env + build.sh + get-latest-version.sh）
│   └── lib/                   # 共享构建函数
├── apps.json                  # 商店索引
├── recommended.json
├── docs/ / test/
└── dist/                      # 构建产物（.fpk）
```

## 新增应用（维护者）

```bash
./scripts/new-app.sh <app-slug> "<display-name>" <port>
```

## 约定

- `apps/<app>/fnos/cmd/` 覆盖 `shared/cmd/` 同名脚本（fnOS 生命周期）
- `apps/<app>/fnos/app/` 为运行时（打包进 app.tgz，平铺到安装根目录）
- `apps/<app>/fnos/ui/` 为桌面入口配置（desktop_uidir 指向）
- `install_dep_apps = nodejs_v24` 声明 Node 运行时依赖
