#!/bin/bash
# Run the per-app smoke test across apps.json and write test/report-<filter>.md.
#   ./run-all.sh [native|docker|all]     (default: native)
#   ./run-all.sh native syncthing gopeed # only these slugs
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/lib.sh"
load_config

filter="${1:-native}"; shift 2>/dev/null || true
report="$here/report-${filter}.md"

slugs=()
if [ $# -gt 0 ]; then
    slugs=("$@")
else
    # bash 3.2 (macOS /bin/bash) has no `mapfile`; read line-by-line instead.
    while IFS= read -r _s; do [ -n "$_s" ] && slugs+=("$_s"); done < <(list_apps "$filter")
fi
total=${#slugs[@]}
echo "Testing $total '$filter' app(s) on fnOS $FNOS_VM_IP (/vol$FNOS_TEST_VOLUME)"

{
  echo "# fnOS app test report"
  echo
  echo "- Generated: $(date '+%Y-%m-%d %H:%M:%S')"
  echo "- VM \`$FNOS_VM_IP\` · volume \`/vol$FNOS_TEST_VOLUME\` · arch \`$FNOS_ARCH\` · filter \`$filter\`"
  echo
  echo "| App | download | install | register | start | port | volume | uninstall | result |"
  echo "|-----|:--------:|:-------:|:--------:|:-----:|:----:|:------:|:---------:|:------:|"
} > "$report"

pass=0; fail=0; failed=()
stage() { echo "$1" | grep -m1 "^$2=" | cut -d= -f2- | tr -d '|'; }

i=0
for slug in "${slugs[@]}"; do
    i=$((i+1))
    if ! IFS=$'\t' read -r appname url port app_type < <(resolve_app "$slug" 2>/dev/null); then
        printf '[%d/%d] %-26s RESOLVE-FAIL\n' "$i" "$total" "$slug"
        echo "| $slug | – | – | – | – | – | – | – | **RESOLVE-FAIL** |" >> "$report"
        fail=$((fail+1)); failed+=("$slug"); continue
    fi
    printf '[%d/%d] %-26s ' "$i" "$total" "$slug"
    out="$(test_one "$appname" "$url" "$port" 2>/dev/null)"
    if echo "$out" | grep -q "=FAIL"; then res="FAIL"; fail=$((fail+1)); failed+=("$slug"); else res="PASS"; pass=$((pass+1)); fi
    echo "$res"
    echo "| $slug | $(stage "$out" download) | $(stage "$out" install) | $(stage "$out" register) | $(stage "$out" start) | $(stage "$out" port) | $(stage "$out" volume) | $(stage "$out" uninstall) | **$res** |" >> "$report"
done

{
  echo
  echo "## Summary"
  echo
  echo "**Total $total · PASS $pass · FAIL $fail**"
  [ ${#failed[@]} -gt 0 ] && { echo; echo "Failed: ${failed[*]}"; }
} >> "$report"

echo "==> PASS=$pass FAIL=$fail   (report: $report)"
[ "$fail" -eq 0 ]
