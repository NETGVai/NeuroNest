/**
 * F8_GPU_Bandwidth_Table — static GPU-name → memory-bandwidth (GB/s) lookup.
 *
 * Lets the Model_Ranker estimate inference throughput (which is dominated by
 * memory bandwidth for token generation) without running a live benchmark.
 *
 * Design: see `.kiro/specs/efficiency-improvements/design.md`
 * (Feature 8: Hardware_Fit_Cookbook → F8_GPU_Bandwidth_Table).
 *
 * Validates: Requirement 43
 *
 * Lookup semantics: `lookupBandwidth` lowercases the input GPU name and
 * returns the value of the most specific table key that appears as a
 * substring of the name. "Most specific" is resolved by matching keys in
 * order of descending length (ties broken alphabetically), so a `4080 super`
 * card resolves to the `'4080 super'` entry rather than the shorter `'4080'`
 * prefix. This length-ordered scan is used instead of plain object-key
 * iteration because JavaScript reorders integer-like keys (`'5090'`, `'4080'`)
 * numerically ahead of insertion order, which would otherwise let a less
 * specific key win. Unknown GPUs return `0`; the function never throws.
 */

/**
 * GPU name substring (lowercase) → published memory bandwidth in GB/s.
 *
 * Values for the design's representative entries come straight from
 * design.md; the remaining series members are filled from published
 * manufacturer/spec bandwidth figures. `lookupBandwidth` resolves matches by
 * descending key length (see the module docstring), so declaration order here
 * is for human readability only and does not affect lookup results.
 */
export const GPU_BANDWIDTH: Record<string, number> = {
  // ── NVIDIA datacenter ────────────────────────────────────────────────
  h200: 4800,
  h100: 2039,
  a100: 1555,
  l40s: 864,
  l40: 864,

  // ── NVIDIA RTX 50 series (Blackwell) ─────────────────────────────────
  '5090': 1792,
  '5080': 960,
  '5070 ti': 896,
  '5070': 672,
  '5060 ti': 448,
  '5060': 448,

  // ── NVIDIA RTX 40 series (Ada Lovelace) ──────────────────────────────
  '4090': 1008,
  '4080 super': 736,
  '4080': 717,
  '4070 ti super': 672,
  '4070 ti': 504,
  '4070 super': 504,
  '4070': 504,
  '4060 ti': 288,
  '4060': 272,

  // ── NVIDIA RTX 30 series (Ampere) ────────────────────────────────────
  '3090 ti': 1008,
  '3090': 936,
  '3080 ti': 912,
  '3080': 760,
  '3070 ti': 608,
  '3070': 448,
  '3060 ti': 448,
  '3060': 360,

  // ── NVIDIA RTX 20 series (Turing) ────────────────────────────────────
  '2080 ti': 616,
  '2080 super': 496,
  '2080': 448,
  '2070 super': 448,
  '2070': 448,
  '2060 super': 448,
  '2060': 336,

  // ── AMD Radeon RX 9000 series (RDNA 4) ───────────────────────────────
  '9070 xt': 640,
  '9070': 640,

  // ── AMD Radeon RX 7000 series (RDNA 3) ───────────────────────────────
  '7900 xtx': 960,
  '7900 xt': 800,
  '7900 gre': 576,

  // ── AMD Radeon RX 6000 series (RDNA 2) ───────────────────────────────
  '6900 xt': 512,
  '6800 xt': 512,
  '6800': 512,

  // ── AMD Instinct (CDNA datacenter) ───────────────────────────────────
  mi300: 5300,
  mi250: 3277,

  // ── Apple Silicon M1 ─────────────────────────────────────────────────
  'm1 ultra': 800,
  'm1 max': 400,
  'm1 pro': 200,
  m1: 68,

  // ── Apple Silicon M2 ─────────────────────────────────────────────────
  'm2 ultra': 800,
  'm2 max': 400,
  'm2 pro': 200,
  m2: 100,

  // ── Apple Silicon M3 ─────────────────────────────────────────────────
  'm3 ultra': 800,
  'm3 max': 400,
  'm3 pro': 150,
  m3: 100,

  // ── Apple Silicon M4 ─────────────────────────────────────────────────
  'm4 max': 546,
  'm4 pro': 273,
  m4: 120,

  // ── Apple Silicon M5 ─────────────────────────────────────────────────
  'm5 max': 546,
  'm5 pro': 273,
  m5: 150,
};

/**
 * Look up the memory bandwidth (GB/s) for a GPU by name.
 *
 * The lookup is case-insensitive and substring-based. Among all table keys
 * that are contained in the lowercased `gpuName`, the longest (most specific)
 * key wins, with alphabetical order as a deterministic tie-break. Returns `0`
 * when no key matches or when `gpuName` is not a usable string. Never throws.
 */
export function lookupBandwidth(gpuName: string): number {
  if (typeof gpuName !== 'string' || gpuName.length === 0) {
    return 0;
  }
  const name = gpuName.toLowerCase();
  const keys = Object.keys(GPU_BANDWIDTH).sort((a, b) =>
    b.length - a.length || (a < b ? -1 : a > b ? 1 : 0),
  );
  for (const key of keys) {
    if (name.includes(key)) {
      return GPU_BANDWIDTH[key];
    }
  }
  return 0;
}
