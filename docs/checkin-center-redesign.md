# checkin 签到工具「签到中心模式」重构方案

> 目标：参照 NAS 中「行云 API」（xingyun-api / JoyCode2Api）的**签到中心模式**，对 checkin 应用做全面重构；同时完整保留行云 API 自身的签到能力，不破坏、不替代其本体。
>
> 本文档为**方案先行**（不含实施）。所有行云 API 侦察均为只读（GET/OPTIONS/HEAD），未做任何写操作，敏感值一律掩码，不落报告。
>
> 侦察日期：2026-09-22 · checkin 现功能版本 1.1.7（`apps/checkin/VERSION` 与 `store.js` DEFAULT_CONFIG.version 一致）

---

## Part A — 行云 API「签到中心模式」侦察结论（只读）

### A.1 应用定位

- 行云 API = **京东 JoyCode 模型在线服务平台**，二进制 `JoyCode2Api serve --skip-validation --tls=false --port 34891`。
- 本体是一个 **OpenAI 兼容代理**（`/health` 返回 `service: joycode-openai-proxy`，端点 `/v1/chat/completions`、`/v1/models`、`/v1/web-search`、`/v1/rerank`）。
- 「签到中心」是其**内置子系统**，用于把多个 AI 编码平台账号（Qoder / Trae / WB / JDHGPT / zcode / JoyCode 等）保活并领取每日额度/积分——与 checkin 面向的通用站点（影视/论坛/中转）**领域不同**。
- 前端是 React + antd 的 SPA（`/assets/index-*.js`），入口 `ui/index.html` 仅是一个「打开面板」跳转卡片；真实面板由二进制在 34891 端口直出，任意未知路径走 catch-all 回落到 index.html。

### A.2 页面与交互模式

- 入口卡片提示：「先在『账号管理』添加京东账号（扫码登录），再到『聊天』页对话，或用 API Token 接入 Claude Code」。
- 核心交互 = **账号管理 + 扫码/浏览器登录 + 签到子页 + 积分展示**，账号为一等公民（account-centric），而非站点为一等公民。

### A.3 API 组织模式（只读探测归纳）

从 SPA bundle 中提取到的端点显示出清晰的**命名空间化 REST** 结构：

| 分组 | 端点 | 作用 |
|---|---|---|
| 面板鉴权 | `/api/auth/setup`、`/api/auth/login`、`/api/auth/status`、`/api/auth/change-password` | 首次设置密码→登录→会话；`/api/*` 无 Authorization 头一律 401（`{"detail":"missing authorization header"}`，FastAPI 风格） |
| 通用账号 | `/api/accounts`、`/api/accounts/{id}`、`/api/accounts/reorder`、`/api/accounts-import`、`/api/accounts-export`、`/api/accounts-clear-all`、`/api/accounts-auto-login` | 多账号 CRUD + 导入/导出/排序/清空/自动登录 |
| **签到中心** | `/api/checkin/accounts`、`/api/checkin/accounts/{id}`、`/api/checkin/config`、`/api/checkin/points`、`/api/checkin/run` | 签到账号、签到配置、积分、执行签到 |
| 平台交互登录 | `/api/checkin/qoder_login/init`+`/status`、`/api/checkin/trae_login/init`+`/status`、`/api/checkin/wb_login/init`+`/status` | 每平台一套 `init→status` 轮询（扫码/浏览器登录，返回二维码/URL，轮询直到登录态就绪） |
| 站外登录流 | `/api/qr-login/init`+`/status`、`/api/browser-login`、`/api/oauth-submit`、`/api/jdhgpt-login/*`、`/api/zcode/login/*` | 二维码/浏览器/OAuth 登录，产出会话而非明文凭据 |
| 统计/排名 | `/api/stats`、`/api/model-ranking`、`/api/model-status`、`/api/github-stars` | 用量、模型排名与状态 |

`/api/auth/status` 为公开端点，返回 `{"initialized":true, ...}`，其余业务端点全部 401（需 Bearer/Authorization 头）。

### A.4 数据模型（只读，敏感值掩码）

- 应用数据目录 `/vol1/@appdata/xingyun-api/`：`credentials.txt`（0600，**未读取**）、`.env`（0600，**未读取**）、`app.pid`、`app_version`、`info.log`（0600）、`logs/joycode.log`（世界可读，内无签到相关明文）、`.initialized`。
- 凭据以私有文件（0600）持久化，登录态通过交互登录流产出，**不在前端暴露明文**。

### A.5 「签到中心」核心特征（提炼）

1. **账号为中心**：先建账号（扫码/浏览器登录），签到围绕账号编排，而非围绕站点。
2. **交互式登录取代明文凭据**：`*_login/init → *_login/status` 轮询模式，产出会话；面板不存/不回显明文密码 Cookie。
3. **命名空间化 REST**：`/api/checkin/{accounts,config,points,run}` + 每平台 `*_login/{init,status}`，新增平台 = 加一组同构端点。
4. **积分/奖励独立呈现**：`/api/checkin/points` 专用端点，集中展示累计收益。
5. **面板自带鉴权门槛**：`/api/auth/*` 会话鉴权，业务端点 401 保护。
6. **账号运维完备**：导入/导出/排序/清空/自动登录，多账号批量管理。

---

## Part B — checkin 现状与重构设计

### B.1 checkin 现状架构

- **运行形态**：Node.js 单进程，unix socket 挂在 fnOS 网关 `/app/checkin/action/<name>` 之后。
- **接口组织**：扁平 action 白名单（`server/main.js` 的 `ACTIONS` Map）：`get_config`/`save_config`/`status`/`run`/`test_login`/`history`/`history_clear`/`get_logs`/`clear_logs`/`check_hotfix`/`apply_hotfix`。非 REST、非命名空间。
- **站点注册**：`server/sites.js` 适配器模式（flzt / right_forum / 恩山 / ypojie / anyrouter），每适配器实现 `fields / defaultConfig / isConfigured / getAccountLabel / runCheckin / testConnection`。`ADAPTERS` 为单一事实源，同时驱动 store、server、前端 meta（新增站点前端零改动）。
- **账号模型**：每站点多账号 `accounts[]`（`id/enabled/remark` + 适配器字段）。**凭据以明文存于 `config.json`**，目录权限依赖 fnOS 应用数据目录。
- **鉴权**：无面板鉴权，完全依赖 fnOS 网关。
- **调度**：`main.js` 每 30 秒 tick，到达 `cron`（HH:MM）后全量首跑 + 每整点/半点漏签补跑（当日上限 5 次），非按账号粒度。
- **前端**：单文件 `ui/index.html`（915 行），侧栏 tab（站点/设置），服务端 meta 驱动站点卡片与编辑弹窗。无导入/导出、无交互登录、无积分面板。
- **通知**：飞书 Webhook。

### B.2 差异分析（checkin vs 签到中心模式）

| 维度 | checkin 现状 | 签到中心模式 | 差距 |
|---|---|---|---|
| 接口组织 | 扁平 action 白名单 | 命名空间化 REST `/api/checkin/*` | 中：需引入分组路由 |
| 凭据模型 | 明文 password/cookie 存 config.json | 交互登录（扫码/浏览器/OAuth）产出会话 | 大：需新增 loginFlow 契约 |
| 账号运维 | 无导入/导出/排序/清空/自动登录 | 全部具备 | 中 |
| 面板鉴权 | 无（靠网关） | `/api/auth/*` 会话门槛 | 小：可选增强 |
| 登录 UX | 静态表单字段填写 | `init→status` 轮询交互登录 | 大 |
| 积分/奖励 | 每次结果内的临时 reward 字符串 | `/api/checkin/points` 专用聚合端点 | 中 |
| 视角 | 站点为中心 | 账号为中心 | 中：前端信息架构调整 |
| 站点接入成本 | 已很低（写一个 adapter 即可） | 平台加一组 `*_login/{init,status}` | 低：现有 adapter 契约扩展即可 |

### B.3 目标架构设计

**目录结构（保持 fnos/app 布局，新增分组文件）**

```
fnos/app/server/
  main.js        # 入口 + 分组路由（保留旧 action 名作兼容别名）
  router.js      # 新增：资源分组路由表（auth / accounts / checkin / logs / hotfix）
  sites.js       # 适配器：扩展可选 loginFlow(init/status) 契约
  store.js       # 数据模型：账号增加 session 字段与导入导出序列化
  server.js      # 业务层：新增 points 聚合、账号运维方法
  auth.js        # 新增（可选）：面板会话鉴权（setup/login/status）
  notify.js httpc.js update.js hotfix.js  # 不变
ui/index.html    # 分阶段改造为账号中心 + 积分面板 + 交互登录弹窗
```

**server 接口表（对齐签到中心命名空间，旧 action 名保留为别名）**

| 新语义 | 兼容别名（现有） | 方法 | 作用 |
|---|---|---|---|
| `checkin/config`（get/save） | `get_config`/`save_config` | GET/POST | 配置读写 |
| `checkin/status` | `status` | GET | 站点/账号状态 + 今日聚合 |
| `checkin/run` | `run` | POST | 立即签到 |
| `checkin/points` | —（新增） | GET | 累计积分/奖励聚合 |
| `checkin/accounts`（list/save/reorder/import/export/clear） | 部分并入 save_config | GET/POST | 账号运维 |
| `checkin/{site}_login/init`+`/status` | —（新增） | POST/GET | 交互登录轮询（有 loginFlow 的站点） |
| `test_login`/`history`/`logs`/`hotfix` | 同名 | — | 保持 |

**sites 注册方式（扩展现有适配器契约，向后兼容）**

在现有 `fields / isConfigured / runCheckin / testConnection` 之外，新增**可选** `loginFlow`：

```js
loginFlow: {
  init(cfg)   -> { mode: 'qr'|'url'|'form', qr?, url?, token, expires },
  status(cfg, token) -> { state: 'pending'|'ready'|'expired', session? },
}
```

无 `loginFlow` 的适配器行为完全不变（仍走静态字段填写）；有的（如恩山 Cookie、anyrouter WAF 站）可提供扫码/浏览器登录，产出 session 存入账号。

**数据模型（store.js）**

- 账号结构扩展：`{ id, enabled, remark, <fields...>, session?, points_total?, last_reward? }`。
- `session` 优先于明文字段用于签到；明文字段保留为回退。
- 新增导入/导出序列化（脱敏导出：默认不含明文，可选带密导出）。

**前端页面结构（签到中心化）**

- 账号中心仪表盘：账号卡片（登录态、今日状态、累计积分）为主视图。
- 积分面板：读 `checkin/points` 聚合展示每站累计收益。
- 交互登录弹窗：`init` 拿二维码/URL → 轮询 `status` → 就绪落库。
- 历史时间线 + 实时日志（复用现有 get_logs）。

**定时编排**

- 保留现有 cron + 补签模型；账号粒度化：漏签补跑按 `账号` 而非仅 `站点` 计算 todo 集。

**迁移路径**

- `store._mergeDefaults` 已具备旧单账号→多账号迁移能力；新增 `session`/`points_total` 字段以缺省值合并，旧 config.json 无需手工迁移。

### B.4 行云 API 保留策略

- **完全不碰行云 API 本体**：它是独立 fnOS 应用（独立 slug、独立二进制、独立端口 34891、独立 `@appdata`），与 checkin（Node + unix socket）无共享运行时。
- **关系 = 并行、非侵入**：checkin **不复用**行云后端（异构运行时 + 会话鉴权，且领域不同——行云管 AI 编码平台账号保活，checkin 管影视/论坛/中转站点）。checkin 只**借鉴其签到中心的 UX/API 模式**用于自身领域。
- 行云 API 的签到功能仍是 AI 编码平台签到的唯一权威；checkin 仍是通用站点签到的权威，二者功能零重叠、互不替代。
- 可选远期：checkin 增加一个**只读**的「外部集成」卡片，展示/跳转行云签到状态（永不写入行云端点）。

### B.5 分阶段实施计划（每阶段可独立验证 + 可回滚）

**阶段 1 — API 归一 + 积分聚合（纯后端热更，前端不动）**
- 抽出 `router.js` 分组路由表，旧 action 名保留为别名（前端零改动仍可用）。
- `server.js` 新增 `points()` 聚合（从 history 汇总每站累计奖励）与账号运维方法骨架。
- 验证：现有 UI 全功能正常（别名生效）、`checkin/points` 返回聚合。
- 回滚：还原 `main.js`/`server.js`/`router.js`（热更回退，无数据变更）。

**阶段 2 — 交互式登录 + 账号运维增强**
- 适配器新增可选 `loginFlow(init/status)`；为恩山/anyrouter 提供扫码或浏览器登录产出 session。
- store 增加 `session` 字段与导入/导出/排序/清空/自动登录 action + 对应 UI。
- 验证：逐站点验证交互登录落库、导入导出往返一致；无 `loginFlow` 站点行为不变。
- 回滚：`loginFlow` 为可选契约 + 特性开关，关闭即退回明文字段填写。

**阶段 3 — 前端签到中心化 +（可选）面板鉴权**
- 前端改造为账号中心布局 + 积分面板 + 交互登录弹窗 + 历史时间线。
- 可选 `auth.js`（setup/login/status）做纵深防御，默认关闭（网关已鉴权）。
- 验证：端到端签到/登录/积分/历史全链路；旧 `index.html` 保留为回退。
- 回滚：前端为独立文件，保留旧版即可切回；auth 默认关闭不影响现网。

---

## 附：纪律确认

- 行云 API 全程只读（GET/OPTIONS/HEAD），未 POST 任何签到/登录/修改，未改其任何文件。
- 真机无写操作、无临时文件残留；敏感文件（credentials.txt/.env/info.log）未读取内容。
- 本方案不修改 checkin 代码、不 commit/push——待用户确认后再进入实施阶段。
