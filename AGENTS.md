# AGENTS.md

## 项目规则

本项目是 115网盘助手（p115assistant）的 fnOS 应用仓库，结构对齐
[conversun/fnos-apps](https://github.com/conversun/fnos-apps)。

### 目录约定

- `apps/p115assistant/fnos/`：FPK 包内容
  - `fnos/app/server/` + `fnos/app/ui/`：运行时，打包进 app.tgz（平铺到安装根目录）
  - `fnos/ui/`：桌面入口配置（config + images，desktop_uidir 指向）
  - `fnos/cmd/`：fnOS 生命周期脚本（覆盖 shared/cmd 同名文件）
  - `fnos/manifest`：应用清单（`install_dep_apps=nodejs_v24` 声明运行时依赖）
- `shared/cmd/` + `shared/wizard/`：通用生命周期框架（build-fpk.sh 打底）
- `scripts/apps/p115assistant/`：构建合约（meta.env / build.sh / get-latest-version.sh）
- `dist/`：构建产物（.fpk），不入 Git

### 构建

```bash
./apps/p115assistant/update_p115assistant.sh
```

### 设备验证

- 部署到 NAS：`scp dist/*.fpk nas:/tmp/` + trim-cli `app install`
- 应用数据：`/vol1/@appdata/p115assistant/`（config / upload records / logs）
- UI 资源：`/vol1/@appcenter/p115assistant/ui/`
- 后端 API：Unix socket `/vol1/@appcenter/p115assistant/app.sock`

### 安全

- `Backups/`、`.env*`、数据库转储、密钥、令牌及包含敏感信息的清单不得提交 Git
- 展示配置和日志时必须隐藏密码、令牌、密钥、Cookie、连接串凭据等敏感值
- 未经用户明确要求，不创建提交、不推送远程仓库
