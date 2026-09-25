#!/bin/bash
# fnos-apps 新应用脚手架（适配统一更新引擎的新结构）。
#
# 用法: ./scripts/new-app.sh <slug> "<display_name>" <port>
# 示例: ./scripts/new-app.sh jellyfin "Jellyfin 媒体服务器" 8096
#
# 输出结构（与 docs/architecture.md §4.1 一致）：
#   apps/<slug>/fnos/{app/server,app/ui,cmd,config,ui,wizard} + manifest + ICON*.PNG(待补)
#   apps/<slug>/VERSION（初始 0.0.1） + README.md + CHANGELOG.md
#   scripts/apps/<slug>/meta.env（构建合约，唯一差异承载点）
# 统一引擎 scripts/update.sh 直接可用，无需 per-app build/update/gen 脚本。

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

SLUG="$1"
DISPLAY_NAME="$2"
PORT="${3:-0}"

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'
info() { echo -e "${GREEN}[INFO]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1" >&2; exit 1; }

[ -z "$SLUG" ] && error "用法: $0 <slug> <display_name> <port>"
[ -z "$DISPLAY_NAME" ] && error "用法: $0 <slug> <display_name> <port>"

# slug 命名规范：小写字母数字 + 连字符
case "$SLUG" in
    *[!a-z0-9-]*|*-*) ;;
    *) ;;
esac
if ! [[ "$SLUG" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
    error "slug 必须为小写字母数字 + 连字符（^[a-z0-9]+(-[a-z0-9]+)*$）：$SLUG"
fi

APP_DIR="$REPO_ROOT/apps/$SLUG"
SCRIPTS_APP_DIR="$REPO_ROOT/scripts/apps/$SLUG"
[ -d "$APP_DIR" ] && error "应用目录已存在: $APP_DIR"
[ -d "$SCRIPTS_APP_DIR" ] && error "构建合约目录已存在: $SCRIPTS_APP_DIR"

info "创建应用: $SLUG（$DISPLAY_NAME，端口 $PORT）"

mkdir -p "$APP_DIR/fnos/app/server" "$APP_DIR/fnos/app/ui" "$APP_DIR/fnos/cmd" \
         "$APP_DIR/fnos/config" "$APP_DIR/fnos/ui/images" "$APP_DIR/fnos/wizard"
mkdir -p "$SCRIPTS_APP_DIR"

# manifest（FPK 版本初始 1.0.0；纯热更模型下稳定不递增，功能更新走 VERSION 热更；若启用 fpk 升级按官方语义随发布递增）
cat > "$APP_DIR/fnos/manifest" << EOF
appname         = ${SLUG}
version         = 1.0.0
display_name    = ${DISPLAY_NAME}
platform        = all
maintainer      = LittlePigeno
maintainer_url  = https://github.com/LittlePigeno217
distributor     = LittlePigeno
distributor_url = https://github.com/LittlePigeno217/fnos-apps
os_min_version  = 1.2.0401
desktop_uidir   = ui
desktop_applaunchname = ${SLUG}.main
service_port    = ${PORT}
checkport       = false
ctl_stop        = true
micro_app       = true
desc            = TODO: Add description
source          = thirdparty
checksum        =
EOF

# VERSION — 功能版本单一事实源（初始 0.0.1）
echo "0.0.1" > "$APP_DIR/VERSION"

# config/privilege
cat > "$APP_DIR/fnos/config/privilege" << EOF
{
    "defaults": {
        "run-as": "package"
    },
    "username": "${SLUG}",
    "groupname": "${SLUG}"
}
EOF

# config/resource
cat > "$APP_DIR/fnos/config/resource" << EOF
{
    "data-share": {
        "shares": [
            {
                "name": "${DISPLAY_NAME}",
                "permission": {
                    "rw": [
                        "${SLUG}"
                    ]
                }
            }
        ]
    },
    "systemd-unit": {
    }
}
EOF

# ui/config — 桌面入口
# 端口=0（micro_app，无固定端口）→ 走 fnOS 统一网关（官方 §4：gatewaySocket 只填文件名、
# 位于 target 目录；protocol/port 对网关入口被忽略）。端口>0 → 传统 port 转发入口。
# 入口 ID 以 appname 前缀、图标约定 images/icon_{0}.png（官方 §7）。
if [ "${PORT}" = "0" ]; then
cat > "$APP_DIR/fnos/ui/config" << EOF
{
    ".url": {
        "${SLUG}.main":
        {
            "title": "${DISPLAY_NAME}",
            "icon": "images/icon_{0}.png",
            "type": "iframe",
            "protocol": "",
            "gatewayPrefix": "/app/${SLUG}",
            "gatewaySocket": "app.sock",
            "url": "/app/${SLUG}",
            "allUsers": true
        }
    }
}
EOF
else
cat > "$APP_DIR/fnos/ui/config" << EOF
{
    ".url": {
        "${SLUG}.main":
        {
            "title": "${DISPLAY_NAME}",
            "desc": "${DISPLAY_NAME}",
            "icon": "images/icon_{0}.png",
            "type": "url",
            "port": "${PORT}",
            "protocol": "http",
            "url": "/",
            "allUsers": true
        }
    }
}
EOF
fi

# health.json
cat > "$APP_DIR/fnos/health.json" << EOF
{
    "type": "http",
    "path": "/",
    "expect_status": [200, 301, 302, 401, 403],
    "startup_timeout_seconds": 60,
    "post_install_warmup_seconds": 0,
    "skip_arch": [],
    "note": ""
}
EOF

# CHANGELOG
cat > "$APP_DIR/CHANGELOG.md" << 'EOF'
## 0.0.1

- 首次发布
EOF

# README
cat > "$APP_DIR/README.md" << EOF
# ${DISPLAY_NAME} for fnOS

TODO: Add description.

## 构建

\`\`\`bash
./scripts/update.sh ${SLUG}
\`\`\`
EOF

# meta.env — 构建合约（应用差异唯一承载点）
cat > "$SCRIPTS_APP_DIR/meta.env" << EOF
# ${SLUG} 构建合约（本地项目，无外部上游 release）
FILE_PREFIX=${SLUG}
RELEASE_TITLE="${DISPLAY_NAME}"
DEFAULT_PORT=${PORT}
HOMEPAGE_URL=https://github.com/LittlePigeno217/fnos-apps
CATEGORY=media
POST_INSTALL_NOTE="安装后在 fnOS 桌面打开 ${DISPLAY_NAME}。"
# VERSION_ENV=${SLUG^^}_VERSION        # 可选：版本 env 变量名，默认 <SLUG>_VERSION
EOF

info "应用已脚手架: apps/$SLUG/"
info "构建合约已生成: scripts/apps/$SLUG/meta.env"
info ""
info "接下来："
info "  1. 放置图标 apps/$SLUG/fnos/ICON.PNG 与 ICON_256.PNG（并自动生成 ui/images/256.png）"
info "  2. 填充 apps/$SLUG/fnos/app/server/ 后端运行时（入口 main.js）与 app/ui/ 前端"
info "  3. 需要时覆盖 apps/$SLUG/fnos/cmd/ 生命周期脚本（否则由 shared/cmd 打底）"
info "  4. 填充 manifest 的 desc、health.json 探针路径"
info "  5. 更新 scripts/apps/$SLUG/meta.env（POST_INSTALL_NOTE / CATEGORY / HOMEPAGE_URL）"
info "  6. 构建验证：./scripts/update.sh $SLUG"
info "  7. 热更清单校验：python3 scripts/gen_runtime_manifest.py --app $SLUG --check"
info ""
info "完整操作指南见 docs/add-app.md"
