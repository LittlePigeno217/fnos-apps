# 115 接口限流与访问上限：方法方案记录

本文档从 `https://github.com/DDSRem-Dev/MoviePilot-Plugins/` 的 `plugins/p115liteassistant`
(P115LiteAssistant) 及同仓库 `p115strmhelper` 的实现中提取，整理 115 网盘 API 的
限流特征与应对策略。仅记录方案，供 fnos-apps 项目参考；不复制任何代码原文。

- 来源仓库版本锚点：`MoviePilot-Plugins` 分支 `5ba11b3 release: P115LiteAssistant 1.3.2`
- 提取依据文件：`plugins/p115liteassistant/{client.py, limiter.py, rate_limiter.py,
  resilience.py, cloud_check.py, uploader.py, api.py, __init__.py}`

---

## 1. 认证模型（两层）

115 提供两套鉴权通道，实现中分开使用：

- **Cookie 通道**：`https://passportapi.115.com` + `https://qrcodeapi.115.com`
  扫码登录，换取整份 Cookie（`_set_cookie_from_login` 中 `data.cookie` 拼成
  `k=v; k=v` 串）。Cookie 用于传统 Web / proapi 接口。
- **Open 通道（OAuth-like）**：`https://proapi.115.com`，用 `access_token` /
  `refresh_token`，配 `client_id`（默认 `100197847`）。用于 `/open/*` 全部端点。

Open 授权可用两条路径重建，形成**降级链**：
1. `refresh_token` 刷新：`POST https://passportapi.115.com/open/refreshToken`
2. Cookie 换取：PKCE + 设备码
   - `POST /open/authDeviceCode`（sha256 code_challenge，client_id）
   - `GET /api/2.0/prompt.php`、`GET /api/2.0/slogin.php`（带 uid）
   - `POST /open/deviceCodeToToken`（uid + code_verifier → access_token）

### 令牌生命周期
- `access_token` 带 `expires_in`；以 `refresh_time + expires_in - 60` 判断过期，
  提前 60 秒刷新（`_open_token_expired`）。
- 请求遇 401/403（`_is_open_auth_error` / `_is_open_auth_payload`，含 `40140125`）
  视为 Open 授权失效 → 尝试 `refresh_token` → 失败则用 Cookie 重建 → 仍失败报
  「请重新扫码登录」。
- 全程用 `threading.RLock` 保护刷新，避免并发重复刷新。

---

## 2. 访问上限（access_limit）——最核心的限流信号

115 Open 接口的限流信号是**业务层字段**，不是 HTTP 状态码：
`message` 含 **「已达到当前访问上限」** → 抛 `U115AccessLimitError`。
检测：`"已达到当前访问上限" in message`。

### 应对：固定 70 秒退避，最多 6 次
- `open_access_limit_attempts = 6`，`open_access_limit_delay = 70.0`
- Open 带 token 请求循环：撞上限 → 置共享「已限流」标志 → 睡 `delay`秒 → 重试，
  直到 6 次后放弃。**重试期间任何其它并发请求立即中止**（见下）。

### 共享限流状态（并发任务统一止损）
用 `threading.local()` 的上下文限流状态 `limit_state`（含 `Event` + `Lock` + `message`）：
- `new_access_limit_state()` 建状态；`run_with_access_limit_state(state, op)` 执行一段
  操作并在其中传播访问上限。
- 一个请求撞上限 → `_mark_shared_access_limited()` 设置事件；此后同上下文所有请求
  （队列扫描、上传、目录遍历）在 `_raise_if_shared_access_limited()` 处**立即抛错
  退出**，不再发任何请求，避免把冷却期拖长。
- 分段等待 `_wait_for_request_retry`：等待期间若事件被置位，立刻中止。

---

## 3. HTTP 429 限流：读响应头，不占重试次数

`httpx.HTTPStatusError` status_code == 429：
- 共享限流状态下 → 立即中止（同上）。
- 否则读 `X-RateLimit-Reset`（秒）为 sleep 时长；缺失/非法时用
  `rate_limit_default_delay = 60.0`；再加 `rate_limit_delay_padding = 5.0`。
- **429 不消耗 transient 重试预算**，睡完原地继续。

### 其它临时 HTTP 错误：指数退避
- `transient_http_statuses = {408, 425, 429, 500, 502, 503, 504}`
- GET/HEAD 有 `read_retry_attempts = 6` 次（`read_retry_delay = 2.0` 起始，指数
  `2 ** (attempt-1)`）；写操作（POST 等）退避但只 1 次，避免加倍触发写限流。
- 网络异常（`httpx.HTTPError` / `ValueError`）同样指数退避。

---

## 4. 客户端主动节流（不让服务器动手）

在打任何请求前先用预约式速控（`limiter.py`）：

### RequestPacer：Open 总预算优先于端点族预算
- `open_global` 全局 QPS 固定先预约，再按 route 预约端点族 —— 全局永远先撞限制，
  防止单端点把整实例打满。
- 路由族：`auth / directory / metadata / upload_control / download_link /
  life_ios / life_web / mutation / other_open`

### 三类速控原语
- **RateLimiter**：固定间隔 QPS（令牌预约），`interval = 1/qps`，线程安全、可取消。
- **CooldownSlot**：首调立即、后续严格按 `cooldown` 预约；`acquire_after` 表示
  「成功动作后的冷却」——当前调用也完整等待一个 cooldown（用于目录翻页）。
- **RequestPacer.acquire_directory_page**：翻页后强制 waiting 一个 cooldown。

### 三档预设（据使用强度选择）
| 档位 | open_qps | dir_qps | 页cooldown | metadata/upload/mutation | life |
|---|---|---|---|---|---|
| conservative | 1 | 2 | 1.5 | 1.0 | 3.0 |
| balanced | 2 | 4 | 0.75 | 0.5 | 2.0 |
| fast | 3 | 5 | 0.25 | 0.25 | 1.0 |

---

## 5. 目录遍历与下载的关键节流参数

- 目录遍历：`queue` / `directory_request_interval = 1/5`（**qps=5**）、并发
  `directory_scan_workers = 6`、预取 `directory_scan_prefetch = 12`、分页
  `page_size = 1150`。
- 下载取链：`download_endpoint = /open/ufile/downurl`，`download_request_interval = 1.0`
  （**qps=1**）。取链和遍历的 QPS 明显低于其它端点。
- 上传：`upload_request_timeout = 120.0`，分片重试 `upload_part_attempts = 3`、
  `upload_part_retry_delay = 1.0`；上传初始化走 `upload_control` 冷却槽。
- 删除：`delete_batch_size = 200` 分批，走 `mutation` 冷却槽。

### 分片上传顺序（sign-check 校验）
`/open/upload/get_token` → `init` → 上传分片 → `resume`；`_build_sign_check_data`
按 `init_result.sign_check` 给出的字节区间计算文件 SHA1 校验段，再复核
`pick_code / sign_key / sign_val` 验证上传完整性。

---

## 6. 应用层「主动核对」的预算与冷却（cloud_check 模式）

对批量只读核对（例如「这部片网盘上还在不在」）——**按预算 + 冷却双限**：
- 单次核对预算`CHECK_BUDGET = 60` 行；只在调用方显式触发时运行，绝不藏在页面
  GET 里。
- 端点最小化：只问 `GET /open/folder/get_info`（每行一次），`state` 记
  `yes/no`，**问不出的不落库**（防把失败误判成「文件没了」）。
- 撞上限立即停，已得出的结果落缓存并记 `cooldown_until`；冷却
  `COOLDOWN_SECONDS = 600`（10 分钟）内不再打接口。115 自身 429 退避 70 秒，
  冷却放宽到 10 分钟，因为「已被限流还继续试只会把限流拖更长」。
- 结果带时间戳缓存，区分「还在 / 没了 / 还没核对」三种状态。

---

## 7. 其它可复用防线

- `TtlCache`：进程内短 TTL 缓存易变的列表接口，减少重复请求。
- `retry_call`：有限线性退避包装可恢复操作，保留最后一次原始异常。
- `RateLimiter`（rate_limiter.py）：按 key 的滑动窗口 + 内存上限
  `maxsize=4096`，防被大量伪造来源 IP 撑爆；提供 `remaining()` / `retry_after()`，
  用于实现「先查剩余再决定是否请求」。

---

## 8. 结论：115 限流应对要点（速记）

1. **识别信号**：业务层 message「已达到当前访问上限」；HTTP 429 带 `X-RateLimit-Reset`。
2. **退避**：访问上限固定 70s × 6 次；429 读响应头 + 5s 填充、不占重试预算；
   其它临时错误指数 2,4,8,16,32。
3. **并发止损**：撞上限置共享事件，同任务其它请求立即停，冷却期绝不继续打。
4. **主动节流**：全局 QPS 先于端点族预约；目录 qps5 / 取链 qps1 / 冷端点用冷却槽。
5. **认证降级链**：access_token → refresh_token → cookie 重建；过期提前 60s 刷新，
   401/403 即重建，全程加锁。
6. **批量只读**：预算 60 行 + 冷却 10 分钟 + 问不出的不落库。