/**
 * Analyst dashboard data: monthly grids of a zone (shared with app/DeepDive.tsx, so the screen and the export can
 * never disagree) and the CSV export of the whole dashboard for a zone and a study period.
 *
 * CSV layout (one file, several tables): lines starting with "#" are comments; each table starts with a line
 * "# [table_name]" followed by its header row, and ends with an empty line. Decimal point ".", no thousands
 * separator, empty field = not available. pandas: split the file on the "# [" lines, or read one table with
 * pd.read_csv(f, skiprows=…, nrows=…). Every value is computed by app/stats.ts (tested by scripts/test_stats.mjs).
 */
import { cleMois, indiceMois, moisPartiel, texteMois, type IndexV2 } from "./donnees";
import type { Metrique, MoisZone, SerieZone } from "./zone";
import * as S from "./stats";

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export type Grids = { hot: S.Grid; frp: S.Grid; inten: S.Grid };

/** Grids of the whole export range (null = month not exported = no data, never 0). */
export function gridsOf(index: IndexV2, serie: SerieZone): Grids {
  const Y0 = cleMois(index.mois[0]).y, Y1 = cleMois(index.mois[index.mois.length - 1]).y;
  const mk = (k: Metrique): S.Grid => ({
    y0: Y0,
    cells: Array.from({ length: Y1 - Y0 + 1 }, (_, i) => Array.from({ length: 12 }, (_, m) => {
      const c = serie.mois[indiceMois(index, Y0 + i, m)];
      return c ? { v: c[k], partial: c.partiel, converted: c.converti } : null;
    })),
  });
  const hot = mk("hotspots"), frp = mk("frp");
  return { hot, frp, inten: S.intensityGrid(hot, frp) };
}

/** Focus month of a period: the last COMPLETE month ≤ its end (a partial month is never the reference). */
export function focusOf(g: S.Grid, k0: number, k1: number): { y: number; m: number } {
  for (let k = k1; k >= k0; k--) { const d = S.ofKey(k); if (S.completeValue(g, d.y, d.m) !== null) return d; }
  return S.ofKey(k1);
}

/* ── CSV formatting ───────────────────────────────────────────────────── */

/** Number with ≤ 4 decimals (trailing zeros removed), "" when not available. */
function n(x: number | null | undefined, d = 4): string {
  if (x === null || x === undefined || !isFinite(x)) return "";
  const r = Number(x.toFixed(d));
  return Object.is(r, -0) ? "0" : String(r);
}
function q(s: string | number | null | undefined): string {
  if (s === null || s === undefined) return "";
  const t = String(s);
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}
const line = (xs: (string | number | null | undefined)[]) => xs.map((x) => (typeof x === "number" ? n(x) : q(x))).join(",");

export interface DashboardExport {
  index: IndexV2;
  serie: SerieZone;
  title: string;
  zoneNote: string;
  /** Study period, month keys 12·y + m (inclusive). */
  k0: number; k1: number;
  /** Focus month shown on screen. */
  focus: { y: number; m: number };
  /** Zone geometry, written as a comment (reproducibility). */
  bbox: [number, number, number, number];
  ring: [number, number][];
}

export function dashboardCsv(p: DashboardExport): string {
  const { index, serie, k0, k1, focus } = p;
  const G = gridsOf(index, serie);
  const B0 = S.BASE_Y0, B1 = S.BASE_Y1;
  const ym = (k: number) => { const d = S.ofKey(k); return texteMois(d.y, d.m); };
  const mz = (y: number, m: number): MoisZone | null => serie.mois[indiceMois(index, y, m)] ?? null;
  const out: string[] = [];
  const table = (name: string, head: string[], rows: (string | number | null | undefined)[][]) => {
    out.push(`# [${name}]`, head.join(","), ...rows.map(line), "");
  };

  /* Header */
  out.push(
    "# Vigil - analyst dashboard export (NASA Space Apps 2026)",
    `# zone: ${p.title}`,
    `# zone scale: ${p.zoneNote}`,
    `# zone bbox [lat_min, lat_max, lon_min, lon_max]: ${p.bbox.map((v) => n(v, 5)).join(" ")}`,
    `# zone ring (lon lat): ${p.ring.map(([lo, la]) => `${n(lo, 5)} ${n(la, 5)}`).join("; ")}`,
    `# study period: ${ym(k0)} to ${ym(k1)} (${k1 - k0 + 1} months); focus month: ${texteMois(focus.y, focus.m)}`,
    `# baseline (normal): complete years ${B0}-${B1}; quantiles Hyndman-Fan type 8; percentile ranks leave the compared year/window out`,
    `# units: hotspots = active-fire detections, MODIS-Aqua equivalent; frp_MW = sum of Fire Radiative Power of the detections, MW, Aqua equivalent (a power summed over detections, not an energy)`,
    `# method: ${index.methode}; MODIS Aqua observed before ${index.bascule_viirs}, VIIRS converted after (80 % / 95 % conformal bands per converted month)`,
    "# no band is given for totals over several months: all months share the same conversion coefficient k (correlated errors)",
    `# partial month: ${moisPartiel(index) ?? "none"} (never summed with or compared to complete months)`,
    `# data: NASA FIRMS (MODIS C6.1, VIIRS 375 m C2), export generated ${index.genere_le}; file generated ${new Date().toISOString()}`,
    "# layout: several tables, each introduced by a '# [name]' line and its header row, separated by an empty line",
    "",
  );

  /* 1. Summary (tidy: one row per statistic) */
  const sum: (string | number | null | undefined)[][] = [];
  const add = (metric: string, stat: string, value: number | string | null | undefined, unit: string, def: string) => sum.push([metric, stat, value, unit, def]);
  for (const [metric, g, u] of [["hotspots", G.hot, "detections"], ["frp_MW", G.frp, "MW"]] as const) {
    const ps = S.periodSummary(g, k0, k1);
    add(metric, "period_total_complete_months", ps.total, u, "sum of the complete months of the period");
    add(metric, "period_months", ps.nMonths, "months", "months in the period");
    add(metric, "period_months_complete", ps.nComplete, "months", "months summed");
    add(metric, "period_months_partial", ps.nPartial, "months", "partial months left out");
    add(metric, "period_months_without_data", ps.nMissing, "months", "months without data (before MODIS Aqua) left out");
    add(metric, "period_expected_normal", ps.expected, u, `sum over the complete months of the mean of their calendar month ${B0}-${B1}`);
    add(metric, "period_pct_of_expected", ps.pctExpected, "%", "100 * total / expected");
    if (ps.window) {
      add(metric, "period_window_median", ps.window.median, u, `median of the same calendar window summed per baseline year (n=${ps.window.base.length})`);
      add(metric, "period_window_pct_of_median", ps.window.pctMedian, "%", "100 * total / window median");
      add(metric, "period_window_percentile_rank", ps.window.pr, "%", "100*(b+0.5e)/n against the baseline windows");
      add(metric, "period_window_class", ps.window.cls, "", "<P10 much below; P10-P33 below; P33-P67 near; P67-P90 above; >P90 much above");
      add(metric, "period_window_n", ps.window.base.length, "years", "baseline windows used");
    } else add(metric, "period_window_median", "", u, "not computed: period longer than 12 months, or too few complete months");

    const fc = mz(focus.y, focus.m), cmp = S.monthComparison(g, focus.y, focus.m);
    const lo = fc ? (metric === "hotspots" ? fc.bas80 : fc.frpBas80) : null, hi = fc ? (metric === "hotspots" ? fc.haut80 : fc.frpHaut80) : null;
    const br = cmp && fc?.converti && lo !== null && hi !== null ? S.bandRank(S.sortAsc(cmp.base), lo, hi) : null;
    add(metric, "focus_month", texteMois(focus.y, focus.m), "", "last complete month of the period, or the month picked in the calendar");
    add(metric, "focus_value", fc && !fc.partiel ? fc[metric === "hotspots" ? "hotspots" : "frp"] : null, u, fc?.converti ? "VIIRS converted" : "MODIS Aqua observed");
    add(metric, "focus_band80_low", fc?.converti ? lo : null, u, "80 % conformal band (converted months only)");
    add(metric, "focus_band80_high", fc?.converti ? hi : null, u, "");
    add(metric, "focus_median_same_month", cmp?.median, u, `median of the same month ${B0}-${B1}, focus year left out (n=${cmp?.base.length ?? 0})`);
    add(metric, "focus_pct_of_median", cmp?.pctMedian, "%", "");
    add(metric, "focus_percentile_rank", cmp?.pr, "%", "");
    add(metric, "focus_percentile_rank_band_low", br?.prLo, "%", "PR of the 80 % band bounds");
    add(metric, "focus_percentile_rank_band_high", br?.prHi, "%", "");
    add(metric, "focus_class", cmp?.cls, "", "");

    const se = S.season(g);
    add(metric, "peak_month_median", se ? MONTHS[se.peak] : null, "", `calendar month with the highest median ${B0}-${B1}`);
    add(metric, "fire_season_months", se ? se.months.map((m) => MONTHS[m]).join(" ") : null, "", "months whose mean >= 10 % of the mean annual total (Giglio et al. 2006)");
    const tp = S.trendIn(g, k0, k1), tb = S.trend(g), t = tp ?? tb;
    add(metric, "trend_years", t ? `${t.years[0]}-${t.years[t.years.length - 1]}` : null, "", tp ? "complete years inside the period" : `fewer than 10 complete years in the period: baseline ${B0}-${B1}`);
    add(metric, "trend_sen_slope", t?.sen.slope, `${u}/yr`, "Theil-Sen slope of the annual totals");
    add(metric, "trend_sen_slope_pct", t?.pct, "%/yr", "slope / median annual total");
    add(metric, "trend_sen_ci95_low_pct", t?.pctLo, "%/yr", "");
    add(metric, "trend_sen_ci95_high_pct", t?.pctHi, "%/yr", "");
    add(metric, "trend_mann_kendall_p", t?.mk.p, "", "two-sided, ties corrected, no autocorrelation correction");
    add(metric, "trend_n_years", t?.mk.n, "years", "");
  }
  const iv = S.intensityAt(G.hot, G.frp, focus.y, focus.m), ivc = S.monthComparison(G.inten, focus.y, focus.m);
  add("intensity_MW_per_detection", "focus_value", iv, "MW/detection", "frp_MW / hotspots of the focus month");
  add("intensity_MW_per_detection", "focus_median_same_month", ivc?.median, "MW/detection", "focus year left out");
  add("intensity_MW_per_detection", "focus_percentile_rank", ivc?.pr, "%", "");
  table("summary", ["metric", "statistic", "value", "unit", "definition"], sum);

  /* 2. Monthly series of the period, with each month's comparison */
  const medAll = (g: S.Grid, m: number) => { const b = S.monthBaseline(g, m); return b.length >= 10 ? S.quantileHF8(S.sortAsc(b), 0.5) : null; };
  const rows: (string | number | null | undefined)[][] = [];
  for (let k = k0; k <= k1; k++) {
    const { y, m } = S.ofKey(k), c = mz(y, m);
    if (!c) { rows.push([texteMois(y, m), "no_data"]); continue; }
    const cols: (string | number | null | undefined)[] = [texteMois(y, m), c.partiel ? "partial" : c.converti ? "viirs_converted" : "modis_observed",
      c.hotspots, c.bas80, c.haut80, c.bas95, c.haut95, c.frp, c.frpBas80, c.frpHaut80, c.hotspots > 0 ? c.frp / c.hotspots : null, c.partiel ? null : c.couverture];
    for (const g of [G.hot, G.frp]) {
      const md = medAll(g, m), v = c.partiel ? null : (g === G.hot ? c.hotspots : c.frp), cmp = c.partiel ? null : S.monthComparison(g, y, m);
      cols.push(md, v !== null && md !== null && md > 0 ? v / md : null, cmp?.pr, cmp?.cls);
    }
    rows.push(cols);
  }
  table("monthly_period", ["month", "status", "hotspots", "hotspots_low80", "hotspots_high80", "hotspots_low95", "hotspots_high95",
    "frp_MW", "frp_low80", "frp_high80", "intensity_MW_per_detection", "share_of_days_with_data_global",
    "hotspots_median_month_2003_2025", "hotspots_ratio_to_median", "hotspots_percentile_rank_loo", "hotspots_class_loo",
    "frp_median_month_2003_2025", "frp_ratio_to_median", "frp_percentile_rank_loo", "frp_class_loo"], rows);

  /* 3. Climatology of each calendar month (baseline) and its mean over the period */
  for (const [name, g] of [["climatology_hotspots", G.hot], ["climatology_frp_MW", G.frp], ["climatology_intensity_MW_per_detection", G.inten]] as const) {
    const cr: (string | number | null | undefined)[][] = [];
    for (let m = 0; m < 12; m++) {
      const s = S.summarize(S.monthBaseline(g, m)), pm = S.periodMonthMean(g, k0, k1, m);
      cr.push([MONTHS[m], s?.n, s?.median, s?.medianCI?.lo, s?.medianCI?.hi, s?.q1, s?.q3, s?.iqr, s?.p10, s?.p90, s?.min, s?.max, s?.mean, s?.sd, s?.cv,
        pm?.mean, pm?.n, pm && s && s.mean > 0 ? pm.mean / s.mean : null]);
    }
    if (g !== G.inten) {
      const s = S.summarize(S.annualBaseline(g).totals);
      cr.push(["Annual", s?.n, s?.median, s?.medianCI?.lo, s?.medianCI?.hi, s?.q1, s?.q3, s?.iqr, s?.p10, s?.p90, s?.min, s?.max, s?.mean, s?.sd, s?.cv, null, null, null]);
    }
    table(name, ["month", "n_years", "median", "median_ci95_low", "median_ci95_high", "q1", "q3", "iqr", "p10", "p90", "min", "max", "mean", "sd", "cv",
      "period_mean", "period_n_years", "period_mean_ratio_to_baseline_mean"], cr);
  }

  /* 4. Calendar years touched by the period */
  const ar: (string | number | null | undefined)[][] = [];
  const aH = S.annualPoints(G.hot), aF = S.annualPoints(G.frp);
  for (let y = S.ofKey(k0).y; y <= S.ofKey(k1).y; y++) {
    const h = aH.find((a) => a.y === y), f = aF.find((a) => a.y === y);
    if (!h) continue;
    const rh = S.annualRank(G.hot, y), rf = S.annualRank(G.frp, y);
    ar.push([y, h.complete ? "complete" : h.total !== null ? `partial ${MONTHS[h.firstM]}-${MONTHS[h.lastM]}` : "no_data", h.nMonths, h.total, f?.total, rh?.rank, rf?.rank, rh?.n]);
  }
  table("annual", ["year", "status", "complete_months", "hotspots_total", "frp_MW_total", "hotspots_rank_2003_2025", "frp_rank_2003_2025", "n_ranked_years"], ar);
  return out.join("\n");
}
