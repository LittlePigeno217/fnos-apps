# WorkBuddy 网关合并说明（checkin 2.1.4）

本文档记录 workbuddy2api-hub v1.7.5（Python）功能合并进 checkin（fnOS Node.js 应用）的方式与阶段状态。
源仓库：`/tmp/wb2api-hub/`（本地化，无网络依赖）。目标：`apps/checkin/`。

## 架构总览

```
客户端（任意 OpenAI 兼容 SDK / curl / 桌面端）
   │  base_url = https://<NAS>/app/checkin/v1
   ▼
main.js handle() ── pathname.startsWith("/v1/") ──► wb_gateway.js handleV1()
   │                                              ├─ 鉴权：X-Trim-Userid（管理端）/ Bearer Key（/v1/*）
   │                                              ├─ 三协议翻译：chat/completions | responses | messages
   ▼                                              ├─ 区域路由（intl/cn）+ derive_id 指纹
dispatchGatewayRequest()                         ├─ 限额护栏（reserve / daily token / daily credit / per-model）
   │                                              └─ 上游 https 转发（流式 SSE 直连 / 非流式缓冲）
   ▼
上游：www.workbuddy.ai（intl）/ copilot.tencent.com（cn）chat + www.codebuddy.cn（cn billing）
```

- 管理端：`/api/wb/*`（`checkin/wb/status|config|keys|usage|test|models`），复用既有 `ok()`/`fail()` 信封。
- 网关端：`/v1/*`（`/v1/models`、`/v1/chat/completions`、`/v1/responses`、`/v1/messages`），原始 OpenAI/SSE 透传。
- 配置持久化：`cfg.wb = {enabled, default_realm, keys[], limits{}, day, usage[]}`，由 store.saveConfig 的 `patch.wb` 段合并写入。
- 日志统一 `[wb]` 前缀；密钥只减不增。

## 与 hub 的功能映射

| hub 模块 | 合并位置 | 移植要点 |
|---|---|---|
| `wb_proxy.py` DISPATCH / open_upstream | `wb_gateway.js` `forwardChat` / `dispatchGatewayRequest` | 上游 URL、UA、指纹头、401 后自动 refresh-retry-1 次 |
| `wb_proxy.py` build_upstream_body | `buildUpstreamBody` | developer→system、system 置顶 messages[0]、max_completion_tokens→max_tokens、`_`-私有键剔除 |
| `wb_proxy.py` detect_model_realm | `MODEL_CATALOG` + `detectModelRealm` | INTL_ONLY/CN_ONLY 集合 + gpt-/gemini- 前缀→intl；minimax-/deepseek-v4-pro→cn；覆盖 catalog.realm 默认 |
| `wb_catalog.py` STATIC_MODELS / _CN_JSON | `MODEL_CATALOG`（26 模型） | 字段 n/c/in/out/vision/tool/think/realm，key 均带引号 |
| `wb_fingerprint.py` | `workbuddy_tasks.js` `deriveId`（P3 已并入） | md5(`${salt}:${uid}`).slice(0,36)，与桌面端一致 |
| `wb_egress.py` | `forwardChat` tunnel/直连 | 流式 raw https + CONNECT 代理隧道；非流式走 httpc.Session |
| `wb_accounts.py`（限额/预留） | `guardBlocked` / `recordUsageWb` / `dayCounters` | 本地 0 点重置；reserve 依 account credit 查询失败则放行 |
| `wb_settings.py`（API Key） | `wb_gateway.js` keysManage / findKey | `{id,name,key,realm,models,enabled,created_at,deleted_at}`；fnmatch glob 校验 |
| 多账号按区域选池 | `buildPool` / `pickAccount` | realm 字段 > domain/token 标记 > 默认 cn；round-robin `_rr` |

## 版本阶段状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| P3 | 审查既有未提交改动（server.js/sites.js/store.js/ui + workbuddy_tasks.js）并验证 | ✅ 达标，未改动 |
| P0 | OpenAI 兼容网关（chat/responses/messages 三协议，intl/cn 双上游） | ✅ `wb_gateway.js` 新建 |
| P1 | 多账号 + 双区域路由 + derive_id 指纹 | ✅ 复用 checkin 账号机制 + `sessionValid` |
| P2 | 限额护栏 + 多 Key 管理 | ✅ 持久化 via `cfg.wb`；`wb_keys` 增删改查区域/模型绑定 |
| P4 | Web 仪表盘 + OpenRouter 定价估算 | ✅ `ui/index.html` wb 面板 + `guessCredits` |
| — | `/v1/models` 模型目录对齐桌面端 | ✅ 26 模型 catalog |
| — | 版本 bump 2.1.4 + 清单 check | ✅ 通过 |

## 网关端点速查

以 `https://<NAS>/app/checkin/v1` 为 base_url：

```bash
# 模型列表（需 Bearer Key）
curl -s -H "Authorization: Bearer wb_xxx" https://<NAS>/app/checkin/v1/models

# OpenAI Chat Completions
curl -s -X POST -H "Authorization: Bearer wb_xxx" -H "Content-Type: application/json" \
  https://<NAS>/app/checkin/v1/chat/completions \
  -d '{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"hi"}],"stream":true}'

# Anthropic Messages（自动翻译 messages 协议，cn/intl 双区域）
curl -s -X POST -H "Authorization: Bearer wb_xxx" -H "Content-Type: application/json" \
  https://<NAS>/app/checkin/v1/responses \
  -d '{"model":"gpt-5.4","input":"hello"}'

# 区域强制（缺省走 default_realm 或模型 catalog）
curl -s -X POST -H "Authorization: Bearer wb_xxx" -H "x-wb-realm: cn" ...

# 管理端示例
curl -s https://<NAS>/app/checkin/action/checkin/wb/status
curl -s -X POST -H "X-Trim-Userid: ..." -H "Content-Type: application/json" \
  https://<NAS>/app/checkin/action/checkin/wb/keys \
  -d '{"action":"create","name":"t","key":"wb_xxx","realm":"cn","models":["deepseek-*"]}'
```

SSE 流式：`wb_gateway.js` 对 stream=true 走自定义 `rawPostStream`（字节转发 + `[DONE]` + 最后一条 usage），
管理端 API 全部走 httpc.Session（缓冲式），互不干扰。

## 错误码约定

| 场景 | HTTP | error.type |
|---|---|---|
| 无/无效 Key | 401 | invalid_api_key |
| Key 未授权模型 / 不匹配 | 400 | model_not_allowed |
| 网关未启用 / Key 停用 / 区域不符 | 403 | access_forbidden / realm_mismatch |
| 限额（daily token/credit/model/reserve） | 429 | rate_limit_exceeded |
| 账号池为空 | 503 | no_account_available |
| 上游失败（网络/续期失败） | 502 | upstream_error |

## 未合并 / 后续建议

- hub 仅做「本地 API ➜ 上游」的直要；**用户计费/配额速率**、**请求级审计导出**未做——当前用量 rows 上限 300，超限丢最旧。
- 各账号独立上游 token（account 多开）沿用 checkin 既有账号模型，hub 的单 key-多上游负载均衡差异已按「Key→模型→账号池」吸收。
- 下一个可做方向：把 gateway 的 `usage[]` 落 `Reports/` 或追加仪表盘图表。