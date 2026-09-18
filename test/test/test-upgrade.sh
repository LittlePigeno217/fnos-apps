#!/bin/bash
# Test ONE app's upgrade data-preservation on the fnOS VM.
#   ./test-upgrade.sh <slug>                  # resolve from apps.json
#   ./test-upgrade.sh <appname> <fpk_url>     # manual
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/lib.sh"
load_config

if [ $# -eq 1 ]; then
    IFS=$'\t' read -r appname url port app_type < <(resolve_app "$1") || exit 1
    answers="$(wizard_answers_for "$1")"
    echo "app=$1  appname=$appname  type=$app_type"
elif [ $# -ge 2 ]; then
    appname="$1"; url="$2"; answers="${3:-[]}"
else
    echo "usage: $0 <slug> | $0 <appname> <fpk_url> [answers_json]" >&2; exit 1
fi

echo "--- upgrade-testing $appname on $FNOS_VM_IP (/vol$FNOS_TEST_VOLUME) ---"
out="$(test_upgrade "$appname" "$url" "$answers")"
echo "$out"
if echo "$out" | grep -q "=FAIL"; then echo "RESULT: FAIL"; exit 1; else echo "RESULT: PASS"; exit 0; fi
