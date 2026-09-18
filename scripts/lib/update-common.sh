#!/bin/bash
# Shared local build library for fnOS app update scripts.
#
# Usage pattern in each update_*.sh:
#
#   #!/bin/bash
#   set -e
#   SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
#   REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
#
#   # App-specific config
#   APP_NAME="plex"
#   APP_DISPLAY_NAME="Plex Media Server"
#   APP_VERSION_VAR="PLEX_VERSION"   # env var name for version
#   APP_VERSION="${PLEX_VERSION:-latest}"
#   APP_DEPS=(curl ar tar sed)       # required commands
#   APP_FPK_PREFIX="plexmediaserver" # fpk filename prefix
#
#   # App-specific arch mappings (called by detect_arch)
#   app_set_arch_vars() {
#       case "$ARCH" in
#           x86) PLEX_BUILD="linux-x86_64" ;;
#           arm) PLEX_BUILD="linux-aarch64" ;;
#       esac
#   }
#
#   # App-specific help examples
#   app_show_help_examples() {
#       cat << 'EOF'
#   $0 --arch x86 1.42.2.10156  # Specific version, x86
#   EOF
#   }
#
#   # App-specific callbacks (must be defined before sourcing)
#   app_get_latest_version() { ... }
#   app_download() { ... }
#   app_build_app_tgz() { ... }
#   app_compare_version() { echo "$APP_VERSION"; }
#
#   source "$REPO_ROOT/scripts/lib/update-common.sh"
#   main "$@"

# ============================================================================
# Guard: prevent double-sourcing
# ============================================================================
[ -n "$_UPDATE_COMMON_LOADED" ] && return 0
_UPDATE_COMMON_LOADED=1

# ============================================================================
# Color definitions
# ============================================================================
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# ============================================================================
# Logging functions
# ============================================================================
info() { echo -e "${GREEN}[INFO]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# ============================================================================
# Cleanup
# ============================================================================
# Sets up temp dir cleanup on EXIT. Apps should set WORK_DIR before sourcing.
# If WORK_DIR is not set, defaults to /tmp/${APP_NAME}_update_$$
setup_cleanup() {
    WORK_DIR="${WORK_DIR:-/tmp/${APP_NAME}_update_$$}"
    cleanup() { rm -rf "$WORK_DIR"; }
    trap cleanup EXIT
}

# ============================================================================
# Architecture detection
# ============================================================================
# Detects or validates ARCH, then sets MANIFEST_PLATFORM.
# After setting the common vars, calls app_set_arch_vars() if defined,
# allowing each app to set its own arch-specific variables (e.g. DEB_ARCH,
# PLEX_BUILD, BINARY_PREFIX).
detect_arch() {
    if [ -z "$ARCH" ]; then
        local machine
        machine=$(uname -m)
        case "$machine" in
            x86_64|amd64)
                ARCH=x86
                ;;
            aarch64|arm64)
                ARCH=arm
                ;;
            *)
                error "Unsupported architecture: $machine. Use --arch to specify x86 or arm."
                ;;
        esac
        info "Auto-detected architecture: $ARCH"
    fi

    case "$ARCH" in
        x86)
            MANIFEST_PLATFORM="x86"
            ;;
        arm)
            MANIFEST_PLATFORM="arm"
            ;;
        *)
            error "Invalid architecture: $ARCH. Must be x86 or arm."
            ;;
    esac

    # Let the app set its own arch-dependent variables
    if type app_set_arch_vars &>/dev/null; then
        app_set_arch_vars
    fi
}

# ============================================================================
# Argument parsing
# ============================================================================
# Generic arg parser: --arch, -h/--help, positional version.
# Sets ARCH and APP_VERSION. Calls show_help on -h/--help.
parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            -h|--help)
                show_help
                exit 0
                ;;
            --arch)
                ARCH="$2"
                shift 2
                ;;
            --arch=*)
                ARCH="${1#*=}"
                shift
                ;;
            -*)
                error "未知选项: $1"
                ;;
            *)
                APP_VERSION="$1"
                shift
                ;;
        esac
    done
}

# ============================================================================
# Help display
# ============================================================================
# Base help template. Apps can override by defining app_show_help_examples()
# and app_show_help_extra() for additional sections.
show_help() {
    local version_example="${APP_HELP_VERSION_EXAMPLE:-1.0.0}"
    local version_env="${APP_VERSION_VAR:-APP_VERSION}"

    cat << EOF
用法: $0 [选项] [版本号|latest]

选项:
  --arch ARCH       指定目标架构 (x86 或 arm)，默认自动检测
  -h, --help        显示此帮助信息

示例:
  $0                        # 最新稳定版，自动检测架构
  $0 --arch arm             # 最新版本，ARM 架构
EOF

    # App-specific examples
    if type app_show_help_examples &>/dev/null; then
        app_show_help_examples
    else
        cat << EOF
  $0 --arch x86 ${version_example}  # 指定版本，x86 架构
  $0 ${version_example}             # 指定版本，自动检测架构
EOF
    fi

    cat << EOF

环境变量:
  ARCH              目标架构 (x86 或 arm)
  ${version_env}    ${APP_DISPLAY_NAME:-App} 版本号

支持的架构:
  x86 (x86_64)      Intel/AMD 64位处理器
  arm (aarch64)     ARM 64位处理器
EOF

    # App-specific extra help sections
    if type app_show_help_extra &>/dev/null; then
        app_show_help_extra
    fi
}

# ============================================================================
# Manifest update
# ============================================================================
# Updates version, platform, and checksum in the manifest file.
# Args:
#   $1 - version string to write
#   $2 - path to app.tgz (for checksum calculation)
#   $3 - (optional) manifest path, defaults to $PKG_DIR/manifest
update_manifest() {
    local version="${1:?update_manifest requires version}"
    local app_tgz="${2:?update_manifest requires app.tgz path}"
    local manifest="${3:-$PKG_DIR/manifest}"

    info "更新 manifest..."
    local checksum
    checksum=$(md5 -q "$app_tgz" 2>/dev/null || md5sum "$app_tgz" | cut -d' ' -f1)

    sed -i.tmp "s/^version.*=.*/version         = ${version}/" "$manifest"
    sed -i.tmp "s/^checksum.*=.*/checksum        = ${checksum}/" "$manifest"

    if ! grep -q "^platform" "$manifest"; then
        echo "platform        = ${MANIFEST_PLATFORM}" >> "$manifest"
    else
        sed -i.tmp "s/^platform.*=.*/platform        = ${MANIFEST_PLATFORM}/" "$manifest"
    fi

    rm -f "${manifest}.tmp"
}

# ============================================================================
# FPK build
# ============================================================================
# Builds the .fpk package using scripts/build-fpk.sh.
# Args:
#   $1 - desired fpk filename (e.g. "plexmediaserver_1.42.2_x86.fpk")
#   $2 - version string
#   $3 - (optional) path to app.tgz, defaults to $WORK_DIR/app.tgz
build_fpk() {
    local fpk_name="${1:?build_fpk requires fpk_name}"
    local version="${2:?build_fpk requires version}"
    local app_tgz="${3:-$WORK_DIR/app.tgz}"
    local output_dir="${4:-$SCRIPT_DIR}"

    local build_fpk_script="${BUILD_FPK_SCRIPT:-$REPO_ROOT/scripts/build-fpk.sh}"

    info "打包 $fpk_name..."

    local build_output
    local built_name
    build_output=$(cd "$output_dir" && "$build_fpk_script" "$SCRIPT_DIR" "$app_tgz" "$version" "$MANIFEST_PLATFORM") || error "打包失败"
    echo "$build_output"
    built_name=$(echo "$build_output" | tail -n 1)

    if [ "$built_name" != "$fpk_name" ] && [ -f "$output_dir/$built_name" ]; then
        mv -f "$output_dir/$built_name" "$output_dir/$fpk_name"
    fi

    info "生成: $output_dir/$fpk_name ($(du -h "$output_dir/$fpk_name" | cut -f1))"
}

# ============================================================================
# Main flow orchestration
# ============================================================================
# Template main function. Apps customize behavior via callbacks:
#
#   REQUIRED callbacks:
#     app_get_latest_version  - Fetch/resolve latest version, update APP_VERSION
#     app_download            - Download upstream artifact(s) to WORK_DIR
#     app_build_app_tgz      - Build app.tgz in WORK_DIR
#
#   OPTIONAL callbacks:
#     app_set_arch_vars       - Set app-specific arch variables (called by detect_arch)
#     app_compare_version     - Return the version to compare against current manifest
#                               (default: APP_VERSION)
#     app_post_build          - Run after fpk build (e.g. extra cleanup)
#     app_show_help_examples  - Custom help examples
#     app_show_help_extra     - Extra help sections
#
#   REQUIRED variables (set before sourcing):
#     APP_NAME            - Short app name (e.g. "plex", "emby")
#     APP_DISPLAY_NAME    - Human-readable name (e.g. "Plex Media Server")
#     APP_VERSION         - Version (from env var or "latest")
#     APP_FPK_PREFIX      - fpk filename prefix (e.g. "plexmediaserver")
#     APP_DEPS            - Array of required commands
#
main_flow() {
    parse_args "$@"

    echo "========================================"
    echo "  ${APP_DISPLAY_NAME} fnOS Package Builder"
    echo "========================================"
    echo

    # Check dependencies
    local deps=("${APP_DEPS[@]}")
    for cmd in "${deps[@]}"; do
        command -v "$cmd" &>/dev/null || error "缺少依赖: $cmd"
    done

    # Validate package directory
    [ -f "$PKG_DIR/manifest" ] || error "找不到 fnos 目录"

    # Setup cleanup trap
    setup_cleanup

    # Detect architecture
    detect_arch

    # Read current version from manifest
    local current_version
    current_version=$(grep "^version" "$PKG_DIR/manifest" | awk -F'=' '{print $2}' | tr -d ' ')
    info "当前版本: $current_version"

    # Get latest version (app-specific)
    app_get_latest_version

    # Determine the version string for comparison
    local compare_version="$APP_VERSION"
    if type app_compare_version &>/dev/null; then
        compare_version=$(app_compare_version)
    fi

    # Download (app-specific)
    app_download

    # Build app.tgz (app-specific)
    app_build_app_tgz

    # Build fpk to dist/
    local dist_dir="$REPO_ROOT/dist"
    mkdir -p "$dist_dir"
    local fpk_name="${APP_FPK_PREFIX}_${compare_version}_${ARCH}.fpk"
    build_fpk "$fpk_name" "$compare_version" "$WORK_DIR/app.tgz" "$dist_dir"

    # Optional post-build hook
    if type app_post_build &>/dev/null; then
        app_post_build
    fi

    echo
    info "完成: $current_version -> $compare_version ($ARCH)"
}
