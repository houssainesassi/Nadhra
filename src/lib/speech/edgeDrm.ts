// Sec-MS-GEC token for Microsoft Edge's "Read aloud" TTS service.
// Faithful TypeScript port of edge_tts/drm.py (https://github.com/rany2/edge-tts, v7.3.1).
// This file is a derivative of LGPL-3.0 code and is distributed under the LGPL-3.0.
// Microsoft rotates this scheme from time to time; when synthesis starts failing with a refused
// handshake, compare these constants with the latest edge-tts release (tests/edgeDrm vectors).
// Pure functions, no I/O: safe to unit test.

export const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
export const CHROMIUM_FULL_VERSION = "143.0.3650.75";
export const CHROMIUM_MAJOR_VERSION = CHROMIUM_FULL_VERSION.split(".")[0];
export const SEC_MS_GEC_VERSION = `2-${CHROMIUM_FULL_VERSION}`;

const WIN_EPOCH = 11644473600;
const M = 0xffffffff;
const u = (x: number) => x >>> 0; // ToUint32 (exact for |x| < 2^53)
const mul = (a: number, b: number) => Math.imul(a, b) >>> 0; // (a * b) & 0xffffffff
const rotr = (x: number, n: number) => ((x >>> n) | (x << (32 - n))) >>> 0;
const rol16 = (x: number) => (((x & M) << 16) | ((x & M) >>> 16)) >>> 0;

const SHA256_INITIAL = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
const SHA256_STATE = [0xfd9fbea2, 0x91243ce7, 0xbe499094, 0xcd2e1e0a, 0x6c006f49, 0x04bd35ab, 0xfeb0a7e4, 0x03effbd2];
const SHA256_SCHEDULE = [
  0xeb24bf9e, 0x1558691f, 0xa0c09ee2, 0x0cfa32ba, 0xa622ee8c, 0xd1dd9491, 0xc0dd25a0, 0xf9e70ab6, 0xf0c31573, 0x7058ce4e, 0x7188e606,
  0x00e5ab33, 0xd258b060, 0x72766564,
];
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be,
  0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa,
  0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85,
  0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f,
  0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
const SHA256_ADJUSTMENT = 0xc9dc06a7;
const K_BLOCK = [...K.slice(0, 14), SHA256_ADJUSTMENT, ...K.slice(15)];
const SIGMA0_ADJ = 0x059c0b80;
const SIGMA1_ADJ = 0x000b92c0;

const CS64_COEFFICIENTS: [number, number][] = [
  [0xe82e91b1, 0xb32700d0], [0x44de24c6, 0x88dff51d], [0x3beb65bc, 0x29514038], [0xc89c5933, 0xb328cbdf],
  [0x8d1ec211, 0xd405b4d5], [0x314ef5d5, 0x26e55f3c], [0xe92491b1, 0x607801c6], [0xf0a5b9d5, 0x82b2c1fb],
  [0x06064cf3, 0xfa51a3da], [0xda79fa60, 0x207cc464], [0xbed20560, 0x3c3c74f3], [0x89f9c9f8, 0xd2d14b61],
  [0x35fa38c6, 0xbb04a2c1], [0xcb49e3c6, 0xc5626167],
];
const CS64_FACTOR = 0x82893933;
const CS64_ADJ0 = 0xf2f90b1a;
const CS64_ADJ1 = 0x0b1a0000;

const sigma0 = (x: number) => rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
const sigma1 = (x: number) => rotr(x, 17) ^ rotr(x, 19) ^ (x >>> 10);

function rounds(state: number[], w: number[], first = 0): number[] {
  let [a, b, c, d, e, f, g, h] = state;
  const k = first === 14 ? K_BLOCK : K;
  for (let i = first; i < 64; i++) {
    const t1 = h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + u(g ^ (e & (f ^ g))) + k[i] + w[i];
    const t2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + u((a & b) | (c & (a | b)));
    h = g;
    g = f;
    f = e;
    e = u(d + t1);
    d = c;
    c = b;
    b = a;
    a = u(t1 + t2);
  }
  return [a, b, c, d, e, f, g, h];
}

function expand(w: number[], first = 16) {
  for (let i = first; i < 64; i++) w.push(u(sigma1(w[i - 2]) + w[i - 7] + sigma0(w[i - 15]) + w[i - 16]));
}

const be32 = (b: Uint8Array, o: number) => u((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);

function sha256Init(d: Uint8Array): number[] {
  const w = [...Array(14).fill(0), u((d[0] << 16) | (d[1] << 8) | d[2]), be32(d, 3)];
  for (let i = 16; i < 30; i++) {
    let v = SHA256_SCHEDULE[i - 16];
    if (i - 2 >= 14) v += i === 16 ? u(sigma1(w[i - 2]) ^ SIGMA1_ADJ) : sigma1(w[i - 2]);
    if (i - 7 >= 14) v += w[i - 7];
    if (i - 15 >= 14) v += i === 29 ? u(sigma0(w[i - 15]) ^ SIGMA0_ADJ) : sigma0(w[i - 15]);
    w.push(u(v));
  }
  w.push(u(sigma1(w[28]) + w[23] + sigma0(w[15]) + w[14] + SHA256_ADJUSTMENT - K[14]));
  expand(w, 31);
  const working = rounds(SHA256_STATE, w, 14);
  return SHA256_INITIAL.map((x, i) => u(x + working[i]));
}

function sha256Digest(data: Uint8Array): Uint8Array {
  const length = 57 + data.length;
  const pad = (((55 - length) % 64) + 64) % 64;
  const rest = data.subarray(7);
  const padded = new Uint8Array(rest.length + 1 + pad + 8);
  padded.set(rest);
  padded[rest.length] = 0x80;
  new DataView(padded.buffer).setBigUint64(padded.length - 8, BigInt(length * 8));
  let state = sha256Init(data.subarray(0, 7));
  for (let o = 0; o < padded.length; o += 64) {
    const w: number[] = [];
    for (let j = 0; j < 16; j++) w.push(be32(padded, o + j * 4));
    expand(w);
    const working = rounds(state, w);
    state = state.map((x, i) => u(x + working[i]));
  }
  const out = new Uint8Array(32);
  const dv = new DataView(out.buffer);
  state.forEach((x, i) => dv.setUint32(i * 4, x));
  return out;
}

function wordsLe4Even(data: Uint8Array): number[] {
  const len = Math.ceil(data.length / 4) * 4;
  const p = new Uint8Array(len);
  p.set(data);
  const dv = new DataView(p.buffer);
  const words: number[] = [];
  for (let o = 0; o < len; o += 4) words.push(dv.getUint32(o, true));
  if (words.length % 2) words.push(0);
  return words;
}

function cs64Digest(data: Uint8Array, digest: Uint8Array): [number, number] {
  const dv = new DataView(digest.buffer, digest.byteOffset);
  const keyA = u(dv.getUint32(0, true) | 1);
  const keyB = u(dv.getUint32(4, true) | 1);
  const factors = [mul(keyA, CS64_FACTOR), mul(keyB, CS64_FACTOR)];
  const terms = CS64_COEFFICIENTS.map(([c], i) => mul(c, factors[i % 2]));
  const offsets = CS64_COEFFICIENTS.map(([, o]) => o);
  const prefixed = new Uint8Array(data.length + 1);
  prefixed.set(data, 1);
  wordsLe4Even(prefixed).forEach((word, i) => {
    let term = mul(word, i % 2 === 0 ? keyA : keyB);
    let offset = mul(rol16(word), i % 2 === 0 ? 0xef0569fb : 0xc31713db);
    if (i === 0) {
      term = u(term + mul(CS64_ADJ0, factors[0]));
      offset = u(offset + CS64_ADJ1);
    }
    terms.push(term);
    offsets.push(offset);
  });
  let swapAcc = 0;
  let swapLast = 0;
  let state = 0;
  let acc = 0;
  for (let i = 0; i < terms.length; i += 2) {
    const x = terms[i];
    const y = terms[i + 1];
    let t = rol16(u(offsets[i] + x));
    let q = mul(t, 0x76f50f34);
    swapAcc += u(mul(rol16(q), 0xc3efea97) + q);
    t = rol16(u(offsets[i + 1] + y));
    q = mul(t, 0x1881ce3c);
    swapLast = u(mul(rol16(q), 0x35bd1ec9) + q);
    swapAcc = u(swapAcc + swapLast);

    state = u(mul(state, keyA) + x);
    state = mul(rol16(state), 0xcf98b111);
    state = mul(rol16(state), 0x87085b9f);
    state = mul(rol16(state), 0x12ceb96d);
    state = mul(rol16(state), 0x257e1d83);
    acc += state;
    t = u(mul(state, keyB) + y);
    t = mul(rol16(t), 0xa27416f5);
    t = mul(rol16(t), 0xd38396ff);
    state = mul(rol16(mul(rol16(t), 0x7c932b89)), 0xbfa49f69);
    acc = u(acc + state);
  }
  return [u(swapLast ^ state), u(swapAcc ^ acc)];
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("").toUpperCase();

/** Sec-MS-GEC v2 token ("<16 hex>-<64 hex>") for a Unix timestamp in seconds (5-minute windows). */
export function secMsGec(unixSeconds: number = Date.now() / 1000): string {
  const secs = Math.floor(unixSeconds + WIN_EPOCH);
  const ticks = BigInt(secs - (secs % 300)) * 10_000_000n;
  const data = new TextEncoder().encode(`${ticks}${TRUSTED_CLIENT_TOKEN}`);
  const digest = sha256Digest(data);
  const cs = new Uint8Array(8);
  const dv = new DataView(cs.buffer);
  const [lo, hi] = cs64Digest(data, digest);
  dv.setUint32(0, lo, true);
  dv.setUint32(4, hi, true);
  return `${hex(cs)}-${hex(digest)}`;
}
