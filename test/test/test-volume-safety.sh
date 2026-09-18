#!/bin/bash
# Regression test for the #189 cross-volume data-loss bug, on real fnOS.
# Requires TWO storage volumes on the VM (default /vol1 and /vol2).
#
# Proves, empirically:
#   A. install-local -v <OTHER volume>  relocates the app + orphans @appdata  (the bug)
#   B. install-local -v <CURRENT volume> keeps the app + preserves data        (the 1.7.12 fix)
#
# Env overrides: APP=<slug> VOL_A=1 VOL_B=2
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/lib.sh"
load_config

APP_IN="${APP:-fnos-apps-store}"
VA="${VOL_A:-1}"; VB="${VOL_B:-2}"
IFS=$'\t' read -r APP url port app_type < <(resolve_app "$APP_IN") || exit 1
echo "=== #189 volume-safety regression: app=$APP  volA=$VA  volB=$VB ==="

_run() {
vm_root_args "$APP" "$url" "$VA" "$VB" <<'REMOTE'
set +e
APP="$1"; URL="$2"; VA="$3"; VB="$4"
AC=/usr/local/bin/appcenter-cli
FPK="/tmp/vs_${APP}.fpk"; DIR="/tmp/vs_${APP}_dir"
# --- clean slate: uninstall + purge leftover @app dirs on ALL volumes ---
$AC uninstall "$APP" >/dev/null 2>&1
for v in /vol[0-9]*; do rm -rf "$v"/@app*/"$APP" 2>/dev/null; done

curl -fsSL --retry 2 -o "$FPK" "$URL" || { echo "download=FAIL"; exit 0; }
rm -rf "$DIR"; mkdir -p "$DIR"; tar xzf "$FPK" -C "$DIR"

# --- setup: install on volume A via install-local (the store's primitive); ASSERT it landed ---
$AC install-local --dir "$DIR" -v "$VA" >/dev/null 2>&1; sleep 3
setup=$(readlink /var/apps/$APP/target)
echo "setup_target=$setup"
case "$setup" in
  /vol$VA/*) : ;;
  *) echo "setup=FAIL_expected_vol$VA"; $AC uninstall "$APP" >/dev/null 2>&1; exit 0 ;;
esac
echo "MARKER_A" > "/vol$VA/@appdata/$APP/DATA_MARKER.txt"

# A) buggy path: install-local pinned to the OTHER volume
$AC install-local --dir "$DIR" -v "$VB" >/dev/null 2>&1; sleep 3
echo "A_relocated_to=$(readlink /var/apps/$APP/target)"
[ -f "/vol$VA/@appdata/$APP/DATA_MARKER.txt" ] && echo "A_marker_orphaned=yes" || echo "A_marker_orphaned=no"

# B) fixed path: install-local pinned to the app's CURRENT volume
cur=$(readlink /var/apps/$APP/target | sed -E 's#/vol([0-9]+)/.*#\1#')
echo "MARKER_B" > "/vol$cur/@appdata/$APP/DATA_MARKER2.txt"
$AC install-local --dir "$DIR" -v "$cur" >/dev/null 2>&1; sleep 3
echo "B_stayed_on=$(readlink /var/apps/$APP/target)"
[ -f "/vol$cur/@appdata/$APP/DATA_MARKER2.txt" ] && echo "B_data_preserved=yes" || echo "B_data_preserved=no"

$AC uninstall "$APP" >/dev/null 2>&1
for v in /vol[0-9]*; do rm -rf "$v"/@app*/"$APP" 2>/dev/null; done
rm -rf "$FPK" "$DIR"
REMOTE
}
out="$(_run)"
echo "$out"
echo "---"

g() { echo "$out" | grep -m1 "^$1=" | cut -d= -f2-; }
reloc="$(g A_relocated_to)"; orph="$(g A_marker_orphaned)"
stayed="$(g B_stayed_on)"; keep="$(g B_data_preserved)"

if echo "$out" | grep -q "^setup=FAIL"; then
    echo "SETUP FAILED — app did not land on /vol$VA (install-local reused an existing volume). Purge /vol*/@app*/$APP and retry." >&2
    exit 2
fi

rc=0
if echo "$reloc" | grep -q "/vol$VB/" && [ "$orph" = yes ]; then
    echo "A  bug mechanism : REPRODUCED — install-local -v $VB relocated the app to $reloc; /vol$VA @appdata orphaned"
else
    echo "A  bug mechanism : NOT reproduced (relocated_to=$reloc orphaned=$orph)"; rc=1
fi
if echo "$stayed" | grep -q "/vol" && [ "$keep" = yes ]; then
    echo "B  1.7.12 fix    : VALIDATED — pinning -v to the current volume kept the app on $stayed; data preserved"
else
    echo "B  1.7.12 fix    : FAIL (stayed_on=$stayed preserved=$keep)"; rc=1
fi
exit $rc
