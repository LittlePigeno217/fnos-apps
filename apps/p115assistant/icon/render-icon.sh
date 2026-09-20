#!/usr/bin/env bash
# 从 icon.svg 重新导出全部图标 PNG（需要网络首次装依赖）
set -euo pipefail
cd "$(dirname "$0")"

VENV="${ICON_VENV:-$HOME/.cache/p115-icon-venv}"
[ -d "$VENV" ] || { python3 -m venv "$VENV"; "$VENV/bin/pip" install -q cairosvg pillow; }

"$VENV/bin/python" - <<'EOF'
import io, cairosvg
from PIL import Image
big = Image.open(io.BytesIO(cairosvg.svg2png(
    url='icon.svg', output_width=1024, output_height=1024))).convert('RGBA')
targets = {
    '../fnos/ui/images/icon_256.png': 256,
    '../fnos/ui/images/icon_64.png': 64,
    '../fnos/ui/images/256.png': 256,
    '../fnos/ui/images/64.png': 64,
    '../fnos/ICON_256.PNG': 256,
    '../fnos/ICON.PNG': 256,
}
for path, size in targets.items():
    big.resize((size, size), Image.LANCZOS).save(path)
    print('wrote', path)
EOF
