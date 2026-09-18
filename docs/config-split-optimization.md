# 115网盘助手：配置项归属优化分析（前端 vs 运行设置）

> 评审基准：v1.1.0 代码。源码：`apps/p115assistant/fnos/{wizard/config, app/ui/index.html, app/server/store.js, app/server/server.js, app/server/update.js}`。
> 结论以「代码是否真正接线 / 操作频率 / 安全敏感度 / 是否需即时反馈 / 平台表单能力」五把尺子衡量。

## 结论摘要（最值得改的前 5 点）

1. **`login_client_type` 应从运行设置移除** —— 它在代码里其实是被登录流程自动写回的**记录型字段**（扫码时选渠道 → `checkLogin`/`_onTokensChanged` 自动回写 `config.login_client_type`），不是用户该手动设的前置偏好。留在运行设置既多余又会让用户误改（改了也会在下次登录后被覆写）。建议隐藏由登录流程接管，登录状态芯片展示即可。
2. **`link_redirect_mode` 当前是“死配置”** —— 它在 `DEFAULT_CONFIG` 和 wizard 都有，但全代码**无任何一处读取它**（STRM 走的是固定 302 跳转，`link` 接口的 mode 来自请求参数而非配置）。放着它只会让用户改了没效果。建议在真正接线前从运行设置移除/隐藏，或先给它接线。
3. **`watch_enabled` 存在双入口，应统一到前端** —— 上传 tab 已有「开始/停止监听」按钮（`watcher_start`/`watcher_stop` 直接写回 `watch_enabled`，且有实时状态反馈），wizard 里又放了一个 `watch_enabled` switch。两个入口写同一配置，叠加“保存并重启按表单覆盖 + switch 显示可能不一致”的平台坑，极易错乱。建议 wizard 删除该字段，由前端按钮统一控制。
4. **上传/附属扩展名（`upload_media_extensions`、`upload_sidecar_extensions`）应放回前端上传 tab 的折叠“高级”块** —— 默认值已覆盖常见格式，普通用户不需要看到一长串；只有进阶用户要自定义（NAS 特有格式、附加元数据）。放进上传 tab 的折叠区比 wizard 的一行 text 更贴合“可视化、按需展开”，且与 `upload_include_sidecars` 联动清晰。
5. **STRM 删除 6 键（`strm_delete_*`×5 + `strm_notify` + `life_monitor_enabled`）当前完全未接线**，建议**在功能实现前保持隐藏默认**、不要补任何 UI。待功能落地后再按“安全敏感、低频”归类到运行设置（会删数据，绝不适合放前端）。

---

## 一、当前划分核对（v1.1.0 实际源码）

### 前端保留（已在 `index.html`）
| 区块 | 内容 | 配置键 |
|---|---|---|
| 上传 tab | `upload_mappings` 映射卡片 + 开始/停止监听按钮 + 指定目录上传一次 | `upload_mappings`、`watch_enabled`(写) |
| STRM tab | `strm_mappings` 映射卡片 + `strm_base_url` 输入框 + 立即同步/对指定目录生成一次 | `strm_mappings`、`strm_base_url` |
| 签到 tab | 手动签到按钮 + 只读时段显示（读 `checkin_time_range`） |（只读 `checkin_time_range`）|
| 设置 tab | 仅更新区块 + 当前版本 |（展示 `version`）|
| 媒体库 tab | 账本 + 云端核对 + 清理失效 STRM |（无配置键）|
| 历史 tab | 历史 + 上传身份冲突逐条处理 |（`upload_conflict_policy=ask` 时挂清单）|

### 运行设置（wizard/config，16 字段）
`enabled`、`rate_limit_profile`、`login_client_type`、`link_redirect_mode`、`watch_enabled`、`upload_include_sidecars`、`upload_generate_strm`、`upload_delete_source`、`upload_conflict_policy`、`upload_risk_profile`、`strm_incremental`、`checkin_enabled`、`checkin_time_range`、`checkin_notify`、`feishu_enabled`、`feishu_webhook`

### 未进入任何配置面（DEFAULT_CONFIG 有、wizard 无）
`upload_media_extensions`、`upload_sidecar_extensions`、`strm_delete_cloud_on_missing`、`strm_delete_sweep_cron`、`strm_delete_watch`、`strm_delete_confirm_threshold`、`strm_notify`、`life_monitor_enabled`

---

## 二、全量配置键逐项分析

> 说明：任务描述称约 35 键，经核对 `DEFAULT_CONFIG` 实际为 **30 个键**。下表全覆盖，无省略。

| # | 配置键 | DEFAULT | 推荐位置 | 理由 |
|---|---|---|---|---|
| 1 | `enabled` | false | **运行设置**（保持） | 总开关，低频一次性。关闭即停登录/上传/签到。符合“设好不动”。 |
| 2 | `version` | "1.1.0" | 隐藏/内部（保持） | 非用户配置，不参与持久化合并（`getConfig` 特例）；前端设置页展示即可。 |
| 3 | `rate_limit_profile` | balanced | **运行设置**（保持） | 全局限流档位，偏好类，设好不动。 |
| 4 | `cookie` | "" | 隐藏/内部（保持） | 敏感，扫码登录写入，Fernet 落盘，不进 UI。 |
| 5 | `tokens` | {} | 隐藏/内部（保持） | 敏感，登录回写，Fernet 落盘，不进 UI。 |
| 6 | `login_client_type` | "" | **移除 → 登录流程自动接管** ⚠ | 登录时扫码渠道即选定并自动回写；非手动偏好。见争议 2。 |
| 7 | `link_redirect_mode` | cookie | **临时移除/接线后再放** ⚠ | 全代码无读取点，当前 UI 是死字段。见争议 3。 |
| 8 | `upload_mappings` | [] | **前端**（保持） | 映射类、高频、可视化，完全符合前端。 |
| 9 | `upload_include_sidecars` | true | **运行设置**（保持） | 上传偏好，低频；与扩展名联动见争议 4。 |
| 10 | `upload_generate_strm` | false | **运行设置**（保持） | 上传行为偏好，低频。 |
| 11 | `upload_delete_source` | false | **运行设置**（保持） | 涉及删除，安全敏感，低频。保留并强化 tips。 |
| 12 | `upload_conflict_policy` | ask | **运行设置**（保持） | 偏好类；`ask` 时前端历史 tab 逐条处理，策略选择放运行设置合适。 |
| 13 | `upload_media_extensions` | .mp4,.mkv,… | **前端上传 tab 高级折叠** ⚠ | 进阶自定义；默认值够用，不必常驻。见争议 4。 |
| 14 | `upload_sidecar_extensions` | .nfo,.jpg,… | **前端上传 tab 高级折叠** ⚠ | 同 13，与 `upload_include_sidecars` 联动。 |
| 15 | `strm_mappings` | [] | **前端**（保持） | 映射类，可视化，选择 115 源/输出目录，前端最合适。 |
| 16 | `strm_incremental` | true | **运行设置**（保持，STRM 组） | 偏好，低频。 |
| 17 | `strm_base_url` | "" | **前端 STRM tab**（保持） | 取链服务地址，与映射操作强上下文相关，需即时反馈；不依赖重启路径。见争议 1。 |
| 18 | `strm_delete_cloud_on_missing` | false | 隐藏默认（保持）⚠ | 未接线；未来实现后归运行设置（涉删除，安全敏感）。 |
| 19 | `strm_delete_sweep_cron` | "" | 隐藏默认（保持）⚠ | 未接线；未来实现后归运行设置。 |
| 20 | `strm_delete_watch` | false | 隐藏默认（保持）⚠ | 未接线；未来实现后归运行设置。 |
| 21 | `strm_delete_confirm_threshold` | 16 | 隐藏默认（保持）⚠ | 未接线；未来实现后归运行设置（安全阈值）。 |
| 22 | `strm_notify` | false | 隐藏默认（保持）⚠ | 未接线；未来实现后归运行设置（STRM 组）。 |
| 23 | `checkin_enabled` | false | **运行设置**（保持） | 签到开关，低频。 |
| 24 | `checkin_time_range` | 06:00-09:00 | **运行设置**（保持） | 定时性质，设好不动；前端只读展示已足够。见争议 5。 |
| 25 | `checkin_notify` | false | **运行设置**（保持） | 偏好，低频。 |
| 26 | `life_monitor_enabled` | false | 隐藏默认（保持）⚠ | 未接线；未来实现后再定归属。 |
| 27 | `feishu_webhook` | "" | **运行设置**（保持）⚠ | 敏感凭据，必须运行设置；标注平台坑（密码不回显，留空=不变）。 |
| 28 | `feishu_enabled` | false | **运行设置**（保持） | 通知偏好的控制系统开关。 |
| 29 | `watch_enabled` | false | **移除 wizard → 前端按钮统一** ⚠ | 前端已有即时按钮，避免双入口。见结论 3。 |
| 30 | `upload_risk_profile` | conservative | **运行设置**（保持） | 上传风控档位，偏好，低频。 |

**说明 ⚠ 表示相对 v1.1.0 有变化的项目**（共 7 项：6、7、13、14、29 有归属建议，18–22、26 为“继续隐藏待接线”）。

---

## 三、争议项专项评估（正反两面）

### 争议 1：`strm_base_url` 该放前端还是运行设置？
- **放前端（STRM tab）的理由**：它是生成 `.strm` 内容的 `{base_url}/redirect?…` 前缀，与 STRM 映射操作**强上下文相关**；用户在 STRM tab 里建映射、点同步、填地址一气呵成。改完**立即生效**（下次同步即用），不需要走运行设置“编辑→保存并重启”的深路径。且它的值会被 `strm_status` 每次进 tab 回填，前端显示不易失真。
- **放运行设置的理由**：它本质是“应用对外访问地址”，是固定、低频、设好就不动的服务参数，符合“偏好类进运行设置”。而且它不带即时反馈需求。
- **结论：保持前端（STRM tab）**。五把尺子里“即时反馈 + 上下文相关”权重占优。建议给它加一条 tips：“改为固定服务地址，改动后对**新生成**的 STRM 生效，已生成的需重新同步”。若未来要进运行设置，落地建议见第五部分（给出 `text` 字段 + tips）。**不建议同时放两处**（避免值分叉）。

### 争议 2：`login_client_type` / `link_redirect_mode` 放运行设置，还是登录流程自动选择？
- **`login_client_type`**：
  - **代码事实**：扫码弹窗的渠道按钮（支付宝/微信/安卓/iOS/网页/PAD/TV）直接发起 `qrcode(client_type=…)`；登录成功后 `checkLogin` 与 `_onTokensChanged` 都会自动写回 `config.login_client_type = client.clientType`。也就是说它**由登录流程自动维持**，是记录型状态，不是前置选择。
  - 反方（为何曾有运行设置）：给用户一个默认客户端类型，理论上可让“无渠道选择”时更稳。
  - 正方（应移除）：手动改会被下次登录覆写；普通用户不理解这玩意。登录状态芯片已展示当前 `client_type`。
  - **结论：从运行设置移除**，隐藏默认即可，由登录流程接管；front-end 登录状态 chip 展示。若坚持保留，至少附加 tips“通常无需修改，登录时自动选择；手动修改会在下次登录后重置”。
- **`link_redirect_mode`**：
  - **代码事实**：`getDownloadUrl(pickcode, ua, mode)` 的 `mode` 来自 `link` 接收入参，STRM 的 302 走 `redirectTarget` 固定跳转——**没有任何代码读取 `config.link_redirect_mode`**。它是定义了但从未被消费的键。
  - **结论：当前是死配置，不应让用户看到**。要么接线（前端取链时按它决定直链/302），要么在接线前从运行设置移除（不显示）。推荐先隐藏，待实现“取链模式”真正影响行为时再放回，并默认 `cookie`。

### 争议 3：上传扩展名列表放哪？
- 反方（进运行设置）：它是全局上传规则，集中放运行设置便于统一管理。
- 正方（放前端上传 tab）：默认值已覆盖全部常见媒体，普通用户看不懂一长串扩展名；只有进阶用户（NAS 特有 `mkv`/`iso`/自定义元数据格式）需要改。放前端上传 tab 的**折叠“高级”块**，既保留能力又不增加默认页面复杂度；还能与 `upload_include_sidecars` 放在一起讲（“是否带上附属文件”+“哪些扩展名算附属”）。
- **结论：迁移到前端上传 tab 的高级折叠块**（缺省折叠），并提供“恢复默认”按钮。注意：`strmSync`/`strmOnce` 也复用 `upload_media_extensions` 决定哪些云文件生成 STRM，tips 里要写明“同时用于上传与 STRM 生成”。

### 争议 4：STRM 删除相关（`strm_delete_*`×5 + `strm_notify`）没 UI，要不要补？
- **先看代码**：这 6 个键（含 `strm_notify`）**只存在于 `DEFAULT_CONFIG`，服务器端没有任何读取点**。当前“媒体库”tab 的云端核对/清理走的是手动 `ledgerVerify → libraryDrop` 流程，与这些键无关。
- 反面（该补 UI）：STRM 删除是用户实际需要的“自动清理失效媒体”能力，藏着不用可惜。
- 正面（先别补）：功能未接线，补 UI = 让用户改一个无效配置；且删除类必须配合确认阈值/风控，属于“安全敏感、低频、一次性设定”，天生适合运行设置而非前端。
- **结论：功能实现前保持隐藏默认，不补 UI**。待真正实现“自动清理”时，统一归入运行设置的 “STRM” 分组（`strm_delete_watch` 开关、`strm_delete_cloud_on_missing` 开关、`strm_delete_sweep_cron` 定时、`strm_delete_confirm_threshold` 确认阈值、`strm_notify` 通知）。绝不放前端（会删除数据）。

### 争议 5：`checkin_time_range` 是“定时”性质，是否适合运行设置？
- 反方：选个时段是偏“日常、想随手改”的操作。
- 正方：它本质是一条 cron 式窗口（`06:00-09:00`），设好即稳定，改的频率极低；运行设置“签到”分组与 `checkin_enabled`/`checkin_notify` 同组语义最清晰；前端签到 tab 已只读展示该时段（`refreshSigninRange`）兼顾可见性。
- **结论：保持运行设置**。已经是最优状态，前端只读展示补足了“看得见”需求。

---

## 四、推荐配置总表（完整覆盖 30 键）

| 配置键 | 推荐位置 | 理由 | 落地细节 |
|---|---|---|---|
| `enabled` | 运行设置（现状） | 总开关，低频 | 保持不动 |
| `version` | 隐藏/内部 | 非用户配置；前端设置页展示 | 保持不动 |
| `rate_limit_profile` | 运行设置（现状） | 偏好，设好不动 | 保持不动 |
| `cookie` | 隐藏/内部 | 敏感，登录写入 | 保持不动 |
| `tokens` | 隐藏/内部 | 敏感，登录写入 | 保持不动 |
| `login_client_type` | **移除 → 登录自动接管** | 登录流程自动写回，非手动偏好 | 从 wizard 删除字段；登录状态 chip 展示 |
| `link_redirect_mode` | **临时隐藏，接线后再放** | 代码未读取，死配置 | 从 wizard 删除；实现后加回 `select` |
| `upload_mappings` | 前端 上传 tab（现状） | 映射、高频、可视化 | 保持不动 |
| `upload_include_sidecars` | 运行设置（现状） | 上传偏好，低频 | 保持不动 |
| `upload_generate_strm` | 运行设置（现状） | 上传行为偏好 | 保持不动 |
| `upload_delete_source` | 运行设置（现状） | 涉删除，安全敏感 | 保持不动（强化 tips） |
| `upload_conflict_policy` | 运行设置（现状） | 偏好；ask 由前端逐条处理 | 保持不动 |
| `upload_media_extensions` | **前端 上传 tab 高级折叠** | 进阶自定义；与上传关联 | 迁移；折叠块 + 恢复默认；tips 注明同时用于 STRM |
| `upload_sidecar_extensions` | **前端 上传 tab 高级折叠** | 同上，与 `upload_include_sidecars` 联动 | 与 13 同组 |
| `strm_mappings` | 前端 STRM tab（现状） | 映射、可视化 | 保持不动 |
| `strm_incremental` | 运行设置 STRM 组（现状） | 偏好，低频 | 保持不动 |
| `strm_base_url` | **前端 STRM tab（现状）** | 即时反馈 + 上下文 | 保持不动；加 tips（对新 STRM 生效） |
| `strm_delete_cloud_on_missing` | 隐藏默认（未接线） | 涉删除，待实现 | 保持不动；实现后归运行设置 |
| `strm_delete_sweep_cron` | 隐藏默认（未接线） | 待实现 | 保持不动；实现后归运行设置 |
| `strm_delete_watch` | 隐藏默认（未接线） | 待实现 | 保持不动；实现后归运行设置 |
| `strm_delete_confirm_threshold` | 隐藏默认（未接线） | 安全阈值，待实现 | 保持不动；实现后归运行设置 |
| `strm_notify` | 隐藏默认（未接线） | 待实现 | 保持不动；实现后归运行设置 |
| `checkin_enabled` | 运行设置（现状） | 签到开关 | 保持不动 |
| `checkin_time_range` | 运行设置（现状） | 定时性质，设好不动 | 保持不动；前端只读展示 |
| `checkin_notify` | 运行设置（现状） | 偏好 | 保持不动 |
| `life_monitor_enabled` | 隐藏默认（未接线） | 待实现 | 保持不动 |
| `feishu_webhook` | 运行设置（现状） | 敏感凭据 | 保持不动；标注平台坑 |
| `feishu_enabled` | 运行设置（现状） | 通知开关 | 保持不动 |
| `watch_enabled` | **移除 wizard → 前端按钮统一** | 前端已有实时按钮，避免双入口 | 从 wizard 删除；由上传 tab 监听按钮写回 |
| `upload_risk_profile` | 运行设置（现状） | 上传风控，偏好 | 保持不动 |

---

## 五、变更落地细节

### A. 从 wizard/config 删除（共 3 项）
1. **`login_client_type`**（移除整个 select 字段）
2. **`link_redirect_mode`**（移除整个 select 字段，接线后再加回）
3. **`watch_enabled`**（移除 switch 字段；前端 `watcher_start`/`watcher_stop` 已是唯一写入方）

> 同时需把这三键从 `EDITABLE_CONFIG_FIELDS` 白名单中剔除（`server.js` 目前含 `login_client_type`、`link_redirect_mode`、`watch_enabled`）。`watch_enabled` 由 `watcher_start`/`watcher_stop` 直接 `store.updateConfig` 写入，不受影响；`login_client_type` 由登录回写，也不受影响；`link_redirect_mode` 本就无消费方。

### B. 新增/迁移到 wizard 的字段（暂不支持，等接线）
- **`link_redirect_mode`（接线后）**：`select`，field=`link_redirect_mode`，label=`取链模式`，default=`cookie`，options=`[Cookie 直链(cookie), 302 跳转(302)]`，tips=`决定取链接口生成的链接类型；Cookie 直链直接返回，302 跳转经应用签名重定向。`
- 若未来将 `strm_base_url` 迁入运行设置：`text`，field=`strm_base_url`，label=`STRM 基础地址（取链服务地址）`，default=``，tips=`应用对外的访问地址，如 http://<NAS>:<端口>/app/p115assistant；生成的 .strm 将以此拼接 redirect 地址。`

### C. 前端上传 tab 新增高级块（迁移 `upload_media_extensions`、`upload_sidecar_extensions`）
- 上传 tab 底部放一个折叠的「高级：上传扩展名」块（缺省收起）。
  - `upload_media_extensions`：`text`（用逗号分隔），label=`媒体扩展名`，default=`.mp4,.mkv,.ts,.iso,.rmvb,.avi,.mov,.mpeg,.mpg,.wmv,.3gp,.asf,.m4v,.flv,.m2ts,.tp,.f4v`，tips=`上传与 STRM 生成都会按它判定媒体文件。`.
  - `upload_sidecar_extensions`：`text`，label=`附属文件扩展名`，default=`.nfo,.jpg,.jpeg,.png,.webp,.srt,.ass,.ssa,.sup`，tips=`当「上传附属文件」开启时才生效。`
  - 提供「恢复默认」按钮，保存走现有 `save_config`（两键已在 `EDITABLE_CONFIG_FIELDS`，可直接复用）。

### D. 平台坑规避
- **`feishu_webhook`（password 不回显）**：建议服务器对 `feishu_webhook` 空值做“不覆盖已有值”处理，并在 wizard 的字段 tips 写“留空 = 保持当前值”，避免用户在运行设置只改签到保存后意外清掉 webhook。这是真实风险点，值得单独修。
- **`watch_enabled` 双入口**：按 A 删除 wizard 字段后即消除；前端按钮有实时 `watchStatus` 反馈，比 switch 可信。
- **`strm_base_url` 留前端**：前端每次进 tab 由 `strm_status` 回填，天然规避“表单陈旧覆盖”问题；若迁到运行设置则要重新处理该坑。

---

## 六、保持现状不动（变更面之外，无需关注）

以下 20 项维持 v1.1.0，**只需在变更后回归验证即可**：
- 前端映射类：`upload_mappings`、`strm_mappings`、`strm_base_url`
- 运行设置偏好类：`enabled`、`rate_limit_profile`、`upload_include_sidecars`、`upload_generate_strm`、`upload_delete_source`、`upload_conflict_policy`、`upload_risk_profile`、`strm_incremental`、`checkin_enabled`、`checkin_time_range`、`checkin_notify`、`feishu_enabled`、`feishu_webhook`
- 内部/隐藏：`version`、`cookie`、`tokens`
- 未接线预留：`strm_delete_cloud_on_missing`、`strm_delete_sweep_cron`、`strm_delete_watch`、`strm_delete_confirm_threshold`、`strm_notify`、`life_monitor_enabled`（共 6 键，保持隐藏）

> 变更面仅 **7 项**（见第二节 ⚠ 列表）：`login_client_type`、`link_redirect_mode`、`watch_enabled`（3 项从运行设置收敛）+ `upload_media_extensions`、`upload_sidecar_extensions`（2 项迁前端高级块）。其余保持。

---

## 附：与任务描述的出入说明
- 任务称 DEFAULT_CONFIG 约 **35** 键，实际为 **30** 键；本表已全覆盖 30 键，未省略任何 <=> 对应关系。
- 任务列“尚未进入任何配置面”8 键准确：`upload_media_extensions`、`upload_sidecar_extensions`（建议迁前端），其余 6 键建议继续隐藏待接线。