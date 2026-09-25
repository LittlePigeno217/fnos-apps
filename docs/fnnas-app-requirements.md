# fnOS 应用开发官方要求（归纳）

> 本文件归纳自飞牛应用开放平台官方开发文档（镜像仓库 `Projects/fnnas-docs`，源 https://developer.fnnas.com/docs/guide，每日自动同步）。**应用开发、打包、发布、升级必须符合下列官方要求**；本仓库既有规范（AGENTS.md / docs/architecture.md）与之冲突时以本文件为准。
> 核对日期：2026-09-25（对应官方文档镜像 docs/ 同步至 2026-07-31 的内容）。

---

## 1. Manifest（应用包描述）

`manifest` 放在应用包根目录，无扩展名（本仓库：`apps/<slug>/fnos/manifest`）。

- `appname`：应用唯一标识（本仓库约定全小写无连字符：`p115assistant` / `checkin`）。
- `version`：fnOS 应用包版本。**官方语义：随 fpk 发布递增**（应用中心按「版本号高于已安装」判定可升级）。本仓库发布模型=**纯热更**：功能更新只升 `apps/<slug>/VERSION`，**不触碰本字段**，FPK 版本当前稳定为 `1.0.1`（不随功能热更递增，避免 fpk 版本漂移）；若未来启用 fpk 升级通道，按官方语义随 fpk 发布递增（勿降级）。见 §9 双版本体系。
- `display_name` / `desc` / `source=thirdparty`：应用中心展示信息。
- `platform`：x86 / arm / **all**（仅包内无特定架构二进制时用 all——本仓库为解释型应用，维持 all）。
- `maintainer` / `maintainer_url`：开发者信息须填写。
- `os_min_version` / `os_max_version`：**只声明实测支持过的范围，不得虚高**。
- `ctl_stop`：静态/配置型应用可 false（不显示启停）。
- `install_type`：root（系统分区）或留空（用户选择存储位置）。本仓库两应用均未声明 → 默认「用户选择存储位置」。
- `install_dep_apps`：依赖应用声明，`:` 分隔，`>` 声明最低版本（如 `database>2.2.2:cache`）。**本仓库现状**：两应用 manifest 均未声明本字段，但运行时解释器为 nodejs_v24（cmd 脚本注释与探测路径均以其为准）——依赖应用未在 manifest 声明，属已知缺口（建议声明 `install_dep_apps=nodejs_v24`，需用户确认后改 manifest，见 §9）。
- `desktop_uidir`（默认 `ui`）/ `desktop_applaunchname`（多入口时指定卡片默认入口）。
- `service_port` / `checkport`：不监听固定端口的应用可省略 service_port 或设 `checkport=false`。
- `disable_authorization_path`：应用不需要用户授权目录时 true。
- `changelog`：面向用户的简洁更新说明。
- `micro_app`：**官方文档未收录的实测字段**（装机验证有效：入口以网关模式挂载、不暴露固定端口）。置 `true` 时配合 `service_port=0`/`checkport=false` 使用；本仓库两应用均用（p115assistant / checkin manifest `micro_app=true`），勿盲目移除。对应 architecture.md §4.3 模板中的同名字段说明。

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
- 卸载逻辑尊重用户数据（是否保留由 wizard/uninstall 收集）。本仓库卸载 wizard 收集 `keep_data`，两应用覆盖的 `uninstall_callback` 不主动删除数据，去留由系统按 wizard 字段处理。

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
  - **本仓库现状偏离**：两应用 `config/privilege` 仍为 `run-as: root`（历史沿革，代码注释注明为有意选择：socket 0660 收紧 + fnOS 网关 X-Trim-* 可信头双防线）。与官方「默认 package、不建议 Root」不一致——**标注，未改造**（改造涉及文件属主/权限模型，需用户决策）。
- **资源（config/resource）**：只声明实际需要的资源；资源名版本间稳定；**不把内部工具/内部数据目录作为共享资源暴露**；用户可见共享目录须在 UI/更新说明说明。
- **中间件**：Redis / MinIO / RabbitMQ 通过 `install_dep_apps` 声明（本仓库当前不需）。
- **运行时**：声明实际使用的运行时包；生命周期脚本调用运行时命令前把运行时 bin 加入 PATH；**应用自身依赖保存在应用目录或专用虚拟环境**；在干净设备上测试确认依赖可安装。（本仓库 checkin/p115assistant 的 venv/数据隔离即此要求的落实。）

## 6. 用户向导（wizard）

- 文件：`wizard/install|upgrade|uninstall|config`。
- **字段命名**：使用稳定字段名（改名会改变环境变量名）；自定义字段用 `wizard_` 前缀；**不得使用 `TRIM_` 前缀**（系统保留）；兼容已发布版本的字段名。
  - **本仓库现状**：uninstall 向导字段为 `keep_data`（未带 `wizard_` 前缀）；若 `keep_data` 非 fnOS 保留字段，按官方要求自定义字段应改 `wizard_keep_data`。另注意 shared/cmd/common 读取的 `wizard_delete_data` 与 `keep_data` 字段名不一致（应用覆盖的 uninstall_callback 不读取前者）——**标注，未改造**（需用户确认 `keep_data` 是否为 fnOS 保留字段语义）。
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
| 功能版本与 FPK 版本分离 | `apps/<slug>/VERSION`（功能热更线，每次热更递增）+ `fnos/manifest version`（当前 1.0.1；纯热更模型下稳定不递增，避免 fpk 版本漂移；若启用 fpk 升级通道按官方语义随发布递增）双版本体系 |
| 热更清单 | `scripts/gen_runtime_manifest.py --bump/--check`（版本字面量同步 store.js/update.js/ui） |
| 生命周期脚本幂等 | shared/cmd 通用框架 + upgrade 保留 venv/data（PKGHOME） |
| 不硬编码路径 | 部署脚本统一环境变量；运行时代码禁 IP/端口硬编码（p115assistant 1.2.2 审计） |
| 运行时依赖声明 | cmd 注释声称解释器由 `install_dep_apps=nodejs_v24` 提供，但 manifest 未声明 `install_dep_apps` 字段——标注：建议补声明，需用户确认（见 §1） |
| 网关用户 Header | 写端点校验 `X-Trim-Userid` 非空（1.5.0+）；热更自动化调用方（NAS 侧 apply_hotfix 命令）以字面量 `X-Trim-Userid: deploy` 通过网关写校验——该头由外部调用方产生，仓库代码不生成 |
| 不暴露敏感文件 | 运行时不服务 @appdata 配置/密钥；展示日志遮罩密码/token/cookie |
| 版本兼容 | 配置迁移白名单（store.js `_migrateAccounts`）、恢复脚本保留 |

## 10. 测试与发布

- 开发测试建议**专用测试设备**（本仓库：249 测试机）；初始化、管理员账号、网络可达、存储可用。
- 正式发布前：打包检查 → 测试设备安装/升级/卸载验证 → 发布应用中心。
- 本仓库发布流程：commit（简体中文）→ push → CDN 传播（1-3 分钟）→ 真机 `apply_hotfix` → 验证 version 与核心功能（详见 AGENTS.md「功能热更发布流程」）。