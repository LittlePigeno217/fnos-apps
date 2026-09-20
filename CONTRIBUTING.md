# 贡献指南

## 新增应用

完整操作指南见 [`docs/add-app.md`](docs/add-app.md)。流程要点：

```bash
# 1. 脚手架：生成 apps/<slug>/ 与 scripts/apps/<slug>/meta.env
./scripts/new-app.sh <slug> "<显示名>" <port>

# 2. 按 docs/add-app.md 填充 fnos/ 包内容（manifest / app 运行时 / cmd / config / ui / wizard / ICON*）

# 3. 检查是否可构建
./scripts/update.sh <slug>
python3 scripts/gen_runtime_manifest.py --app <slug> --check
```

## 修改应用代码

改 `apps/<slug>/fnos/app/` 下运行时源码后，按功能热更发布流程：

```bash
python3 scripts/gen_runtime_manifest.py --app <slug> --bump   # 递增功能版本 + 同步字面量
./scripts/update.sh <slug>                                    # 构建 fpk + 重生成清单
python3 scripts/gen_runtime_manifest.py --app <slug> --check  # 校验
```

## 提交纪律

- 不得提交：`dist/`、`app.tgz`、`*.fpk`、`*.env`、`Backups/`、`backups/`。
- 提交信息末尾附真实署名行（由开发会话指定）。
- 未经明确要求，不创建提交、不推送远程仓库。