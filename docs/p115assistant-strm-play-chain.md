# p115assistant STRM 完整播放链（权威文档）

> 本文档描述 p115assistant 的 STRM 从生成到播放的完整链路、关键依赖、
> 以及 2026-10-08「strm_base_url 临时配置污染 2276 个存量 strm」事故的
> 教训与操作规范。改动播放相关代码/配置前必读。

## 1. 端到端播放链

```
115 云端文件
   │
   │ (1) 应用生成 .strm（定时同步 / 手动同步 / 临时生成）
   ▼
本地磁盘 .strm 文件                       ┌─ 内容格式见 §2
   │
   │ (2) 播放器打开 .strm
   │     · 飞牛影视（trim-media）：服务端 ffmpeg 读取 strm 内 URL（fnmov: 协议）
   │     · 外部播放器（Infuse/VLC 等）：直接请求 URL（局域网可达时）
   ▼
GET http://<base>:<relay_port>/api/v1/plugin/P115LiteAssistant/redirect?pickcode=…&expires=…&sign=…
   │     （3667 端口 = 应用独立中转端口，匿名可达，绕开 fnOS 网关认证）
   │
   │ (3) 应用校验：HMAC 验签（v2 payload 含 pickcode+expires，密钥 store.getRedirectSecret()）
   │     + IP 限流（60 req/60s 滑窗，进程级共享桶）
   ▼
(4) 应用向 115 OpenAPI 取链（getDownloadUrl），返回 CDN 直链
   ▼
302 Found → Location: https://cdnfhnfile.115cdn.net/…（公网 https CDN）
   │
   │ (5) 播放器跟随 302，直连 115 CDN 拉流（HEAD/Range/full GET）
   ▼
播放成功
```

## 2. strm 文件内容格式

```
http://<base>:<relay_port>/api/v1/plugin/P115LiteAssistant/redirect?pickcode=<115文件pickcode>&expires=<v2签名TTL>&sign=<HMAC-SHA256>
```

| 参数 | 来源 | 说明 |
|---|---|---|
| `base` | `strm_base_url` 配置（生成时写入）| 支持裸 host（如 `10.10.10.3`、`nas.local`）或带 `http(s)://` 的地址；**仅取 hostname**，scheme 恒为 `http`（1.4.6 起回退 1.3.9 语义，不再支持「完整 URL 原样生成」）|
| `relay_port` | `relay_port` 配置（默认 3667）| 应用中转监听端口（本机 0.0.0.0 匿名监听）|
| `pickcode` | 115 云端文件标识 | 生成时取自 115 API |
| `expires` | 签名 TTL 时间戳 | 默认「今天结束 + 7 天」的日界粗粒度；同一天生成签名稳定 |
| `sign` | `HMAC-SHA256(payload)` | v2: `p115liteassistant:v2:{pickcode小写}:{expires}`；v1 无 TTL 仅兼容旧链。**sign 只依赖 pickcode+expires，不依赖 base** |

⚠️ **关键性质**：
- **strm_base_url 在生成时写入文件**——**改配置只影响之后新生成的 strm，存量 strm 内容不会自动更新**（增量同步只写变化文件）。
- **sign 与 base 无关**——批量修正 strm 里 base/host 不会破坏验签（pickcode、expires、sign 原样保留即有效）。
- 侧车（字幕/刮削）复制与播放链无关；`redirect` 端点只关心验签+限流，随后 302 CDN。

## 3. 播放模式说明（1.4.6 回退后）

- **唯一模式：redirect 直链**：302 Location 恒为 115 CDN 公网直链，内网/外网均可达。
- 1.4.1~1.4.5 引入的 stream 本地代理/播放器 UA 取链豁免/远程自动 redirect 判定
  **已于 1.4.6 整体回退移除**（代码中不再存在 `/stream` 路由、3668 HTTPS 端口、自签证书）。
- **飞牛影视**：服务端 ffmpeg 在本机打开 strm（NAS 侧可达 3667），跟随 302 到 CDN——
  播放链与用户所在网络无关（内网/反代/fnconnect 均可用）。
- **外部播放器**：需播放器可到达 strm 内嵌 base（局域网直连 base=内网 IP 即可；
  外网直开需自建反代发布 3667 并把 strm_base_url 配成反代可达地址——见
  `docs/p115assistant-strm-remote-guide.md`）。

## 4. 事故记录（2026-10-08：2276 个存量 strm 被污染）

### 现象
- 全部 2276 个存量 strm 内容变成 `http://nas.example.com:8080/…/redirect`（应 `http://10.10.10.3:3667/…`）。
- 播放 302 到不可达域名 → 全部播放失败；用户反馈「1.4.5 还有问题」即此根因。

### 根因链
1. 真机验证 1.4.5「strm_base_url 支持完整 URL」时，验证脚本用 `save_config` 临时把
   `strm_base_url` 改为 `http://nas.example.com:8080`（测试完整 URL 解析）。
2. 验证脚本中途崩溃（NAS 上 python3 无权限），**还原步骤未执行**，配置停留在测试值。
3. 期间应用触发了一次 STRM 全量重生成（自动同步/定时任务），把**存量 2276 个 strm
   全部按错误 base 重写**。
4. 复核时**只检查了配置值还原，未抽查存量 strm 前缀**——污染未被及时发现。

### 教训
- **strm_base_url 是「生成时写死、存量不跟随」的全局参数**：临时改动它 = 一次潜在的全量改写。
- 验证/调试不得用生产配置直接改 strm_base_url；确需验证时：
  1. 先 `grep -rl "当前base" <媒体库>/Strm/ | wc -l` 记录基线；
  2. 改配置后**不触发生成**（暂停自动同步/定时任务）验证完立即还原；
  3. 还原后**抽查存量 strm 前缀**（`grep -rl "<错误域名>" <媒体库>/Strm/ | wc -l` 应为 0）。
- 任何会改配置的验证脚本必须**失败兜底**（trap 还原 / 脚本幂等还原），不能依赖人工收尾。

### 恢复流程（事故已发生）
1. 确认 `strm_base_url` 已还原正确值（`action/strm_status` → `base_url` 应为 `http://10.10.10.3:3667`）。
2. 方案 A（应用路径）：在应用 STRM 页触发一次全量同步，重写全部 strm（走应用写入）。
3. 方案 B（快速修复）：批量替换 strm 内 base 段——`sed -i 's#http://nas.example.com:8080#http://10.10.10.3:3667#g' <strm 文件>`——
   pickcode/expires/sign 原样保留，验签仍有效。**任何批量写媒体库操作须用户授权后再执行，且改前备份清单。**

## 5. 操作规范与防再发

| 规则 | 说明 |
|---|---|
| R1 | 改 `strm_base_url`/`relay_port` 前必须记录存量基线（grep 计数）+ 备份 config |
| R2 | 改配置验证期间不得触发生成（暂停同步/定时任务）；验证完**必须还原配置** |
| R3 | 还原后**必须**抽查存量 strm 前缀（`grep -rl <测试域名> | wc -l` 应为 0） |
| R4 | 验证脚本必须自带失败兜底还原（trap），不依赖人工收尾 |
| R5 | 媒体库（`/vol1/1000/媒体库`）属用户数据，写入（含批量替换）须显式授权 |
| R6 | 运行时 `strm_status` 的 `base_url` 只反映「下次生成用的地址」，**不代表存量 strm 已一致** |
| R7 | 存量 strm 前缀核验应纳入每次播放相关热更/验证的验收清单 |

## 6. 相关文件与版本线

- 代码：`apps/p115assistant/fnos/app/server/{main,server,store}.js` + `ui/index.html`
- 播放回退版本：1.4.6（回退至 1.3.9 语义；提交 `1ec349e`）
- 相邻文档：`docs/p115assistant-strm-remote-guide.md`（外网自建反代指引）