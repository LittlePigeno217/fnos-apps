/**
 * 115网盘助手 FPK —— 115 轻量助手加密算法（p115cipher / p115pickcode 移植）。
 *
 * 与 MoviePilot-Plugins p115liteassistant 所依赖的 p115cipher==0.0.5.4、
 * p115pickcode==0.0.5.4 逐字节一致（见 fpkg/README.md 的移植说明）。全部用
 * Node 内置 crypto + BigInt 实现，零第三方运行时依赖。
 *
 * 注意：RSA 部分不是标准 PKCS#1 v1.5 签名/加密，而是 115 服务端自定义的
 * 「RSA 公钥模幂 + XOR 混淆」payload 方案（见 rsa_encrypt / rsa_decrypt）。
 */

"use strict";

const crypto = require("node:crypto");

// ───── p115cipher 常量 ─────
// RSA 公钥 (n, e)，与 p115cipher.util.RSA_PUBKEY_PAIR 相同
const RSA_N = BigInt(
  "0x8686980c0f5a24c4b9d43020cd2c22703ff3f450756529058b1cf88f09b8602136477198a6e2683149659bd122c33592fdb5ad47944ad1ea4d36c6b172aad6338c3bb6ac6227502d010993ac967d1aef00f0c8e038de2e4d3bc2ec368af2e9f10a6f1eda4f7262f136420c07c331b871bf139f74f3010e3c4fe57df3afb71683"
);
const RSA_E = 0x10001n;

const RSA_KEY = Buffer.from([0x8d, 0xa5, 0xa5, 0x8d]);
const RSA_RAND_KEY = Buffer.alloc(16, 0);

// G_key_l：12 字节密钥 (p115cipher G_key_l)
const G_key_l = Buffer.from([0x78, 0x06, 0xad, 0x4c, 0x33, 0x86, 0x5d, 0x18, 0x4c, 0x01, 0x3f, 0x46]);

// G_kts：128 字节查表 (p115cipher.util.G_kts)
const G_kts = Buffer.from([
  0xf0, 0xe5, 0x69, 0xae, 0xbf, 0xdc, 0xbf, 0x8a, 0x1a, 0x45, 0xe8, 0xbe, 0x7d, 0xa6, 0x73, 0xb8,
  0xde, 0x8f, 0xe7, 0xc4, 0x45, 0xda, 0x86, 0xc4, 0x9b, 0x64, 0x8b, 0x14, 0x6a, 0xb4, 0xf1, 0xaa,
  0x38, 0x01, 0x35, 0x9e, 0x26, 0x69, 0x2c, 0x86, 0x00, 0x6b, 0x4f, 0xa5, 0x36, 0x34, 0x62, 0xa6,
  0x2a, 0x96, 0x68, 0x18, 0xf2, 0x4a, 0xfd, 0xbd, 0x6b, 0x97, 0x8f, 0x4d, 0x8f, 0x89, 0x13, 0xb7,
  0x6c, 0x8e, 0x93, 0xed, 0x0e, 0x0d, 0x48, 0x3e, 0xd7, 0x2f, 0x88, 0xd8, 0xfe, 0xfe, 0x7e, 0x86,
  0x50, 0x95, 0x4f, 0xd1, 0xeb, 0x83, 0x26, 0x34, 0xdb, 0x66, 0x7b, 0x9c, 0x7e, 0x9d, 0x7a, 0x81,
  0x32, 0xea, 0xb6, 0x33, 0xde, 0x3a, 0xa9, 0x59, 0x34, 0x66, 0x3b, 0xaa, 0xba, 0x81, 0x60, 0x48,
  0xb9, 0xd5, 0x81, 0x9c, 0xf8, 0x6c, 0x84, 0x77, 0xff, 0x54, 0x78, 0x26, 0x5f, 0xbe, 0xe8, 0x1e,
  0x36, 0x9f, 0x34, 0x80, 0x5c, 0x45, 0x2c, 0x9b, 0x76, 0xd5, 0x1b, 0x8f, 0xcc, 0xc3, 0xb8, 0xf5,
]);

// ───── 工具函数 ─────

/** 把 Buffer 转为 BigInt（大端） */
function bytesToBigInt(buf) {
  return BigInt("0x" + buf.toString("hex"));
}

/** 把 BigInt 转成大端 Buffer，长度不足前补零（padLen 指定目标长度） */
function bigIntToBytes(value, padLen) {
  let hex = value.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  let out = Buffer.from(hex, "hex");
  if (out.length < padLen) {
    out = Buffer.concat([Buffer.alloc(padLen - out.length), out]);
  }
  return out;
}

/**
 * xor：把 src 与 key 按「大端逐位异或、分段」的方式混合。
 * 与 p115cipher.util.xor 一致：
 *   先处理 len(src) mod 4 的前缀（与 key 前 4 字节按大端 int XOR 取低位），
 *   再按 key 长度分段整体异或。
 */
function xor(src, key) {
  const s = Buffer.from(src);
  const k = Buffer.from(key);
  const secret = Buffer.alloc(s.length);
  let i = 0;

  const head = s.length & 0b11;
  if (head) {
    // bytes_xor(src[0:head], key[0:head], head, 'big') →
    // int(src[0:head]) ^ int(key[0:head]) 的大端还原
    const sx = bytesToBigInt(s.subarray(0, head));
    const kx = bytesToBigInt(k.subarray(0, head));
    bigIntToBytes(sx ^ kx, head).copy(secret, 0);
    i = head;
  }

  const keyLen = k.length;
  while (i < s.length) {
    const take = Math.min(keyLen, s.length - i);
    const sx = bytesToBigInt(s.subarray(i, i + take));
    const kx = bytesToBigInt(k.subarray(0, take));
    bigIntToBytes(sx ^ kx, take).copy(secret, i);
    i += keyLen;
  }
  return secret;
}

/**
 * rsa_gen_key：从 rand_key（4 字节）推出 XOR 密钥。
 * 与 p115cipher.util.rsa_gen_key 一致。
 */
function rsa_gen_key(randKey, skLen = 4) {
  const xorKey = Buffer.alloc(skLen);
  let length = skLen * (skLen - 1);
  let index = 0;
  for (let i = 0; i < skLen; i++) {
    const x = (randKey[i] + G_kts[index]) & 0xff;
    xorKey[i] = G_kts[length] ^ x;
    length -= skLen;
    index += skLen;
  }
  return xorKey;
}

/**
 * 快速模幂（BigInt）：base^exp mod mod。
 * 不能直接用 `base ** exp % mod`——exp=65537 时 BigInt 幂产生超长整数，耗时数秒；
 * Python 版 pow(m, e, n) 是内置快速模幂（亚毫秒），这里对齐其性能。
 */
function modPow(base, exp, mod) {
  let result = 1n;
  base %= mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * base) % mod;
    base = (base * base) % mod;
    e >>= 1n;
  }
  return result;
}

/**
 * rsa_encrypt_with_pubkey：把数据按 117 字节一块，用 PKCS#1 v1.5 风格 padding
 * 后做 RSA 模幂，输出 128 字节单位密文。与 p115cipher.util.rsa_encrypt_with_pubkey 一致。
 */
function rsaEncryptWithPubkey(data) {
  const view = Buffer.from(data);
  const out = [];
  for (let i = 0; i < view.length; i += 117) {
    const chunk = view.subarray(i, i + 117);
    // pad_pkcs1_v1_5: b"\x00" + b"\x02"*(126-n) + b"\x00" + chunk
    const padLen = 126 - chunk.length;
    const padded = Buffer.alloc(1 + padLen + 1 + chunk.length);
    let p = 0;
    padded[p++] = 0x00;
    for (let j = 0; j < padLen; j++) padded[p++] = 0x02;
    padded[p++] = 0x00;
    chunk.copy(padded, p);
    const m = bytesToBigInt(padded);
    const c = modPow(m, RSA_E, RSA_N);
    out.push(bigIntToBytes(c, 128));
  }
  return Buffer.concat(out);
}

/**
 * rsa_decrypt_with_pubkey：128 字节一块做 RSA 模幂，剥掉 PKCS#1 v1.5 头部。
 * 与 p115cipher.util.rsa_decrypt_with_pubkey 一致。
 */
function rsaDecryptWithPubkey(cipherData) {
  const view = Buffer.from(cipherData);
  const out = [];
  for (let i = 0; i < view.length; i += 128) {
    const chunk = view.subarray(i, i + 128);
    const c = bytesToBigInt(chunk);
    const m = modPow(c, RSA_E, RSA_N);
    const b = bigIntToBytes(m, Math.ceil(m.toString(16).length / 2));
    const firstZero = b.indexOf(0);
    out.push(b.subarray(firstZero + 1));
  }
  return Buffer.concat(out);
}

/**
 * rsa_encrypt：公开入口。
 *   tmp = xor(data, key)[::-1]
 *   xor_data = rand_key + xor(tmp, G_key_l)
 *   return base64(rsa_encrypt_with_pubkey(xor_data))
 */
function rsaEncrypt(data, randKey = RSA_RAND_KEY) {
  const key = randKey === RSA_RAND_KEY ? RSA_KEY : rsa_gen_key(randKey);
  const tmp = Buffer.from(xor(data, key)).reverse();
  const xorData = Buffer.concat([Buffer.from(randKey), xor(tmp, G_key_l)]);
  return rsaEncryptWithPubkey(xorData).toString("base64");
}

/**
 * rsa_decrypt：公开入口（解密 rsa_encrypt 的结果）。
 *   data = rsa_decrypt_with_pubkey(b64decode(cipher))
 *   randkey = data[:16]; key_l = rsa_gen_key(randkey, 12)
 *   tmp = xor(data[16:], key_l)[::-1]
 *   return xor(tmp, key)
 */
function rsaDecrypt(cipherData, randKey = RSA_RAND_KEY) {
  const key = randKey === RSA_RAND_KEY ? RSA_KEY : rsa_gen_key(randKey);
  const data = rsaDecryptWithPubkey(Buffer.from(cipherData, "base64"));
  const randkey = data.subarray(0, 16);
  const keyL = rsa_gen_key(randkey, 12);
  const tmp = Buffer.from(xor(data.subarray(16), keyL)).reverse();
  return xor(tmp, key);
}

// ───── p115pickcode 常量与表 ─────

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

// 前缀 → 把密文字符映射回明文字符（PREFIX_TO_TRANSTAB_REV 的字符映射方向）
// 每个表：str.maketrans("密文字符串", ALPHABET) 的反向映射，即 密文 char → 明文 char
const PREFIX_TO_REV = {
  a: _rev("fuln1ytpj3smg8d5a094qh7cxkbi62zvewro"),
  b: _rev("sk721n9a0emlfpcrzbqdw3gjh6ty5xui48vo"),
  c: _rev("ywcz3hite6f1j0guoakvdb2ns7p8qr9ml5x4"),
  d: _rev("rq2vl5o7wsken9u8tp4jg3zbyc6xmhifd01a"),
  e: _rev("ljm9eqbcfhw7ktv3x1dgp5ua8y6s4znr2io0"),
  fa: _rev("fumk0ytpj3sng8d5a194qh7cxlbi62zvewro"),
  fb: _rev("sk732o9a1enmfpcrzbqdw4gjh6ty5xui08vl"),
  fc: _rev("ywcz6hite9f4j3gup2kvdb5osal0qr1nm8x7"),
  fd: _rev("on6vl0r2wpkeq9u3ts8jg7zbyc1xmhifd45a"),
  fe: _rev("ljm0es2cfhwakqv6x4dgp8r1by9u7znt5io3"),
};

function _rev(cipherChars) {
  const map = {};
  for (let i = 0; i < cipherChars.length; i++) {
    map[cipherChars[i]] = ALPHABET[i];
  }
  return map;
}

/** 36 进制字符串 → 整数 */
function b36decode(s) {
  let n = 0;
  for (const ch of String(s)) {
    n = n * 36 + ALPHABET.indexOf(ch);
  }
  return n;
}

/**
 * pickcode_to_id：从 115 的 pickcode 解出文件/目录 id。
 * 与 p115pickcode.pickcode_to_id 一致：
 *   前缀（首字符，若是 f 则前 2 字符）+ 中缀 + 后缀(最后 4 字符)
 *   中缀为加密的 36 进制 id，用前缀对应表反向翻译后按 36 进制解析。
 */
function pickcodeToId(pickcode) {
  const s = String(pickcode || "");
  if (!s) return 0;
  let prefix, cipher;
  if (s.startsWith("f")) {
    prefix = s.slice(0, 2);
    cipher = s.slice(2, -4);
  } else {
    prefix = s.slice(0, 1);
    cipher = s.slice(1, -4);
  }
  const table = PREFIX_TO_REV[prefix];
  if (!table) {
    throw new Error(`未知的 pickcode 前缀: ${prefix}`);
  }
  let plain = "";
  for (const ch of cipher) {
    plain += table[ch] !== undefined ? table[ch] : ch;
  }
  return b36decode(plain);
}

/** to_id：pickcode 或数字 id 一律转成 id。与 p115pickcode.to_id 一致。 */
function toId(pickcode) {
  if (typeof pickcode === "number") return pickcode;
  const s = String(pickcode || "");
  if (!s) return 0;
  if (/^[a-f]/.test(s)) return pickcodeToId(s);
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error(`无效的 115 id: ${s}`);
  return n;
}

module.exports = {
  rsa_encrypt: rsaEncrypt,
  rsa_decrypt: rsaDecrypt,
  rsaEncrypt,
  rsaDecrypt,
  rsa_gen_key,
  pickcodeToId,
  toId,
  ALPHABET,
  PREFIX_TO_REV,
};