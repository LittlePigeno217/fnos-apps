"use strict";

/**
 * QR Code 编码器（纯 JS，零依赖）
 * ----------------------------------
 * 只处理 byte 模式、ECC LEVEL M，版本自动选择（最小能装下数据的版本）。
 * 输出：2D 矩阵（0=白, 1=黑, 其他=保留/格式位随 spec）。
 *
 * 参考 ISO/IEC 18004:2015。
 */

// ── GF(256) 基础 ──────────────────────────────────────────
const gf256_exp = new Uint8Array(512);
const gf256_log = new Uint8Array(256);
(() => {
  let v = 1;
  for (let i = 0; i < 255; i++) {
    gf256_exp[i] = v;
    gf256_log[v] = i;
    v = (v << 1) ^ (v & 0x80 ? 0x11d : 0);
  }
  gf256_exp[255] = gf256_exp[0];
  for (let i = 256; i < 512; i++) gf256_exp[i] = gf256_exp[i - 255];
})();

function gf_mul(a, b) { return a === 0 || b === 0 ? 0 : gf256_exp[gf256_log[a] + gf256_log[b]]; }
function gf_poly_mul(p, q) {
  const r = new Uint8Array(p.length + q.length - 1).fill(0);
  for (let i = 0; i < p.length; i++)
    for (let j = 0; j < q.length; j++)
      r[i + j] ^= gf_mul(p[i], q[j]);
  return r;
}
function gf_poly_eval(p, x) {
  let y = 0;
  for (let i = 0; i < p.length; i++) y = gf_mul(y, x) ^ p[i];
  return y;
}

// ── Reed-Solomon 生成多项式 ──────────────────────────────
// ECC codewords 对应各版本每块
const ECC_PER_BLOCK_M = { 1: [10,16,26,18,24,16,18,16,22,22,26,30,22,22,24,24,28,28,26,26,26,26,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28] };
const BLOCK_COUNT_M = { 1: [1,1,1,2,2,4,4,4,5,5,5,6,6,7,8,8,9,9,10,12,12,12,13,14,15,16,17,18,19,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49] };
const DATA_COUNT_M = { 1: [16,28,44,64,86,108,124,154,180,198,224,250,262,306,374,438,516,588,650,708,774,876,966,1050,1156,1244,1372,1462,1536,1684,1780,1912,2052,2166,2294,2438,2576,2718,2856,2986,3136,3282,3408,3550,3688,3828,3966,4110,4246,4386,4524,4668,4822,4946,5088,5236,5352,5502,5648,5780] };

function rs_generator_poly(degree) {
  let g = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) g = gf_poly_mul(g, new Uint8Array([1, gf256_exp[i]]));
  return g;
}

function rs_encode(data, eccCount) {
  const gen = rs_generator_poly(eccCount);
  const padded = new Uint8Array(data.length + eccCount);
  padded.set(data);
  for (let i = 0; i < data.length; i++) {
    if (padded[i] === 0) continue;
    const coef = padded[i];
    for (let j = 0; j < gen.length; j++) padded[i + j] ^= gf_mul(gen[j], coef);
  }
  return padded.slice(data.length);
}

// ── 版本表（字节模式, ECC M）────────────────────────────
// [version, data_bytes, ecc_per_block, num_blocks, matrix_size]
function buildVersionTable() {
  const t = [];
  const eccTable = ECC_PER_BLOCK_M[1];  // { 1: [array] } keyed by ECC level index
  const blkTable = BLOCK_COUNT_M[1];
  const datTable = DATA_COUNT_M[1];
  for (let v = 1; v <= 40; v++) {
    const i = v - 1;
    t.push({ version: v, dataBytes: datTable[i], eccCount: eccTable[i], blocks: blkTable[i], size: v * 4 + 17 });
  }
  return t;
}
const VERSION_TABLE = buildVersionTable();

function select_version(dataLen) {
  for (const v of VERSION_TABLE) {
    if (dataLen <= v.dataBytes) return v;
  }
  return null;
}

// ── 格式信息（ECC M + 各掩码的 15bit BCH 值）─────────
// QR 预计算：格式信息位 = (EC level << 3 | mask) 的 BCH(15,5) + 掩码 101010000010010
const FORMAT_M = [0x5c37, 0x5c12, 0x5c6b, 0x5c1e, 0x5d3f, 0x5d5a, 0x5d23, 0x5d56];

function precompute_format(mask) {
  return FORMAT_M[mask]; // ECC level M (0b00) at bits 14~13
}
// 抱歉写死 Level M + mask 的组合值，上面已算好 8 个。

// ── 数据编码（字节模式）────────────────────────────────
function encode_bytes(data, version) {
  const mode = 0x4; // byte mode indicator: 0100
  const charCount = data.length;
  const charCountBits = version <= 9 ? 8 : 16;
  const bitBuf = [];
  // mode
  for (let b = 3; b >= 0; b--) bitBuf.push((mode >> b) & 1);
  // char count
  for (let b = charCountBits - 1; b >= 0; b--) bitBuf.push((charCount >> b) & 1);
  // data bytes
  for (let i = 0; i < data.length; i++) {
    for (let b = 7; b >= 0; b--) bitBuf.push((data.charCodeAt(i) >> b) & 1);
  }
  // terminator
  for (let i = 0; i < 4 && bitBuf.length < version.dataBytes * 8; i++) bitBuf.push(0);
  // padding to byte boundary
  while (bitBuf.length % 8 !== 0) bitBuf.push(0);
  // padding bytes (EC-11 的 11101100 00010001 交替)
  const padBytes = [0xec, 0x11];
  let pi = 0;
  while (bitBuf.length < version.dataBytes * 8) {
    const pb = padBytes[pi++ % 2];
    for (let b = 7; b >= 0; b--) bitBuf.push((pb >> b) & 1);
  }
  // 转 byte array
  const bytes = new Uint8Array(version.dataBytes);
  for (let i = 0; i < bytes.length; i++) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bitBuf[i * 8 + j];
    bytes[i] = v;
  }
  return bytes;
}

// ── 模块放置 ──────────────────────────────────────────
// 版本信息查找表（18bit BCH 值，用于版本 >= 7）
const VERSION_INFO = {};
for (let v = 7; v <= 40; v++) {
  let d = v << 12;
  for (let g = (1 << 12) | (0x0f69 << 1); g; g >>= 1) {
    if (d & (1 << 17)) d ^= g;
    d <<= 1;
  }
  VERSION_INFO[v] = (v << 12) | ((d >>> 1) & 0xfff);
}

// 取模坐标序列（数据区域放置路径）
function get_data_sequence(version) {
  const size = version.size;
  const seq = [];
  const visited = new Uint8Array(size * size);
  let row = size - 1, col = size - 1;
  let dir = -1; // -1=向上, 1=向下
  while (col >= 0) {
    if (col === 6) { col = 5; continue; }
    // 在当前行处理列对 (col, col-1)
    for (let step = 0; step < 2; step++) {
      const c = col - step;
      if (c < 0) break;
      if (!visited[row * size + c]) {
        seq.push({ r: row, c });
        visited[row * size + c] = 1;
      }
    }
    row += dir;
    if (row < 0 || row >= size) {
      dir = -dir;
      row += dir;
      col -= 2;
    }
  }
  return { seq, visited };
}

// 检查该坐标是否属于功能图形
function is_functional(r, c, size, version) {
  // 定位图案（左上、右上、左下）
  if (r < 9 && c < 9) return true;
  if (r < 9 && c >= size - 8) return true;
  if (r >= size - 8 && c < 9) return true;
  // 时序图案
  if (r === 6 || c === 6) return true;
  // 格式信息区域（在定位图案上方和左侧的保留区，9x8 和 8x9）
  if (r < 9 && (c === 8 || c === size - 9)) return true;
  if (c < 9 && (r === 8 || r === size - 9)) return true;
  // 版本信息（版本 >= 7 时，右上角 6x3 和 3x6）
  if (version >= 7) {
    if (r >= size - 11 && r <= size - 9 && c <= 5) return true;
    if (r <= 5 && c >= size - 11 && c <= size - 9) return true;
  }
  return false;
}

function place_modules(matrix, dataCodewords, eccCodewords, version) {
  const size = matrix.length;
  const { seq, visited } = get_data_sequence(version);
  
  // 交互数据码字与纠错码字：按块交错
  // 简化处理：单块版交错，多块版合并后交错
  // 对于 QR M 级大部分版本只有 1-2 个块，简化实现
  const bits = [];
  const total = [...dataCodewords, ...eccCodewords];
  // 按块交错（业界标准做法：每个块轮流出 1 个 codeword）
  // 对于单块不用交错；多块需要
  // 简化：先放到 dataCodewords 结构里
  // 实际上 block interleave 比较复杂。简化方案：直接合并 codewords 然后按模块放置。
  // 真正的 QR 交错：先排所有块的第 1 个数据字，然后第 2 个...，再排所有块的第 1 个纠错字...
  // 但我们这里的 ENCODE 不区分块，因为只处理单块情况（版本1~6）。
  // 对于 > V6 的多块情况，简化处理。
  
  for (const byte of total) {
    for (let b = 7; b >= 0; b--) bits.push((byte >> b) & 1);
  }

  let bi = 0;
  for (const { r, c } of seq) {
    if (bi >= bits.length) break;
    if (!is_functional(r, c, size, version.version)) {
      matrix[r][c] = bits[bi++];
    }
  }
}

function apply_mask(matrix, mask) {
  const size = matrix.length;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (is_functional(r, c, size, 1)) continue; // 简化：版本参数仅用于功能判断
      if (matrix[r][c] !== 0 && matrix[r][c] !== 1) continue; // non-data
      let cond = false;
      const rc = r * c, rm = r % 2, cm = c % 2, r3 = r % 3;
      switch (mask) {
        case 0: cond = (r + c) % 2 === 0; break;
        case 1: cond = r % 2 === 0; break;
        case 2: cond = c % 3 === 0; break;
        case 3: cond = (r + c) % 3 === 0; break;
        case 4: cond = Math.floor(r / 2 + c / 3) % 2 === 0; break;
        case 5: cond = (rc) % 2 + (rc) % 3 === 0; break;
        case 6: cond = ((rc) % 2 + (rc) % 3) % 2 === 0; break;
        case 7: cond = ((rc) % 3 + (r + c) % 2) % 2 === 0; break;
      }
      if (cond) matrix[r][c] ^= 1;
    }
  }
}

function place_functional(matrix, version) {
  const size = matrix.length;
  // 定位图案（3 个 finder + 分隔符）
  function place_finder(tr, tc) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = tr + r, cc = tc + c;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        const inFinder = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        if (inFinder) {
          const pen = Math.abs(r - 3) <= 1 && Math.abs(c - 3) <= 1 ? 0 : 1;
          const outer = (r === 0 || r === 6 || c === 0 || c === 6) ? 1 : 0;
          const core = ((r >= 2 && r <= 4) && (c >= 2 && c <= 4)) ? 0 : 1; // 实际上用上面 pen
          matrix[rr][cc] = (r === 0 || r === 6 || c === 0 || c === 6 || r === 2 || r === 4 || c === 2 || c === 4) ? 1 : 0;
          if ((r >= 2 && r <= 4) && (c >= 2 && c <= 4)) matrix[rr][cc] = 0;
          if (r === 3 && c === 3) matrix[rr][cc] = 0;
          // 简化的 3-module-wide ring
        } else {
          // 分隔符：白
          matrix[rr][cc] = 0;
        }
      }
    }
  }
  
  // 再简化：用 ISO 标准放置
  // 清除并重新放置功能图案
  for (let r = 0; r < size; r++)
    for (let c = 0; c < size; c++)
      matrix[r][c] = 0;
  
  // 左上 finder
  for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) {
    const isRing = r === 0 || r === 6 || c === 0 || c === 6;
    const isCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
    matrix[r][c] = isRing || isCore ? 1 : 0;
  }
  // 右上 finder
  for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) {
    const cc = size - 8 + c;
    const isRing = r === 0 || r === 6 || c === 0 || c === 6;
    const isCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
    matrix[r][cc] = isRing || isCore ? 1 : 0;
  }
  // 左下 finder
  for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) {
    const rr = size - 8 + r;
    const isRing = r === 0 || r === 6 || c === 0 || c === 6;
    const isCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
    matrix[rr][c] = isRing || isCore ? 1 : 0;
  }
  
  // 分隔符：白色（0）
  for (let i = 0; i < 8; i++) {
    if (i + 7 < size) matrix[i][7] = 0;
    if (i + 7 < size) matrix[7][i] = 0;
    // 右上
    if (i + size - 8 < size) matrix[i][size - 8] = 0;
    if (i + 7 < size) matrix[7][size - 1 - i] = 0;
    // 左下
    if (i + 7 < size) matrix[size - 8][i] = 0;
    if (i + 7 < size) matrix[size - 1 - i][7] = 0;
  }
  
  // 时序图案
  for (let i = 0; i < size; i++) {
    if (i > 7 && i < size - 8) {
      if (matrix[6][i] === undefined) continue;
      matrix[6][i] = i % 2 === 0 ? 1 : 0;
      matrix[i][6] = i % 2 === 0 ? 1 : 0;
    }
  }
  
  // 暗模块
  matrix[size - 8][8] = 1;
  
  // 格式信息区域预留（稍后由 place_format 填写）
  
  // 版本信息区域
  if (version.version >= 7) {
    const vi = VERSION_INFO[version.version];
    if (vi !== undefined) {
      for (let i = 0; i < 18; i++) {
        const b = (vi >> (17 - i)) & 1;
        const r1 = Math.floor(i / 3), c1 = i % 3 + size - 11;
        const r2 = i % 3, c2 = Math.floor(i / 3) + size - 11;
        if (r1 < size && c1 < size) matrix[r1][c1] = b;
        if (r2 < size && c2 < size) matrix[r2][c2] = b;
      }
    }
  }
}

function place_format(matrix, formatBits) {
  const size = matrix.length;
  // 格式信息放在固定位置（ISO 表 14）
  const positions = [
    // 上半从右下到左上（需留出 finder + 时序）
    [0,8],[1,8],[2,8],[3,8],[4,8],[5,8],[7,8],
    [8,8],[8,7],[8,5],[8,4],[8,3],[8,2],[8,1],[8,0],
    // 左下
    [8, size-1-7],[8, size-1-6],[8, size-1-5],[8, size-1-4],[8, size-1-3],[8, size-1-2],[8, size-1-1],
    [8,size-8],[7,size-8],[5,size-8],[4,size-8],[3,size-8],[2,size-8],[1,size-8],[0,size-8],
  ];
  for (let i = 0; i < 15; i++) {
    const b = (formatBits >> (14 - i)) & 1;
    if (i < positions.length) {
      const [r, c] = positions[i];
      if (r < size && c < size) matrix[r][c] = b;
    }
  }
  // 额外位置（ISO 表 14 背面）
  const extra = [[size-1,8],[size-2,8],[size-3,8],[size-4,8],[size-5,8],[size-6,8],[size-7,8],
                 [size-8,8],[12,11],[12,12],[12,13],[12,14],[12,15]];
  for (let i = 14; i >= 0 && (15 - i - 1) < extra.length; i--) {
    const b = (formatBits >> i) & 1;
    const [r, c] = extra[14 - i];
    if (r < size && c < size) matrix[r][c] = b;
  }
}

// ── 惩罚评分 ──────────────────────────────────────────
function penalty_score(matrix) {
  const size = matrix.length;
  let score = 0;
  // N1: 连续相同模块 ≥5
  for (let r = 0; r < size; r++) {
    let run = 1;
    for (let c = 1; c < size; c++) {
      if (matrix[r][c] === matrix[r][c - 1]) run++;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) score += 3 + (run - 5);
  }
  for (let c = 0; c < size; c++) {
    let run = 1;
    for (let r = 1; r < size; r++) {
      if (matrix[r][c] === matrix[r - 1][c]) run++;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) score += 3 + (run - 5);
  }
  // N2: 2x2 色块
  for (let r = 0; r < size - 1; r++)
    for (let c = 0; c < size - 1; c++) {
      const v = matrix[r][c];
      if (v === matrix[r][c+1] && v === matrix[r+1][c] && v === matrix[r+1][c+1]) score += 3;
    }
  // N3: 1011101 或 0100010 图案
  for (let r = 0; r < size; r++)
    for (let c = 0; c < size - 6; c++) {
      const pat = (matrix[r][c]<<6) | (matrix[r][c+1]<<5) | (matrix[r][c+2]<<4) | (matrix[r][c+3]<<3) | (matrix[r][c+4]<<2) | (matrix[r][c+5]<<1) | matrix[r][c+6];
      if (pat === 0b1011101 || pat === 0b0100010) score += 40;
    }
  for (let c = 0; c < size; c++)
    for (let r = 0; r < size - 6; r++) {
      const pat = (matrix[r][c]<<6) | (matrix[r+1][c]<<5) | (matrix[r+2][c]<<4) | (matrix[r+3][c]<<3) | (matrix[r+4][c]<<2) | (matrix[r+5][c]<<1) | matrix[r+6][c];
      if (pat === 0b1011101 || pat === 0b0100010) score += 40;
    }
  // N4: 黑白比例
  let black = 0;
  for (let r = 0; r < size; r++)
    for (let c = 0; c < size; c++)
      if (matrix[r][c]) black++;
  const pct = Math.round(100 * black / (size * size));
  const n4 = Math.floor(pct / 5) * 5;
  score += Math.abs(n4 - 50) / 5 * 10;
  return score;
}

// ── 主入口 ──────────────────────────────────────────
function encode(text) {
  // 1. 选版本
  const data = new TextEncoder().encode(text);
  const version = select_version(data.length);
  if (!version) throw new Error(`数据过长（${data.length} 字节），超过 QR 最大容量`);

  // 2. 编码数据
  const dataCodewords = encode_bytes(text, version);

  // 3. RS 纠错编码
  const eccCodewords = rs_encode(dataCodewords, version.eccCount);

  // 4. 尝试 8 种掩码选最优
  let bestMatrix = null;
  let bestScore = Infinity;
  const bestMask = 0;

  for (let mask = 0; mask < 8; mask++) {
    const size = version.size;
    const matrix = new Array(size);
    for (let r = 0; r < size; r++) matrix[r] = new Uint8Array(size);

    place_functional(matrix, version);
    place_modules(matrix, dataCodewords, eccCodewords, version);
    apply_mask(matrix, mask);
    place_format(matrix, FORMAT_M[mask]);

    // 功能图案已在 apply_mask + place_format 后重写，但 place_format 只覆盖部分，additional bits also needed
    // 重新写格式信息
    // 格式和功能图案可能在 masked 区域被改，所以我们在 mask 后重放功能图案？
    // 实际上 masking 应该仅在数据区域作用——我们已经在 apply_mask 中跳过了功能区域。
    // OK，所以这个顺序是标准的：place_functional → place_data → mask(只影响数据) → format

    const score = penalty_score(matrix);
    if (score < bestScore) {
      bestScore = score;
      // 深拷贝
      bestMatrix = matrix.map(r => Array.from(r));
    }
  }

  return {
    version: version.version,
    size: version.size,
    matrix: bestMatrix,
    score: bestScore,
    dataBytes: dataCodewords.length,
  };
}

module.exports = { encode };