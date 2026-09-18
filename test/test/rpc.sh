# Server-side daemon-RPC helpers for the fnOS VM test harness.
# This file is concatenated INTO the remote heredoc that vm_root_args runs as
# root on the VM, so it must be self-contained POSIX-ish bash with no external
# deps beyond curl + python3 (both present on fnOS).
#
# Why daemon RPC and not appcenter-cli:
#   appcenter-cli install-local / install-fpk = uninstall-then-install, which
#   destroys the app and its @appdata (fnOS issue #189). The undocumented
#   daemon socket /var/run/com.trim.app.center.sock is the data-preserving
#   channel the store itself uses. All installs/upgrades here go through it.

FNOS_SOCK="${FNOS_SOCK:-/var/run/com.trim.app.center.sock}"

# rpc <path> <json-body>  -> raw JSON envelope on stdout.
rpc() {
    curl -s -m 60 --unix-socket "$FNOS_SOCK" \
        -X POST "http://localhost$1" \
        -H 'Content-Type: application/json' \
        -d "$2" 2>&1
}

# rpc_code <path> <json-body> -> numeric `code` field (0 = ok).
rpc_code() {
    rpc "$1" "$2" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("code", -1))
except Exception: print(-1)'
}

# rpc_data <path> <json-body> <dotted-key> -> value at data.<key> ("" if absent).
rpc_data() {
    rpc "$1" "$2" | python3 -c 'import json,sys
key=sys.argv[1]
try:
    d=json.load(sys.stdin).get("data") or {}
    for k in key.split("."): d=d.get(k, {}) if isinstance(d, dict) else {}
    print(d if not isinstance(d, (dict, list)) else "")
except Exception: print("")' "$3"
}

# rpc_stage_fpk <fpk-path>
# Downloads/stages an fpk and waits for the download task to finish.
# Prints TSV: appname<TAB>version<TAB>packageType<TAB>installed(true|false).
# Exits non-zero (and prints nothing) on failure.
rpc_stage_fpk() {
    local fpk="$1" tid st i
    tid=$(rpc_data /rpc/v1/download/task \
          "{\"packageSourceType\":\"file\",\"path\":\"$fpk\"}" downloadTaskId)
    [ -n "$tid" ] || return 1
    st=""
    for i in $(seq 1 30); do
        st=$(rpc /rpc/v1/download/status "{\"downloadTaskId\":\"$tid\"}")
        echo "$st" | grep -q '"status":2' && break
        echo "$st" | grep -qE '"status":(3|-1)' && return 1
        sleep 2
    done
    echo "$st" | grep -q '"status":2' || return 1
    echo "$st" | python3 -c 'import json,sys
d=json.load(sys.stdin)["data"]
print(d.get("appName",""), d.get("version",""), d.get("packageType",""),
      str(d.get("installed","")).lower(), sep="\t")'
}

# rpc_wait_task <taskId> <timeout-secs>
# Polls /rpc/v1/common/status until the task reaches a terminal state.
# Prints the final numeric status (2=success, 3=failed, -1=error). "" on timeout.
rpc_wait_task() {
    local tid="$1" timeout="${2:-180}" i st
    for i in $(seq 1 $((timeout/3))); do
        st=$(rpc_data /rpc/v1/common/status "{\"taskId\":\"$tid\"}" status)
        case "$st" in 2|3|-1) echo "$st"; return 0 ;; esac
        sleep 3
    done
    echo ""
}

# rpc_fetch_wizard <appname> <version> <packageType>
# Returns the install-time wizard definition (wizardContent JSON) on stdout.
# Empty output when the app has no wizard.
rpc_fetch_wizard() {
    rpc /rpc/v1/install/info \
        "{\"appName\":\"$1\",\"version\":\"$2\",\"packageType\":\"$3\",\"language\":\"zh-CN\"}" \
    | python3 -c 'import json,sys
try:
    w=(json.load(sys.stdin).get("data") or {}).get("wizardInfo") or {}
    print(json.dumps(w.get("wizardContent") or [], ensure_ascii=False))
except Exception: print("[]")'
}

# rpc_install <appname> <version> <packageType> <volume> <customParams-json> <start(true|false)>
# Installs via the daemon with wizard answers. customParams is a JSON array of
# {"key":...,"value":...}. Prints the final task status (2=success).
rpc_install() {
    local body tid
    body=$(python3 -c '
import json,sys
app,ver,pt,vol,params,start=sys.argv[1:7]
print(json.dumps({
 "appName":app,"version":ver,"packageType":pt,
 "systemParameters":{"agreedToProtocol":True,"installVolumeID":int(vol),
                     "dataVolumeId":int(vol),"immediateStart":start=="true"},
 "customParameters":json.loads(params),
 "language":"zh-CN"}))' "$1" "$2" "$3" "$4" "$5" "$6")
    tid=$(rpc_data /rpc/v1/install/task "$body" taskId)
    [ -n "$tid" ] || { echo ""; return 1; }
    rpc_wait_task "$tid" 240
}

# rpc_upgrade <appname> <newVersion> <packageType>
# Upgrades an INSTALLED app via the data-preserving update path. Mirrors the
# store's proven flow: update/info first (validates + yields the volume the
# app already occupies), then update/task pinned to that volume,
# immediateStart:false. Prints the final task status (2=success).
rpc_upgrade() {
    local app="$1" ver="$2" pt="$3" vol body tid
    # 1) update/info: validates the update and reports the occupied volume.
    vol=$(rpc_data /rpc/v1/update/info \
          "{\"appName\":\"$app\",\"updateVersion\":\"$ver\",\"packageType\":\"$pt\",\"language\":\"zh-CN\"}" \
          wizardInfo.installedVolumeID)
    [ -n "$vol" ] && [ "$vol" != "0" ] || { echo ""; return 1; }
    # 2) update/task pinned to that volume, immediateStart:false (matches store).
    body=$(python3 -c '
import json,sys
app,ver,pt,vol=sys.argv[1:5]
print(json.dumps({
 "appName":app,"updateVersion":ver,"packageType":pt,
 "systemParameters":{"agreedToProtocol":True,"installVolumeID":int(vol),
                     "dataVolumeId":int(vol),"immediateStart":False},
 "customParameters":[],
 "language":"zh-CN"}))' "$app" "$ver" "$pt" "$vol")
    tid=$(rpc_data /rpc/v1/update/task "$body" taskId)
    [ -n "$tid" ] || { echo ""; return 1; }
    rpc_wait_task "$tid" 240
}

# rpc_bump_fpk <src-fpk> <dst-fpk> <newVersion>
# Repackage an fpk with a bumped manifest version so the same package can be
# offered to the daemon as an "upgrade". fpk = tar.gz holding manifest et al.
rpc_bump_fpk() {
    local src="$1" dst="$2" newver="$3" tmp
    tmp=$(mktemp -d) || return 1
    tar xzf "$src" -C "$tmp" 2>/dev/null || { rm -rf "$tmp"; return 1; }
    [ -f "$tmp/manifest" ] || { rm -rf "$tmp"; return 1; }
    sed -i -E "s/^version[[:space:]]*=.*/version         = $newver/" "$tmp/manifest"
    ( cd "$tmp" && tar czf "$dst" . ) || { rm -rf "$tmp"; return 1; }
    rm -rf "$tmp"
}
