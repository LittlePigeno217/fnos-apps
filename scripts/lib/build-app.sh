#!/bin/bash
# 公共 app.tgz 构建函数（由 scripts/update.sh source 调用）。
#
# 单一事实源：所有本地自研应用共用本函数生成 app.tgz（server + www + ui + config），
# 应用差异仅通过参数/meta.env 表达，不再每应用一份 build.sh。
#
# build_app_tgz <app_dir> <slug> <version_env_name> <fpk_version> <out_tgz>
#   app_dir         应用目录（apps/<slug>）
#   slug            应用 slug
#   version_env_name bootstrap env 变量名（如 P115ASSISTANT_VERSION）
#   fpk_version     FPK 版本（恒 1.0.0，由引擎校验后传入）
#   out_tgz         输出的 app.tgz 路径

[ -n "${_BUILD_APP_LIB_LOADED:-}" ] && return 0
_BUILD_APP_LIB_LOADED=1

build_app_tgz() {
    local app_dir="$1"
    local slug="$2"
    local version_env_name="$3"
    local fpk_version="$4"
    local out_tgz="$5"
    local fnos_dir="${app_dir}/fnos"
    local build_status

    [ -d "${fnos_dir}/app/server" ] || { echo "[${slug}] ERROR: 缺少 fnos/app/server" >&2; return 1; }
    [ -d "${fnos_dir}/app/ui" ] || { echo "[${slug}] ERROR: 缺少 fnos/app/ui（前端运行时）" >&2; return 1; }
    [ -d "${fnos_dir}/ui" ] || { echo "[${slug}] ERROR: 缺少 fnos/ui（桌面入口配置）" >&2; return 1; }

    # 构建在子 shell 中执行：EXIT trap 只对子 shell 生效，保证每次调用无论成败都清理
    # 临时目录，且不会污染引擎的全局 trap。
    build_status=$(
        set -e
        work_dir=$(mktemp -d)
        trap 'rm -rf "${work_dir}"' EXIT

        # app.tgz 内容 = server/ + www/（前端运行时）+ ui/（桌面图标配置）+ config/（权限/资源）
        # 重要（2026-09-17 真机验证）：install-fpk 只平铺 app.tgz 到安装根目录，
        # FPK 包根的 ui/、config/ 不会被部署（解包后为空目录）→ 桌面图标/appServiceInfo 不注册 → 应用中心找不到。
        # 因此桌面图标配置（fnos/ui）和 config/ 必须打进 app.tgz。
        mkdir -p "${work_dir}/server" "${work_dir}/www" "${work_dir}/ui" "${work_dir}/config"
        cp -a "${fnos_dir}/app/server/." "${work_dir}/server/"
        cp -a "${fnos_dir}/app/ui/." "${work_dir}/www/"
        cp -a "${fnos_dir}/ui/." "${work_dir}/ui/"
        if [ -d "${fnos_dir}/config" ]; then
            cp -a "${fnos_dir}/config/." "${work_dir}/config/"
        fi

        # 版本 env 写入 config/bootstrap/（upgrade_callback 读取；manifest 不部署到设备，
        # 目标版本必须随包带）
        mkdir -p "${work_dir}/config/bootstrap"
        cat > "${work_dir}/config/bootstrap/${slug}-version.env" <<EOF
# ${slug} FPK 版本（恒 1.0.0，构建时注入；upgrade_callback 读取）
${version_env_name}=${fpk_version}
EOF
        echo "[${slug}] FPK 版本 env 已写入: config/bootstrap/${slug}-version.env"

        # 不向运行时源码注入版本：
        #   fpk 版本恒 1.0.0，功能版本以 apps/<slug>/VERSION 为单一事实源，
        #   store.js / update.js 的功能版本字面量由 gen_runtime_manifest.py --bump（或显式版本）同步。
        #   若在此注入 fpk 版本，安装后源码 sha 将与 runtime-manifest（按源码原样计算）永久不一致 →
        #   热更检查永远提示「有更新」，无法收敛。故此处保持源码原样打包。

        # 运行时语法自检（部署前发现低级错误）
        if command -v node >/dev/null 2>&1; then
            for f in "${work_dir}"/server/*.js; do
                node --check "$f" >/dev/null 2>&1 || { echo "[${slug}] ERROR: 语法检查失败: $f" >&2; exit 1; }
            done
            echo "[${slug}] Node 语法自检通过"
        fi

        cd "${work_dir}"
        tar czf "${out_tgz}" server/ www/ ui/ config/
        echo "[${slug}] 已生成 app.tgz（$(du -h "${out_tgz}" | cut -f1)）"
    ) || { echo "[${slug}] ERROR: 构建 app.tgz 失败" >&2; return 1; }

    printf '%s\n' "${build_status}"
}