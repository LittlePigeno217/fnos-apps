#!/bin/bash
set -euo pipefail

# p115assistant 是本地自研应用，没有外部上游 release。
# 版本号直接从 apps/p115assistant/fnos/manifest 读取。
#
# 用法: ./get-latest-version.sh [VERSION]
#   - 不带参数: 输出 manifest 当前版本
#   - 带参数:   输出传入版本（便于与其它应用脚本统一调用方式）

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
MANIFEST="${REPO_ROOT}/apps/p115assistant/fnos/manifest"

INPUT_VERSION="${1:-}"
if [ -n "$INPUT_VERSION" ]; then
  VERSION="$INPUT_VERSION"
else
  VERSION=$(grep "^version" "$MANIFEST" | awk -F'=' '{print $2}' | tr -d ' ')
fi

[ -z "$VERSION" ] && { echo "Failed to resolve version for p115assistant" >&2; exit 1; }
echo "VERSION=$VERSION"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "version=$VERSION" >> "$GITHUB_OUTPUT"
fi
