# CHANGELOG

## 2026-09-16

### Changed
- 仓库结构对齐 [conversun/fnos-apps](https://github.com/conversun/fnos-apps)：
  `apps/p115assistant/fnos` + `shared/` + `scripts/` 标准布局
- 构建链路：`apps/p115assistant/update_p115assistant.sh` → `scripts/apps/p115assistant/build.sh`
  （app.tgz）→ `scripts/build-fpk.sh`（.fpk）→ `dist/`
- `fnos/ui/` 拆分为桌面入口配置，运行时移至 `fnos/app/`（app.tgz 平铺）
- manifest 补齐 `distributor` / `service_port=0` / `install_dep_apps=nodejs_v24` / `checksum`
- 应用功能：上传映射卡片化 + 实时文件监听 + 上传风控 + STRM 生成（见 apps/p115assistant/CHANGELOG.md）

### Removed
- 旧 `fpkg/` 目录（内容已迁移至 `apps/p115assistant/fnos/`）
- 仓库根 `p115assistant.fpk` 直接产物（构建输出改到 `dist/`）
