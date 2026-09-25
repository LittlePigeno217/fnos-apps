# fnOS 应用开发官方要求（归纳）

> 本文件归纳自飞牛应用开放平台官方开发文档（镜像仓库 `Projects/fnnas-docs`，源 https://developer.fnnas.com/docs/guide，每日自动同步）。**应用开发、打包、发布、升级必须符合下列官方要求**；本仓库既有规范（AGENTS.md / docs/architecture.md）与之冲突时以本文件为准。
> 核对日期：2026-09-25（对应官方文档镜像 docs/ 同步至 2026-07-31 的内容）。

---

## 1. Manifest（应用包描述）

`manifest` 放在应用包根目录，无扩展名（本仓库：`apps/<slug>/fnos/manifest`）。

- `appname`：应用唯一标识（本仓库约定全小写无连字符：`p115assistant` / `checkin`）。
- `version`：fnOS 应用包版本（本仓库 FPK 版本**恒 1.0.0**，功能版本走 VERSION 热更线，见 §9）。
- `display_name` / `desc` / `source=thirdparty`：应用中心展示信息。
- `platform`：x86 / arm / **all**（仅包内无特定架构二进制时用 all——本仓库为解释型应用，维持 all）。
- `maintainer` / `maintainer_url`：开发者信息须填写。
- `os_min_version` / `os_max_version`：**只声明实测支持过的范围，不得虚高**。
- `ctl_stop`：静态/配置型应用可 false（不显示启停）。
- `install_type`：root（系统分区）或留空（用户选择存储位置）。
- `install_dep_apps`：依赖应用声明，`:` 分隔，`>` 声明最低版本（如 `database>2.2.2:cache`）。
- `desktop_uidir`（默认 `ui`）/ `desktop_applaunchname`（多入口时指定卡片默认入口）。
- `service_port` / `checkport`：不监听固定端口的应用可省略 service_port 或设 `checkport=false`。
- `disable_authorization_path`：应用不需要用户授权目录时 true。
- `changelog`：面向用户的简洁更新说明。

## 2. 应用框架与目录结构（安装后 `/var/apps/{appname}/`）

| 目录 | 含义 |
|---|---|
| `target → /vol{n}/@appcenter/{appname}` | 已安装应用文件（运行时束） |
| `etc → @appconf` | 应用配置 |
| `var → @appdata` | **重启后保留的运行数据** |
| `tmp → @apptemp` / `home → @apphome` | 临时 / 用户数据 |
| `shares` | `config/resource` 声明的共享目录 |
| `cmd/` | 生命周期脚本 |
| `wizard/` | install/upgrade/uninstall/config 用户表单 |

**不得硬编码路径**——一律使用 `TRIM_APPDEST`、`TRIM_PKGETC`、`TRIM_PKGVAR` 等环境变量。

### 生命周期脚本（cmd/）
- `install_init` / `install_callback`、`main`（start/stop/status）、`upgrade_init` / `upgrade_callback`、`uninstall_init` / `uninstall_callback`、`config_init` / `config_callback`。
- **脚本必须可重复执行**（安装/升级/配置可能被重新执行，本仓库 upgrade 时 venv/data 保留逻辑即为此设计）。
- `cmd/main` status 退出码：**0=运行中，3=未运行**，其他失败。
- 升级脚本适合做数据迁移/配置迁移/兼容性检查（可能先停应用、升级后再启动）。
- 卸载逻辑尊重用户数据（是否保留由 wizard/uninstall 收集）。

## 3. 环境变量（官方清单，节选与本仓库相关项）

- `TRIM_APPNAME` / `TRIM_APPVER` / `TRIM_OLD_APPVER` / `TRIM_APP_STATUS`（INSTALL/START/UPGRADE/UNINSTALL/STOP/CONFIG）
- `TRIM_APPDEST`（target）/ `TRIM_PKGETC`（配置）/ `TRIM_PKGVAR`（运行数据）/ `TRIM_PKGTMP` / `TRIM_PKGHOME` / `TRIM_PKGMETA` / `TRIM_APPDEST_VOL`
- `TRIM_USERNAME` / `TRIM_GROUPNAME` / `TRIM_UID` / `TRIM_GID` / `TRIM_RUN_USERNAME` / `TRIM_RUN_GROUPNAME`（专用用户/执行用户）
- `TRIM_DATA_ACCESSIBLE_PATHS`：用户授权的可访问路径，`:` 分隔
- **`TRIM_API_TOKEN`：应用调用开放 API 时的认证 token**（本仓库曾误用它派生 302 落盘密钥——官方语义是 API 认证，**不得复用为数据加密密钥**，1.2.4 已解耦）
- `TRIM_TEMP_LOGFILE`：用户可见错误日志（生命周期脚本）

## 4. 统一网关（gateway-registration）

- 访问模型选型：统一网关适合**常驻服务 / WebSocket / API**；网关路径 `/app/{appname}[/{customPath}]`。
- **工作方式**：fnOS 校验用户会话 → 转发到 Unix Socket（`gatewaySocket` 只填文件名如 `app.sock`，位于 target 目录，脚本用 `${TRIM_APPDEST}` 定位）。“发送到网关路径的请求会先由飞牛 fnOS 校验，再转发到应用本地 Unix Socket”。
- 字段规则：`protocol`/`port` 对网关入口**被忽略**；`gatewayPrefix` 用 `/app/{appname}` 或加稳定子路径，**版本间保持稳定、公开路径避免点号**；Socket 文件在 target 下。
- **应用要求**：
  - 服务监听 gatewaySocket 的 Unix Socket；HTTP 与 WebSocket 路由都保持在 gatewayPrefix 下。
  - **不要信任客户端传入的用户 ID**——用网关节转发来的鉴权 Header。
  - 读取文件/执行用户相关操作前验证请求路径和输入。
- **用户上下文 Header（网关可信身份）**：
  - `X-Trim-Userid`（UID，如 1000）/ `X-Trim-Isadmin`（true/false）/ `X-Trim-Username`（如 admin）
  - 应用仍负责自己的业务鉴权。
- **WebSocket**：复用同一网关前缀+Socket；连接建立时获得同身份上下文；连接绑定 X-Trim-Userid；**不要信任消息中的客户端用户 ID**。
- **鉴权与安全（必须执行）**：
  - 用户只能访问自己的数据；管理接口需管理员身份；高风险操作明确鉴权；文件路径/记录 ID 结合当前用户校验。
  - 网关文件访问：标准化路径、拒绝 `..` 穿越、只从预期目录提供、**不暴露密钥/数据库/配置文件/私有日志**。
  - OAuth 等公开回调路径保持窄而明确，未鉴权路径只开放所需方法与数据。
- 官方文档未提及网关会改写 Host/X-Forwarded-* ——本仓库 CSRF 校验实践：同源判定以「Origin 与请求 Host 的主机名比较（忽略端口）」+「fnOS 官方隧道域（`.fnconnect.net` / `.5ddd.com`）豁免」+「socket 直连无 Origin 放行（由 X-Trim-Userid 把关）」为准（见 p115assistant main.js `sameOriginOk`）。

## 5. 权限与资源

- **权限**：默认 `run-as=package`（专用应用用户，非 root）；仅在访问特定用户组保护资源时 `join-groups`；**不建议 Root 模式**（放大 Web/API/后台/第三方依赖风险）；用户文件访问须用户明确授权目录。
- **资源（config/resource）**：只声明实际需要的资源；资源名版本间稳定；**不把内部工具/内部数据目录作为共享资源暴露**；用户可见共享目录须在 UI/更新说明说明。
- **中间件**：Redis / MinIO / RabbitMQ 通过 `install_dep_apps` 声明（本仓库当前不需）。
- **运行时**：声明实际使用的运行时包；生命周期脚本调用运行时命令前把运行时 bin 加入 PATH；**应用自身依赖保存在应用目录或专用虚拟环境**；在干净设备上测试确认依赖可安装。（本仓库 checkin/p115assistant 的 venv/数据隔离即此要求的落实。）

## 6. 用户向导（wizard）

- 文件：`wizard/install|upgrade|uninstall|config`。
- **字段命名**：使用稳定字段名（改名会改变环境变量名）；自定义字段用 `wizard_` 前缀；**不得使用 `TRIM_` 前缀**（系统保留）；兼容已发布版本的字段名。
- **设计**：只询问所需值；提供合理默认；简短标签+清晰校验；**密钥类用 password 类型**；**不将密钥写入日志**；生命周期脚本使用前再次校验。

## 7. 图标与入口

- 包图标：根目录 `ICON.PNG` + `ICON_256.PNG`，单文件 ≤ 1024 KB；圆角矩形风格、64px 仍清晰。
- 入口配置 `app/ui/config`；入口 ID 稳定并以 appname 前缀（如 `myapp.main`）；`images/icon_{0}.png` 对应 `icon_64.png`/`icon_256.png` 需齐。

## 8. 工具链

- **fnpack**：下载/创建项目/打包/打包检查（构建期检查如缺失 ICON 会报错）。
- **appcenter-cli**（设备上）：`install-fpk <app>.fpk [--env config.env]`、`install-local`（从项目目录快速安装）、`default-volume`、`list`、`start|stop`、应用管理。
- **安全**：含账号/密码/token 的 wizard 环境变量文件**不得提交代码仓库**（本仓库 `.env*`/Backups 不入 Git 的同一原则）。

## 9. 本仓库开发流程对照

| 官方要求 | 本仓库落实 |
|---|---|
| 功能版本与 FPK 版本分离 | `apps/<slug>/VERSION`（功能热更线）+ `fnos/manifest version`（恒 1.0.0）双版本体系 |
| 热更清单 | `scripts/gen_runtime_manifest.py --bump/--check`（版本字面量同步 store.js/update.js/ui） |
| 生命周期脚本幂等 | shared/cmd 通用框架 + upgrade 保留 venv/data（PKGHOME） |
| 不硬编码路径 | 部署脚本统一环境变量；运行时代码禁 IP/端口硬编码（p115assistant 1.2.2 审计） |
| 网关用户 Header | 写端点校验 `X-Trim-Userid`（1.5.0+），热更带 `X-Trim-Userid: deploy` |
| 不暴露敏感文件 | 运行时不服务 @appdata 配置/密钥；展示日志遮罩密码/token/cookie |
| 版本兼容 | 配置迁移白名单（store.js `_migrateAccounts`）、恢复脚本保留 |

## 10. 测试与发布

- 开发测试建议**专用测试设备**（本仓库：249 测试机）；初始化、管理员账号、网络可达、存储可用。
- 正式发布前：打包检查 → 测试设备安装/升级/卸载验证 → 发布应用中心。
- 本仓库发布流程：commit（简体中文）→ push → CDN 传播（1-3 分钟）→ 真机 `apply_hotfix` → 验证 version 与核心功能（详见 AGENTS.md「功能热更发布流程」）。