"use strict";

/**
 * 115网盘助手 FPK —— 媒体账本聚合（Node.js 版）。
 *
 * 行为语义对齐 MoviePilot-Plugins p115liteassistant/media_ledger.py：把逐文件的
 * STRM 记录聚合成「一部电影一行、一季剧一行」的总账。
 *
 * 本阶段的口径（比参考实现窄，但一致）：
 *   已记录 ← strm_records 里本应用生成的 .strm（每个文件都记着云端大小/pickcode/云目录）
 *   未记录 ← 输出目录里躺着、但记录里没有的 .strm（网盘上有没有无从得知 → 状态 untracked）
 *
 * 两侧都是纯本地判断，不发一个 115 请求，所以账本能随时重算。
 *
 * 归组主键不用目录：同一部片在不同映射、不同输出目录下路径都不同，按目录归组会变成多行，
 * 那就没法在一行上看清「这部片一共几个 STRM、多大、核对过没有」。
 */

//: 季目录的几种写法。命中就说明标题在上一层。
const _SEASON_DIR = [
  /^season\s*(\d{1,3})$/i,
  /^s(\d{1,3})$/i,
  /^第\s*(\d{1,3})\s*季$/,
];

//: 目录名里的年份：`某剧 (2024)`、`某剧（2024）`
const _TITLE_YEAR = /^(.*?)[\s._]*[\(（](\d{4})[\)）]/;

//: 集号，与参考实现 library_audit 同一套写法
const _EPISODE = [
  /[Ss](\d{1,3})[\s._-]*[Ee](\d{1,4})/,
  /(?<![A-Za-z0-9])[Ee](\d{1,4})(?![A-Za-z0-9])/,
  /第\s*(\d{1,4})\s*[集话話]/,
];

/** 从文件名解析 ``[季, 集]``；解析不出来说明是电影。 */
function parseEpisode(name) {
  const text = String(name || "");
  let matched = _EPISODE[0].exec(text);
  if (matched) return [parseInt(matched[1], 10), parseInt(matched[2], 10)];
  for (const pattern of _EPISODE.slice(1)) {
    matched = pattern.exec(text);
    if (matched) return [1, parseInt(matched[1], 10)];
  }
  return null;
}

/** 目录名是不是季目录（``Season 01`` / ``S01`` / ``第 1 季``）。 */
function seasonOfDir(name) {
  const text = String(name || "").trim();
  for (const pattern of _SEASON_DIR) {
    const matched = pattern.exec(text);
    if (matched) return parseInt(matched[1], 10);
  }
  return null;
}

/** 目录名 → ``[标题, 年份]``。没有年份就整段当标题，不猜。 */
function splitTitle(name) {
  const text = String(name || "").trim();
  const matched = _TITLE_YEAR.exec(text);
  if (matched) return [matched[1].replace(/^[\s._-]+|[\s._-]+$/g, ""), matched[2]];
  return [text, ""];
}

function posixDirname(value) {
  const text = String(value || "").replace(/\\/g, "/").replace(/\/+$/, "");
  const index = text.lastIndexOf("/");
  if (index < 0) return "";
  return text.slice(0, index);
}

function posixBasename(value) {
  const text = String(value || "").replace(/\\/g, "/").replace(/\/+$/, "");
  const index = text.lastIndexOf("/");
  return index < 0 ? text : text.slice(index + 1);
}

/**
 * 一个 .strm 的**输出相对路径** → 它属于账本里的哪一行。
 *
 * 电影：所在目录就是一行。
 * 剧集：文件名里有集号才算剧集；季号优先取**目录**上的（``Season 01``），目录没写才用
 * 文件名里的 —— 目录是刮削器排的，比文件名可靠。命中季目录时标题取上一层。
 *
 * ``rootTitle`` 是这个映射输出根目录对应的标题（一般取 115 源目录名）。文件直接躺在
 * 输出根目录时没有上层目录可取名，只能用它；它也是空的就归到「其他」，不硬猜。
 */
function locate(relPath, rootTitle) {
  const rel = String(relPath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!rel) return null;
  const folder = posixDirname(rel);
  const fileNameRaw = posixBasename(rel);
  // .strm 只是壳，媒体名以去掉壳之后的名字为准（.iso.strm 同样只剥一层）
  const fileName = fileNameRaw.toLowerCase().endsWith(".strm")
    ? fileNameRaw.slice(0, -".strm".length)
    : fileNameRaw;

  const dirSeason = folder ? seasonOfDir(posixBasename(folder)) : null;
  const parsed = parseEpisode(fileName);

  if (parsed === null && dirSeason === null) {
    if (!folder) {
      const title = String(rootTitle || "").trim();
      if (!title) {
        // 根目录下的散装 .strm：没有目录也没有集号，归到「其他」，不冒充电影
        return { kind: "other", title: fileName || fileNameRaw, year: "", season: null, episode: null, folder: "", key: `other|${rel}` };
      }
      // 输出根目录就是这部片自己（单文件映射）
      const [splitName, splitYear] = splitTitle(title);
      const resolved = splitName || title;
      return { kind: "movie", title: resolved, year: splitYear, season: null, episode: null, folder: "", key: `movie|${resolved}|${splitYear}|` };
    }
    const dirName = posixBasename(folder);
    const [title, year] = splitTitle(dirName);
    const resolved = title || dirName;
    return { kind: "movie", title: resolved, year, season: null, episode: null, folder, key: `movie|${resolved}|${year}|` };
  }

  const season = dirSeason !== null ? dirSeason : parsed[0];
  const episode = parsed ? parsed[1] : null;
  const holder = dirSeason !== null ? posixDirname(folder) : folder;
  const holderName = holder ? posixBasename(holder) : String(rootTitle || "").trim();
  const [title, year] = splitTitle(holderName);
  const resolved = title || holderName || String(rootTitle || "").trim() || "未命名剧集";
  return {
    kind: "tv",
    title: resolved,
    year,
    season,
    episode,
    folder,
    key: `tv|${resolved}|${year}|${season === null ? "" : season}`,
  };
}

function blankRow(spot) {
  return {
    id: spot.key,
    kind: spot.kind,
    title: spot.title,
    year: spot.year,
    season: spot.season,
    // 归属的 STRM 映射；同一部片被多条映射收录时都记下来
    mapping_ids: [],
    mapping_names: [],
    channel: "",
    source_name: "",
    source_cid: "",
    target_dirs: [],
    // 逐文件明细：核对状态就是在这里落的
    items: [],
    folders: [],
    files: 0,
    size: 0,
    last_sync: 0,
    episodes: [],
    missing: [],
    span: "",
    tracked_files: 0,
    untracked_files: 0,
    checked_files: 0,
    stale_files: 0,
    state: "untracked",
    flags: [],
  };
}

/**
 * 三个来源拼一本总账，同一部片合成一行。零 115 请求。
 *
 * @param {object} options
 * @param {object} options.records       strm_records：``键 → 记录``
 * @param {Array}  options.strmMappings  配置里的 STRM 映射
 * @param {Array}  options.untracked     输出目录里未被记录的 .strm：``{path, rel, target_dir, mtime}``
 */
function buildLedger(options) {
  const opts = options || {};
  const records = opts.records && typeof opts.records === "object" ? opts.records : {};
  const mappings = Array.isArray(opts.strmMappings) ? opts.strmMappings : [];
  const untracked = Array.isArray(opts.untracked) ? opts.untracked : [];

  const mappingById = new Map();
  for (const mapping of mappings) {
    if (!mapping || typeof mapping !== "object") continue;
    mappingById.set(String(mapping.id || ""), mapping);
  }

  const rows = new Map();
  const bucket = (spot) => {
    if (!rows.has(spot.key)) rows.set(spot.key, blankRow(spot));
    return rows.get(spot.key);
  };

  const applyMapping = (row, mappingId, mapping, targetDir) => {
    if (mappingId && !row.mapping_ids.includes(mappingId)) row.mapping_ids.push(mappingId);
    const label = mapping && String(mapping.name || "").trim();
    if (label && !row.mapping_names.includes(label)) row.mapping_names.push(label);
    if (targetDir && !row.target_dirs.includes(targetDir)) row.target_dirs.push(targetDir);
    if (!row.channel) {
      row.channel = label || (String(mappingId || "").startsWith("once") ? "一次性任务" : String(mappingId || "未知映射"));
      row.source_cid = mapping ? String(mapping.source_cid || "") : "";
      row.source_name = mapping ? String(mapping.source_name || "") : "";
    }
  };

  // ① 记录侧：本应用生成过的 .strm，每一条都带着云端大小与云目录
  for (const [key, record] of Object.entries(records)) {
    if (!record || typeof record !== "object") continue;
    const rel = String(record.rel || "").replace(/\\/g, "/");
    if (!rel.toLowerCase().endsWith(".strm")) continue;
    const mappingId = String(record.mapping_id || key.split(":").slice(0, -1).join(":") || "");
    const mapping = mappingById.get(mappingId) || null;
    // 文件直接躺在输出根目录时没有上层目录可取名，只能拿 115 源目录名当标题
    const rootTitle = mapping ? posixBasename(String(mapping.source_name || "")) : "";
    const spot = locate(rel, rootTitle);
    if (!spot) continue;
    const row = bucket(spot);
    applyMapping(row, mappingId, mapping, String(record.target_dir || ""));
    const size = parseInt(record.size || 0, 10);
    row.size += Number.isFinite(size) && size > 0 ? size : 0;
    if (spot.episode !== null && spot.episode !== undefined) row.episodes.push(spot.episode);
    const verifyState = String(record.verify_state || "");
    row.items.push({
      id: String(key),
      rel,
      path: String(record.path || ""),
      name: String(record.name || ""),
      size: Number.isFinite(size) && size > 0 ? size : 0,
      pickcode: String(record.pickcode || ""),
      cloud_dir: String(record.cloud_dir || ""),
      verify_state: verifyState,
      verify_at: parseInt(record.verify_at || 0, 10) || 0,
      synced_at: parseInt(record.synced_at || 0, 10) || 0,
      tracked: true,
    });
    if (verifyState === "yes" || verifyState === "no") row.checked_files += 1;
    if (verifyState === "no") row.stale_files += 1;
    if (!String(record.pickcode || "").trim() && !row.flags.includes("unlinkable")) {
      row.flags.push("unlinkable");
    }
    const cloudDir = String(record.cloud_dir || "");
    if (cloudDir && !row.folders.includes(cloudDir)) row.folders.push(cloudDir);
    const syncedAt = parseInt(record.synced_at || 0, 10) || 0;
    if (syncedAt > row.last_sync) row.last_sync = syncedAt;
    row.tracked_files += 1;
  }

  // ② 未记录侧：输出目录里躺着、记录里没有的 .strm。
  //    网盘上到底还有没有这东西无从得知，所以单独标 untracked 而不是硬塞进某一类 —— 猜一个
  //    会把筛选和「清理失效」的计数全带偏。
  for (const item of untracked) {
    if (!item || typeof item !== "object") continue;
    const rel = String(item.rel || "").replace(/\\/g, "/");
    if (!rel.toLowerCase().endsWith(".strm")) continue;
    const targetDir = String(item.target_dir || "");
    // 反查这个输出目录属于哪条映射，让「所属映射」这一列有意义
    let mappingId = "";
    let mapping = null;
    for (const [id, candidate] of mappingById) {
      if (String(candidate.target_dir || "") === targetDir) { mappingId = id; mapping = candidate; break; }
    }
    // 文件直接躺在输出根目录时没有上层目录可取名，只能拿 115 源目录名当标题
    const rootTitle = mapping ? posixBasename(String(mapping.source_name || "")) : "";
    const spot = locate(rel, rootTitle);
    if (!spot) continue;
    const row = bucket(spot);
    if (mappingId) applyMapping(row, mappingId, mapping, targetDir);
    else if (!row.channel) { row.channel = "记录缺失"; if (targetDir) row.target_dirs.push(targetDir); }
    row.items.push({
      id: `untracked:${targetDir}:${rel}`,
      rel,
      path: String(item.path || ""),
      name: posixBasename(rel),
      size: 0,
      pickcode: "",
      cloud_dir: "",
      verify_state: "",
      verify_at: 0,
      synced_at: parseInt(item.mtime || 0, 10) || 0,
      tracked: false,
    });
    if (spot.episode !== null && spot.episode !== undefined) row.episodes.push(spot.episode);
    if (!row.flags.includes("untracked")) row.flags.push("untracked");
    const mtime = parseInt(item.mtime || 0, 10) || 0;
    if (mtime > row.last_sync) row.last_sync = mtime;
    row.untracked_files += 1;
  }

  // ③ 收尾：算季集跨度与缺号，推出核对状态
  const finished = [];
  for (const row of rows.values()) {
    const episodes = [...new Set(row.episodes.filter((n) => Number.isInteger(n)))].sort((a, b) => a - b);
    row.episodes = episodes;
    if (row.kind === "tv" && episodes.length >= 2) {
      const low = episodes[0];
      const high = episodes[episodes.length - 1];
      row.span = `${low}-${high}`;
      row.missing = [];
      for (let n = low; n <= high; n += 1) if (!episodes.includes(n)) row.missing.push(n);
    }
    if (row.missing.length && !row.flags.includes("season_gap")) row.flags.push("season_gap");

    // 状态口径：有任何一个文件被确认「云端没了」就是 stale；全部核对过才算 ok；
    // 有记录但一个都没核对过是 unchecked；全是未记录文件则是 untracked（判不出来）。
    if (row.stale_files > 0) row.state = "stale";
    else if (row.tracked_files > 0 && row.checked_files >= row.tracked_files) row.state = "ok";
    else if (row.tracked_files > 0) row.state = "unchecked";
    else row.state = "untracked";

    row.files = row.items.length;
    row.flags = [...new Set(row.flags)].sort();
    finished.push(row);
  }
  finished.sort((a, b) => (b.size - a.size) || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));

  const summary = {
    rows: finished.length,
    movies: finished.filter((r) => r.kind === "movie").length,
    tv: finished.filter((r) => r.kind === "tv").length,
    other: finished.filter((r) => r.kind === "other").length,
    files: finished.reduce((sum, r) => sum + r.files, 0),
    size: finished.reduce((sum, r) => sum + r.size, 0),
    stale: finished.filter((r) => r.state === "stale").length,
    stale_files: finished.reduce((sum, r) => sum + r.stale_files, 0),
    unchecked: finished.filter((r) => r.state === "unchecked").length,
    untracked: finished.filter((r) => r.state === "untracked").length,
  };
  return { rows: finished, summary };
}

module.exports = {
  buildLedger,
  locate,
  parseEpisode,
  seasonOfDir,
  splitTitle,
  posixDirname,
  posixBasename,
};
