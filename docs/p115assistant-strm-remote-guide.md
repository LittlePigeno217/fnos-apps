# p115assistant STRM 外网播放（自建反向代理）指引

> 目标版本：p115assistant 1.4.5+（1.4.5 起 `strm_base_url` 支持填写完整 URL，
> 可用于 https 反向代理 / 自定义端口 / 网关子路径）。
> 本文档是**方案 D**：零代码，指导用户自建反代让 STRM 在外网可播放。

---

## 1. 适用场景

**非飞牛影视播放器**（Infuse / VLC / 手机 App / Kodi 等）在**外网**（非局域网）直接打开 `.strm` 文件时，
`.strm` 内嵌的地址必须是**外网可达**的，播放器才能建立连接并拿到 115 直链。

- ✅ 局域网播放：默认即可，无需本指引。
- ✅ 飞牛影视（trim-media）播放：走**服务端拉流**（内网 / 反向代理 / fnconnect 均可），无需本指引（见第 7 节）。
- ⚠️ 外网 + 非飞牛影视播放器：**必读本指引**。

## 2. 原理

STRM 文件里写的是 `http(s)://<strm_base_url>/api/v1/plugin/P115LiteAssistant/redirect?...`。
要让外网播放器能访问：

1. 应用在 NAS 的 **3667** 端口提供匿名取链 + 302 跳转服务（`_relayPort()`）；
2. 外网无法直连 NAS 内网私有 IP → 需要自建**反向代理**，把公网 HTTPS 入口转发到 NAS 的 3667；
3. 把 `strm_base_url` 配成这个公网可达的反代地址。

## 3. nginx 反向代理配置示例

假设 NAS 内网地址 `192.168.1.50`，公网域名 `nas.example.com`，公网 HTTPS 由 nginx 或别的网关终止。

```nginx
server {
    listen 443 ssl;
    server_name nas.example.com;
    ssl_certificate     /etc/letsencrypt/live/nas.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/nas.example.com/privkey.pem;

    # 关键：把 /api/v1/plugin/P115LiteAssistant/ 转发到 NAS 的 3667
    location /api/v1/plugin/P115LiteAssistant/ {
        proxy_pass http://192.168.1.50:3667;

        # ★必须★：透传原始 Host 头，否则应用回拼的 302 Location 会写成内网 IP/端口，
        #         外网播放器跟随后会拿到不可达地址
        proxy_set_header Host $host;
    }
}
```

**强调**：`proxy_set_header Host $host;` 这一行**必须保留**。
应用依据请求 Host 回拼跳转地址，若不透传 Host，302 Location 会带上内网 IP，外网播放器会 404 / 无法连接。

> 注：若你的反代在**同一台 NAS**（例如用 Caddy/nginx 也跑在 NAS 上），proxy_pass 目标可写 `http://127.0.0.1:3667`，其余不变。

## 4. 工作流与配置

```
外网域名 nas.example.com (443)
        │  反向代理
        ▼
NAS 内网 192.168.1.50:3667  ← p115assistant 取链/302
```

1. 按第 3 节部署反向代理，验证 `https://nas.example.com/api/v1/plugin/P115LiteAssistant/` 能访问；
2. 在 p115assistant 的「STRM」页，「播放地址」里把 `strm_base_url` 填为
   **完整 URL**：`https://nas.example.com`（1.4.5 起支持）。
   - 若反代挂在子路径，例如 nginx 用 `location /p115/` 且内部拼接，可填 `https://nas.example.com/p115`；
   - 若反代是自定义 HTTPS 端口，填 `https://nas.example.com:8443`；
3. 重新同步 STRM，确认生成的 `.strm` 内地址是 `https://nas.example.com/...`；
4. 从外网用非飞牛影视播放器打开一个 `.strm` 验证。

## 5. 只支持 redirect 模式

- 反代场景**建议把播放模式保持为 `redirect`**（默认值）。
- 即便配置成 `stream`，1.4.5 下 stream 经反代的 302 跳转仍是 `http://<host>:3667/stream`，
  该 `3667/stream` 地址不一定能同样经反代协议/端口正确穿透，容易踩 TLS 与内外网差别。
- 保持 redirect：302 指到 115 官方 CDN，外网播放最稳。

## 6. 安全建议

- **3667 是匿名取链端口**：签名防篡改，但**不校验来源 IP**——任何能访问 3667 的人都可匿名取链。
- 建议用防火墙（iptables / ufw）把 3667 **只放行反代服务器 IP**，防公网直扫滥用；
- 或反代上加 `allow/deny` 限制中间层可达来源；
- 公网入口优先走 https（自建证书或 Let's Encrypt），避免明文 token 泄漏。

## 7. fnconnect 说明

若你只用**飞牛影视**播放：飞牛影视经 **fnconnect 远程通道**播放时是**服务端拉流**，
`.strm` 内嵌的是内网地址也能正常播放，**无需**本指引，也不用改 `strm_base_url`。
本指引仅针对「外网 + 非飞牛影视播放器」的客户端直拉场景。