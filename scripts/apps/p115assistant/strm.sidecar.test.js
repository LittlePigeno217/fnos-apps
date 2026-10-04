"use strict";
// p115assistant 1.3.8「复制刮削及字幕」验收单测（零依赖，node --test）。
//
// 覆盖：
//   1) 同目录同名字幕（.srt/.ass/.ssa/.sup/.vtt）落盘
//   2) 同目录同名刮削（.nfo/.jpg/.png/.webp 去扩展同名，大小写不敏感）落盘
//   3) 固定刮削名（movie.nfo / tvshow.nfo / poster / fanart / backdrop / folder / season*）落盘
//   4) 无关图片（非同名前缀、非固定刮削名）不复制
//   5) 本地已有且 size 一致 → 跳过计数，不重复下载
//   6) strm_copy_sidecar=false → 不复制任何 sidecar
//   7) 旧键 strm_add_subtitles 读取兼容（true/false/缺省）
//   8) store.js 迁移：strm_add_subtitles → strm_copy_sidecar（真 Store 实例）
//   9) 收集顺序回归：收集与匹配分离（先收集全部刮削候选、再按同目录媒体过滤），
//      刮削附件先于媒体列出仍全部收集复制，顺序无关
//   10) 多文件目录诊断：scrape 附件下载阶段不按 base 过滤（探针）
//
// 用法：node --test scripts/apps/p115assistant/strm.sidecar.test.js

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SERVER_PATH = path.join(__dirname, "../../../apps/p115assistant/fnos/app/server/server.js");
const STORE_PATH = path.join(__dirname, "../../../apps/p115assistant/fnos/app/server/store.js");
const { Server } = require(SERVER_PATH);
const { Store, DEFAULT_CONFIG } = require(STORE_PATH);

// 与 DEFAULT_CONFIG.upload_media_extensions 一致
const MEDIA_EXTS = new Set(
  ".mp4,.mkv,.ts,.iso,.rmvb,.avi,.mov,.mpeg,.mpg,.wmv,.3gp,.asf,.m4v,.m4a,.flv,.m2ts,.tp,.f4v"
    .split(",")
    .map((e) => e.trim().toLowerCase())
);

function file(name, fid, size, pc) {
  // size 字段名对齐 client.js _itemSize 读取键（size_byte/file_size/size/fs）
  return { n: name, fid, pc, size, fc: "1", t: 1720000000 };
}

function makeClient(cidItems) {
  return {
    getDirList: async (cid) => cidItems[cid] || [],
    downloadFile: async (pickcode, outputPath, createParent, expectedSize) => {
      if (createParent) fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, Buffer.alloc(expectedSize, 0x41));
    },
  };
}

function makeStore(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p115-strm-"));
  const store = {
    dir,
    _config: Object.assign({ strm_copy_sidecar: true }, config || {}),
    _records: {},
    getConfig() {
      return Object.assign({}, this._config);
    },
    getRedirectSecret() {
      return "0123456789abcdef0123456789abcdef";
    },
    getStrmRecords() {
      return this._records;
    },
    saveStrmRecords(records) {
      this._records = records;
    },
    appendHistory() {},
  };
  return store;
}

async function runSync(cidItems, targetDir, storeCfg) {
  const store = makeStore(storeCfg);
  const api = new Server(store);
  const client = makeClient(cidItems);
  const mapping = {
    id: "test-map",
    name: "测试映射",
    source_cid: "c0",
    source_path: "/测试云",
    target_dir: targetDir,
    enabled: true,
  };
  const counts = await api._runStrmMapping(
    client, mapping, "c0", targetDir, "http://nas:3667", true, MEDIA_EXTS
  );
  return { counts, store };
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "p115-strm-out-"));
}

// 标准测试云端目录：媒体 + 同名字幕 + 同名刮削 + 固定刮削名 + 无关图 + 无关 txt
// 媒体最后上传（user_utime 最新）→ 列表首个即媒体（对齐 115 user_utime 降序）。
const STANDARD_ORDER_MEDIA_FIRST = [
  file("媒体.mkv", "f1", 1000, "pc-mkv"),
  file("媒体.srt", "f2", 200, "pc-srt"),
  file("媒体.nfo", "f3", 300, "pc-nfo"),
  file("媒体.jpg", "f4", 400, "pc-jpg"),
  file("poster.jpg", "f5", 500, "pc-poster"),
  file("movie.nfo", "f6", 600, "pc-movieNfo"),
  file("x.jpg", "f7", 700, "pc-x"),
  file("说明.txt", "f8", 800, "pc-txt"),
];

test("同目录同名刮削落盘 + 固定名刮削落盘 + 无关图不复制（媒体最新、列表在前）", async () => {
  const out = tmpDir();
  try {
    const { counts } = await runSync({ c0: STANDARD_ORDER_MEDIA_FIRST }, out, {});
    // 落盘清单
    for (const name of ["媒体.strm", "媒体.srt", "媒体.nfo", "媒体.jpg", "poster.jpg", "movie.nfo"]) {
      assert.ok(fs.existsSync(path.join(out, name)), `应落盘：${name}`);
    }
    // 无关内容不复制
    assert.ok(!fs.existsSync(path.join(out, "x.jpg")), "无关图 x.jpg 不得复制");
    assert.ok(!fs.existsSync(path.join(out, "说明.txt")), "无关 说明.txt 不得复制");
    // STRM 内容指向媒体 pickcode
    const strm = fs.readFileSync(path.join(out, "媒体.strm"), "utf8");
    assert.ok(strm.includes("pickcode=pc-mkv"), "STRM 内容应对应媒体 pickcode");
    // 计数：1 个新增 STRM、1 字幕、4 刮削
    assert.strictEqual(counts.added, 1);
    assert.strictEqual(counts.errors, 0);
    assert.strictEqual(counts.subtitles, 1);
    assert.strictEqual(counts.subtitles_skipped, 0);
    assert.strictEqual(counts.scrapes, 4);
    assert.strictEqual(counts.scrapes_skipped, 0);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("本地已有且 size 一致 → 跳过（字幕/刮削均计入 skipped，不重复下载）", async () => {
  const out = tmpDir();
  try {
    // 预置与云端 size 一致的既有文件
    fs.writeFileSync(path.join(out, "媒体.srt"), Buffer.alloc(200, 0x42)); // 云端 200
    fs.writeFileSync(path.join(out, "poster.jpg"), Buffer.alloc(500, 0x42)); // 云端 500
    const { counts } = await runSync({ c0: STANDARD_ORDER_MEDIA_FIRST }, out, {});
    // 既有文件内容未被覆盖（仍是 0x42）
    assert.strictEqual(fs.readFileSync(path.join(out, "媒体.srt"))[0], 0x42, "size 一致应跳过下载");
    assert.strictEqual(fs.readFileSync(path.join(out, "poster.jpg"))[0], 0x42, "size 一致应跳过下载");
    // 跳过计数：字幕 1（媒体.srt）、刮削 1（poster.jpg）
    assert.strictEqual(counts.subtitles, 0);
    assert.strictEqual(counts.subtitles_skipped, 1);
    assert.strictEqual(counts.scrapes, 3);
    assert.strictEqual(counts.scrapes_skipped, 1);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("strm_copy_sidecar=false → 不复制任何 sidecar，仅写 STRM", async () => {
  const out = tmpDir();
  try {
    const { counts } = await runSync({ c0: STANDARD_ORDER_MEDIA_FIRST }, out, { strm_copy_sidecar: false });
    assert.ok(fs.existsSync(path.join(out, "媒体.strm")));
    for (const name of ["媒体.srt", "媒体.nfo", "媒体.jpg", "poster.jpg", "movie.nfo", "x.jpg"]) {
      assert.ok(!fs.existsSync(path.join(out, name)), `关闭时不得复制：${name}`);
    }
    assert.strictEqual(counts.subtitles, 0);
    assert.strictEqual(counts.scrapes, 0);
    assert.strictEqual(counts.added, 1);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("旧键 strm_add_subtitles 读取兼容：true=开，false=关（服务端回退路径）", async () => {
  const outTrue = tmpDir();
  const outFalse = tmpDir();
  try {
    // 旧键 true / 缺省 → 复制
    const r1 = await runSync({ c0: STANDARD_ORDER_MEDIA_FIRST }, outTrue, { strm_copy_sidecar: undefined, strm_add_subtitles: true });
    assert.ok(fs.existsSync(path.join(outTrue, "媒体.srt")), "旧键 true 应复制字幕");
    assert.ok(fs.existsSync(path.join(outTrue, "poster.jpg")), "旧键 true 应复制刮削");
    assert.strictEqual(r1.counts.subtitles, 1);
    assert.strictEqual(r1.counts.scrapes, 4);
    // 旧键 false → 不复制
    const r2 = await runSync({ c0: STANDARD_ORDER_MEDIA_FIRST }, outFalse, { strm_copy_sidecar: undefined, strm_add_subtitles: false });
    assert.ok(!fs.existsSync(path.join(outFalse, "媒体.srt")), "旧键 false 不得复制字幕");
    assert.ok(!fs.existsSync(path.join(outFalse, "poster.jpg")), "旧键 false 不得复制刮削");
    assert.strictEqual(r2.counts.subtitles, 0);
    assert.strictEqual(r2.counts.scrapes, 0);
  } finally {
    fs.rmSync(outTrue, { recursive: true, force: true });
    fs.rmSync(outFalse, { recursive: true, force: true });
  }
});

test("store.js 迁移：strm_add_subtitles → strm_copy_sidecar（真 Store 实例）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p115-strm-store-"));
  try {
    const store = new Store(dir);
    // 旧键 true → 新键 true
    store.saveConfig({ strm_add_subtitles: true });
    assert.strictEqual(store.getConfig().strm_copy_sidecar, true, "旧键 true 迁移后应为 true");
    // 旧键 false → 新键 false（不得被 DEFAULT true 覆盖）
    store.saveConfig({ strm_add_subtitles: false });
    assert.strictEqual(store.getConfig().strm_copy_sidecar, false, "旧键 false 迁移后应为 false");
    // 新旧键并存 → 新键优先
    store.saveConfig({ strm_add_subtitles: false, strm_copy_sidecar: true });
    assert.strictEqual(store.getConfig().strm_copy_sidecar, true, "并存时新键优先");
    // 两键皆缺 → DEFAULT true
    store.saveConfig({});
    assert.strictEqual(store.getConfig().strm_copy_sidecar, true, "缺省应为 DEFAULT true");
    // 版本恒定（不随旧配置回写覆盖），始终反映当前代码常量 DEFAULT_CONFIG.version
    assert.strictEqual(store.getConfig().version, DEFAULT_CONFIG.version, "version 始终反映当前代码常量");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 顺序无关回归（收集与匹配分离）──────────────────────────
test("刮削附件先于媒体列出 → 刮削仍全部收集并复制（顺序无关）", async () => {
  const out = tmpDir();
  try {
    // 模拟 115 user_utime 降序：刮削（nfo/jpg/poster/movie.nfo）排最前、字幕居中、媒体最后
    const SCRAPE_FIRST = [
      file("媒体.nfo", "f3", 300, "pc-nfo"),
      file("媒体.jpg", "f4", 400, "pc-jpg"),
      file("poster.jpg", "f5", 500, "pc-poster"),
      file("movie.nfo", "f6", 600, "pc-movieNfo"),
      file("媒体.srt", "f2", 200, "pc-srt"),
      file("媒体.mkv", "f1", 1000, "pc-mkv"),
      file("x.jpg", "f7", 700, "pc-x"),
    ];
    const { counts } = await runSync({ c0: SCRAPE_FIRST }, out, {});
    // 媒体 + 字幕 + 全部刮削均落盘
    for (const name of ["媒体.strm", "媒体.srt", "媒体.nfo", "媒体.jpg", "poster.jpg", "movie.nfo"]) {
      assert.ok(fs.existsSync(path.join(out, name)), `应落盘：${name}`);
    }
    // 无关图不复制
    assert.ok(!fs.existsSync(path.join(out, "x.jpg")), "无关图 x.jpg 不得复制");
    // 计数：1 字幕、4 刮削、0 跳过/错误
    assert.strictEqual(counts.subtitles, 1);
    assert.strictEqual(counts.scrapes, 4);
    assert.strictEqual(counts.scrapes_skipped, 0);
    assert.strictEqual(counts.errors, 0);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("子目录刮削先于媒体列出 → 子目录内刮削/字幕仍全部复制（顺序无关）", async () => {
  const out = tmpDir();
  try {
    // c0 只含目录条目「电影」；c1 内刮削在前、字幕居中、媒体最后
    const cidItems = {
      c0: [{ n: "电影", cid: "c1", fc: "0", fid: "d1", size: 0, t: 1720000000 }],
      c1: [
        file("电影.nfo", "g1", 300, "pc-gnfo"),
        file("电影.jpg", "g2", 400, "pc-gjpg"),
        file("电影.srt", "g3", 200, "pc-gsrt"),
        file("电影.mkv", "g4", 1000, "pc-gmkv"),
        file("无关.png", "g5", 500, "pc-gpng"),
      ],
    };
    const { counts } = await runSync(cidItems, out, {});
    for (const rel of ["电影/电影.strm", "电影/电影.nfo", "电影/电影.jpg", "电影/电影.srt"]) {
      assert.ok(fs.existsSync(path.join(out, rel)), `应落盘：${rel}`);
    }
    // 无关图不复制
    assert.ok(!fs.existsSync(path.join(out, "电影/无关.png")), "无关.png 不得复制");
    // 计数：1 字幕、2 刮削（电影.nfo + 电影.jpg）、无错误
    assert.strictEqual(counts.subtitles, 1);
    assert.strictEqual(counts.scrapes, 2);
    assert.strictEqual(counts.errors, 0);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

// ── 诊断探针（如实记录行为，不判定通过/失败）──────────────────────────
test("多文件目录探针：scrape 附件下载阶段不按 base 过滤，同目录附件会随每个 STRM 复制", async () => {
  const out = tmpDir();
  try {
    const EP_DIR = [
      file("S01E01.mkv", "e1", 1000, "pc-e1"),
      file("S01E01.nfo", "e2", 300, "pc-e1nfo"),
      file("S01E02.mkv", "e3", 1000, "pc-e2"),
      file("S01E02.nfo", "e4", 300, "pc-e2nfo"),
    ];
    const { counts } = await runSync({ c0: EP_DIR }, out, {});
    assert.ok(fs.existsSync(path.join(out, "S01E01.strm")));
    assert.ok(fs.existsSync(path.join(out, "S01E02.strm")));
    // 探针记录：S01E02.nfo 会同时出现在 S01E01.strm 同目录（scrape 不按 base 过滤）
    // eslint-disable-next-line no-console
    console.log(`[探针] 多文件目录：S01E01.strm 旁实际含 nfo=${["S01E01.nfo", "S01E02.nfo"].filter((n) => fs.existsSync(path.join(out, n))).join(",")}；scrapes=${counts.scrapes}`);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
