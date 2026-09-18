# 115网盘助手（p115assistant）

在 fnOS 上登录 115 网盘，浏览、上传（秒传/增量/实时监听）、STRM 生成、签到与 302 取链。
核心能力移植自 [MoviePilot-Plugins](https://github.com/DDSRem-Dev/MoviePilot-Plugins) 的
`p115liteassistant` 插件。

## 功能

- **扫码登录**：支付宝 / 微信 / 安卓 / iOS / 网页 / PAD / TV 多端扫码
- **网盘浏览**：目录树分页浏览、新建 / 重命名 / 删除
- **上传**：秒传优先 + 增量扫描 + 实时文件监听自动上传，多映射卡片管理
  - 源目录：fnOS 本地目录树可视化选择
  - 目标目录：115 网盘目录树可视化选择
  - 风控规避：文件级冷却 + 批量暂停 + 检测 115 访问上限自动全局暂停
- **STRM 生成**：115 目录 → 本地 `.strm` 文件（302 免登录取链，Emby/Jellyfin/Infuse 可直接扫库）
- **签到**：每日自动签到
- **302 取链**：签名校验 + 播放器 UA 直链

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `strm_base_url` | `""` | STRM 文件内 redirect 前缀（应用对外访问地址，如 `http://10.10.10.3/app/p115assistant`）|
| `upload_risk_profile` | `conservative` | 上传风控档位：conservative / balanced / aggressive |
| `watch_enabled` | `false` | 实时文件监听开关 |
| `strm_incremental` | `true` | STRM 增量同步（内容一致跳过、失效自动清理）|

## 运行时

- 依赖：`nodejs_v24`（manifest 通过 `install_dep_apps=nodejs_v24` 声明，安装时自动就绪）
- 后端为 Node.js 版，全部代码只使用内置模块，**零第三方 npm 依赖**（RSA/Fernet/OSS 分片签名/限流均为自实现）
- 数据目录：`TRIM_PKGVAR`（配置、上传记录、日志）

## 构建

```bash
# 完整构建 .fpk（app.tgz + fnOS 包装 → dist/）
./apps/p115assistant/update_p115assistant.sh

# 或分步
./scripts/apps/p115assistant/build.sh          # 生成 app.tgz
./scripts/build-fpk.sh apps/p115assistant app.tgz   # 生成 .fpk
```
