# 115网盘助手 前端配置项 vs 应用设置（运行设置）重复项全面审查

> 审查基于源码：`fnos/app/ui/index.html`（前端）、`fnos/wizard/config`（运行设置 13 字段）、`fnos/app/server/server.js`（白名单与 action）、`fnos/app/server/store.js`（DEFAULT_CONFIG 30 键）。版本 v1.1.3。

## 结论摘要

1. **严格意义下的「同一配置键在前后端都有写入口」已不存在**——这次审查没有发现任何一个键同时能在前端表单和运行设置里被编辑（EDITABLE_CONFIG_FIELDS 只含 18 键，其中前端能写的仅 upload_mappings / strm_mappings / upload_media_extensions / upload_sidecar_extensions / watch_enabled / enabled；运行设置的 13 个字段里与前端写入口零重叠）。
2. **最值得处理：`enabled` 总开关被前端动作隐式改写**。`watcher_start`、`upload_sweep` 会在后端把 `enabled` 置 true（server.js:895、server.js:954），用户在运行设置把「启用」关掉后再点前端的「开始监听 / 立即上传全部」，总开关会被静默重新打开——"我明明关了还在跑"的困惑，是唯一一处需真正收敛的交叉双影响。
3. **`strm_incremental` 跨面生效但前端无提示**：用户在 STRM 页点「立即同步」时，是否清理失效 STRM / 增量判断完全由运行设置的「增量生成」开关决定，两处 UI 无任何关联说明，属语义重叠。
4. **手动签到与 `checkin_enabled` 自动开关脱节**：`checkin_now` 不校验检查开关，即使「每日签到」关了双击仍会执行，界面无提示区分"自动关掉 / 手动可用"。
5. **只读展示项（签到时段、STRM 基础地址、风控档位）与可配置项关系清晰、无重复写入**，保持现状即可；历史已消除的重复（`watch_enabled` 双入口、旧设置表单）已在代码层面确认收敛。

---

## 一、重复项清单（前端与运行设置同时出现 / 交叉影响的键）

| 配置键 | 前端位置 | 运行设置位置 | 重复类型 | 风险 | 建议 |
|---|---|---|---|---|---|
| `enabled`（总开关） | 上传 tab「开始监听」(watcher_start)、「立即上传全部」(sweep) 会在后端 `updateConfig({enabled:true})`；前端本身无总开关 UI | 「运行配置」step「启用」switch（default false） | 语义重叠（双影响门） | 用户在运行设置关总开关，再到前端点监听/上传会把总开关静默打开，与预期状态不一致 | **归一为运行设置唯一权威**。前端 watcher_start / sweep 不再隐式置 enabled=true；若 enabled=false 应返回错误并提示"请在应用设置 → 运行设置开启「启用」"。这需要同步调整 server.js 的 watcherStart() 与 uploadSweep()（去 895/954 行的自动开启逻辑），前端弹提示而不是静默。 |
| `strm_incremental`（增量生成） | STRM tab「立即同步」内部使用该语义（server strmSync 读 config 决定是否增量+删失效），前端**无控件、无状态展示** | 「STRM」step「增量生成」switch（true） | 语义重叠（跨面生效） | 用户在前端点「立即同步」的行为被运行设置里的开关改变，两处 UI 不关联，易困惑"为什么这次删了失效 STRM/没删" | 保持运行设置为唯一写入口；在 `strm_status` 返回端增加 `incremental` 状态，前端 STRM tab 加一行只读提示「增量生成：开 / 关（在应用设置调整）」。不新增前端写入口。 |
| `checkin_enabled`（每日签到自动开关） | 签到 tab「立即签到」按钮(checkin_now)——**不受此开关约束** | 「签到」step「每日签到」switch（false） | 语义重叠 | 运行设置关了自动签到，前端手动签到仍可点击并成功，界面无任何"自动已关"提示 | 保持手动签到独立于自动开关（本意合理），但前端在 checkin_enabled=false 时于签到 tab 显示「每日自动签到已关闭（定时不执行）；手动签到仍可用」。需 get_config 已返回 checkin_enabled（PUBLIC_CONFIG_FIELDS 含该键，前端可直接读到）。 |
| `checkin_time_range`（签到时段） | 签到 tab `.summary-range` 只读展示（refreshSigninRange 读 get_config.checkin_time_range，2026-09-17 起跟随运行设置） | 「签到」step「签到时段」text | 只读展示 vs 可配置 | 低：只读展示与配置源一致，无冲突 | 保持现状。前端只读回显已明确标注"跟随运行设置"，无需改动。 |
| `strm_base_url`（基础地址） | STRM tab 只读 input（saveStrmBase/loadStrmMappings 读 strm_status.base_url，readonly 不可编辑） | 无（wizard 不存在） | 只读展示（自动推导，1.1.3） | 无重复配置入口；服务端 loopback 时回退 config.strm_base_url 属内部兼容逻辑，不进 UI | 保持现状。确认无第二写入口（EDITABLE_CONFIG_FIELDS 含 strm_base_url 但无任何前端控件写它）。 |
| `upload_risk_profile`（上传风控策略） | 上传 tab 风控条只读展示（refreshWatchStatus 读 watcher_status.risk.profile_name） | 「上传」step「上传风控策略」select | 只读展示 vs 可配置 | 与 `rate_limit_profile`(限流档位) 同为"档位"，前端仅回显其一，用户易混淆两者差异 | 保持现状。在两处 select 的 tips 里澄清：`rate_limit_profile`=请求级限速档，`upload_risk_profile`=上传任务节流档，避免都叫"档位"。 |
| `upload_media_extensions` | 上传 tab「高级：上传扩展名」块，可读可写（saveExtensions/restoreDefaultExtensions 调 save_config） | 无 | 前端唯一入口（已确认无重复） | 无重复 | 保持现状。EDITABLE_CONFIG_FIELDS 含该键，wizard 无字段，唯一写入口在前端。 |
| `upload_sidecar_extensions` | 同上「高级」块附属文件扩展名输入框 | 无 | 前端唯一入口（已确认无重复） | 无重复 | 保持现状，同 upload_media_extensions。 |

---

## 二、已消除的重复（历史上处理过、代码确认已收敛）

| 配置键 / 主题 | 前端 | 运行设置 | 现状确认 |
|---|---|---|---|
| `watch_enabled`（监听开关） | 上传 tab 监听按钮 watcher_start / watcher_stop / watcher_status，唯一操作入口 | 1.1.1 已从 wizard 删除，无字段 | **已收敛**。server.js EDITABLE_CONFIG_FIELDS 不含 watch_enabled（仅 78 行 PUBLIC 里有暴露），前端按钮是唯一写入口；watcherStart 内部 `updateConfig({watch_enabled:true})` 属动作副作用而非表单入口。 |
| 旧前端「设置」配置表单 | 设置 tab 现仅保留「更新」区块与版本信息（index.html:707 注释"配置项已迁移至应用中心 → 应用设置 → 运行设置"） | 全部配置字段承载 | 已收敛。前端不再有同键表单，双入口消失。 |
| `strm_base_url` 用户手动配置 | 1.1.3 改为请求头自动推导，前端该 input 置 readonly | 本来就无 wizard 字段 | 已收敛为只读展示。 |

---

## 三、无重复项（只在一处暴露，无需处理）

> 以下覆盖 DEFAULT_CONFIG 全部 30 键中除上文「重复项清单」与「已消除」外的所有键，并标注暴露面。

| 配置键 | 暴露面 | 说明（代码依据） |
|---|---|---|
| `version` | 仅后端常量；前端设置 tab `#currentVersion` 只读展示 | store.js:210 合并时跳过 version，杜绝旧版本号覆盖运行版本；无任何写入口，无重复 |
| `rate_limit_profile` | 仅运行时设置（wizard「限流档位」select） | 前端无控件、无展示；唯一入口，无重复 |
| `cookie` / `tokens` | 仅后端；Fernet 加密落盘，前端不可见 | store.js ENCRYPTED_FIELDS；PUBLIC_CONFIG_FIELDS 不包含，隐藏内部键，无重复 |
| `login_client_type` | 仅后端内部记录（扫码登录回写） | PUBLIC 含但不进 UI，无前端控件；status 接口只读返回，无重复 |
| `link_redirect_mode` | 仅后端默认值（"cookie"） | 无 wizard、无前端控件，无重复 |
| `upload_mappings` | 仅前端上传 tab 映射卡片（增删改走 save_upload_mapping / delete_upload_mapping） | wizard 无字段，后端白名单含但无表单；唯一入口 |
| `strm_mappings` | 仅前端 STRM tab 映射卡片（save_strm_mapping / delete_strm_mapping） | 同上，唯一入口 |
| `upload_include_sidecars` | 仅运行设置（「上传附属文件」switch） | 前端无控件；后端唯一读取（上传/监听路径），无重复 |
| `upload_generate_strm` | 仅运行设置（「上传后生成 STRM」switch） | 前端无控件，无重复 |
| `upload_delete_source` | 仅运行设置（「上传后删除源文件」switch） | 前端无控件，无重复 |
| `upload_conflict_policy` | 仅运行设置（「上传身份冲突」select）；前端历史 tab 冲突处理按钮仅按当前策略动作 | 前端 uploadConflicts 只读返回 policy 不编辑，无重复写入口 |
| `strm_delete_cloud_on_missing` / `strm_delete_sweep_cron` / `strm_delete_watch` / `strm_delete_confirm_threshold` / `strm_notify` | 后端保留但无任何 UI（wizard 与前端均无） | 内部/占位键，无重复 |
| `checkin_notify` | 仅运行设置（「签到结果通知」switch） | 前端无控件，无重复 |
| `life_monitor_enabled` | 后端保留，无 UI | 无重复 |
| `feishu_enabled` / `feishu_webhook` | 仅运行设置（飞书通知组） | 前端无控件；`feishu_webhook` password 类型经 mask 输出、空值保持已有（server.js:495 防清空），唯一入口，无重复 |

**保持现状不动**：`version`、全部内部/隐藏键（cookie、tokens、login_client_type、link_redirect_mode、strm_delete_*、life_monitor_enabled）、前端唯一入口（upload_mappings、strm_mappings、upload_media_extensions、upload_sidecar_extensions）、运行设置唯一入口（rate_limit_profile、upload_include_sidecars、upload_generate_strm、upload_delete_source、upload_conflict_policy、checkin_notify、feishu_enabled、feishu_webhook），以及只读展示项（checkin_time_range、strm_base_url、upload_risk_profile）。

---

## 四、落地优先级

1. **改** `enabled`：server.js `watcherStart()`(895-903) / `uploadSweep()`(952-964) 去掉隐式 `enabled=true`，改为当 enabled=false 时返回明确错误；前端对应按钮透出提示。**这是唯一真正的双影响点。**
2. **改** `strm_incremental`：`strm_status` 返回已含 `incremental`，前端 STRM tab 加一行只读状态条。
3. **改** `checkin_enabled`：前端签到 tab 在开关关闭时显示提示（get_config 已含该键）。
4. **改（文案）**：wizard `rate_limit_profile` / `upload_risk_profile` 的 tips 澄清两档位分工。
5. **不动**：其余全部键，见「无重复项」与「保持现状」。