#!/usr/bin/env python3
"""生成 runtime-manifest.json：签到工具 热更新清单（运行时文件 + sha256）。

用法：python3 gen_runtime_manifest.py [VERSION] [--check]
输出：apps/checkin/runtime-manifest.json

规范约定（与 server/hotfix.js 的 rawRel 映射保持同源，本脚本内含双向校验）：
  - 清单 rel 使用「安装相对路径」：server/*.js、www/*
  - 仓库路径 = apps/p115assistant/fnos/app/{server|ui}/*，由 rawRel 反向推导
  - 自动发现：server/*.js（排除 package.json）+ app/ui/*（全部），新增运行时文件无需改脚本
用法示例：
  python3 gen_runtime_manifest.py 1.0.0          # 生成清单（含校验）
  python3 gen_runtime_manifest.py --check        # 仅校验本地清单与仓库一致（CI/发布前）
"""
import datetime
import hashlib
import json
import os
import re
import sys

ROOT = "apps/checkin/fnos"
MANIFEST_PATH = "apps/checkin/runtime-manifest.json"
VERSION_FILE = "apps/checkin/VERSION"   # 功能版本单一事实源（热更发布时用 --bump 递增）

# 仓库子目录 → (安装前缀, 排除文件名集合)
RUNTIME_ROOTS = [
    ("app/server", "server", {"package.json"}),
    ("app/ui", "www", set()),
]

# 构建期版本注入文件（build.sh 打包时 sed 注入 fpk 版本号）：
# 清单必须按「注入后」内容计算 sha，否则与 NAS 上运行的注入版永远不一致，热更检查无法收敛。
INJECT_RULES = {
    "app/server/store.js": re.compile(r'version: "[0-9.]*"'),
    "app/server/update.js": re.compile(r'const CURRENT_VERSION = process\.env\.CHECKIN_VERSION \|\| "[0-9.]*"'),
}


def sha256_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def sha256_file_injected(p, version):
    """sha256：对构建期注入文件先模拟 build.sh 的版本注入，再取哈希。"""
    if version == "dev" or p not in INJECT_RULES:
        return sha256_file(p)
    with open(p, encoding="utf-8") as f:
        content = f.read()
    rule = INJECT_RULES[p]
    if p.endswith("store.js"):
        content = rule.sub(f'version: "{version}"', content)
    else:
        content = rule.sub(f'const CURRENT_VERSION = process.env.CHECKIN_VERSION || "{version}"', content)
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def repo_to_install(rel):
    """仓库相对 rel → 安装相对 rel（与 hotfix.js rawRel 反向同源）。"""
    if rel.startswith("app/server/"):
        return "server/" + rel[len("app/server/"):]
    if rel.startswith("app/ui/"):
        return "www/" + rel[len("app/ui/"):]
    return None


def install_to_repo(rel):
    """安装相对 rel → 仓库相对 rel（与 hotfix.js rawRel 同向同源）。"""
    if rel.startswith("server/"):
        return "app/server/" + rel[len("server/"):]
    if rel.startswith("www/"):
        return "app/ui/" + rel[len("www/"):]
    return None


def discover_files():
    """自动发现应热更的仓库文件（rel 为仓库相对路径）。"""
    found = []
    for sub, _, exclude in RUNTIME_ROOTS:
        base = os.path.join(ROOT, sub)
        for name in sorted(os.listdir(base)):
            if name in exclude:
                continue
            p = os.path.join(base, name)
            if os.path.isfile(p):
                found.append(f"{sub}/{name}")
    return found


def build_manifest(version):
    files = {}
    missing = []
    for repo_rel in discover_files():
        install_rel = repo_to_install(repo_rel)
        if install_rel is None:
            missing.append(repo_rel)
            continue
        p = os.path.join(ROOT, repo_rel)
        files[install_rel] = {
            "sha256": sha256_file_injected(p, version),
            "size": os.path.getsize(p),
        }
    if missing:
        print(f"警告：无法映射的仓库文件：{', '.join(missing)}")
    return {
        "version": version,
        "generated_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "files": files,
    }


def load_version():
    """功能版本单一事实源：apps/<app>/VERSION 文件；缺失时回落 dev。"""
    try:
        with open(VERSION_FILE, encoding="utf-8") as f:
            v = f.read().strip()
        return v if v else "dev"
    except FileNotFoundError:
        return "dev"


def bump_version(v):
    """补丁号递增：1.0.0 → 1.0.1（功能热更发布用）。"""
    parts = [int(x) for x in str(v).split(".")]
    if len(parts) < 3:
        parts += [0] * (3 - len(parts))
    parts[-1] += 1
    return ".".join(str(x) for x in parts)


def write_version(v):
    with open(VERSION_FILE, "w", encoding="utf-8") as f:
        f.write(v + "\n")


def verify_manifest(expected):
    """校验本地清单与仓库现状一致（CI/发布前调用）。返回错误列表。"""
    errors = []
    if not os.path.isfile(MANIFEST_PATH):
        return ["缺少 runtime-manifest.json（先运行 python3 gen_runtime_manifest.py <VERSION>）"]
    with open(MANIFEST_PATH, encoding="utf-8") as f:
        m = json.load(f)
    exp_files = expected["files"]
    cur_files = m.get("files", {})
    for rel, info in exp_files.items():
        if rel not in cur_files:
            errors.append(f"清单缺少文件：{rel}（仓库已存在，未生成？）")
        elif cur_files[rel].get("sha256") != info["sha256"]:
            errors.append(f"清单过期：{rel}（sha256 与仓库不一致）")
    for rel in cur_files:
        if rel not in exp_files:
            errors.append(f"清单多余文件：{rel}（仓库已移除/不再属于运行时？）")
        else:
            repo_rel = install_to_repo(rel)
            if repo_rel is None:
                errors.append(f"清单非法路径（不在 server/ www/ 白名单）：{rel}")
            elif not os.path.isfile(os.path.join(ROOT, repo_rel)):
                errors.append(f"清单指向仓库不存在文件：{rel} → {repo_rel}")
    return errors


def main():
    args = sys.argv[1:]
    if args and args[0] == "--check":
        expected = build_manifest("check")
        errors = verify_manifest(expected)
        # 校验版本一致性：清单版本应与 VERSION 文件一致（保证热更后版本号递增可追踪）
        cur = json.load(open(MANIFEST_PATH, encoding="utf-8")) if os.path.isfile(MANIFEST_PATH) else {}
        declared = cur.get("version")
        if declared and declared != load_version():
            errors.append(f"版本不一致：VERSION={load_version()} ≠ manifest={declared}（发布前运行 --bump）")
        if errors:
            print("❌ 清单校验失败：")
            for e in errors:
                print("  - " + e)
            sys.exit(1)
        print("✅ runtime-manifest.json 与仓库一致（{} 个文件，版本{}）".format(len(expected["files"]), declared))
        return

    # 版本来源：--bump 递增 VERSION → 显式 VERSION → VERSION 文件
    bump = "--bump" in args
    explicit = [a for a in args if a != "--bump"]
    if bump:
        version = bump_version(load_version())
        write_version(version)
        # 同步运行时源码中的版本字面量（store.js / update.js），保证「源码默认版本 == 清单版本」，
        # 否则热更下载的是源码（无构建注入），与按注入后计算的清单 sha 不一致会校验失败
        for p, rule in INJECT_RULES.items():
            fp = os.path.join(ROOT, p)
            if not os.path.isfile(fp):
                continue
            with open(fp, encoding="utf-8") as f:
                content = f.read()
            if p.endswith("store.js"):
                content = re.sub(r'version: "[0-9.]*"', f'version: "{version}"', content)
            else:
                # 只同步 CURRENT_VERSION 声明行的默认版本，避免误伤其他业务默认值文本
                content = re.sub(
                    r'(const CURRENT_VERSION = process\.env\.[A-Z_]+ \|\| )"[0-9.]*"',
                    rf'\g<1>"{version}"',
                    content,
                )
            with open(fp, "w", encoding="utf-8") as f:
                f.write(content)
        print(f"功能版本已递增：VERSION -> {version}（源码版本字面量已同步）")
    elif explicit:
        version = explicit[0]
        write_version(version)
    else:
        version = load_version()

    manifest = build_manifest(version)
    errors = []
    if os.path.isfile(MANIFEST_PATH):
        errors = verify_manifest(manifest)
    with open(MANIFEST_PATH, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.write("\n")
    ok = "（与仓库一致 ✅）" if not errors else f"（校验提示 {len(errors)} 项，见下）"
    print(f"已生成 {MANIFEST_PATH}（{manifest['version']}，{len(manifest['files'])} 文件）{ok}")
    for e in errors:
        print("  - " + e)


if __name__ == "__main__":
    main()