# STRM 302 播放链路诊断分析

> 对象：fnOS 应用「115网盘助手」（p115assistant，v1.1.9）
> 目的：分析应用生成的 STRM 文件为何无法 302 播放，对照上游 DDSRem P115StrmHelper 与 p115liteassistant，给出可落地修复清单。
> 日期：2026-09-18
> 方法：代码级推演 + NAS 真机验证（3667 端口端到端测试 + CDN 下载 UA 对照）。

---

## 一、结论摘要

**最可能的失败原因 Top 3（按历史影响排序）：**

1. **Content-Disposition 头编码 bug（旧版必现，已修复并部署）**：旧代码对中文/特殊字符文件名用 `Buffer.from(name).toString("ascii")` 静默生成控制字符，Node `writeHead` 抛 `ERR_INVALID_CHAR`，302 变成 400，播放直接失败。NAS app.log 共 **37 条** `Invalid character in header content ["Content-Disposition"]`，**全部发生在 2026-09-18 06:24:44（+0800）修复文件落盘之前**；当前进程（06:24:49 启动）运行修复代码后 **0 条**。
2. **115 CDN 下载 URL 与取链时 User-Agent 强绑定**（修复后仍可能失败的首要原因）：真机验证同 UA 下载 → 200，异 UA → **403**。播放器请求 3667 不带 UA 时，取链兜底成 `P115LiteAssistant/1.0`，CDN URL 绑定该 UA，播放器用自己的 UA 下载必然 403。
3. **取链失败（open token 生命周期 / 文件失效）**：当前为纯 open 登录态（无 cookie），access_token 过期后若无有效 refresh_token 则无法续期，返回"缺少有效的 115 Open 授权"，取链 502。日志中 `取链失败：参数错误`（09-15）、`取链失败：文件不存在或已删除`（09-17）佐证部分映射的 pickcode 本身失效。

> 真机验证结论：**在 Content-Disposition 修复已部署、UA 一致的前提下，本应用 302 链路是通的**——有效签名 → 302 + CDN Location → 同 UA 200。故障是"特定条件下的必然失败"，不是链路整体不可用。

---

## 二、上游链路解析

### 2.1 DDSRem P115StrmHelper（NAS moviepilot-v2 容器，2.8.74）

**STRM 内容格式**（`utils/strm.py:446-452`）：

```
http://{moviepilot_address}/api/v1/plugin/P115StrmHelper/redirect_url?pickcode={pickcode}
```

- **默认无 sign、无 file_name**；仅当 `strm_url_format == "pickname"` 时才追加 `&file_name=…`。
- pickcode 为 115 原生小写值。

**匿名放行**（`__init__.py`）：redirect_url 的 GET / POST / HEAD 三个路由均注册 `allow_anonymous: True`，播放器无需登录态即可访问，鉴权靠 pickcode 本身存在性。

**302 服务实现**（`api.py` `_redirect_url_impl`）：

1. 取请求 `User-Agent`；pickcode 校验 `len==17 and isalnum()` 后 **`pickcode.lower()`** 再取链。
2. 按 `link_redirect_mode` 配置选择 cookie 模式（`get_downurl_cookie`）或 open 模式（`get_downurl_open`）。
3. 缓存按 **`(pickcode, cache_ua)`** 分桶（`r302cacher`），`cache_ua` 为空时用 `"NoUA"`；TTL = 链接过期 - 5min；并发用 `_acquire_downurl_lock` 锁。
4. 响应：
   - `Location = UrlUtils.encode_url_fully(str(url))`，即 `quote(url, safe=":/?#@!$&'()*+,;=%")`——对 URL 全量百分号编码，避免 Location 头里出现空白/非 ASCII。
   - `Content-Disposition`：ASCII 文件名 → `attachment; filename="..."`；非 ASCII → **RFC 5987** `attachment; filename*=UTF-8''{quote(file_name, safe="")}`（safe 为空串，`'()!*` 也编码，保证头值合法）。
   - 302 带 JSON body `{"status":"redirecting","url":url}`（便于排障）。
5. **UA 绑定处理**：CDN URL 与取链 UA 绑定，DDSRem 通过"缓存键含 cache_ua + 透传请求 UA"保证同一播放器再次取链拿到的是同一绑定 UA 的 URL；空 UA 播放器是已知限制（`"NoUA"`）。

**其他**：插件还提供 FUSE 挂载等能力，但 302 播放本身不依赖。

### 2.2 p115liteassistant（本地 worktree，上游参考）

- STRM：`{moviepilot}/api/v1/plugin/P115LiteAssistant/redirect?pickcode=…&file_name=…&sign=HMAC`。
- 签名：`build_redirect_signature` = HMAC-SHA256(`p115liteassistant:v{REDIRECT_SIGNATURE_VERSION}:{normalize_pickcode}`)，pickcode 先 `normalize_pickcode` 小写化。
- `api.py redirect()`：客户端 IP → 限流（60 req/60s）→ 验签 → 按配置 `link_redirect_mode` 取链 → `_redirect_cache`（key = pickcode + cache_ua + auth_mode）→ singleflight → `retry_call(fetch_url, 3)` → `_redirect_response`。
- `_redirect_response` 的 Content-Disposition：`name.encode("ascii")` 成功 → `inline; filename="…"`；抛 `UnicodeEncodeError` → `filename*=UTF-8''{quote(name, safe='')}`——**判断用的是"能否 ascii 编码"，编码对象是原始字符串，非 ASCII 必抛异常走 RFC5987 分支**（与本应用旧 bug 的"JS 字符串没有 encode、静默走 Buffer.ascii"形成对比）。

---

## 三、本应用链路推演

### 3.1 链路构成

1. **STRM 文件内容**（`server.js` `_runStrmMapping` / `_resolveStrmBaseUrl`）：
   ```
   http://10.10.10.3:3667/api/v1/plugin/P115LiteAssistant/redirect?pickcode=…&file_name=…&sign=HMAC-SHA256(p115liteassistant:v1:{pickcode})
   ```
2. **3667 中转端口**（`main.js` `startRedirectPort`）：0.0.0.0:3667，只放行 `/redirect`、`/action/redirect`、`/api/v1/plugin/P115LiteAssistant/redirect`，其余 404；复用 `TrimHandler._handleRedirect`。
3. **`_handleRedirect`**（`main.js:258`）：
   - `method !== "GET"` → 405（HEAD 也 405）。
   - 2 秒限流：source = `x-forwarded-for` / `x-real-ip` / **`unknown`**；直连 3667 时前两者缺失 → **所有直连客户端共享同一个"unknown"桶**。
   - 调 `server.api.redirectTarget(pickcode, sign, file_name, userAgent)`。
   - 成功 302：`{ Location, Connection: close, Cache-Control: no-store }`——**不设置 Content-Disposition**（当前部署版）。
4. **`redirectTarget`**（`server.js:2283`）：
   - 验签 `verifyRedirectSignature`（HMAC，`p115liteassistant:v1:{pickcode}`，**未做小写归一**；115 生成 pickcode 本就小写，实际无差异）。
   - 缓存 key = `{pickcode}|{ua}`，TTL = CDN URL `t` 参数剩余 - 300s，兜底 15min；singleflight 并发去重；`_fetchRedirectUrlWithRetry` 重试 3 次（限流/认证类错误不重试）。
   - `getDownloadUrl(pickcode, ua)`。
5. **`getDownloadUrl`**（`client.js:1471`）：
   - `_playbackAuthMode`：无 mode 时 `this.cookie ? "cookie" : "open"`。当前登录态为 open（仅 access_token）。
   - open 模式 `_getOpenDownloadUrl`：POST `/open/ufile/downurl`，form `{pick_code}`，`headers: { "User-Agent": userAgent }`，走 `_request` → `_ensureOpenAuth`（Bearer token）。
   - cookie 模式 `_getCookieDownloadUrl`：RSA 加密 `{pick_code}` → `proapi.115.com/android/2.0/ufile/download`。
   - **UA 兜底**：`_requestUrl`（`client.js:2036`）`if (!headers["User-Agent"]) headers["User-Agent"] = "P115LiteAssistant/1.0"`——播放器不带 UA 时取链用固定 UA。

### 3.2 Content-Disposition bug 是否必然导致 302 失败（播放器视角）

**旧版 bug 代码**（`git show HEAD` 基线）：

```js
if (result.file_name) {
  const name = String(result.file_name).replace(/["\r\n]/g, "_");
  try {
    name.encode ? name.encode("ascii") : Buffer.from(name).toString("ascii");
    headersOut["Content-Disposition"] = `inline; filename="${name}"`;
  } catch {
    headersOut["Content-Disposition"] = `inline; filename*=UTF-8''${encodeURIComponent(name)}`;
  }
}
```

推演结论：

- **ASCII 文件名**：`Buffer.from("abc.mp4").toString("ascii")` 输出不变，`writeHead` 成功 → 302 正常。**旧版对英文名文件本来就能播放**（真机验证过 52 字节 ASCII probe 文件）。
- **中文/emoji 等非 ASCII 文件名**：JS 字符串无 `.encode`，条件走 `Buffer.from(name).toString("ascii")`——该方法**不抛异常**，而是把每个 UTF-8 字节 `& 0x7F` 静默降位，产生 `0x00–0x1F` 控制字符（例如"中文"两字的尾字节 0x16/0x07）。catch 分支**永远不会执行**（无异常），于是 `Content-Disposition` 头值含控制字符 → Node `writeHead` 抛 `ERR_INVALID_CHAR "Invalid character in header content [\"Content-Disposition\"]"` → `_handleRedirect` 的 promise reject → `handle()` catch → 回 **400 `{"success":false,"message":"请求格式错误"}`**。播放器看到 400 而非 302 → **播放必然失败**。
- 中文字幕/片名在媒体库中是绝大多数，因此旧版**实际覆盖面几乎是"所有中文名文件必挂"**。

**时间线铁证**（NAS app.log，UTC）：

| 时刻 (UTC) | 事件 |
|---|---|
| 09-17 22:10:20–22:10:31 | 16 条 CD 错误（旧进程） |
| 09-17 22:17:37 | 进程重启（仍加载磁盘上旧 main.js） |
| 09-17 22:20:45 | 再 1 条 CD 错误（旧进程，文件尚未替换） |
| 09-18 06:24:44 (+0800) | **main.js 被替换为修复版**（mtime 铁证） |
| 09-18 06:24:49 (+0800) | 当前进程 PID 178075 启动，加载修复代码 |
| 之后 | **0 条 CD 错误** |

→ 修复已上线并生效。**剩余风险与"能否播放"无关，是"是否所有场景都能播"**。

### 3.3 修复后仍可能失败的点（按概率）

1. **UA 不一致 → CDN 403**（最高）：CDN URL 与取链 UA 绑定。真实播放器（Infuse/Jellyfin）请求 3667 时会带自己的 UA，`redirectTarget` 把该 UA 透传给 115 → CDN URL 绑定播放器 UA → 播放器下载同 UA → 200，正常。但以下情况 403：
   - 播放器不发 UA（或中间层剥掉 UA）→ 取链兜底 `P115LiteAssistant/1.0`，播放器下载用自己的 UA → **403**。
   - 取链请求与下载请求 UA 不一致（下载由另一组件/客户端完成）。
   - 缓存命中跨 UA：缓存 key 含 UA，正常不会，但兜底 UA 与真实 UA 不一致时第二次同文件仍 403。
2. **open token 过期且无续期路径 → 取链失败**：`_ensureOpenAuth` 顺序 refresh_token → cookie 换 token → 都没有则报"缺少有效的 115 Open 授权"。当前无 cookie，若 refresh 也失效（如令牌吊销/过期），播放器取链 502。历史日志 `检查登录状态失败：参数错误`（09-14 多次）、`取链失败：参数错误`（09-15 多次）即为该异常区间证据。
3. **限流 429**：直连共享 "unknown" 桶，2 秒 1 次。单集播放只请求 1 次不受影响；但扫描/重试/多集连播可能 429。429 时播放器显示"过于频繁"，非 302。
4. **HEAD 405**：`method !== "GET"` → 405。部分播放器/下载器先 HEAD 探测。
5. **Location 头未编码**：CDN URL 路径段若含空格/非 ASCII（写盘文件名），`Location` 直接原样下发；Node 允许 0x80–0xFF，不会 ERR_INVALID_CHAR，但严格客户端可能解析失败。DDSRem 用 `encode_url_fully` 规避。
6. **pickcode 失效**：文件在 115 被删/转存失效 → `取链失败：文件不存在或已删除`（09-17 13:07 UTC 实测日志）。

---

## 四、差异对照表

| 维度 | DDSRem P115StrmHelper | 本应用 p115assistant | 影响 |
|---|---|---|---|
| STRM URL | `…/redirect_url?pickcode=xxx`（无 sign；pickname 模式才带 file_name） | `…/redirect?pickcode=&file_name=&sign=HMAC`（恒带签名+file_name） | 本应用有验签更安全；恒带 file_name 使旧版 CD bug 全量触发 |
| 匿名放行 | MoviePilot 路由 `allow_anonymous: True`，GET/POST/HEAD | 独立 3667 端口，仅 GET（HEAD/POST → 405） | HEAD 探测型客户端会失败 |
| pickcode 大小写 | 校验后 `pickcode.lower()` 再取链 | 透传（签名未归一，115 原生小写无实际差异） | 风险极低 |
| 取链模式 | 配置 `link_redirect_mode`（cookie/open） | `_playbackAuthMode`：有 cookie 用 cookie，否则 open（当前 open） | 一致 |
| UA 处理 | 透传请求 UA；缓存键 `(pickcode, cache_ua)`，空 UA 用 "NoUA" | 透传请求 UA；缓存键 `{pickcode}|{ua}`；**空 UA 兜底 `P115LiteAssistant/1.0`** | 空 UA 播放器取链绑定错误 UA → CDN 403 |
| 缓存 | r302cacher `(pickcode, cache_ua)`，TTL=expire-5min，并发锁 | `{pickcode}|{ua}`，TTL=t 剩余-300s 兜底 15min，singleflight | 等效 |
| 重试 | retry_call 3 次 | 3 次（限流/认证不重试） | 一致 |
| Content-Disposition | 恒设置：ASCII→`attachment; filename="…"`；非 ASCII→**RFC5987** `filename*=UTF-8''{quote(safe="")}` | 修复前 buggy（Buffer.ascii 静默控制字符 → 400）；**修复后不设置** | 已解决；DDSRem 保留因需在文件名场景展示，播放场景可省 |
| Location 编码 | `UrlUtils.encode_url_fully`（quote safe 含 `%`） | 原样下发 | 特殊字符路径段可能解析失败 |
| 302 body | JSON `{"status":"redirecting","url":url}` | 空 body | 排障可观测性 |
| 限流 | 60 req/60s（按 IP） | 2s 1 次/IP；直连共享 "unknown" 桶 | 多客户端连播可能 429 |
| FUSE | 提供（播放不依赖） | 无 | 无关 |

---

## 五、修复清单（按优先级）

> 依据：本任务只产出文档、**不改源码**；以下为落地建议，均给出文件/函数/改法。

### P0 —— 已修复并部署（核对确认）

1. **移除 302 响应中的 Content-Disposition 头**
   - 位置：`fnos/app/server/main.js` → `TrimHandler._handleRedirect` 302 分支。
   - 现状：只下发 `{ Location, Connection, Cache-Control }`（main.js:285-289 注释说明），已上线（2026-09-18 06:24:44 +0800 替换 main.js，06:24:49 重启生效）。
   - 验证：部署后日志 0 条 CD 错误；真机 302 测试通过。
   - 后续若确需文件名展示，应仿 DDSRem：`filename*=UTF-8''${quote(file_name, safe="")}`（safe 空串，含 `'()!*`），而非 `encodeURIComponent`。

### P1 —— 高优先级（修复后仍无法播放的最可能原因）

2. **空 UA 时的取链兜底策略**
   - 位置：`fnos/app/server/client.js` → `_getOpenDownloadUrl` / `_getCookieDownloadUrl`（headers）与 `_requestUrl`（:2036）。
   - 问题：播放器不带 UA → 取链用 `P115LiteAssistant/1.0` → CDN URL 绑定该 UA → 播放器下载 403。
   - 改法：
     a. 定义 `DEFAULT_PLAYBACK_UA`（如 `Infuse/7.5`），空 UA 时取链用它；
     b. 至少在文档/UI 注明"播放器必须带 UA，且取链与下载 UA 一致"，否则 CDN 403；
     c. 可选：`_getOpenDownloadUrl` 取链后无法预判播放器 UA，因此**空 UA 场景无完美解**——接受限制并提示，或在 302 的 Location 后追加 UA 校验接口供排障。
3. **open token 生命周期兜底**
   - 位置：`fnos/app/server/client.js` → `_ensureOpenAuth`（:636）。
   - 问题：当前无 cookie，access_token 过期且 refresh_token 失效 → 取链 502"请重新扫码登录"。
   - 改法：
     a. 定时检测 `_openTokenExpired()`，剩余寿命 < 阈值时推送通知/UI 红点引导重新扫码；
     b. `redirectTarget` 把"Open 授权失效"错误映射为播放器可见的友好 502 文案；
     c. 建议 UI 增加"Open 授权状态 + 过期时间"展示。

### P2 —— 中优先级（特定场景失败）

4. **支持 HEAD 请求**
   - 位置：`main.js` → `_handleRedirect`（:259）。
   - 改法：`method === "GET" || method === "HEAD"` 放行；HEAD 走与 GET 相同的验签/取链/302 头，`res.end()` 不写 body（`_respond` 也可复用）。
5. **直连限流按真实 IP 分桶**
   - 位置：`main.js` → `_handleRedirect` source 推导（:267-269）。
   - 改法：`headers["x-forwarded-for"] || headers["x-real-ip"] || req.socket.remoteAddress || "unknown"`，使直连各客户端独立分桶；并可放宽为令牌桶（如 1 次/2s + burst 3）避免连播抖动。
6. **Location 头 URL 编码**
   - 位置：`main.js` → `_handleRedirect` 302 分支（:288）。
   - 改法：仿 `UrlUtils.encode_url_fully`：`url.split('#')[0]` 全量 quote，保留 `:/?#@!$&'()*+,;=%`（Node 侧 `encodeURI(url)` 保留集基本一致，但注意 `encodeURI` 不编码已有 `%` 序列——直接使用 `url` 原样风险可控，加固即可）。
7. **STRM 生成时 pickcode 预检**
   - 位置：`server.js` → `_runStrmMapping`。
   - 改法：生成 STRM 前对 pickcode 做一次 open 取链预检（或校验长度/字符集），失败的在映射状态标记"文件失效"，避免生成死链；日志中 09-15/09-17 的"参数错误 / 文件不存在或已删除"即此类。

### P3 —— 低优先级 / 加固

8. **pickcode 签名归一**
   - 位置：`server.js` → `buildRedirectSignature`（:2261）。
   - 改法：签名前 `String(pickcode).trim().toLowerCase()`，与上游 `normalize_pickcode` 对齐（当前 115 原生小写，纯防御）。
9. **302 带 JSON body**
   - 位置：`main.js` → `_handleRedirect`。
   - 改法：302 时 `res.end(JSON.stringify({ status: "redirecting", url: result.url }))`，与 DDSRem 一致，便于 curl/播放器日志排障。

---

## 六、验证方法

### 6.1 端到端（真机已执行，2026-09-18）

```bash
# 1) 有效签名 → 期望 302 + Location
curl -i "http://10.10.10.3:3667/api/v1/plugin/P115LiteAssistant/redirect?pickcode=<pickcode>&file_name=<name>.mp4&sign=<sign>"
#   → HTTP/1.1 302 Found，Location: https://cdnfhnfile.115cdn.net/…

# 2) 用与取链相同的 UA 下载 CDN → 期望 200，文件大小吻合
curl -s -o /dev/null -w "%{http_code} %{size_download}\n" -H "User-Agent: Infuse/7.5" "<Location>"
#   → 200 52

# 3) 换 UA 下载同一 Location → 期望 403（证明 UA 绑定）
curl -s -o /dev/null -w "%{http_code}\n" -H "User-Agent: Jellyfin/10.9" "<Location>"
#   → 403
```

### 6.2 边界用例（回归时逐条跑）

| 用例 | 期望 | 对应修复项 |
|---|---|---|
| 中文名文件播放 | 302 且无 `ERR_INVALID_CHAR` | P0 |
| 不带 UA 请求 3667 | 302（但 CDN 可能 403，须提示） | P1-2 |
| 带 UA A 取链、UA A 下载 | 200 | P1-2 |
| 带 UA A 取链、UA B 下载 | 403（预期行为，非 bug） | P1-2 |
| `curl -I`（HEAD）请求 | 302（修复后） | P2-4 |
| 2 秒内连发 2 次 | 第 2 次 429（直连共享桶） | P2-5 |
| open token 过期后播放 | 友好 502，UI 提示重登 | P1-3 |
| 已删除文件的 STRM | 502"文件不存在" | P2-7 |

### 6.3 日志判读

- `Invalid character in header content ["Content-Disposition"]` → 旧版 CD bug（P0 后应绝迹）。
- `匿名取链失败：…` → redirectTarget 取链异常（open token / 网络）。
- `取链失败：…` → UI `link()` 测试动作失败（token 或 pickcode 问题）。
- `请求过于频繁` → 429 限流。

---

## 附：证据索引

- NAS：`/vol1/@appdata/p115assistant/app.log`（1078 行；37 条 CD 错误均在 2026-09-18 06:24:44 +0800 前；06:24:49 后 0 条）。
- NAS：`/vol1/@appcenter/p115assistant/server/main.js`（mtime 2026-09-18 06:24:44 +0800，修复版；与本地工作区 diff 一致）。
- 容器 DDSRem：`/app/app/plugins/p115strmhelper/api.py`（302 实现）、`utils/url.py`（encode_url_fully）、`helper/r302/__init__.py`（UA 缓存）、`utils/strm.py`（STRM 格式）。
- 本地工作区：`apps/p115assistant/fnos/app/server/{main.js,server.js,client.js}`。
