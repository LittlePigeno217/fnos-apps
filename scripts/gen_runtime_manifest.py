#!/usr/bin/env python3
"""生成/校验 runtime-manifest.json：统一热更新清单生成器（--app 参数化，单一事实源）。

用法：
  python3 scripts/gen_runtime_manifest.py --app <slug> [--check|--bump|[VERSION]]

  --app <slug>   应用 slug（apps/<slug>/）；必填
  （无版本参数） 用 apps/<slug>/VERSION 重新生成清单（构建流程/构建后重生成）
  --bump         VERSION 补丁号 +1 并同步源码版本字面量（功能热更发布流程）
  <VERSION>      显式版本（写入 VERSION 并同步源码字面量）
  --check        仅校验本地清单与仓库一致（CI/发布前）

输出：apps/<slug>/runtime-manifest.json

规范约定（与 server/hotfix.js 的 rawRel 映射保持同源，本脚本内含双向校验）：
  - 清单 rel 使用「安装相对路径」：server/*.js、www/*
  - 仓库路径 = apps/<slug>/fnos/app/{server|ui}/*，由 rawRel 反向推导
  - 自动发现：server/*.js（排除 package.json）+ app/ui/*（全部），新增运行时文件无需改脚本

应用私有常量全部由 slug 推导：
  ROOT          = apps/<slug>/fnos
  MANIFEST_PATH = apps/<slug>/runtime-manifest.json
  VERSION_FILE  = apps/<slug>/VERSION
  VERSION_ENV   = <SLUG_UPPER>_VERSION（如 P115ASSISTANT_VERSION / CHECKIN_VERSION）
                  （update.js 中 `process.env.<VERSION_ENV> || "<功能版本>"`）
"""
import argparse
import datetime
import hashlib
import json
import os
import re
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

RUNTIME_ROOTS = [
    ("app/server", "server", {"package.json"}),
    ("app/ui", "www", set()),
]


def slug_to_env(slug: str) -> str:
    return slug.upper().replace("-", "_") + "_VERSION"


def app_paths(slug: str):
    """由 slug 推导应用私有路径。"""
    base = os.path.join(REPO_ROOT, "apps", slug)
    return {
        "ROOT": os.path.join(base, "fnos"),
        "MANIFEST_PATH": os.path.join(base, "runtime-manifest.json"),
        "VERSION_FILE": os.path.join(base, "VERSION"),
    }


def sha256_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def sync_source_literals(version, slug, version_env):
    """同步 store.js / update.js 的功能版本字面量到指定版本（bump/显式版本时调用）。"""
    root = app_paths(slug)["ROOT"]
    targets = [
        ("app/server/store.js", re.compile(r'version: "[0-9.]*"'), f'version: "{version}"'),
        (
            "app/server/update.js",
            re.compile(rf'(const CURRENT_VERSION = process\.env\.{version_env} \|\| )"[0-9.]*"'),
            rf'\g<1>"{version}"',
        ),
        (
            "app/ui/index.html",
            re.compile(r'id="appVersion">v[0-9.]*</span>'),
            f'id="appVersion">v{version}</span>',
        ),
    ]
    for rel, rule, repl in targets:
        fp = os.path.join(root, rel)
        if not os.path.isfile(fp):
            continue
        with open(fp, encoding="utf-8") as f:
            content = f.read()
        with open(fp, "w", encoding="utf-8") as f:
            f.write(rule.sub(repl, content))


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


def discover_files(root):
    """自动发现应热更的仓库文件（rel 为仓库相对路径）。"""
    found = []
    for sub, _, exclude in RUNTIME_ROOTS:
        base = os.path.join(root, sub)
        for name in sorted(os.listdir(base)):
            if name in exclude:
                continue
            p = os.path.join(base, name)
            if os.path.isfile(p):
                found.append(f"{sub}/{name}")
    return found


def build_manifest(version, slug):
    root = app_paths(slug)["ROOT"]
    files = {}
    missing = []
    for repo_rel in discover_files(root):
        install_rel = repo_to_install(repo_rel)
        if install_rel is None:
            missing.append(repo_rel)
            continue
        p = os.path.join(root, repo_rel)
        files[install_rel] = {
            "sha256": sha256_file(p),
            "size": os.path.getsize(p),
        }
    if missing:
        print(f"警告：无法映射的仓库文件：{', '.join(missing)}")
    return {
        "version": version,
        "generated_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "files": files,
    }


def load_version(slug):
    """功能版本单一事实源：apps/<slug>/VERSION 文件；缺失时回落 dev。"""
    version_file = app_paths(slug)["VERSION_FILE"]
    try:
        with open(version_file, encoding="utf-8") as f:
            v = f.read().strip()
        return v if v else "dev"
    except FileNotFoundError:
        return "dev"


def validate_version_line(v):
    """版本线校验（addVersionLine 语义）：版本必须为 x.y.z，且每段 0-9；
    patch 达 9 进位 minor、minor 达 9 进位 major——永不出现 .10+。
    合法返回 None，非法返回错误字符串。显式 --version / --check 均走此校验，
    防止绕过 bump_version 直接写 1.2.10 之类的越线版本。"""
    s = str(v).strip()
    if not re.fullmatch(r"\d+\.\d+\.\d+", s):
        return f"版本格式非法（应为 x.y.z）：{v}"
    parts = [int(x) for x in s.split(".")]
    if any(x > 9 for x in parts):
        return f"版本线违规（任一段不得 ≥10，patch 达 9 应进位 minor）：{v}"
    return None


def bump_version(v):
    """补丁号递增（功能热更发布用），遵守项目版本线：永不出现 .10+，
    1.0.9 的下个版本跳 1.1.0（patch 达 9 进位 minor；minor 达 9 进位 major）。
    1.0.0 → 1.0.1 → … → 1.0.9 → 1.1.0 → … → 1.9.9 → 2.0.0"""
    parts = [int(x) for x in str(v).split(".")]
    if len(parts) < 3:
        parts += [0] * (3 - len(parts))
    parts[2] += 1
    if parts[2] >= 10:
        parts[2] = 0
        parts[1] += 1
    if parts[1] >= 10:
        parts[1] = 0
        parts[0] += 1
    return ".".join(str(x) for x in parts)


def write_version(slug, v):
    with open(app_paths(slug)["VERSION_FILE"], "w", encoding="utf-8") as f:
        f.write(v + "\n")


def verify_manifest(expected, slug):
    """校验本地清单与仓库现状一致（CI/发布前调用）。返回错误列表。"""
    manifest_path = app_paths(slug)["MANIFEST_PATH"]
    errors = []
    if not os.path.isfile(manifest_path):
        return [f"缺少 runtime-manifest.json（先运行 python3 scripts/gen_runtime_manifest.py --app {slug} <VERSION>）"]
    with open(manifest_path, encoding="utf-8") as f:
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
            elif not os.path.isfile(os.path.join(app_paths(slug)["ROOT"], repo_rel)):
                errors.append(f"清单指向仓库不存在文件：{rel} → {repo_rel}")
    return errors


def main():
    parser = argparse.ArgumentParser(
        description="生成/校验 runtime-manifest.json（统一热更清单生成器）")
    parser.add_argument("--app", required=True, help="应用 slug（apps/<slug>/）")
    parser.add_argument("--check", action="store_true", help="仅校验清单与 VERSION 及仓库一致")
    parser.add_argument("--bump", action="store_true", help="VERSION 补丁号 +1 并同步源码字面量")
    parser.add_argument("version", nargs="?", default=None, help="显式版本（写入 VERSION 并同步源码字面量）")
    args = parser.parse_args()

    slug = args.app
    paths = app_paths(slug)
    if not os.path.isdir(paths["ROOT"]):
        print(f"❌ 应用目录不存在：apps/{slug}/fnos")
        sys.exit(1)

    version_env = slug_to_env(slug)

    if args.check:
        expected = build_manifest("check", slug)
        errors = verify_manifest(expected, slug)
        manifest_path = paths["MANIFEST_PATH"]
        cur = json.load(open(manifest_path, encoding="utf-8")) if os.path.isfile(manifest_path) else {}
        declared = cur.get("version")
        for v in [declared, load_version(slug)]:
            if v:
                verr = validate_version_line(v)
                if verr:
                    errors.append(verr)
        if declared and declared != load_version(slug):
            errors.append(f"版本不一致：VERSION={load_version(slug)} ≠ manifest={declared}（发布前运行 --bump）")
        if errors:
            print("❌ 清单校验失败：")
            for e in errors:
                print("  - " + e)
            sys.exit(1)
        print("✅ runtime-manifest.json 与仓库一致（{} 个文件，版本{}）".format(len(expected["files"]), declared))
        return

    # 版本来源：--bump 递增 VERSION → 显式 VERSION → VERSION 文件
    if args.bump:
        version = bump_version(load_version(slug))
        write_version(slug, version)
        sync_source_literals(version, slug, version_env)
        print(f"功能版本已递增：VERSION -> {version}（源码版本字面量已同步）")
    elif args.version:
        version = args.version
        verr = validate_version_line(version)
        if verr:
            print(f"❌ {verr}")
            sys.exit(1)
        write_version(slug, version)
        sync_source_literals(version, slug, version_env)
    else:
        version = load_version(slug)
        verr = validate_version_line(version)
        if verr:
            print(f"❌ {verr}")
            sys.exit(1)

    manifest = build_manifest(version, slug)
    errors = []
    if os.path.isfile(paths["MANIFEST_PATH"]):
        errors = verify_manifest(manifest, slug)
    with open(paths["MANIFEST_PATH"], "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.write("\n")
    ok = "（与仓库一致 ✅）" if not errors else f"（校验提示 {len(errors)} 项，见下）"
    print(f"已生成 {paths['MANIFEST_PATH']}（{manifest['version']}，{len(manifest['files'])} 文件）{ok}")
    for e in errors:
        print("  - " + e)


if __name__ == "__main__":
    main()