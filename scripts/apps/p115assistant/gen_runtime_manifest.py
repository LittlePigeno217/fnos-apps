#!/usr/bin/env python3
"""生成 runtime-manifest.json：115网盘助手 热更新清单（业务运行时文件 + sha256）。

用法：python3 gen_runtime_manifest.py [VERSION]
输出：apps/p115assistant/runtime-manifest.json（构建脚本会自动调用）
"""
import hashlib, json, os, sys

ROOT = "apps/p115assistant/fnos"
# 热更新覆盖的运行时文件（相对安装目录）；不包含 manifest/wizard/cmd（由 fpk 管理）
RUNTIME_FILES = [
    "app/server/main.js",
    "app/server/server.js",
    "app/server/store.js",
    "app/server/update.js",
    "app/server/hotfix.js",
    "app/server/client.js",
    "app/server/crypto.js",
    "app/server/limiter.js",
    "app/server/ledger.js",
    "app/server/notify.js",
    "app/server/records.js",
    "app/ui/index.html",
]

def sha256_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()

def main():
    version = sys.argv[1] if len(sys.argv) > 1 else "dev"
    files = {}
    missing = []
    for rel in RUNTIME_FILES:
        p = os.path.join(ROOT, rel)
        if not os.path.isfile(p):
            missing.append(rel)
            continue
        # 安装目录映射：仓库 app/server/*.js → 安装 server/*.js；app/ui/ → www/
        install_rel = rel
        if rel.startswith("app/server/"):
            install_rel = "server/" + rel[len("app/server/"):]
        elif rel.startswith("app/ui/"):
            install_rel = "www/" + rel[len("app/ui/"):]
        files[install_rel] = {
            "sha256": sha256_file(p),
            "size": os.path.getsize(p),
        }
    if missing:
        print("警告：清单中缺失文件：", ", ".join(missing))
    import datetime
    manifest = {
        "version": version,
        "generated_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "files": files,
    }
    out = "apps/p115assistant/runtime-manifest.json"
    with open(out, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print(f"已生成 {out}（{version}，{len(files)} 文件）")

if __name__ == "__main__":
    main()