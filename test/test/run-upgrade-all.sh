#!/bin/bash
# Run the upgrade data-preservation test across apps.json and write
# test/report-upgrade-<filter>.md. One flow per app covers install + upgrade +
# data-preservation, so this is the install/upgrade stability matrix.
#   ./run-upgrade-all.sh [native|docker|all]     (default: native)
#   ./run-upgrade-all.sh native syncthing gopeed # only these slugs
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/lib.sh"
load_config

filter="${1:-native}"; shift 2>/dev/null || true
report="$here/report-upgrade-${filter}.md"

slugs=()
if [ $# -gt 0 ]; then
    slugs=("$@")
else
    while IFS= read -r _s; do [ -n "$_s" ] && slugs+=("$_s"); done < <(list_apps "$filter")
fi
total=${#slugs[@]}
echo "Upgrade-testing $total '$filter' app(s) on fnOS $FNOS_VM_IP (/vol$FNOS_TEST_VOLUME)"

{
  echo "# fnOS app upgrade / data-preservation report"
  echo
  echo "- Generated: $(date '+%Y-%m-%d %H:%M:%S')"
  echo "- VM \`$FNOS_VM_IP\` · volume \`/vol$FNOS_TEST_VOLUME\` · arch \`$FNOS_ARCH\` · filter \`$filter\`"
  echo
  echo "| App | download | stage | install | settle | repack | upgrade | data | start | uninstall | result |"
  echo "|-----|:--------:|:-----:|:-------:|:------:|:------:|:-------:|:----:|:-----:|:---------:|:------:|"
} > "$report"

pass=0; fail=0; failed=()
stage() { echo "$1" | grep -m1 "^$2=" | cut -d= -f2- | tr -d '|'; }

i=0
for slug in "${slugs[@]}"; do
    i=$((i+1))
    if ! IFS=$'\t' read -r appname url port app_type < <(resolve_app "$slug" 2>/dev/null); then
        printf '[%d/%d] %-26s RESOLVE-FAIL\n' "$i" "$total" "$slug"
        echo "| $slug | – | – | – | – | – | – | – | – | – | **RESOLVE-FAIL** |" >> "$report"
        fail=$((fail+1)); failed+=("$slug"); continue
    fi
    answers="$(wizard_answers_for "$slug")"
    printf '[%d/%d] %-26s ' "$i" "$total" "$slug"
    out="$(test_upgrade "$appname" "$url" "$answers" 2>/dev/null)"
    if echo "$out" | grep -q "=FAIL"; then res="FAIL"; fail=$((fail+1)); failed+=("$slug"); else res="PASS"; pass=$((pass+1)); fi
    echo "$res"
    echo "| $slug | $(stage "$out" download) | $(stage "$out" stage) | $(stage "$out" install) | $(stage "$out" settle) | $(stage "$out" repack) | $(stage "$out" upgrade) | $(stage "$out" data) | $(stage "$out" start) | $(stage "$out" uninstall) | **$res** |" >> "$report"
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
