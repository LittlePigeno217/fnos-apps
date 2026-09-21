# p115assistant 配置项链路排查报告（2026-09-21，功能版本 1.1.7）

排查对象：`apps/p115assistant/fnos/app/`（server/*.js + ui/index.html）
方法：读代码定位「默认值 / UI 控件 / 白名单 / 运行时读取点」四要素，逐项判定是否生效；再用 NAS Unix socket 只读 API 复核。全程只读，未做任何写操作、未落任何文件到真机。

---

## 1. 配置项全量表（store.js DEFAULT_CONFIG，共 27 项）

图例：读取点为「谁真正消费该值」的 file:line；「生效」= 有运行时读取点且驱动行为。

| # | 字段 | 默认值 | 分组 | UI 控件(id) | 白名单 | 运行时读取点(行号) | 生效 |
|---|---|---|---|---|---|---|---|
| 1 | enabled | false | 总开关 | `enabled` | PUB/EDIT | server.js:1045,1107,2411 | ✅ |
| 2 | version | "1.1.7" | 其他 | 显示 | PUB | server.js:575,577(显示) | ✅(显示) |
| 3 | rate_limit_profile | balanced | 风控 | `rateLimit` | PUB/EDIT | client.js:294→limiter.js;server.js:502,516 | ✅ |
| 4 | cookie | "" | 登录 | 扫码流程 | — | client.js:287,639… ; server.js:501,513,718 | ✅ |
| 5 | tokens | {} | 登录 | 扫码流程 | — | client.js:288… ; server.js:503,514,716 | ✅ |
| 6 | login_client_type | "" | 登录 | 内部写 | PUB | server.js:515,676,717 | ✅ |
| 7 | fnos_username | "" | 登录 | fnos 登录 action | — | server.js:573,1561 | ✅ |
| 8 | fnos_password | "" | 登录 | fnos 登录 action | — | server.js:573,1562 | ✅ |
| 9 | upload_mappings | [] | 上传 | 映射编辑器 | PUB/EDIT | server.js:161,179,1048,1110… | ✅ |
| 10 | upload_include_sidecars | true | 上传 | `upIncludeSidecars` | PUB/EDIT | server.js:200,1147 | ✅ |
| 11 | upload_generate_strm | false | 上传↔STRM | `upGenStrm` | PUB/EDIT | server.js:2141 | ✅（1.1.5 已修） |
| 12 | upload_delete_source | false | 上传 | `upDelSource` | PUB/EDIT | server.js:1262 | ✅ |
| 13 | upload_conflict_policy | ask | 上传 | `upConflict` | PUB/EDIT | server.js:1353,1463 | ✅ |
| 14 | upload_media_extensions | (媒体列表) | 上传 | `upMediaExt` | PUB/EDIT | server.js:198,1148,1761,2073,2159 | ✅ |
| 15 | upload_sidecar_extensions | (附属列表) | 上传 | `upSidecarExt` | PUB/EDIT | server.js:199,1149 | ✅ |
| 16 | strm_mappings | [] | STRM | 映射编辑器 | PUB/EDIT | server.js:1630,1752,2145… | ✅ |
| 17 | strm_incremental | true | STRM | `strmIncremental` | PUB/EDIT | server.js:1687,1760 | ✅ |
| 18 | strm_add_subtitles | true | STRM | `strmSubs` | PUB/EDIT | server.js:1901 | ✅ |
| 19 | strm_base_url | "" | STRM | `strmBaseUrl` | PUB/EDIT | server.js:1690,1692,1721 | ✅ |
| 20 | relay_port | 3667 | STRM | `relayPort` | PUB/EDIT | server.js:601,646,1689,1707;main.js:564 | ✅ |
| 21 | checkin_enabled | false | 签到 | `checkinEnabled` | PUB/EDIT | server.js:2411 | ✅ |
| 22 | checkin_time_range | 06:00-09:00 | 签到 | `checkinRange` | PUB/EDIT | server.js:2420 | ✅ |
| 23 | **checkin_notify** | false | 签到 | `checkinNotify` | PUB/EDIT | **无** | ❌ **失效** |
| 24 | feishu_webhook | "" | 通知 | `feishuWebhook` | PUB/EDIT | notify.js:23 | ✅ |
| 25 | feishu_enabled | false | 通知 | `feishuEnabled` | PUB/EDIT | notify.js:22 | ✅ |
| 26 | watch_enabled | false | 上传监听 | watcher_start/stop action | PUB | server.js:1080,1082;main.js:593 | ✅ |
| 27 | upload_risk_profile | conservative | 风控 | `upRisk` | PUB/EDIT | server.js:432,479 | ✅ |

生效 26 / 27，失效 1（checkin_notify）。

---

## 2. 链路图

### 2.1 上传链路
```
enabled ─┐
upload_mappings(enabled 项) ─┤
watch_enabled → FileWatcher(30s 轮询,60s 稳定期) ┐
             ├→ uploadSweep / _runUploadMapping / 上传 worker
upload_media_extensions  → extensionSet 过滤(仅媒体入队)
upload_sidecar_extensions + upload_include_sidecars → 附属文件是否随传
upload_conflict_policy(ask/reupload…) → 同名冲突处理
upload_delete_source → 上传成功后删本地源(server.js:1262)
rate_limit_profile → U115Client/RequestPacer(HTTP 层 QPS/cooldown)
upload_risk_profile → RISK_PROFILES(worker 层 fileInterval/batch/cooldown, 风控暂停)
```
两个 profile 分属两层：`rate_limit_profile` 管单请求节流（limiter.js，preset: conservative/balanced/**fast**），`upload_risk_profile` 管上传批次节奏与风控冷却（server.js RISK_PROFILES，preset: conservative/balanced/**aggressive**）。

### 2.2 STRM 链路
```
strm_mappings(source_cid→target_dir) ─┐
strm_incremental → 已存在同内容跳过/更新计数(1760,1895)
                                      ├→ strmSync / _runStrmMapping → 写 .strm
strm_base_url(host) + relay_port(port) → _resolveStrmBaseUrl ⇒ base_url
                                          → .strm 内容 = base_url + /redirect?pickcode&sign
strm_add_subtitles → 同名字幕(.srt/.ass/.ssa/.sup/.vtt)下载到 .strm 同目录(1901)
relay_port → 独立 302 中转监听(main.js:564)；save_config 改动即 _relistener 动态重绑(server.js:646)
```

### 2.3 签到链路
```
enabled && checkin_enabled ─→ schedulerTick(每分钟)(2411)
checkin_time_range(06:00-09:00) → inCheckinWindow 窗口判定(2420)
history 今日成功记录 → 去重(不重复签到)
→ checkinNow → client.checkin → 记 history
   通知：_notifier.notify(1603) 【仅由 feishu_enabled 决定，未读 checkin_notify】
```

### 2.4 通知/登录链路
```
feishu_enabled(gate) + feishu_webhook → Notifier._webhook(notify.js:22-23) → 飞书 POST
cookie / tokens / login_client_type → _getClient → U115Client(签名变更即重建客户端)
fnos_username/password → fnos 登录 action(1522,1561)；对外仅暴露 fnos_configured 布尔
```

### 2.5 交叉联动（重点）
- **upload_generate_strm → _maybeAutoStrmForFile**（server.js:2139）：上传成功后即时生成 .strm；依赖 `strm_mappings` 中存在 `source_cid == 上传 target_cid` 的启用映射，否则静默跳过。真机已匹配（见 §4）。
- **relay_port ← save_config 动态重绑**（server.js:601,644 → main.js:571 `_relistener`）：改端口立即切 302 监听，失败回退「重启生效」，绝不双源分叉。
- **strm_base_url + relay_port ⇒ base_url**（server.js:_resolveStrmBaseUrl / strm_status）：host 取 strm_base_url，port 补 relay_port。
- **strm_base_url/relay_port 变更 → 防抖 2s 自动 strmSync**（server.js:628-640）：免等 watch 立即重写全部 .strm。

---

## 3. 问题清单

### 问题 1 —— `checkin_notify` 配置项失效（同 upload_generate_strm 先例）⚠ 失效
- **证据**：`grep -rn checkin_notify server/*.js` 仅命中 store.js:45（默认值）、server.js:76/94（PUB/EDIT 白名单），**无任何运行时读取点**。签到通知实际发送在 `checkinNow`（server.js:1603 `await this._notifier.notify(...)`）无条件调用，其内部（notify.js:22）只用 `feishu_enabled` 作为开关。
- **UI 侧**：ui/index.html:3579 保存 `checkin_notify`，4129 回填 `setCfgCheck("checkinNotify", …)` —— 用户可勾选、能存能读回，但后端从不消费。
- **真机佐证**：`checkin_notify:true` 且 `feishu_enabled:false` → 实际不会发通知，证明开关无效、真实门控是 feishu_enabled。
- **影响**：用户勾了「签到通知」却收不到（因为 feishu 未开）；或关了「签到通知」但只要开了飞书，签到仍会推送。语义与实际行为不符。

### 问题 2 —— `rate_limit_profile` 与 `upload_risk_profile` 语义重叠 ⚠ 重叠
- **证据**：二者都是面向用户的「上传快慢/风控」档位，但作用于不同层、preset 名不一致：
  - `rate_limit_profile`（limiter.js:28 PROFILE_PRESETS）：conservative/balanced/**fast**，管 HTTP 请求 QPS 与端点 cooldown（client.js:294-298）。
  - `upload_risk_profile`（server.js:424-428 RISK_PROFILES）：conservative/balanced/**aggressive**，管上传批次间隔/批大小/风控冷却（server.js:432）。
- **影响**：UI 上两个「档位」并列（`rateLimit` + `upRisk`），含义相近但取值第三档命名不同（fast vs aggressive），默认值也不同（balanced vs conservative），用户易混淆、易产生「我调了快档为什么还是慢」的错配。非失效，仅重叠/易误解。

### 读写不一致：0 项
- 逐一核对 EDITABLE 字段的读取点，除 checkin_notify（归为失效）外全部有对应消费点，无「UI 存 A 后端读 B」的字段错位。
- `feishu_webhook` 存在「空值=保持当前、不回显」的刻意非对称（server.js:594-597、密码类型），属设计而非缺陷。

---

## 4. 修复建议（最小改动，未实施）

### 建议 1（问题 1，二选一）
- **方案 A（保留开关语义，推荐）**：在 `checkinNow` 发通知处加门控。将 server.js:1603 改为
  ```js
  if (this.store.getConfig().checkin_notify) await this._notifier.notify("每日签到", detail);
  ```
  语义变为「签到通知＝feishu_enabled 且 checkin_notify 均开」。改动 1 行，符合用户对独立开关的预期。
- **方案 B（彻底移除死配置）**：从 DEFAULT_CONFIG、PUB/EDIT 白名单、UI（3579/4129 及对应 checkbox）删除 `checkin_notify`，签到通知统一由 feishu_enabled 控制。改动分散，需前后端同步删。
- 二者取其一即可；推荐 A（成本最低、最贴近用户直觉）。

### 建议 2（问题 2）
- 不改行为，仅消歧义：UI 上为两个档位补文案区分——`rate_limit_profile` 标注「115 接口请求节流（QPS）」，`upload_risk_profile` 标注「上传批次节奏 / 风控冷却」；并统一第三档命名或在提示中说明两者独立。若要根治可考虑合并为单一「上传强度」档并在后端派生两层参数，但改动较大，非本次必需。

---

## 5. 真机只读复核记录（NAS Unix socket，全部只读，无写、无落文件）

| 只读 action | 结果 | 与代码结论一致性 |
|---|---|---|
| get_config | enabled=true; rate_limit_profile=balanced; upload_risk_profile=balanced; upload_generate_strm=true; watch_enabled=true; strm_base_url=http://10.10.10.3; relay_port=3667; checkin_notify=true; feishu_enabled=false | ✅ 一致 |
| strm_status | incremental=true; base_url=`http://10.10.10.3:3667`; relay_port=3667; manual_base_url=http://10.10.10.3; auto_base_url=false | ✅ base_url = host+port 组合正确 |
| watcher_status | enabled=true, running=true；risk.profile_name=balanced, profile{fileIntervalMs:3000,batchSize:10,cooldownMs:70000} | ✅ =RISK_PROFILES.balanced |
| upload_status | active=false, pending=0；risk 同上 | ✅ 一致 |

**关键交叉验证（真机）**：
- upload_generate_strm 交叉链路成立：upload_mappings.target_cid `3397019246553726638` == strm_mappings.source_cid `3397019246553726638` → 自动 STRM 匹配条件满足，链路活跃。
- **checkin_notify 失效实证**：真机 `checkin_notify=true` 但 `feishu_enabled=false`，按代码签到不会发通知——证明该开关不参与决策。
- 两个 profile 并存且都为 balanced，分别体现在 client 层与 worker 层，互不替代。

---

## 附：判定汇总
- 配置项总数：27
- 疑似失效：1（checkin_notify）
- 重复/重叠：1 对（rate_limit_profile ↔ upload_risk_profile）
- 读写不一致：0
- 链路完整：26
- 真机只读复核：4 项，全部与代码结论一致，0 异常
