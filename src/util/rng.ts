/** Deterministic string -> 32-bit hash (FNV-1a), used to seed per-entity RNGs. */
export function hashString(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32 seeded PRNG — fast, deterministic, good enough for simulation (not crypto). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A reproducible RNG scoped to a free-form key (e.g. `${contactId}:${step}`). */
export function rngFor(key: string): () => number {
  return mulberry32(hashString(key));
}
