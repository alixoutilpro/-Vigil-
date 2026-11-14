/**
 * Pure statistics of the analyst dashboard (no React, no I/O, no imports): every number shown in
 * app/DeepDive.tsx comes from here. Rules of docs/contrat_donnees_v2.md §4–5:
 *  - baseline = complete calendar years 2003–2025 (2002 starts in July with Aqua, the current month is partial);
 *  - quantiles = Hyndman–Fan type 8 (numpy method="median_unbiased");
 *  - percentile rank PR = 100·(b + 0.5·e)/n, b = baseline values below x, e = equal, the year of x left out;
 *  - the series of a zone is summed over its hexagons BEFORE any statistic (done in app/zone.ts);
 *  - no band is ever summed: months share the same conversion coefficient k, their errors are correlated, so a
 *    multi-month or annual total has NO valid band here.
 * Checked by scripts/test_stats.mjs (hand values + numpy) — run `node scripts/test_stats.mjs`.
 * Written with erasable TypeScript only, so Node ≥ 22.6 can run it directly (type stripping).
 */

export const BASE_Y0 = 2003;
export const BASE_Y1 = 2025;

/* ── Order statistics ─────────────────────────────────────────────────── */

/** Ascending copy (never sorts the caller's array in place). */
export function sortAsc(xs: readonly number[]): number[] {
  return [...xs].sort((a, b) => a - b);
}

/**
 * Hyndman–Fan type 8 quantile of an ASCENDING array (median-unbiased whatever the distribution).
 * 1-based position h = (n + 1/3)·p + 1/3 (= n·p + (p+1)/3), x(h) = x(⌊h⌋) + (h − ⌊h⌋)·(x(⌊h⌋+1) − x(⌊h⌋)),
 * clamped to [x(1), x(n)]. Same formula as quantileHF8 of app/zone.ts.
 */
export function quantileHF8(sorted: readonly number[], p: number): number {
  const n = sorted.length;
  if (!n) return NaN;
  const h = (n + 1 / 3) * p + 1 / 3;
  if (h <= 1) return sorted[0];
  if (h >= n) return sorted[n - 1];
  const j = Math.floor(h);
  return sorted[j - 1] + (h - j) * (sorted[j] - sorted[j - 1]);
}

/** Binomial CDF P(B ≤ k), B ~ Binomial(n, p), by exact recursion of the pmf (n ≤ a few hundred). */
export function binomCdf(k: number, n: number, p = 0.5): number {
  if (k < 0) return 0;
  if (k >= n) return 1;
  let pmf = Math.pow(1 - p, n), s = pmf;
  for (let i = 0; i < k; i++) {
    pmf *= ((n - i) / (i + 1)) * (p / (1 - p));
    s += pmf;
  }
  return Math.min(1, s);
}

export interface MedianCI {
  lo: number; hi: number;
  /** 1-based order statistics used: lo = x(rankLo), hi = x(rankHi). */
  rankLo: number; rankHi: number;
  /** Exact coverage 1 − 2·P(B ≤ rankLo − 1), B ~ Binomial(n, ½) (≥ the nominal level). */
  coverage: number;
}

/**
 * Distribution-free confidence interval of the median: [x(k), x(n−k+1)] with k the LARGEST integer such that
 * P(B ≤ k−1) ≤ α/2, B ~ Binomial(n, ½). Conservative (coverage ≥ conf). n = 23, 95 % → [x(7), x(17)], 96.5 %.
 * Returns null when n is too small for the level (n ≤ 5 at 95 %).
 */
export function medianCI(sorted: readonly number[], conf = 0.95): MedianCI | null {
  const n = sorted.length, a2 = (1 - conf) / 2;
  let k = 0;
  while (k + 1 <= Math.floor((n + 1) / 2) && binomCdf(k, n) <= a2) k++; // binomCdf(k) = P(B ≤ (k+1) − 1)
  if (k < 1) return null;
  return { lo: sorted[k - 1], hi: sorted[n - k], rankLo: k, rankHi: n - k + 1, coverage: 1 - 2 * binomCdf(k - 1, n) };
}

export interface BandRank {
  /** PR of the lower and upper 80 % bounds against the SAME baseline as the value. */
  prLo: number; prHi: number;
  /** Record high only if the LOWER bound exceeds the baseline maximum; record low only if the UPPER bound is below its minimum. */
  recordHigh: boolean; recordLow: boolean;
}
/**
 * Uncertainty of a percentile rank for a converted month (lead audit 14/11, verdict 4): the rank of the band bounds
 * against the same leave-one-out baseline. PR is monotone in x, so [prLo, prHi] brackets every value of the band.
 */
export function bandRank(base: readonly number[], lo: number, hi: number): BandRank | null {
  if (!base.length) return null;
  let mn = Infinity, mx = -Infinity;
  for (const v of base) { if (v < mn) mn = v; if (v > mx) mx = v; }
  return { prLo: percentileRank(base, lo), prHi: percentileRank(base, hi), recordHigh: lo > mx, recordLow: hi < mn };
}

/** Percentile rank of x in a baseline: PR = 100·(b + 0.5·e)/n (b below, e equal). NaN on an empty baseline. */
export function percentileRank(base: readonly number[], x: number): number {
  if (!base.length) return NaN;
  let b = 0, e = 0;
  for (const v of base) { if (v < x) b++; else if (v === x) e++; }
  return (100 * (b + 0.5 * e)) / base.length;
}

export const CLASS_NAMES = ["much below normal", "below normal", "near normal", "above normal", "much above normal"] as const;
export type ClassName = (typeof CLASS_NAMES)[number];

/** 5 classes of the contract: < P10 · P10–P33 · P33–P67 · P67–P90 · > P90 (HF8 of the ascending baseline). Same cut as statMois. */
export function normalClass(x: number, sortedBase: readonly number[]): ClassName {
  const q = (p: number) => quantileHF8(sortedBase, p);
  const i = x < q(0.1) ? 0 : x < q(1 / 3) ? 1 : x <= q(2 / 3) ? 2 : x <= q(0.9) ? 3 : 4;
  return CLASS_NAMES[i];
}

export interface Summary {
  n: number;
  min: number; p10: number; q1: number; median: number; q3: number; p90: number; max: number;
  /** IQR = Q3 − Q1 (robust spread). */
  iqr: number;
  mean: number;
  /** Sample standard deviation (n − 1). */
  sd: number;
  /** Coefficient of variation sd / mean (null when mean = 0). */
  cv: number | null;
  medianCI: MedianCI | null;
}

/** Descriptive summary of a sample (HF8 quantiles, sample sd, binomial median CI). null if empty. */
export function summarize(values: readonly number[]): Summary | null {
  const n = values.length;
  if (!n) return null;
  const s = sortAsc(values);
  const q = (p: number) => quantileHF8(s, p);
  const mean = s.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : NaN;
  const q1 = q(0.25), q3 = q(0.75);
  return {
    n, min: s[0], p10: q(0.1), q1, median: q(0.5), q3, p90: q(0.9), max: s[n - 1], iqr: q3 - q1,
    mean, sd, cv: mean !== 0 ? sd / mean : null, medianCI: medianCI(s),
  };
}

/* ── Distributions ────────────────────────────────────────────────────── */

/** Standard normal CDF Φ(z) (erfc by Numerical Recipes' Chebyshev fit, |error| < 1.2e-7). */
export function normCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.5 * x);
  const erfc = t * Math.exp(-x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 +
    t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return z >= 0 ? 1 - erfc / 2 : erfc / 2;
}
/** z of the two-sided 95 % level, Φ⁻¹(0.975). */
export const Z975 = 1.959963984540054;

function lnGamma(x: number): number {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const ci of c) ser += ci / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}
function betacf(a: number, b: number, x: number): number {
  const EPS = 3e-14, FPMIN = 1e-300;
  let c = 1, d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}
/** Regularized incomplete beta I_x(a, b). */
export function betaInc(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}
/** Two-sided p-value of a Student t statistic with df degrees of freedom: I_{df/(df+t²)}(df/2, ½). */
export function studentTwoSidedP(t: number, df: number): number {
  return betaInc(df / 2, 0.5, df / (df + t * t));
}

/* ── Trend: Mann–Kendall and Sen's slope ──────────────────────────────── */

/** Sizes of the groups of tied values (only groups of size ≥ 2). */
function tieGroups(xs: readonly number[]): number[] {
  const m = new Map<number, number>();
  for (const v of xs) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m.values()].filter((k) => k > 1);
}
const tieTerm = (g: number[]) => g.reduce((a, k) => a + k * (k - 1) * (2 * k + 5), 0);

export interface MannKendall { n: number; S: number; varS: number; z: number; p: number }

/**
 * Mann–Kendall trend test (series in time order). S = Σ_{i<j} sign(y_j − y_i);
 * Var(S) = [n(n−1)(2n+5) − Σ_t t(t−1)(2t+5)]/18 (t = sizes of tied groups);
 * Z = (S − sign(S))/√Var(S) (continuity correction); two-sided p = 2·(1 − Φ(|Z|)).
 * Assumes independent years (no autocorrelation correction).
 */
export function mannKendall(y: readonly number[]): MannKendall | null {
  const n = y.length;
  if (n < 3) return null;
  let S = 0;
  for (let i = 0; i < n - 1; i++) for (let j = i + 1; j < n; j++) S += Math.sign(y[j] - y[i]);
  const varS = (n * (n - 1) * (2 * n + 5) - tieTerm(tieGroups(y))) / 18;
  const z = varS > 0 ? (S > 0 ? (S - 1) / Math.sqrt(varS) : S < 0 ? (S + 1) / Math.sqrt(varS) : 0) : 0;
  return { n, S, varS, z, p: Math.min(1, 2 * (1 - normCdf(Math.abs(z)))) };
}

/** numpy-style rounding (half to even), so the CI ranks match scipy.stats.theilslopes exactly. */
function roundHalfEven(x: number): number {
  const f = Math.floor(x), d = x - f;
  if (Math.abs(d - 0.5) > 1e-9) return Math.round(x);
  return f % 2 === 0 ? f : f + 1;
}

export interface SenSlope { slope: number; lo: number; hi: number; intercept: number; nSlopes: number }

/**
 * Theil–Sen slope = median of the pairwise slopes (y_j − y_i)/(t_j − t_i), t_j > t_i.
 * Confidence interval of Sen (1968, eq. 2.6), as in scipy.stats.theilslopes:
 * σ² = [n(n−1)(2n+5) − Σ ties in t − Σ ties in y]/18, C = z·σ, N = number of slopes,
 * lo = slope[round((N − C)/2) − 1], hi = slope[round((N + C)/2)] (0-based, ascending; numpy rounding).
 * Intercept = median(y) − slope·median(t).
 */
export function senSlope(t: readonly number[], y: readonly number[], conf = 0.95): SenSlope | null {
  const n = y.length;
  if (n < 3 || t.length !== n) return null;
  const slopes: number[] = [];
  for (let i = 0; i < n - 1; i++) for (let j = i + 1; j < n; j++) if (t[j] !== t[i]) slopes.push((y[j] - y[i]) / (t[j] - t[i]));
  if (!slopes.length) return null;
  slopes.sort((a, b) => a - b);
  const N = slopes.length;
  const slope = quantileMid(slopes);
  const z = conf === 0.95 ? Z975 : invNorm(1 - (1 - conf) / 2);
  const sig = Math.sqrt((n * (n - 1) * (2 * n + 5) - tieTerm(tieGroups(t)) - tieTerm(tieGroups(y))) / 18);
  const ru = Math.min(roundHalfEven((N + z * sig) / 2), N - 1);
  const rl = Math.max(roundHalfEven((N - z * sig) / 2) - 1, 0);
  const intercept = quantileMid(sortAsc(y)) - slope * quantileMid(sortAsc(t));
  return { slope, lo: slopes[rl], hi: slopes[ru], intercept, nSlopes: N };
}
/** Plain median of an ascending array (mean of the two middle values when n is even). */
function quantileMid(s: readonly number[]): number {
  const n = s.length, h = Math.floor(n / 2);
  return n % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}
/** Φ⁻¹ by bisection (only used for a non-default confidence level). */
function invNorm(p: number): number {
  let lo = -10, hi = 10;
  for (let i = 0; i < 100; i++) { const mid = (lo + hi) / 2; if (normCdf(mid) < p) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}

/* ── Spearman rank correlation ─────────────────────────────────────────── */

/** Average ranks (1-based), ties share the mean of their ranks. */
export function rankAvg(xs: readonly number[]): number[] {
  const idx = xs.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const r = new Array<number>(xs.length);
  for (let a = 0; a < idx.length;) {
    let b = a;
    while (b + 1 < idx.length && idx[b + 1].v === idx[a].v) b++;
    const rr = (a + b) / 2 + 1;
    for (let k = a; k <= b; k++) r[idx[k].i] = rr;
    a = b + 1;
  }
  return r;
}

export interface Spearman { rho: number; n: number; p: number }

/**
 * Spearman ρ = Pearson correlation of the average ranks (exact with ties). p-value: t = ρ·√((n−2)/(1−ρ²)),
 * Student t with n − 2 df, two-sided (same approximation as scipy.stats.spearmanr). Assumes independent pairs.
 */
export function spearman(x: readonly number[], y: readonly number[]): Spearman | null {
  const n = x.length;
  if (n < 4 || y.length !== n) return null;
  const rx = rankAvg(x), ry = rankAvg(y);
  const mx = rx.reduce((a, b) => a + b, 0) / n, my = ry.reduce((a, b) => a + b, 0) / n;
  let c = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) { c += (rx[i] - mx) * (ry[i] - my); vx += (rx[i] - mx) ** 2; vy += (ry[i] - my) ** 2; }
  if (!vx || !vy) return null;
  const rho = c / Math.sqrt(vx * vy);
  const p = Math.abs(rho) >= 1 ? 0 : studentTwoSidedP(rho * Math.sqrt((n - 2) / (1 - rho * rho)), n - 2);
  return { rho, n, p };
}

/* ── Monthly grid of a zone ───────────────────────────────────────────── */

/** One month of a zone for ONE metric. null in the grid = month not exported (no data). */
export interface GridCell { v: number; partial: boolean; converted: boolean }
/** cells[y − y0][m], m = 0..11. */
export interface Grid { y0: number; cells: (GridCell | null)[][] }

export function cellAt(g: Grid, y: number, m: number): GridCell | null {
  return g.cells[y - g.y0]?.[m] ?? null;
}
/** Value of a complete month (non-null, non-partial), else null. */
export function completeValue(g: Grid, y: number, m: number): number | null {
  const c = cellAt(g, y, m);
  return c && !c.partial ? c.v : null;
}

/** Values of calendar month m over the baseline years 2003–2025 (complete months only), optionally without one year. */
export function monthBaseline(g: Grid, m: number, excludeYear?: number): number[] {
  const out: number[] = [];
  for (let y = BASE_Y0; y <= BASE_Y1; y++) {
    if (y === excludeYear) continue;
    const v = completeValue(g, y, m);
    if (v !== null) out.push(v);
  }
  return out;
}

/** Sum of months m0..m1 of year y if they are ALL complete, else null. */
export function sumMonths(g: Grid, y: number, m0: number, m1: number): number | null {
  let s = 0;
  for (let m = m0; m <= m1; m++) { const v = completeValue(g, y, m); if (v === null) return null; s += v; }
  return s;
}

export interface AnnualPoint {
  y: number;
  /** Sum of the complete months of the year (no extrapolation). null if none. */
  total: number | null;
  /** True when the 12 months are complete. */
  complete: boolean;
  /** Complete months summed (e.g. "Jul–Dec" for 2002). */
  nMonths: number; firstM: number; lastM: number;
}
export function annualPoints(g: Grid): AnnualPoint[] {
  return g.cells.map((row, i) => {
    let s = 0, k = 0, f = -1, l = -1;
    row.forEach((c, m) => { if (c && !c.partial) { s += c.v; k++; if (f < 0) f = m; l = m; } });
    return { y: g.y0 + i, total: k ? s : null, complete: k === 12, nMonths: k, firstM: f, lastM: l };
  });
}
/** Annual totals of the baseline years (complete years only), with their years. */
export function annualBaseline(g: Grid): { years: number[]; totals: number[] } {
  const years: number[] = [], totals: number[] = [];
  for (const a of annualPoints(g)) if (a.y >= BASE_Y0 && a.y <= BASE_Y1 && a.complete && a.total !== null) { years.push(a.y); totals.push(a.total); }
  return { years, totals };
}
/** Rank of a year's total among the baseline years (1 = highest; ties share the best rank). */
export function annualRank(g: Grid, y: number): { rank: number; n: number } | null {
  const { years, totals } = annualBaseline(g);
  const i = years.indexOf(y);
  if (i < 0) return null;
  return { rank: 1 + totals.filter((v) => v > totals[i]).length, n: totals.length };
}

export interface Comparison {
  value: number;
  /** Baseline values (one per year), the compared year excluded. */
  base: number[];
  median: number;
  pctMedian: number | null;
  pr: number;
  cls: ClassName;
}
function compare(value: number, base: number[]): Comparison | null {
  if (base.length < 10) return null;
  const s = sortAsc(base), med = quantileHF8(s, 0.5);
  return { value, base, median: med, pctMedian: med > 0 ? (100 * value) / med : null, pr: percentileRank(s, value), cls: normalClass(value, s) };
}

/**
 * Year-to-date: Jan..m of year y (all complete) vs the same months of each baseline year, summed PER YEAR,
 * then the median of those sums (never a sum of monthly medians). The year y is left out of its own baseline.
 */
export function ytd(g: Grid, y: number, m: number): Comparison | null {
  const v = sumMonths(g, y, 0, m);
  if (v === null) return null;
  const base: number[] = [];
  for (let a = BASE_Y0; a <= BASE_Y1; a++) { if (a === y) continue; const s = sumMonths(g, a, 0, m); if (s !== null) base.push(s); }
  return compare(v, base);
}

/** Total of the 12 months ending at (y, m), all complete; null otherwise. */
export function sum12(g: Grid, y: number, m: number): number | null {
  let s = 0;
  for (let k = 0; k < 12; k++) {
    const t = y * 12 + m - k, v = completeValue(g, Math.floor(t / 12), t % 12);
    if (v === null) return null;
    s += v;
  }
  return s;
}
/**
 * Last 12 complete months ending at (y, m) vs the 12-month totals ending at the SAME calendar month in the
 * baseline (windows entirely inside 2003-01 … 2025-12, so the same season is compared and windows do not overlap);
 * the window ending at (y, m) itself is left out.
 */
export function last12(g: Grid, y: number, m: number): Comparison | null {
  const v = sum12(g, y, m);
  if (v === null) return null;
  const base: number[] = [];
  for (let a = BASE_Y0; a <= BASE_Y1; a++) {
    if (a === y || a * 12 + m - 11 < BASE_Y0 * 12) continue;
    const s = sum12(g, a, m);
    if (s !== null) base.push(s);
  }
  return compare(v, base);
}

/** Focus month vs the same month of the other baseline years (identical to statMois of app/zone.ts). */
export function monthComparison(g: Grid, y: number, m: number): Comparison | null {
  const v = completeValue(g, y, m);
  return v === null ? null : compare(v, monthBaseline(g, m, y));
}

export interface Season {
  /** Median and mean of each calendar month over the baseline. */
  medians: number[]; means: number[];
  /** argmax of the monthly median (first month on ties). */
  peak: number;
  /** Months whose mean ≥ 10 % of the mean annual total Σ_m mean_m (Giglio et al. 2006). */
  months: number[];
  /** Number of baseline years used per month (min over months). */
  n: number;
}
export function season(g: Grid): Season | null {
  const medians: number[] = [], means: number[] = [];
  let n = Infinity;
  for (let m = 0; m < 12; m++) {
    const b = monthBaseline(g, m);
    if (b.length < 10) return null;
    n = Math.min(n, b.length);
    medians.push(quantileHF8(sortAsc(b), 0.5));
    means.push(b.reduce((a, x) => a + x, 0) / b.length);
  }
  const tot = means.reduce((a, b) => a + b, 0);
  let peak = 0;
  medians.forEach((v, i) => { if (v > medians[peak]) peak = i; });
  return { medians, means, peak, months: tot > 0 ? means.map((v, i) => (v >= 0.1 * tot ? i : -1)).filter((i) => i >= 0) : [], n };
}

export interface Trend {
  years: number[]; totals: number[];
  sen: SenSlope; mk: MannKendall;
  /** Median annual total (HF8) used to express the slope in %/yr. */
  medianTotal: number;
  /** 100·slope/median annual total, and its CI. null when the median is 0. */
  pct: number | null; pctLo: number | null; pctHi: number | null;
}
/** Sen's slope and Mann–Kendall on the annual totals of the complete baseline years (≥ 10 years). */
export function trend(g: Grid): Trend | null {
  const { years, totals } = annualBaseline(g);
  if (years.length < 10) return null;
  const sen = senSlope(years, totals), mk = mannKendall(totals);
  if (!sen || !mk) return null;
  const med = quantileHF8(sortAsc(totals), 0.5);
  const pc = (v: number) => (med > 0 ? (100 * v) / med : null);
  return { years, totals, sen, mk, medianTotal: med, pct: pc(sen.slope), pctLo: pc(sen.lo), pctHi: pc(sen.hi) };
}

/** Mean FRP per detection Σ FRP / hotspots of a complete month (null when hotspots = 0 or incomplete). */
export function intensityAt(hot: Grid, frp: Grid, y: number, m: number): number | null {
  const h = completeValue(hot, y, m), f = completeValue(frp, y, m);
  return h !== null && f !== null && h > 0 ? f / h : null;
}
/** Grid of the monthly intensity (MW / detection); months with 0 detection are null (undefined ratio). */
export function intensityGrid(hot: Grid, frp: Grid): Grid {
  return {
    y0: hot.y0,
    cells: hot.cells.map((row, i) => row.map((c, m) => {
      const f = frp.cells[i]?.[m];
      if (!c || !f || c.v <= 0) return null;
      return { v: f.v / c.v, partial: c.partial || f.partial, converted: c.converted };
    })),
  };
}

/* ── Study period (dashboard filter) ──────────────────────────────────── */

/** Month key k = 12·y + m (m = 0..11). */
export const mkey = (y: number, m: number) => y * 12 + m;
export const ofKey = (k: number) => ({ y: Math.floor(k / 12), m: ((k % 12) + 12) % 12 });

export interface PeriodSummary {
  /** First and last month keys of the period (inclusive). */
  k0: number; k1: number;
  /** Months of the period: total, complete (summed), partial (left out), without data (left out). */
  nMonths: number; nComplete: number; nPartial: number; nMissing: number;
  /** Sum of the complete months of the period. */
  total: number;
  /**
   * Climatological expectation of that same set of months: Σ over the complete months of the period of the MEAN of
   * their calendar month over the baseline 2003–2025. The mean is additive (E[Σ] = Σ E), the median is not, so this
   * is the right "normal" for a total of any length. null if a calendar month has fewer than 10 baseline years.
   */
  expected: number | null;
  /** 100·total / expected. */
  pctExpected: number | null;
  /**
   * Same-window comparison, only when the complete months span ≤ 12 consecutive months: the same calendar months,
   * at the same offsets, summed PER baseline year, then median HF8 / PR / class of those sums (the period's own
   * starting year left out; windows entirely inside 2003–2025). Exactly ytd() for a Jan..m period.
   */
  window: Comparison | null;
}

/**
 * Summary of the study period [k0, k1] for one metric. Only complete months are summed (a partial month is never
 * added to complete ones; months without data are not zeros). No band: monthly errors are correlated (same k).
 */
export function periodSummary(g: Grid, k0: number, k1: number): PeriodSummary {
  const comp: { y: number; m: number; v: number }[] = [];
  let nPartial = 0, nMissing = 0;
  for (let k = k0; k <= k1; k++) {
    const { y, m } = ofKey(k), c = cellAt(g, y, m);
    if (!c) nMissing++;
    else if (c.partial) nPartial++;
    else comp.push({ y, m, v: c.v });
  }
  const total = comp.reduce((a, c) => a + c.v, 0);
  let expected: number | null = comp.length ? 0 : null;
  const meanOf = new Map<number, number | null>();
  for (const c of comp) {
    if (!meanOf.has(c.m)) { const b = monthBaseline(g, c.m); meanOf.set(c.m, b.length >= 10 ? b.reduce((a, x) => a + x, 0) / b.length : null); }
    const mu = meanOf.get(c.m)!;
    expected = expected === null || mu === null ? null : expected + mu;
  }
  let window: Comparison | null = null;
  if (comp.length) {
    const first = mkey(comp[0].y, comp[0].m), last = mkey(comp[comp.length - 1].y, comp[comp.length - 1].m);
    if (last - first <= 11) {
      const y0 = comp[0].y, offs = comp.map((c) => ({ dy: c.y - y0, m: c.m }));
      const dyMax = Math.max(...offs.map((o) => o.dy));
      const base: number[] = [];
      for (let a = BASE_Y0; a + dyMax <= BASE_Y1; a++) {
        if (a === y0) continue;
        let s = 0, ok = true;
        for (const o of offs) { const v = completeValue(g, a + o.dy, o.m); if (v === null) { ok = false; break; } s += v; }
        if (ok) base.push(s);
      }
      window = compare(total, base);
    }
  }
  return {
    k0, k1, nMonths: k1 - k0 + 1, nComplete: comp.length, nPartial, nMissing, total,
    expected, pctExpected: expected !== null && expected > 0 ? (100 * total) / expected : null, window,
  };
}

/** Calendar years entirely inside [k0, k1] whose 12 months are complete (for a trend over the period). */
export function fullYearsIn(g: Grid, k0: number, k1: number): { years: number[]; totals: number[] } {
  const years: number[] = [], totals: number[] = [];
  for (const a of annualPoints(g)) if (a.complete && a.total !== null && mkey(a.y, 0) >= k0 && mkey(a.y, 11) <= k1) { years.push(a.y); totals.push(a.total); }
  return { years, totals };
}
/** Theil–Sen + Mann–Kendall on the complete calendar years inside the period (≥ 10 years), in % of their median. */
export function trendIn(g: Grid, k0: number, k1: number): Trend | null {
  const { years, totals } = fullYearsIn(g, k0, k1);
  if (years.length < 10) return null;
  const sen = senSlope(years, totals), mk = mannKendall(totals);
  if (!sen || !mk) return null;
  const med = quantileHF8(sortAsc(totals), 0.5);
  const pc = (v: number) => (med > 0 ? (100 * v) / med : null);
  return { years, totals, sen, mk, medianTotal: med, pct: pc(sen.slope), pctLo: pc(sen.lo), pctHi: pc(sen.hi) };
}

/** Mean of calendar month m over the complete months of the period (n = years used). */
export function periodMonthMean(g: Grid, k0: number, k1: number, m: number): { mean: number; n: number } | null {
  const v: number[] = [];
  for (let k = k0; k <= k1; k++) { const d = ofKey(k); if (d.m === m) { const x = completeValue(g, d.y, m); if (x !== null) v.push(x); } }
  return v.length ? { mean: v.reduce((a, b) => a + b, 0) / v.length, n: v.length } : null;
}

/* ── Anomaly classes of the calendar ───────────────────────────────────── */

/** Edges (log2 of x/median) of the 9 diverging classes: centres −2, −1.5, …, +2 (¼× … 4×), clipped at ±2. */
export const ANOMALY_EDGES = [-1.75, -1.25, -0.75, -0.25, 0.25, 0.75, 1.25, 1.75];
/**
 * Anomaly class of x against the median of its month: 0..8 (4 = within ±0.25 in log2, i.e. 0.84×–1.19× the median),
 * 0 also for x = 0 with median > 0; null when the median is 0 (ratio undefined).
 */
export function anomalyClass(x: number, med: number): number | null {
  if (!(med > 0)) return null;
  if (x <= 0) return 0;
  const l = Math.log2(x / med);
  let c = 0;
  while (c < ANOMALY_EDGES.length && l > ANOMALY_EDGES[c]) c++;
  return c;
}

/* ── Weather anomalies (de-seasonalised) ──────────────────────────────── */

/**
 * De-seasonalised anomaly: value minus the median (HF8) of the same calendar month over the given years.
 * Removes the shared seasonal cycle that would otherwise dominate any correlation between monthly series.
 */
export function deseasonalize(rows: { y: number; m: number; v: number }[], baseY0 = BASE_Y0, baseY1 = BASE_Y1): Map<string, number> {
  const per: number[][] = Array.from({ length: 12 }, () => []);
  for (const r of rows) if (r.y >= baseY0 && r.y <= baseY1) per[r.m].push(r.v);
  const med = per.map((b) => (b.length ? quantileHF8(sortAsc(b), 0.5) : NaN));
  const out = new Map<string, number>();
  for (const r of rows) if (!isNaN(med[r.m])) out.set(`${r.y}-${r.m}`, r.v - med[r.m]);
  return out;
}
