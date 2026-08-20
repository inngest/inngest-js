/**
 * Produces span IDs identical to the Go executor's
 * `DeterministicSpanConfig(seed).SpanID` in `pkg/tracing/tracer.go`.
 *
 * Algorithm: SHA-256 the seed, interpret the 32-byte digest as a ChaCha8
 * key, then read 24 bytes from Go's `chacha8rand` PRNG
 * (https://c2sp.org/chacha8rand) — 16 bytes for TraceID (discarded) plus
 * 8 bytes for SpanID (returned).  This is the 3rd uint64 in the
 * interleaved output buffer (buf[2] = word 1 from blocks 0 and 1).
 *
 * Uses `hash.js` for SHA-256 (same as the rest of the SDK) so it works in
 * Node, browsers, and edge runtimes without `node:crypto`.
 */
import hashjs from "hash.js";

const { sha256 } = hashjs;

/**
 * Compute a deterministic 8-byte span ID from an arbitrary seed string,
 * byte-for-byte compatible with Go's `DeterministicSpanConfig(seed).SpanID`.
 *
 * Returns the span ID as a 16-character hex string (the format OTel uses).
 */
export function deterministicSpanID(seed: string): string {
  const hash = sha256().update(seed).digest(); // number[]
  const third = chacha8randThirdUint64(hash);
  return uint64ToLEHex(third);
}

// ---------------------------------------------------------------------------
// chacha8rand – Go's math/rand/v2.ChaCha8 PRNG (3rd uint64)
// ---------------------------------------------------------------------------

/**
 * Compute blocks 0 and 1 (counters 0,1) and return the 3rd uint64 (buf[2])
 * of the interleaved output buffer.  This matches `DeterministicSpanConfig.SpanID`
 * which reads 16 bytes (TraceID = buf[0..1]) then 8 bytes (SpanID = buf[2]).
 *
 * The chacha8rand interleaved layout is:
 *   buf[2*i]   = block0[i] | block1[i] << 32
 *   buf[2*i+1] = block2[i] | block3[i] << 32
 * So buf[2] = buf[2*1] = block0[1] | block1[1] << 32 = s1 from both blocks.
 */
function chacha8randThirdUint64(key: number[]): bigint {
  // Interpret 32-byte key as 4 little-endian uint64 → 8 uint32 words.
  const k = new Uint32Array(8);
  for (let i = 0; i < 8; i++) {
    k[i] =
      (key[i * 4]! |
        (key[i * 4 + 1]! << 8) |
        (key[i * 4 + 2]! << 16) |
        (key[i * 4 + 3]! << 24)) >>>
      0;
  }

  // We only need block-column 0 (counter = 0) to get the first uint64.
  // Initial state: [constants | key | counter=0 | nonce=0]
  let s0 = 0x61707865;
  let s1 = 0x3320646e;
  let s2 = 0x79622d32;
  let s3 = 0x6b206574;
  let s4 = k[0]!;
  let s5 = k[1]!;
  let s6 = k[2]!;
  let s7 = k[3]!;
  let s8 = k[4]!;
  let s9 = k[5]!;
  let s10 = k[6]!;
  let s11 = k[7]!;
  let s12 = 0; // counter
  let s13 = 0; // nonce
  let s14 = 0;
  let s15 = 0;

  // Save key words for partial addition later (positions 4-11).
  const ok4 = s4,
    ok5 = s5,
    ok6 = s6,
    ok7 = s7;
  const ok8 = s8,
    ok9 = s9,
    ok10 = s10,
    ok11 = s11;

  // 4 double-rounds = 8 quarter-round rounds (ChaCha8).
  for (let i = 0; i < 4; i++) {
    // Column rounds
    s0 = (s0 + s4) >>> 0;
    s12 ^= s0;
    s12 = ((s12 << 16) | (s12 >>> 16)) >>> 0;
    s8 = (s8 + s12) >>> 0;
    s4 ^= s8;
    s4 = ((s4 << 12) | (s4 >>> 20)) >>> 0;
    s0 = (s0 + s4) >>> 0;
    s12 ^= s0;
    s12 = ((s12 << 8) | (s12 >>> 24)) >>> 0;
    s8 = (s8 + s12) >>> 0;
    s4 ^= s8;
    s4 = ((s4 << 7) | (s4 >>> 25)) >>> 0;

    s1 = (s1 + s5) >>> 0;
    s13 ^= s1;
    s13 = ((s13 << 16) | (s13 >>> 16)) >>> 0;
    s9 = (s9 + s13) >>> 0;
    s5 ^= s9;
    s5 = ((s5 << 12) | (s5 >>> 20)) >>> 0;
    s1 = (s1 + s5) >>> 0;
    s13 ^= s1;
    s13 = ((s13 << 8) | (s13 >>> 24)) >>> 0;
    s9 = (s9 + s13) >>> 0;
    s5 ^= s9;
    s5 = ((s5 << 7) | (s5 >>> 25)) >>> 0;

    s2 = (s2 + s6) >>> 0;
    s14 ^= s2;
    s14 = ((s14 << 16) | (s14 >>> 16)) >>> 0;
    s10 = (s10 + s14) >>> 0;
    s6 ^= s10;
    s6 = ((s6 << 12) | (s6 >>> 20)) >>> 0;
    s2 = (s2 + s6) >>> 0;
    s14 ^= s2;
    s14 = ((s14 << 8) | (s14 >>> 24)) >>> 0;
    s10 = (s10 + s14) >>> 0;
    s6 ^= s10;
    s6 = ((s6 << 7) | (s6 >>> 25)) >>> 0;

    s3 = (s3 + s7) >>> 0;
    s15 ^= s3;
    s15 = ((s15 << 16) | (s15 >>> 16)) >>> 0;
    s11 = (s11 + s15) >>> 0;
    s7 ^= s11;
    s7 = ((s7 << 12) | (s7 >>> 20)) >>> 0;
    s3 = (s3 + s7) >>> 0;
    s15 ^= s3;
    s15 = ((s15 << 8) | (s15 >>> 24)) >>> 0;
    s11 = (s11 + s15) >>> 0;
    s7 ^= s11;
    s7 = ((s7 << 7) | (s7 >>> 25)) >>> 0;

    // Diagonal rounds
    s0 = (s0 + s5) >>> 0;
    s15 ^= s0;
    s15 = ((s15 << 16) | (s15 >>> 16)) >>> 0;
    s10 = (s10 + s15) >>> 0;
    s5 ^= s10;
    s5 = ((s5 << 12) | (s5 >>> 20)) >>> 0;
    s0 = (s0 + s5) >>> 0;
    s15 ^= s0;
    s15 = ((s15 << 8) | (s15 >>> 24)) >>> 0;
    s10 = (s10 + s15) >>> 0;
    s5 ^= s10;
    s5 = ((s5 << 7) | (s5 >>> 25)) >>> 0;

    s1 = (s1 + s6) >>> 0;
    s12 ^= s1;
    s12 = ((s12 << 16) | (s12 >>> 16)) >>> 0;
    s11 = (s11 + s12) >>> 0;
    s6 ^= s11;
    s6 = ((s6 << 12) | (s6 >>> 20)) >>> 0;
    s1 = (s1 + s6) >>> 0;
    s12 ^= s1;
    s12 = ((s12 << 8) | (s12 >>> 24)) >>> 0;
    s11 = (s11 + s12) >>> 0;
    s6 ^= s11;
    s6 = ((s6 << 7) | (s6 >>> 25)) >>> 0;

    s2 = (s2 + s7) >>> 0;
    s13 ^= s2;
    s13 = ((s13 << 16) | (s13 >>> 16)) >>> 0;
    s8 = (s8 + s13) >>> 0;
    s7 ^= s8;
    s7 = ((s7 << 12) | (s7 >>> 20)) >>> 0;
    s2 = (s2 + s7) >>> 0;
    s13 ^= s2;
    s13 = ((s13 << 8) | (s13 >>> 24)) >>> 0;
    s8 = (s8 + s13) >>> 0;
    s7 ^= s8;
    s7 = ((s7 << 7) | (s7 >>> 25)) >>> 0;

    s3 = (s3 + s4) >>> 0;
    s14 ^= s3;
    s14 = ((s14 << 16) | (s14 >>> 16)) >>> 0;
    s9 = (s9 + s14) >>> 0;
    s4 ^= s9;
    s4 = ((s4 << 12) | (s4 >>> 20)) >>> 0;
    s3 = (s3 + s4) >>> 0;
    s14 ^= s3;
    s14 = ((s14 << 8) | (s14 >>> 24)) >>> 0;
    s9 = (s9 + s14) >>> 0;
    s4 ^= s9;
    s4 = ((s4 << 7) | (s4 >>> 25)) >>> 0;
  }

  // Partial addition: only key positions (4-11) get the original added back.
  s4 = (s4 + ok4) >>> 0;
  s5 = (s5 + ok5) >>> 0;
  s6 = (s6 + ok6) >>> 0;
  s7 = (s7 + ok7) >>> 0;
  s8 = (s8 + ok8) >>> 0;
  s9 = (s9 + ok9) >>> 0;
  s10 = (s10 + ok10) >>> 0;
  s11 = (s11 + ok11) >>> 0;

  // The chacha8rand interleaved output layout is:
  //   buf[2*i]   = block0[i] | block1[i] << 32    (blocks 0,1)
  //   buf[2*i+1] = block2[i] | block3[i] << 32    (blocks 2,3)
  //
  // DeterministicSpanConfig reads 16 bytes (TraceID = buf[0..1]) then
  // 8 bytes (SpanID = buf[2]).  buf[2] = buf[2*1] = block0[1] | block1[1] << 32.
  // So the SpanID uses state word index 1 (s1) from both blocks.
  // s1 is a constants position (no addition in chacha8rand).
  const hi = chacha8randColumn1Row1(k);

  return BigInt(s1 >>> 0) | (BigInt(hi >>> 0) << 32n);
}

/**
 * Run chacha8rand for column 1 (counter = 1) and return row 1 (s1).
 */
function chacha8randColumn1Row1(k: Uint32Array): number {
  let s0 = 0x61707865;
  let s1 = 0x3320646e;
  let s2 = 0x79622d32;
  let s3 = 0x6b206574;
  let s4 = k[0]!;
  let s5 = k[1]!;
  let s6 = k[2]!;
  let s7 = k[3]!;
  let s8 = k[4]!;
  let s9 = k[5]!;
  let s10 = k[6]!;
  let s11 = k[7]!;
  let s12 = 1; // counter = 1
  let s13 = 0;
  let s14 = 0;
  let s15 = 0;

  for (let i = 0; i < 4; i++) {
    // Column rounds
    s0 = (s0 + s4) >>> 0;
    s12 ^= s0;
    s12 = ((s12 << 16) | (s12 >>> 16)) >>> 0;
    s8 = (s8 + s12) >>> 0;
    s4 ^= s8;
    s4 = ((s4 << 12) | (s4 >>> 20)) >>> 0;
    s0 = (s0 + s4) >>> 0;
    s12 ^= s0;
    s12 = ((s12 << 8) | (s12 >>> 24)) >>> 0;
    s8 = (s8 + s12) >>> 0;
    s4 ^= s8;
    s4 = ((s4 << 7) | (s4 >>> 25)) >>> 0;

    s1 = (s1 + s5) >>> 0;
    s13 ^= s1;
    s13 = ((s13 << 16) | (s13 >>> 16)) >>> 0;
    s9 = (s9 + s13) >>> 0;
    s5 ^= s9;
    s5 = ((s5 << 12) | (s5 >>> 20)) >>> 0;
    s1 = (s1 + s5) >>> 0;
    s13 ^= s1;
    s13 = ((s13 << 8) | (s13 >>> 24)) >>> 0;
    s9 = (s9 + s13) >>> 0;
    s5 ^= s9;
    s5 = ((s5 << 7) | (s5 >>> 25)) >>> 0;

    s2 = (s2 + s6) >>> 0;
    s14 ^= s2;
    s14 = ((s14 << 16) | (s14 >>> 16)) >>> 0;
    s10 = (s10 + s14) >>> 0;
    s6 ^= s10;
    s6 = ((s6 << 12) | (s6 >>> 20)) >>> 0;
    s2 = (s2 + s6) >>> 0;
    s14 ^= s2;
    s14 = ((s14 << 8) | (s14 >>> 24)) >>> 0;
    s10 = (s10 + s14) >>> 0;
    s6 ^= s10;
    s6 = ((s6 << 7) | (s6 >>> 25)) >>> 0;

    s3 = (s3 + s7) >>> 0;
    s15 ^= s3;
    s15 = ((s15 << 16) | (s15 >>> 16)) >>> 0;
    s11 = (s11 + s15) >>> 0;
    s7 ^= s11;
    s7 = ((s7 << 12) | (s7 >>> 20)) >>> 0;
    s3 = (s3 + s7) >>> 0;
    s15 ^= s3;
    s15 = ((s15 << 8) | (s15 >>> 24)) >>> 0;
    s11 = (s11 + s15) >>> 0;
    s7 ^= s11;
    s7 = ((s7 << 7) | (s7 >>> 25)) >>> 0;

    // Diagonal rounds
    s0 = (s0 + s5) >>> 0;
    s15 ^= s0;
    s15 = ((s15 << 16) | (s15 >>> 16)) >>> 0;
    s10 = (s10 + s15) >>> 0;
    s5 ^= s10;
    s5 = ((s5 << 12) | (s5 >>> 20)) >>> 0;
    s0 = (s0 + s5) >>> 0;
    s15 ^= s0;
    s15 = ((s15 << 8) | (s15 >>> 24)) >>> 0;
    s10 = (s10 + s15) >>> 0;
    s5 ^= s10;
    s5 = ((s5 << 7) | (s5 >>> 25)) >>> 0;

    s1 = (s1 + s6) >>> 0;
    s12 ^= s1;
    s12 = ((s12 << 16) | (s12 >>> 16)) >>> 0;
    s11 = (s11 + s12) >>> 0;
    s6 ^= s11;
    s6 = ((s6 << 12) | (s6 >>> 20)) >>> 0;
    s1 = (s1 + s6) >>> 0;
    s12 ^= s1;
    s12 = ((s12 << 8) | (s12 >>> 24)) >>> 0;
    s11 = (s11 + s12) >>> 0;
    s6 ^= s11;
    s6 = ((s6 << 7) | (s6 >>> 25)) >>> 0;

    s2 = (s2 + s7) >>> 0;
    s13 ^= s2;
    s13 = ((s13 << 16) | (s13 >>> 16)) >>> 0;
    s8 = (s8 + s13) >>> 0;
    s7 ^= s8;
    s7 = ((s7 << 12) | (s7 >>> 20)) >>> 0;
    s2 = (s2 + s7) >>> 0;
    s13 ^= s2;
    s13 = ((s13 << 8) | (s13 >>> 24)) >>> 0;
    s8 = (s8 + s13) >>> 0;
    s7 ^= s8;
    s7 = ((s7 << 7) | (s7 >>> 25)) >>> 0;

    s3 = (s3 + s4) >>> 0;
    s14 ^= s3;
    s14 = ((s14 << 16) | (s14 >>> 16)) >>> 0;
    s9 = (s9 + s14) >>> 0;
    s4 ^= s9;
    s4 = ((s4 << 12) | (s4 >>> 20)) >>> 0;
    s3 = (s3 + s4) >>> 0;
    s14 ^= s3;
    s14 = ((s14 << 8) | (s14 >>> 24)) >>> 0;
    s9 = (s9 + s14) >>> 0;
    s4 ^= s9;
    s4 = ((s4 << 7) | (s4 >>> 25)) >>> 0;
  }

  // No addition for row 1 (constants row in chacha8rand).
  return s1;
}

/** Convert a uint64 bigint to a 16-char little-endian hex string. */
function uint64ToLEHex(v: bigint): string {
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += (Number((v >> BigInt(i * 8)) & 0xffn) | 0x100).toString(16).slice(1);
  }
  return out;
}
