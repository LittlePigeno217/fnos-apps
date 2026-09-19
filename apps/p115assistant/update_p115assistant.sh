#!/bin/bash
set -e

# p115assistant 更新+构建脚本（对齐 fnos-apps 各应用 update_<app>.sh 用法）。
#
# 本项目是本地自研应用（无外部上游 release），脚本直接构建当前工作区：
#   1. 生成 app.tgz（server + ui 运行时）
#   2. 用 build-fpk.sh 合并 shared 框架 + fnos 配置 → .fpk
#   3. 产物输出到仓库根 dist/
#
# 用法:
#   ./update_p115assistant.sh                 # 使用 manifest 当前版本
#   VERSION=1.0.2 ./update_p115assistant.sh   # 覆盖版本号

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
APP_NAME="p115assistant"
APP_DIR="${SCRIPT_DIR}"
FNOS_DIR="${APP_DIR}/fnos"

if [ -z "${VERSION:-}" ]; then
    VERSION=$(grep "^version" "${FNOS_DIR}/manifest" | awk -F'=' '{print $2}' | tr -d ' ')
fi
[ -z "$VERSION" ] && { echo "ERROR: 无法确定版本号" >&2; exit 1; }

echo "[${APP_NAME}] 构建版本 ${VERSION}"

# 1. 生成 app.tgz
"${SCRIPT_DIR}/../../scripts/apps/${APP_NAME}/build.sh"

# 2. 用 build-fpk.sh 生成 .fpk（输出含 INFO 行，取最后一行作为文件名）
mkdir -p "${REPO_ROOT}/dist"
cd "${REPO_ROOT}"
BUILD_OUTPUT=$("${REPO_ROOT}/scripts/build-fpk.sh" "${APP_DIR}" "${REPO_ROOT}/app.tgz" "${VERSION}")
FPK_NAME=$(echo "${BUILD_OUTPUT}" | tail -n 1 | tr -d '[:space:]')
rm -f "${REPO_ROOT}/app.tgz"   # 中间产物不留在仓库根

# 3. 移动到 dist/
if [ -f "${REPO_ROOT}/${FPK_NAME}" ]; then
    mv -f "${REPO_ROOT}/${FPK_NAME}" "${REPO_ROOT}/dist/${FPK_NAME}"
    echo "[${APP_NAME}] 构建完成: dist/${FPK_NAME}"
else
    echo "[${APP_NAME}] ERROR: build-fpk.sh 未产出 fpk" >&2
    exit 1
fi

# 4. 同步生成热更新清单（与 fpk 同版本发布；发布时随 fpk 一起推送）
GEN_SCRIPT="${REPO_ROOT}/scripts/apps/${APP_NAME}/gen_runtime_manifest.py"
if [ -f "${GEN_SCRIPT}" ]; then
    python3 "${GEN_SCRIPT}" "${VERSION}"
    echo "[${APP_NAME}] 热更新清单已生成: apps/${APP_NAME}/runtime-manifest.json（v${VERSION}）"
else
    echo "[${APP_NAME}] WARNING: 未找到 gen_runtime_manifest.py，跳过热更新清单生成" >&2
fi
