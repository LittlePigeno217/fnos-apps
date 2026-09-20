# CHANGELOG

## 1.0.1 (2026-09-18)

### Changed

- **应用图标替换**：fnos/ui/images 与 ICON.PNG/ICON_256.PNG 全部换用新图
  （256/64 双尺寸，含旧命名 icon_256/icon_64 同步）

## 1.0.0 (2026-09-18)
## 1.2.1 (2026-09-18)

### Fixed

- **302 播放彻底移除 Content-Disposition**：该头仅下载场景需要，且中文/特殊字符
  文件名触发 Node writeHead Invalid character 校验失败（真机日志确认），
  导致播放器 302 请求 400 无法跳转；移除后播放器按 Location 跳转即可（2026-09-18）

## 1.2.0 (2026-09-18)
## 1.2.0 (2026-09-18)

### Fixed

- **302 播放 Content-Disposition header 编码修复**：中文/特殊字符文件名时
  encodeURIComponent 不编码 '()!* 等字符导致 Node writeHead 抛
  Invalid character in header content（302 响应失败，播放器无法跳转）；
  改为逐字节 UTF-8 百分号编码，只保留安全 ASCII，header 值合法

## 1.1.9 (2026-09-18)
## 1.1.9 (2026-09-18)

### Changed

- **新增独立 302 播放中转端口（默认 3667）**：绕开 fnOS 网关对 /app/* 的强制认证
  （播放器带不了登录 token，此前 STRM 302 被网关拦截 invalid token 无法播放）：
  - 后端 main.js 启动时额外监听 0.0.0.0:3667，只放行 /redirect 与
    /api/v1/plugin/P115LiteAssistant/redirect（GET/HEAD），其余路径 404
    （不暴露 UI/API，保持最小攻击面）
  - HMAC 验签 + IP 限流 + URL 缓存 + 取链重试逻辑全部复用（同一 redirectTarget）
  - 端口可用 --port 或环境变量 P115_RELAY_PORT 覆盖（默认 3667）
- **STRM 基础地址改为固定中转端口**：（宿主 IP 优先取
  strm_base_url 配置中的 IP，否则取默认路由网卡 IPv4）；前端只读展示自动回填

### Fixed

- 此前 STRM 302 播放被 fnOS 网关认证层拦截（invalid token），播放器无法匿名取链

## 1.1.8 (2026-09-18)