#!/bin/bash
# FnOS-APP 统一更新引擎（单一事实源：一份脚本管所有应用）。
#
# 用法:
#   ./scripts/update.sh <app>   构建单个应用（apps/<app>）
#   ./scripts/update.sh all     构建全部应用
#   ./scripts/update.sh list    列出已注册应用
#   ./scripts/update.sh help    显示帮助
#
# 公共流程（每应用）:
#   1. 校验应用注册（apps/<slug>/fnos/manifest + scripts/apps/<slug>/meta.env）
#   2. 读 meta.env（FILE_PREFIX 等，应用差异唯一承载点）
#   3. FPK 版本 = manifest version，校验恒 1.0.0
#   4. 功能版本 = apps/<slug>/VERSION（单一事实源，构建流程不写它）
#   5. 公共构建函数 scripts/lib/build-app.sh → app.tgz（不注入源码版本）
#   6. scripts/build-fpk.sh → dist/<file_prefix>_<ver>_all.fpk
#   7. gen_runtime_manifest.py --app <slug> 重生成热更清单（用 VERSION 文件）
#   8. 校验清单 version == VERSION
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'
info() { echo -e "${GREEN}[INFO]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1" >&2; exit 1; }

# 公共构建函数（生成 app.tgz）
# shellcheck source=./lib/build-app.sh
source "${SCRIPT_DIR}/lib/build-app.sh"

# 构建中途失败时清理仓库根 app.tgz 中间产物
trap 'rm -f "${REPO_ROOT}/app.tgz"' EXIT

usage() {
    cat <<'EOF'
用法: ./scripts/update.sh <app> | all | list | help

  <app>   构建单个应用（apps/<app>，须存在 scripts/apps/<app>/meta.env）
  all     构建全部应用
  list    列出已注册应用
  help    显示帮助

示例:
  ./scripts/update.sh list
  ./scripts/update.sh p115assistant
  ./scripts/update.sh checkin
  ./scripts/update.sh all
EOF
}

# 已注册应用 = 具备 fnos/manifest 的应用目录，按名称排序
discover_apps() {
    local apps=() slug d
    for d in "${REPO_ROOT}"/apps/*/; do
        [ -d "${d}" ] || continue
        slug=$(basename "${d}")
        [ -f "${REPO_ROOT}/apps/${slug}/fnos/manifest" ] && apps+=("${slug}")
    done
    printf '%s\n' "${apps[@]}" | sort
}

require_app() {
    local slug="$1"
    [ -f "${REPO_ROOT}/apps/${slug}/fnos/manifest" ] \
        || error "未找到应用 ${slug}（apps/${slug}/fnos/manifest 不存在）"
    [ -f "${REPO_ROOT}/scripts/apps/${slug}/meta.env" ] \
        || error "未找到构建合约 ${slug}（scripts/apps/${slug}/meta.env 不存在）"
}

list_apps() {
    info "已注册应用："
    local slug
    while IFS= read -r slug; do
        [ -z "${slug}" ] && continue
        local display feature
        display=$(grep "^display_name" "${REPO_ROOT}/apps/${slug}/fnos/manifest" | awk -F'=' '{print $2}' | tr -d ' ')
        feature=$(cat "${REPO_ROOT}/apps/${slug}/VERSION" 2>/dev/null || echo "?")
        echo "  - ${slug}（${display}，功能版本 ${feature}）"
    done < <(discover_apps)
}

# build_one <slug>：构建单个应用（公共流程）
build_one() {
    local slug="$1"
    require_app "${slug}"
    local app_dir="${REPO_ROOT}/apps/${slug}"
    local fnos_dir="${app_dir}/fnos"

    # 1. FPK 版本 = manifest version，校验恒 1.0.0
    local fpk_version
    fpk_version=$(grep "^version" "${fnos_dir}/manifest" | awk -F'=' '{print $2}' | tr -d ' ')
    [ -z "${fpk_version}" ] && error "[${slug}] 无法确定 fpk 版本号（manifest 缺少 version）"
    if [ "${fpk_version}" != "1.0.0" ]; then
        error "[${slug}] fpk 版本必须为 1.0.0（manifest version=${fpk_version}）；功能更新请走热更（VERSION 文件 + runtime-manifest.json）"
    fi

    # 2. 功能版本 = VERSION 文件（单一事实源；构建流程绝不写它）
    local feature_version
    feature_version=$(cat "${app_dir}/VERSION" 2>/dev/null || true)
    [ -z "${feature_version}" ] && error "[${slug}] 功能版本为空（apps/${slug}/VERSION 缺失）"

    # 3. meta.env — 应用差异唯一承载点
    # shellcheck disable=SC1090
    source "${REPO_ROOT}/scripts/apps/${slug}/meta.env"
    local file_prefix="${FILE_PREFIX:-${slug}}"
    local release_title="${RELEASE_TITLE:-${slug}}"
    local version_env_name="${VERSION_ENV:-$(echo "${slug^^}" | tr '-' '_')_VERSION}"

    echo "========================================"
    echo "  ${release_title}（${slug}）"
    echo "  FPK 版本: ${fpk_version} | 功能版本: ${feature_version}"
    echo "========================================"

    # 4. 生成 app.tgz（公共构建函数，不注入源码版本）
    local app_tgz="${REPO_ROOT}/app.tgz"
    build_app_tgz "${app_dir}" "${slug}" "${version_env_name}" "${fpk_version}" "${app_tgz}"

    # 5. 用 build-fpk.sh 生成 .fpk（cwd=REPO_ROOT，产物输出到仓库根）
    local build_output fpk_name
    build_output=$(cd "${REPO_ROOT}" && "${SCRIPT_DIR}/build-fpk.sh" "${app_dir}" "${app_tgz}" "${fpk_version}")
    fpk_name=$(echo "${build_output}" | tail -n 1 | tr -d '[:space:]')

    # 6. 移到 dist/（app.tgz 为中间产物，立即清理）
    rm -f "${app_tgz}"
    if [ -n "${fpk_name}" ] && [ -f "${REPO_ROOT}/${fpk_name}" ]; then
        mkdir -p "${REPO_ROOT}/dist"
        mv -f "${REPO_ROOT}/${fpk_name}" "${REPO_ROOT}/dist/${fpk_name}"
    else
        error "[${slug}] build-fpk.sh 未产出 fpk"
    fi
    info "[${slug}] 构建完成: dist/${fpk_name}"

    # 7. 重生成热更清单（用 VERSION 文件，功能版本；不覆盖 VERSION）
    python3 "${SCRIPT_DIR}/gen_runtime_manifest.py" --app "${slug}"

    # 8. 校验清单版本与 VERSION 一致
    local manifest_version
    manifest_version=$(grep '"version"' "${app_dir}/runtime-manifest.json" | head -1 | sed 's/.*: "\([^"]*\)".*/\1/')
    [ "${manifest_version}" = "${feature_version}" ] \
        || error "[${slug}] runtime-manifest.json version=${manifest_version} ≠ VERSION=${feature_version}"
    info "[${slug}] 热更清单已生成: apps/${slug}/runtime-manifest.json（v${manifest_version}）"

    info "[${slug}] ✅ 完成"
}

build_all() {
    local slug
    while IFS= read -r slug; do
        [ -z "${slug}" ] && continue
        build_one "${slug}" || error "[${slug}] 构建失败"
    done < <(discover_apps)
    info "全部应用构建完成 ✅"
}

CMD="${1:-help}"
case "${CMD}" in
    list)
        list_apps
        ;;
    all)
        build_all
        ;;
    help|-h|--help)
        usage
        ;;
    *)
        case "${CMD}" in
            -*)
                error "未知选项: ${CMD}"
                ;;
            *)
                build_one "${CMD}"
                ;;
        esac
        ;;
esac