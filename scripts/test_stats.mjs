// Tests of app/stats.ts (pure statistics of the analyst dashboard).
// Run: node scripts/test_stats.mjs          (Node >= 22.6: TypeScript type stripping, no dependency)
// Optional real-data check: node scripts/test_stats.mjs --greece   (reads public/data/{index,pays}.json)
// Reference values: hand computations and numpy (np.quantile(..., method="median_unbiased") = Hyndman-Fan type 8),
// see scripts/check_stats_numpy.py for the independent Python side of the Greece check.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as S from "../app/stats.ts";

let fails = 0, passes = 0;
const close = (a, b, tol = 1e-9) => (Number.isNaN(a) && Number.isNaN(b)) || Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
function eq(name, got, want, tol) {
  const ok = Array.isArray(want) ? want.every((w, i) => close(got[i], w, tol)) && got.length === want.length : close(got, want, tol);
  if (ok) passes++; else { fails++; console.error(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}

/* HF8 quantiles: values from numpy 2.x, np.quantile(x, p, method="median_unbiased") */
const x10 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
eq("hf8 median n=10", S.quantileHF8(x10, 0.5), 5.5);
eq("hf8 p10 n=10", S.quantileHF8(x10, 0.1), 1.3666666666666667);   // h = (10+1/3)·0.1 + 1/3 = 1.3667
eq("hf8 p25 n=10", S.quantileHF8(x10, 0.25), 2.9166666666666665);
eq("hf8 p90 n=10", S.quantileHF8(x10, 0.9), 9.633333333333333);
const x7 = [0, 3, 3, 10, 40, 41, 900];
eq("hf8 median n=7", S.quantileHF8(x7, 0.5), 10);
eq("hf8 p33 n=7", S.quantileHF8(x7, 1 / 3), 3);
eq("hf8 p75 n=7", S.quantileHF8(x7, 0.75), 40.833333333333336);
eq("hf8 p0.01 clamps", S.quantileHF8(x7, 0.01), 0);
eq("hf8 p0.99 clamps", S.quantileHF8(x7, 0.99), 900);

/* Binomial median CI */
eq("binomCdf(6,23)", S.binomCdf(6, 23), 145499 / 8388608, 1e-12);
const s23 = Array.from({ length: 23 }, (_, i) => (i + 1) * 10);
const ci23 = S.medianCI(s23);
eq("median CI n=23 ranks", [ci23.rankLo, ci23.rankHi], [7, 17]);
eq("median CI n=23 values", [ci23.lo, ci23.hi], [70, 170]);
eq("median CI n=23 coverage", ci23.coverage, 1 - 2 * 145499 / 8388608, 1e-12);
const ci22 = S.medianCI(Array.from({ length: 22 }, (_, i) => i + 1));
eq("median CI n=22 ranks", [ci22.rankLo, ci22.rankHi], [6, 17]);   // P(B<=5)=0.0085, P(B<=6)=0.0262 > .025
const ci10 = S.medianCI(x10);
eq("median CI n=10 ranks", [ci10.rankLo, ci10.rankHi], [2, 9]);     // classic table: n=10 -> x(2), x(9)
eq("median CI n=5 none", S.medianCI([1, 2, 3, 4, 5]) === null ? 1 : 0, 1);

/* Percentile rank and class */
eq("PR", S.percentileRank([1, 2, 2, 3], 2), 50);
eq("PR below all", S.percentileRank([1, 2, 3, 4], 0), 0);
const br = S.bandRank([1, 2, 3, 4], 3.5, 9);
eq("band PR", [br.prLo, br.prHi, br.recordHigh ? 1 : 0], [75, 100, 0]);
eq("band record only if lower bound > max", S.bandRank([1, 2, 3, 4], 4.5, 9).recordHigh ? 1 : 0, 1);

/* Mann-Kendall */
let mk = S.mannKendall([1, 2, 3, 4, 5]);
eq("MK S", mk.S, 10); eq("MK var", mk.varS, 50 / 3); eq("MK z", mk.z, 9 / Math.sqrt(50 / 3)); eq("MK p", mk.p, 0.0274863361115103, 1e-6);
mk = S.mannKendall([1, 2, 2, 3]);                                   // ties: one group of 2
eq("MK ties S", mk.S, 5); eq("MK ties var", mk.varS, (4 * 3 * 13 - 2 * 1 * 9) / 18); eq("MK ties p", mk.p, 0.14856177489186884, 1e-6);
mk = S.mannKendall([5, 5, 5, 5]);
eq("MK constant", [mk.S, mk.z, mk.p], [0, 0, 1]);

/* Sen slope (CI ranks of scipy.stats.theilslopes) */
let sen = S.senSlope([0, 1, 2, 3, 4], [0, 1, 2, 3, 4]);
eq("Sen exact line", [sen.slope, sen.lo, sen.hi, sen.intercept], [1, 1, 1, 0]);
sen = S.senSlope([1, 2, 3, 4, 5, 6], [1, 3, 2, 5, 4, 7]);
// reference: the 15 pairwise slopes computed independently below
const pair = [];
const t6 = [1, 2, 3, 4, 5, 6], y6 = [1, 3, 2, 5, 4, 7];
for (let i = 0; i < 6; i++) for (let j = i + 1; j < 6; j++) pair.push((y6[j] - y6[i]) / (t6[j] - t6[i]));
pair.sort((a, b) => a - b);
eq("Sen slope = median of pair slopes", sen.slope, pair[7]);
// sigma^2 = 6*5*17/18 = 28.333 ; C = 1.96*5.3229 = 10.4326 ; N = 15 -> ru = round(12.716)=13, rl = round(2.284)-1 = 1
eq("Sen CI", [sen.lo, sen.hi], [pair[1], pair[13]]);

/* Spearman with ties, p-value from Student t */
const sp = S.spearman([1, 2, 3, 4, 5], [5, 6, 7, 8, 7]);
eq("Spearman rho ties", sp.rho, 0.8207826816681233, 1e-12);       // scipy.stats.spearmanr -> 0.8207826816681233
eq("Spearman p ties", sp.p, 0.08858700531354381, 1e-6);            // scipy -> 0.0885870053135438
eq("t two-sided p t=2.228 df=10", S.studentTwoSidedP(2.228138851986, 10), 0.05, 1e-6);
eq("normCdf(1.96)", S.normCdf(1.959963984540054), 0.975, 1e-6);
eq("rankAvg", S.rankAvg([10, 20, 20, 5]), [2, 3.5, 3.5, 1]);

/* Summary */
const sm = S.summarize([2, 4, 4, 4, 5, 5, 7, 9]);
eq("mean", sm.mean, 5); eq("sd (n-1)", sm.sd, Math.sqrt(32 / 7)); eq("cv", sm.cv, Math.sqrt(32 / 7) / 5);

/* Grid helpers on a synthetic grid 2002..2026 */
const grid = { y0: 2002, cells: [] };
for (let y = 2002; y <= 2026; y++) {
  const row = [];
  for (let m = 0; m < 12; m++) {
    if (y === 2002 && m < 6) row.push(null);
    else if (y === 2026 && m > 10) row.push(null);
    else row.push({ v: (y - 2000) + (m === 7 ? 100 : 0), partial: y === 2026 && m === 10, converted: y * 12 + m >= 2020 * 12 + 10 });
  }
  grid.cells.push(row);
}
const ap = S.annualPoints(grid);
eq("annual 2002 months", [ap[0].nMonths, ap[0].firstM, ap[0].lastM, ap[0].complete ? 1 : 0], [6, 6, 11, 0]);
eq("annual 2026 months (partial Nov excluded)", [ap[24].nMonths, ap[24].lastM], [10, 9]);
eq("annual rank 2025 = highest", S.annualRank(grid, 2025).rank, 1);
eq("annual rank 2002 none", S.annualRank(grid, 2002) === null ? 1 : 0, 1);
const y26 = S.ytd(grid, 2026, 9);   // Jan..Oct 2026 = 10*26 + 100 = 360 ; baseline years: 10*(y-2000)+100
eq("ytd value", y26.value, 360);
eq("ytd median per-year sums", y26.median, 10 * 14 + 100);          // years 2003..2025 -> median year 2014
eq("ytd n", y26.base.length, 23);
const l12 = S.last12(grid, 2026, 9);   // Nov 2025..Oct 2026
eq("last12 value", l12.value, 2 * 25 + 10 * 26 + 100);
eq("last12 n (windows ending Oct 2004..2025)", l12.base.length, 22);
const tr = S.trend(grid);
eq("trend slope (12 units/yr)", tr.sen.slope, 12);
eq("season peak = Aug", S.season(grid).peak, 7);
eq("anomaly classes", [S.anomalyClass(0, 5), S.anomalyClass(5, 5), S.anomalyClass(20, 5), S.anomalyClass(1.25, 5), S.anomalyClass(3, 0) === null ? -1 : 9], [0, 4, 8, 0, -1]);
eq("anomaly edge 2^0.25 is class 4", S.anomalyClass(5 * 2 ** 0.25, 5), 4);

/* Study period (dashboard filter) on the same grid: v(y, m) = (y − 2000) + 100·[m = Aug] */
const p26 = S.periodSummary(grid, S.mkey(2026, 0), S.mkey(2026, 10));   // Jan..Nov 2026, Nov partial
eq("period counts", [p26.nMonths, p26.nComplete, p26.nPartial, p26.nMissing], [11, 10, 1, 0]);
eq("period total = complete months only", p26.total, 360);
eq("period expected = Σ monthly means 2003-2025", p26.expected, 10 * 14 + 100);
eq("period % of expected", p26.pctExpected, 150);
eq("period window == ytd (median, n, PR)", [p26.window.median, p26.window.base.length, p26.window.pr], [y26.median, y26.base.length, y26.pr]);
const pw = S.periodSummary(grid, S.mkey(2024, 10), S.mkey(2025, 1));   // Nov 2024 .. Feb 2025, across the new year
eq("window across years: total", pw.total, 24 + 24 + 25 + 25);
eq("window across years: n (start 2003..2024, own start 2024 left out)", pw.window.base.length, 21);
eq("window across years: median", pw.window.median, 4 * 13 + 2);
eq("period with months before data", [S.periodSummary(grid, S.mkey(2002, 0), S.mkey(2002, 11)).nMissing, S.periodSummary(grid, S.mkey(2002, 0), S.mkey(2002, 11)).nComplete], [6, 6]);
eq("period > 12 months: no window", S.periodSummary(grid, S.mkey(2010, 0), S.mkey(2012, 5)).window === null ? 1 : 0, 1);
eq("trendIn whole baseline == trend", S.trendIn(grid, S.mkey(2003, 0), S.mkey(2025, 11)).sen.slope, tr.sen.slope);
eq("trendIn 2015-2025 (11 yrs)", [S.trendIn(grid, S.mkey(2015, 0), S.mkey(2025, 11)).sen.slope, S.trendIn(grid, S.mkey(2015, 0), S.mkey(2025, 11)).years.length], [12, 11]);
eq("trendIn < 10 full years -> null", S.trendIn(grid, S.mkey(2018, 3), S.mkey(2026, 10)) === null ? 1 : 0, 1);
eq("period month mean Aug 2020-2022", [S.periodMonthMean(grid, S.mkey(2020, 0), S.mkey(2022, 11), 7).mean, S.periodMonthMean(grid, S.mkey(2020, 0), S.mkey(2022, 11), 7).n], [121, 3]);

/* Real data: Greece (country series) */
if (process.argv.includes("--greece")) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const ix = JSON.parse(fs.readFileSync(path.join(root, "public/data/index.json"), "utf8"));
  const gr = JSON.parse(fs.readFileSync(path.join(root, "public/data/pays.json"), "utf8")).Greece;
  const [oy, om] = ix.mois_index_0.split("-").map(Number), [py, pm] = gr.premier_mois.split("-").map(Number);
  const off = (py - oy) * 12 + (pm - om);
  const last = ix.mois[ix.mois.length - 1];
  const partial = ix.mois_partiel !== undefined ? ix.mois_partiel : (ix.genere_le.slice(0, 7) === last ? last : null);
  const mk2 = (key) => {
    const g = { y0: oy, cells: [] };
    const [ly] = last.split("-").map(Number);
    for (let y = oy; y <= ly; y++) g.cells.push(new Array(12).fill(null));
    gr[key].forEach((v, j) => {
      if (v === null) return;
      const k = (oy * 12 + om - 1) + off + j, y = Math.floor(k / 12), m = k % 12;
      const t = `${y}-${String(m + 1).padStart(2, "0")}`;
      g.cells[y - oy][m] = { v, partial: t === partial, converted: t >= ix.bascule_viirs.slice(0, 7) };
    });
    return g;
  };
  const hot = mk2("hotspots"), frp = mk2("frp_MW");
  const out = {};
  for (const [name, m] of [["Aug", 7], ["Oct", 9]]) {
    const s = S.summarize(S.monthBaseline(hot, m));
    out[name] = { n: s.n, median: s.median, p10: s.p10, p90: s.p90, mean: s.mean, sd: s.sd, ci: [s.medianCI.lo, s.medianCI.hi],
      frpMedian: S.summarize(S.monthBaseline(frp, m)).median };
  }
  out.v2007_08 = S.cellAt(hot, 2007, 7).v;
  out.v2023_08 = S.cellAt(hot, 2023, 7).v;
  out.v2026_10 = S.cellAt(hot, 2026, 9).v;
  out.oct2026_vs_others = S.monthComparison(hot, 2026, 9);
  out.oct_loo_median_n = [S.summarize(S.monthBaseline(hot, 9, 2026)).median, S.monthBaseline(hot, 9, 2026).length];
  out.aug2023_loo = S.monthComparison(hot, 2023, 7);
  const t = S.trend(hot);
  out.trend = { slope: t.sen.slope, lo: t.sen.lo, hi: t.sen.hi, pct: t.pct, S: t.mk.S, z: t.mk.z, p: t.mk.p, n: t.years.length };
  const se = S.season(hot);
  out.season = { peak: se.peak, months: se.months };
  out.ytd2026_oct = (({ value, median, pr }) => ({ value, median, pr }))(S.ytd(hot, 2026, 9));
  out.last12_2026_oct = (({ value, median, pr, base }) => ({ value, median, pr, n: base.length }))(S.last12(hot, 2026, 9));
  out.cell_2002_01 = S.cellAt(hot, 2002, 0);
  out.cell_2026_11 = S.cellAt(hot, 2026, 10);
  console.log(JSON.stringify(out, (k, v) => (k === "base" ? undefined : v), 1));
  if (Math.round(out.v2007_08) !== 1457) { fails++; console.error("FAIL Greece Aug 2007 != 1,457"); }
  if (Math.round(out.v2023_08) !== 827) { fails++; console.error("FAIL Greece Aug 2023 != 827"); }
  if (Math.round(out.v2026_10) !== 71) { fails++; console.error("FAIL Greece Oct 2026 != 71"); }
  // 2026 is not a baseline year: nothing is left out, n = 23 (lead audit 14/11: median 153.0, P10 46.50, P90 518.67, PR 26.1)
  if (Math.round(out.oct_loo_median_n[0]) !== 153 || out.oct_loo_median_n[1] !== 23) { fails++; console.error("FAIL Greece Oct 2026 baseline median != 153 (n=23)"); }
  const o = out.oct2026_vs_others;
  if (Math.abs(o.pr - 26.087) > 0.01 || o.cls !== "below normal" || Math.abs(out.Oct.p10 - 46.5033) > 0.001 || Math.abs(out.Oct.p90 - 518.6667) > 0.001) { fails++; console.error("FAIL Greece Oct 2026 PR/class/P10/P90"); }
  const a = out.aug2023_loo;   // 2023 left out: n = 22, LOO median 137.96, PR 95.5, much above normal
  if (Math.abs(a.median - 137.96) > 1e-6 || a.base.length !== 22 || Math.abs(a.pr - 95.4545) > 0.01 || a.cls !== "much above normal") { fails++; console.error("FAIL Greece Aug 2023 LOO"); }
}

console.log(`${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
