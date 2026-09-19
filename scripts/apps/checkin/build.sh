#!/bin/bash
set -e

# checkin 打包脚本：生成 app.tgz（server + ui 运行时）。
# 本项目是本地自研应用（无外部上游 release），版本号从 manifest 读取。
#
# 用法:
#   ./build.sh                 # 使用 manifest 中的版本号
#   VERSION=1.0.2 ./build.sh   # 覆盖版本号
#
# 产物: 仓库根目录 app.tgz（由 build-fpk.sh 进一步合并成 .fpk）

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
APP_DIR="${SCRIPT_DIR}/../../../apps/checkin"
FNOS_DIR="${APP_DIR}/fnos"

# 版本号优先取环境变量，否则读 manifest
if [ -z "${VERSION:-}" ]; then
    VERSION=$(grep "^version" "${FNOS_DIR}/manifest" | awk -F'=' '{print $2}' | tr -d ' ')
fi
[ -z "$VERSION" ] && { echo "ERROR: 无法确定版本号（manifest 缺少 version 或 VERSION 未设置）" >&2; exit 1; }
echo "[checkin] 打包版本: ${VERSION}"

WORK_DIR=$(mktemp -d)
trap "rm -rf ${WORK_DIR}" EXIT

# app.tgz 内容 = server/ + www/（前端运行时）+ ui/（桌面图标配置）+ config/（权限/资源）
# 重要（2026-09-17 真机验证）：install-fpk 只平铺 app.tgz 到安装根目录，
# FPK 包根的 ui/、config/ 不会被部署（解包后为空目录）→ 桌面图标/appServiceInfo 不注册 → 应用中心找不到。
# 因此桌面图标配置（fnos/ui）和 config/ 必须打进 app.tgz。
mkdir -p "${WORK_DIR}/server" "${WORK_DIR}/www" "${WORK_DIR}/ui" "${WORK_DIR}/config"
cp -a "${FNOS_DIR}/app/server/." "${WORK_DIR}/server/"
cp -a "${FNOS_DIR}/app/ui/." "${WORK_DIR}/www/"
cp -a "${FNOS_DIR}/ui/." "${WORK_DIR}/ui/"
if [ -d "${FNOS_DIR}/config" ]; then
  cp -a "${FNOS_DIR}/config/." "${WORK_DIR}/config/"
fi

# 版本 env 写入 config/bootstrap/（upgrade_callback 读取，参照 hermes-agent 的
# hermes-version.env；manifest 不部署到设备，目标版本必须随包带）
mkdir -p "${WORK_DIR}/config/bootstrap"
cat > "${WORK_DIR}/config/bootstrap/checkin-version.env" <<EOF
# 115网盘助手 目标版本（构建时注入；upgrade_callback 读取用于版本记录/检测）
P115ASSISTANT_VERSION=${VERSION}
EOF
echo "[checkin] 版本 env 已写入: config/bootstrap/checkin-version.env"

# 版本注入：store.js 的 DEFAULT_CONFIG.version 与 update.js 的 CURRENT_VERSION 随构建版本更新
sed -i "s/version: \"[0-9.]*\"/version: \"${VERSION}\"/" "${WORK_DIR}/server/store.js" 2>/dev/null || true
sed -i "s/const CURRENT_VERSION = process.env.P115ASSISTANT_VERSION || \"[0-9.]*\"/const CURRENT_VERSION = process.env.P115ASSISTANT_VERSION || \"${VERSION}\"/" "${WORK_DIR}/server/update.js" 2>/dev/null || true
echo "[checkin] 版本注入完成: ${VERSION}"

# 运行时语法自检（部署前发现低级错误）
if command -v node >/dev/null 2>&1; then
    for f in "${WORK_DIR}"/server/*.js; do
        node --check "$f" >/dev/null 2>&1 || { echo "ERROR: 语法检查失败: $f" >&2; exit 1; }
    done
    echo "[checkin] Node 语法自检通过"
fi

cd "${WORK_DIR}"
tar czf "${REPO_ROOT}/app.tgz" server/ www/ ui/ config/
echo "[checkin] 已生成 app.tgz（$(du -h "${REPO_ROOT}/app.tgz" | cut -f1)）"
