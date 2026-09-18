#!/bin/bash
# Test ONE app end-to-end on the fnOS VM.
#   ./test-app.sh <slug>                         # resolve from apps.json
#   ./test-app.sh <appname> <fpk_url> <port>     # manual
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/lib.sh"
load_config

if [ $# -eq 1 ]; then
    IFS=$'\t' read -r appname url port app_type < <(resolve_app "$1") || exit 1
    echo "app=$1  appname=$appname  type=$app_type  port=$port"
elif [ $# -ge 3 ]; then
    appname="$1"; url="$2"; port="$3"
else
    echo "usage: $0 <slug> | $0 <appname> <fpk_url> <port>" >&2; exit 1
fi

echo "--- testing $appname on $FNOS_VM_IP (/vol$FNOS_TEST_VOLUME) ---"
out="$(test_one "$appname" "$url" "$port")"
echo "$out"
if echo "$out" | grep -q "=FAIL"; then echo "RESULT: FAIL"; exit 1; else echo "RESULT: PASS"; exit 0; fi
