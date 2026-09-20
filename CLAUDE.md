# FnOS-APP 项目强制规则

本规则适用于 FnOS-APP 仓库中的所有构建、更新、备份、迁移、清理、脚本和文档操作。
本仓库位于 `/home/LittlePigeno/WorkSpace/Projects/FnOS-APP`，受 WorkSpace 根项目规则约束。

## 仓库边界与只读源

- **`fnos-apps`（`/home/LittlePigeno/WorkSpace/Projects/fnos-apps`）是只读参考源，
  任何情况下不得修改其中任何文件。**
- 迁移采用「复制不是移动」：不得删除 fnos-apps 中任何文件。

## 目录分类原则

所有文件按以下顺序存放：

`应用(slug) → 业务/子系统 → 文件功能 → 文件`

- `apps/<slug>/`：应用自身（fnos/ 包内容、VERSION、runtime-manifest.json、README）。
- `scripts/apps/<slug>/`：应用构建合约 meta.env（唯一差异承载点）与可选参考脚本。
- `shared/`：通用生命周期框架（cmd + wizard），跨应用共用，不放入应用私有逻辑。
- `docs/`：`architecture.md`（唯一权威结构源）、`migration-baseline.md`、`add-app.md`。
- `dist/`：构建产物 `.fpk`，不入 Git。

禁止在仓库根堆积临时下载/命令输出/一次性中间文件；中间产物（app.tgz 等）用完即删。

## 命名规范（必须遵守）

- 应用 slug：小写字母数字 + 连字符；目录名与 slug 一致。
- `fnos/manifest`：`appname` = slug；`version` = FPK 版本，**恒 1.0.0**。
- fpk 产物名：`<file_prefix>_<ver>_all.fpk`（file_prefix = meta.env FILE_PREFIX，默认 = slug）。
- **严禁改动**：应用 slug / display_name / file_prefix / 应用内更新 URL（`update.js`
  的 `UPDATE_REPO` 与热更 tag 前缀）。

## 修改前强制备份（远程设备操作）

对远程设备（NAS）进行任何会改变配置、数据或运行状态的修改前，必须：

1. 读取并确认待修改的目标及其当前用途。
2. 将修改前内容备份到对应 `设备/业务/Backups/` 目录（含时间戳 `YYYYMMDD-HHMMSS`）。
3. 生成 SHA-256 清单并校验通过。
4. 确认备份可读且不为空后，才能修改远程目标。

## 远程目录整洁规则

1. 远程生产目录只保留当前业务实际使用的配置、持久数据和运行脚本。
2. 清理前必须核对容器挂载、Compose 配置、定时任务、服务配置和符号链接引用。
3. 无法确认是否使用的目录不得删除；应先记录到对应 `Inventory/` 或 `Reports/`。
4. 删除远程文件前，必须确认其本地归档完整并通过校验。
5. 修改结束后必须验证配置、服务健康状态和核心业务连接。

## 本地项目整洁规则

1. 临时下载、命令输出和一次性中间文件不得留在仓库根目录。
2. 操作完成后，应将清单、报告和脚本归入对应目录。
3. 不得重复保存相同备份；重复内容通过 SHA-256 识别后合并。

## 操作完成标准

任务只有在以下项目全部完成后才能报告成功：

1. 本地文件已按应用、业务和功能正确归档。
2. 仓库根没有本次操作产生的临时备份或无用文件。
3. SHA-256 或相应完整性校验通过。
4. 受影响服务恢复为 `running` 或 `healthy`。
5. 核心业务连接和配置验证通过。
6. 对应 `docs/`、`Inventory/` 或 `Reports/` 已记录重要变更。

## Git 与安全

- `dist/`、`app.tgz`、`*.fpk`、`*.env`、数据库转储、密钥、令牌及包含敏感信息的清单不得提交 Git。
- 未经用户明确要求，不创建提交、不推送远程仓库。
- 展示配置和日志时必须隐藏密码、令牌、密钥、Cookie、连接串凭据等敏感值。
- 应用配置中的 115 cookie/tokens 使用 Fernet 加密落盘（`TRIM_PKGVAR`），密钥只缓存在内存。