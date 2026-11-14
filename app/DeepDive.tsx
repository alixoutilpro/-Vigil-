"use client";

/**
 * Analyst dashboard of a zone (full-screen "deep dive"), on the contract-v2 series of app/zone.ts.
 * Every number comes from app/stats.ts (pure, tested by scripts/test_stats.mjs and scripts/check_stats_numpy.py).
 * Questions answered: is this month abnormal? is the year so far abnormal? when is the season? is there a trend?
 * how intense are the fires? Rules (docs/contrat_donnees_v2.md): baseline = complete years 2003–2025, HF8 quantiles,
 * leave-one-out percentile rank, partial month never compared, no band on multi-month totals.
 * Removed on purpose (data audit 14/11 evening): Spearman ρ on the pooled monthly series and the hot/dry index
 * (seasonality-dominated, autocorrelated, wrong tie handling) and the extrapolated partial-year totals.
 */
import React, { useEffect, useId, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { gridDisk, latLngToCell, polygonToCells } from "h3-js";
import {
  ResponsiveContainer, ComposedChart, Line, Area, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ReferenceArea,
} from "recharts";
import { cleMois, indiceMois, type IndexV2, type Ring } from "./donnees";
import type { Metrique, MoisZone, SerieZone } from "./zone";
import * as S from "./stats";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const B0 = S.BASE_Y0, B1 = S.BASE_Y1;
const MIN_HEX_BAND = 3; // contract §2: below ~3 hexagons the band is only indicative

/* ── Formatting ───────────────────────────────────────────────────────── */

/** Compact number for the calendar cells: 0 · <0.1 · 3.2 · 87 · 1.2k · 12k · 1.2M. */
export function fmtC(x: number): string {
  if (!isFinite(x)) return "—";
  const a = Math.abs(x), s = x < 0 ? "−" : "";
  if (a === 0) return "0";
  if (a < 0.05) return s + "<0.1";
  if (a < 9.95) return s + a.toFixed(1).replace(/\.0$/, "");
  if (Math.round(a) < 1000) return s + Math.round(a);
  if (a < 9950) return s + (a / 1000).toFixed(1) + "k";
  if (Math.round(a / 1000) < 1000) return s + Math.round(a / 1000) + "k";
  return s + (a / 1e6).toFixed(1) + "M";
}
/** Full number for tooltips and tables (2 decimals below 100, integers above, thousands separators). */
function fmtF(x: number | null | undefined): string {
  if (x === null || x === undefined || !isFinite(x)) return "—";
  return x.toLocaleString("en-US", { maximumFractionDigits: Math.abs(x) < 100 ? 2 : 0 });
}
const fmtPct = (x: number | null | undefined) => (x === null || x === undefined || !isFinite(x) ? "n.d." : `${Math.round(x)} %`);
const fmtSigned = (x: number, d = 1) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(d)}`;
const unitOf = (m: Metrique) => (m === "hotspots" ? "detections" : "MW");
const nameOf = (m: Metrique) => (m === "hotspots" ? "Hotspots" : "Σ FRP");
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const monthSpan = (a: number, b: number) => (a === b ? MONTHS[a] : `${MONTHS[a]}–${MONTHS[b]}`);

/** Diverging RdBu (ColorBrewer, 9 classes), reversed: blue = below the median, red = above. Colour-blind safe. */
const DIV = ["#2166ac", "#4393c3", "#92c5de", "#d1e5f0", "#f7f7f7", "#fddbc7", "#f4a582", "#d6604d", "#b2182b"];
const DIV_TEXT = (c: number) => (c <= 1 || c >= 7 ? "#ffffff" : "#0f172a");
const NEUTRAL = "#e9ecef";
const CLASS_COLORS: Record<string, string> = { "much below normal": "#2166ac", "below normal": "#92c5de", "near normal": "#f7f7f7", "above normal": "#f4a582", "much above normal": "#b2182b" };
const EDGE_RATIOS = S.ANOMALY_EDGES.map((e) => 2 ** e);

/* ── Accessible definition tooltip (hover + keyboard focus) ───────────── */

type Pop = { x: number; y: number; below: boolean };
function popAt(el: HTMLElement): Pop {
  const r = el.getBoundingClientRect();
  const below = r.top < 170;
  return { x: r.left + r.width / 2, y: below ? r.bottom + 6 : r.top - 6, below };
}
function PopBox({ pos, children, wide }: { pos: Pop; children: React.ReactNode; wide?: boolean }) {
  if (typeof document === "undefined") return null;
  const w = wide ? 300 : 280;
  return createPortal(
    <div className="dd-pop" role="tooltip" style={{ width: w, left: clamp(pos.x - w / 2, 8, window.innerWidth - w - 8), top: pos.y, transform: pos.below ? "none" : "translateY(-100%)" }}>
      {children}
    </div>, document.body);
}

/** Metric label with a definition shown on hover AND keyboard focus (Tab), read by screen readers via aria-describedby. */
function Def({ children, def, className }: { children: React.ReactNode; def: React.ReactNode; className?: string }) {
  const [pos, setPos] = useState<Pop | null>(null);
  const id = useId();
  return (
    <span className={"dd-def" + (className ? " " + className : "")} tabIndex={0} aria-describedby={id}
      onMouseEnter={(e) => setPos(popAt(e.currentTarget))} onMouseLeave={() => setPos(null)}
      onFocus={(e) => setPos(popAt(e.currentTarget))} onBlur={() => setPos(null)}>
      {children}
      <span id={id} hidden>{def}</span>
      {pos && <PopBox pos={pos}>{def}</PopBox>}
    </span>
  );
}

/* ── Props ─────────────────────────────────────────────────────────────── */

export interface DeepDiveProps {
  index: IndexV2;
  serie: SerieZone | null;
  metrique: Metrique;
  /** Focus month (single month of the study period, else the last complete month). */
  focus: { y: number; m: number };
  /** Click / Enter on a calendar cell: make that month the focus month. */
  onPickMonth?: (y: number, m: number) => void;
  /** Zone name and the scale/band note of the main view. */
  title?: string;
  zoneNote?: string;
  ring: Ring;
  bbox: [number, number, number, number];
}

type MonthRecord = { y: number; m: number; tmax: number; precip: number; rh: number; wind: number };

export default function DeepDive({ index, serie, metrique, focus, onPickMonth, title, zoneNote, ring, bbox }: DeepDiveProps) {
  const Y0 = cleMois(index.mois[0]).y, Y1 = cleMois(index.mois[index.mois.length - 1]).y;
  const mz = (y: number, m: number): MoisZone | null => (serie ? serie.mois[indiceMois(index, y, m)] ?? null : null);

  /* Monthly grids of both metrics (null = month not exported = no data, never 0) */
  const grids = useMemo(() => {
    const mk = (k: Metrique): S.Grid => ({
      y0: Y0,
      cells: Array.from({ length: Y1 - Y0 + 1 }, (_, i) => Array.from({ length: 12 }, (_, m) => {
        const c = serie ? serie.mois[indiceMois(index, Y0 + i, m)] : null;
        return c ? { v: c[k], partial: c.partiel, converted: c.converti } : null;
      })),
    });
    if (!serie) return null;
    const hot = mk("hotspots"), frp = mk("frp");
    return { hot, frp, inten: S.intensityGrid(hot, frp) };
  }, [serie, index, Y0, Y1]);

  if (!serie || !grids) return <div className="dd-empty">Loading the zone series…</div>;
  const g = metrique === "hotspots" ? grids.hot : grids.frp;
  const bandOf = (c: MoisZone): [number, number] | null => {
    const lo = metrique === "hotspots" ? c.bas80 : c.frpBas80, hi = metrique === "hotspots" ? c.haut80 : c.frpHaut80;
    return c.converti && lo !== null && hi !== null ? [lo, hi] : null;
  };
  const smallZone = serie.source === "h3" && serie.hexagones.length < MIN_HEX_BAND;

  return (
    <div className="dd-root">
      <style dangerouslySetInnerHTML={{ __html: DD_CSS }} />
      <header className="dd-head">
        <div>
          <h2 className="dd-title">{title || "Selected zone"} <span className="dd-title-sub">· {nameOf(metrique)} per month, MODIS-Aqua equivalent</span></h2>
          {zoneNote && <p className="dd-note">{zoneNote}{serie.fiabilite === "faible" ? " — little data, conversion less certain" : ""}</p>}
        </div>
      </header>
      <Kpis g={g} grids={grids} metrique={metrique} focus={focus} mz={mz} bandOf={bandOf} />
      <div className="dd-grid">
        <section className="dd-panel dd-cal-panel" aria-label="Anomaly calendar">
          <AnomalyCalendar g={g} metrique={metrique} focus={focus} mz={mz} bandOf={bandOf} smallZone={smallZone}
            frpBandNote={metrique === "frp" && serie.source === "h3"} onPick={onPickMonth} />
        </section>
        <div className="dd-side">
          <section className="dd-panel" aria-label="Annual totals"><AnnualChart g={g} metrique={metrique} index={index} /></section>
          <section className="dd-panel" aria-label="FRP and intensity"><FrpBlock grids={grids} focusY={focus.y} /></section>
        </div>
        <section className="dd-panel dd-full" aria-label="Monthly climatology"><Climatology g={g} metrique={metrique} focus={focus} mz={mz} bandOf={bandOf} /></section>
        <section className="dd-panel dd-full" aria-label="Weather context"><Weather index={index} ring={ring} bbox={bbox} focus={focus} /></section>
      </div>
      <p className="dd-foot">
        NASA FIRMS MODIS &amp; VIIRS active fires, harmonized by {index.methode}. Observed by MODIS Aqua before {index.bascule_viirs},
        VIIRS converted to Aqua equivalent after (80 % conformal band per month). Baseline: complete years {B0}–{B1}; quantiles
        Hyndman–Fan type 8; percentile ranks leave the compared year out. No band is shown for totals over several months:
        all months share the same conversion coefficient k, so their errors are correlated and bands cannot be added.
      </p>
    </div>
  );
}

/* ── KPI strip ─────────────────────────────────────────────────────────── */

type Grids = { hot: S.Grid; frp: S.Grid; inten: S.Grid };
interface CommonProps {
  g: S.Grid; metrique: Metrique; focus: { y: number; m: number };
  mz: (y: number, m: number) => MoisZone | null;
  bandOf: (c: MoisZone) => [number, number] | null;
}

function ClassBadge({ cls }: { cls: string }) {
  return <span className="dd-badge" style={{ background: CLASS_COLORS[cls], color: cls.startsWith("much") ? "#fff" : "#0f172a" }}>{cls}</span>;
}

function Kpis({ g, grids, metrique, focus, mz, bandOf }: CommonProps & { grids: Grids }) {
  const u = unitOf(metrique);
  const fc = mz(focus.y, focus.m);
  const partial = !!fc?.partiel;
  // YTD and 12-month totals end at the last COMPLETE month ≤ focus (a partial month is never summed with complete ones)
  const anchor = partial ? (focus.m === 0 ? { y: focus.y - 1, m: 11 } : { y: focus.y, m: focus.m - 1 }) : focus;
  const cmp = S.monthComparison(g, focus.y, focus.m);
  const band = fc ? bandOf(fc) : null;
  const br = cmp && band ? S.bandRank(S.sortAsc(cmp.base), band[0], band[1]) : null;
  const maxBase = cmp ? Math.max(...cmp.base) : NaN, minBase = cmp ? Math.min(...cmp.base) : NaN;
  const record = cmp ? (br ? (br.recordHigh ? "high" : br.recordLow ? "low" : null) : cmp.value > maxBase ? "high" : cmp.value < minBase ? "low" : null) : null;
  const inBase = focus.y >= B0 && focus.y <= B1;
  const ytd = S.ytd(g, anchor.y, anchor.m);
  const l12 = S.last12(g, anchor.y, anchor.m);
  const se = S.season(g);
  const tr = S.trend(g);
  const iv = S.intensityAt(grids.hot, grids.frp, focus.y, focus.m);
  const ivCmp = S.monthComparison(grids.inten, focus.y, focus.m);
  const startL12 = (() => { const t = anchor.y * 12 + anchor.m - 11; return `${MONTHS[t % 12]} ${Math.floor(t / 12)}`; })();
  const seasonTxt = se ? (se.months.length ? se.months.map((m) => MONTHS[m]).join(", ") : "none ≥ 10 %") : "—";
  const meanPeak = se ? se.means.indexOf(Math.max(...se.means)) : -1;

  return (
    <div className="dd-kpis">
      <div className="dd-kpi">
        <Def def={<>Value of the focus month for the zone, harmonized to MODIS-Aqua equivalent ({u}). Converted VIIRS months carry an 80 % conformal band (the true Aqua-equivalent value lies inside it 4 times out of 5). Click a calendar cell to change the focus month.</>}>
          <span className="dd-kpi-lbl">{nameOf(metrique)} · {MONTHS[focus.m]} {focus.y}</span></Def>
        <span className="dd-kpi-val">{fc ? fmtF(fc[metrique]) : "—"} <small>{u}</small></span>
        <span className="dd-kpi-sub">{!fc ? "no data" : partial ? "partial month: incomplete data, not compared" : band ? `80 % band ${fmtF(band[0])}–${fmtF(band[1])} · VIIRS converted` : "MODIS Aqua observed"}</span>
      </div>

      <div className="dd-kpi">
        <Def def={<>%med = 100·x / median, where the median (Hyndman–Fan type 8) is taken over the same calendar month of the complete years {B0}–{B1}, the focus year left out. n.d. when the median is 0.</>}>
          <span className="dd-kpi-lbl">vs median {B0}–{B1}</span></Def>
        <span className="dd-kpi-val">{cmp ? fmtPct(cmp.pctMedian) : "—"}</span>
        <span className="dd-kpi-sub">{cmp ? `median ${fmtF(cmp.median)} ${u} · Δ ${cmp.value - cmp.median >= 0 ? "+" : "−"}${fmtF(Math.abs(cmp.value - cmp.median))} · n=${cmp.base.length}` : partial ? "not comparable (partial month)" : "baseline unavailable"}</span>
      </div>

      <div className="dd-kpi">
        <Def def={<>Percentile rank PR = 100·(b + 0.5·e)/n, b = baseline years below the value, e = equal, n = years {B0}–{B1} {inBase ? "other than the focus year" : ""}. For a converted month the PR of the 80 % band bounds is shown too. Class: &lt;P10 much below · P10–P33 below · P33–P67 near · P67–P90 above · &gt;P90 much above. A record is claimed only if the whole band is beyond the historical extreme.</>}>
          <span className="dd-kpi-lbl">Percentile rank · class</span></Def>
        <span className="dd-kpi-val">{cmp ? Math.round(cmp.pr) : "—"}{br && <small> (band {Math.round(br.prLo)}–{Math.round(br.prHi)})</small>}</span>
        <span className="dd-kpi-sub">{cmp ? <><ClassBadge cls={cmp.cls} /> {inBase ? `vs the other ${cmp.base.length} yrs` : `vs ${cmp.base.length} yrs`}{record ? ` · record ${record}` : ""}</> : "—"}</span>
      </div>

      <div className="dd-kpi">
        <Def def={<>Year to date: sum of {monthSpan(0, anchor.m)} {anchor.y} (complete months only) compared with the same months of each year {B0}–{B1}, summed per year THEN the median of those sums (never a sum of monthly medians). PR as for a month. No band: monthly errors are correlated.</>}>
          <span className="dd-kpi-lbl">Year to date · {monthSpan(0, anchor.m)} {anchor.y}</span></Def>
        <span className="dd-kpi-val">{ytd ? fmtF(ytd.value) : "—"} <small>{u}</small></span>
        <span className="dd-kpi-sub">{ytd ? `${fmtPct(ytd.pctMedian)} of median ${fmtF(ytd.median)} · PR ${Math.round(ytd.pr)} · n=${ytd.base.length}` : "incomplete months"}</span>
      </div>

      <div className="dd-kpi">
        <Def def={<>Total of the 12 complete months {startL12} → {MONTHS[anchor.m]} {anchor.y}, compared with the 12-month totals ending in {MONTHS[anchor.m]} of the baseline (windows entirely inside {B0}–{B1}: same season, no overlap); median HF8 and PR of those totals.</>}>
          <span className="dd-kpi-lbl">Last 12 months</span></Def>
        <span className="dd-kpi-val">{l12 ? fmtF(l12.value) : "—"} <small>{u}</small></span>
        <span className="dd-kpi-sub">{l12 ? `${fmtPct(l12.pctMedian)} of median ${fmtF(l12.median)} · PR ${Math.round(l12.pr)} · n=${l12.base.length}` : "incomplete months"}</span>
      </div>

      <div className="dd-kpi">
        <Def def={<>Peak = calendar month with the highest median {B0}–{B1}. Fire season = months whose mean is ≥ 10 % of the mean annual total (Giglio et al. 2006); months need not be contiguous.</>}>
          <span className="dd-kpi-lbl">Peak month · fire season</span></Def>
        <span className="dd-kpi-val">{se ? MONTHS[se.peak] : "—"} <small>{se ? `· ${se.months.length} mo` : ""}</small></span>
        <span className="dd-kpi-sub">{se ? `${seasonTxt}${meanPeak >= 0 && meanPeak !== se.peak ? ` · peak of the mean: ${MONTHS[meanPeak]}` : ""}` : "—"}</span>
      </div>

      <div className="dd-kpi">
        <Def def={<>Theil–Sen slope of the annual totals {B0}–{B1} (median of all pairwise slopes), in % of the median annual total per year, with its 95 % CI (Sen 1968). Mann–Kendall two-sided p-value (ties corrected, no autocorrelation correction). Years from 2021 on are VIIRS converted to Aqua equivalent.</>}>
          <span className="dd-kpi-lbl">Trend {B0}–{B1}</span></Def>
        <span className="dd-kpi-val">{tr && tr.pct !== null ? `${fmtSigned(tr.pct)} %/yr` : "—"}</span>
        <span className="dd-kpi-sub">{tr ? `95 % CI ${tr.pctLo !== null ? fmtSigned(tr.pctLo) : "—"} to ${tr.pctHi !== null ? fmtSigned(tr.pctHi) : "—"} · MK p=${tr.mk.p < 0.001 ? "<0.001" : tr.mk.p.toFixed(3)} · n=${tr.mk.n}` : "fewer than 10 complete years"}</span>
      </div>

      <div className="dd-kpi">
        <Def def={<>Mean FRP per detection = Σ FRP / hotspots of the month (MW per detection, both harmonized to Aqua equivalent): an intensity indicator, independent of how many fires burn. Compared with the median of the same ratio for the same month {B0}–{B1} (focus year left out).</>}>
          <span className="dd-kpi-lbl">Intensity · MW / detection</span></Def>
        <span className="dd-kpi-val">{iv !== null ? iv.toFixed(1) : "—"} <small>MW/det</small></span>
        <span className="dd-kpi-sub">{ivCmp ? `${fmtPct(ivCmp.pctMedian)} of median ${ivCmp.median.toFixed(1)} · PR ${Math.round(ivCmp.pr)}` : partial ? "partial month" : "—"}</span>
      </div>
    </div>
  );
}

/* ── Anomaly calendar ─────────────────────────────────────────────────── */

type Tip = { kind: "cell" | "annual" | "median" | "medianAnnual"; y: number; m: number; pos: Pop };

function AnomalyCalendar({ g, metrique, focus, mz, bandOf, smallZone, frpBandNote, onPick }: CommonProps & { smallZone: boolean; frpBandNote: boolean; onPick?: (y: number, m: number) => void }) {
  const [tip, setTip] = useState<Tip | null>(null);
  const [kbd, setKbd] = useState<{ y: number; m: number }>(focus);
  useEffect(() => setKbd(focus), [focus.y, focus.m]); // eslint-disable-line react-hooks/exhaustive-deps
  const u = unitOf(metrique);
  const years = Array.from({ length: g.cells.length }, (_, i) => g.y0 + i);
  const meds = useMemo(() => Array.from({ length: 12 }, (_, m) => {
    const b = S.monthBaseline(g, m);
    return { n: b.length, med: b.length >= 10 ? S.quantileHF8(S.sortAsc(b), 0.5) : NaN };
  }), [g]);
  const annual = useMemo(() => S.annualPoints(g), [g]);
  const annBase = useMemo(() => S.annualBaseline(g), [g]);
  const annMed = annBase.totals.length >= 10 ? S.quantileHF8(S.sortAsc(annBase.totals), 0.5) : NaN;

  const cellStyle = (x: number, med: number): React.CSSProperties => {
    const c = isNaN(med) ? null : S.anomalyClass(x, med);
    return c === null ? { background: NEUTRAL, color: "#0f172a" } : { background: DIV[c], color: DIV_TEXT(c) };
  };
  const show = (kind: Tip["kind"], y: number, m: number) => (e: React.SyntheticEvent<HTMLElement>) => setTip({ kind, y, m, pos: popAt(e.currentTarget) });
  const move = (e: React.KeyboardEvent, y: number, m: number) => {
    const d: Record<string, [number, number]> = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] };
    if (d[e.key]) {
      e.preventDefault();
      const ny = clamp(y + d[e.key][0], years[0], years[years.length - 1]), nm = clamp(m + d[e.key][1], 0, 11);
      setKbd({ y: ny, m: nm });
      (e.currentTarget.parentElement?.querySelector(`[data-ym="${ny}-${nm}"]`) as HTMLElement | null)?.focus();
    } else if ((e.key === "Enter" || e.key === " ") && mz(y, m)) { e.preventDefault(); onPick?.(y, m); }
  };

  return (
    <>
      <div className="dd-sec-head">
        <Def def={<>Each cell: the month&apos;s value ({u}, rounded for display). Colour: log₂(value ÷ median of the same month in the top row), clipped at ¼× and 4×, 9 classes. The top-row median uses all 23 complete years {B0}–{B1} (the cell&apos;s own year included); the percentile rank in the tooltip leaves the cell&apos;s year out, so the two can differ slightly. Colours use the unrounded values.</>}>
          <span className="dd-sec-title">Anomaly calendar · {nameOf(metrique)} vs monthly median</span></Def>
        <span className="dd-hint">click or Enter = focus month · arrows move</span>
      </div>
      <div className="dd-cal" role="grid" aria-label={`${nameOf(metrique)} per month and year, coloured by ratio to the monthly median`} onMouseLeave={() => setTip(null)}>
        <div className="dd-ch" role="columnheader" />
        {MONTHS.map((mn) => <div key={mn} className="dd-ch" role="columnheader">{mn}</div>)}
        <div className="dd-ch dd-ann-h" role="columnheader">
          <Def def={<>Sum of the year&apos;s complete months (no extrapolation) and its rank among the complete years {B0}–{B1} (#1 = highest). Partial years are hatched, labelled with the months they cover and not ranked. No band: monthly errors are correlated (same k).</>}>Year · rank</Def>
        </div>

        <div className="dd-rh dd-med-lbl" role="rowheader">
          <Def def={<>Median (Hyndman–Fan type 8) of each calendar month over the complete years {B0}–{B1} (n shown in the tooltip). Reference of the cell colours.</>}>Median {String(B0).slice(2)}–{String(B1).slice(2)}</Def>
        </div>
        {meds.map((d, m) => (
          <div key={m} className="dd-c dd-med" role="gridcell" onMouseEnter={show("median", 0, m)} onMouseLeave={() => setTip(null)}>{isNaN(d.med) ? "—" : fmtC(d.med)}</div>
        ))}
        <div className="dd-c dd-med dd-ann" role="gridcell" onMouseEnter={show("medianAnnual", 0, 0)} onMouseLeave={() => setTip(null)}>{isNaN(annMed) ? "—" : fmtC(annMed)}</div>

        {years.map((y, yi) => {
          const a = annual[yi];
          const rk = S.annualRank(g, y);
          return (
            <React.Fragment key={y}>
              <div className="dd-rh" role="rowheader">{y}</div>
              {g.cells[yi].map((c, m) => {
                const isFocus = y === focus.y && m === focus.m;
                const common = {
                  "data-ym": `${y}-${m}`, role: "gridcell", tabIndex: y === kbd.y && m === kbd.m ? 0 : -1,
                  onMouseEnter: show("cell", y, m), onFocus: show("cell", y, m), onBlur: () => setTip(null),
                  onKeyDown: (e: React.KeyboardEvent) => move(e, y, m),
                };
                if (!c) return <div key={m} {...common} className="dd-c dd-nodata" aria-label={`${MONTHS[m]} ${y}: no data`} />;
                if (c.partial) return (
                  <div key={m} {...common} className={"dd-c dd-partial" + (isFocus ? " dd-focus" : "")} onClick={() => onPick?.(y, m)}
                    aria-label={`${MONTHS[m]} ${y}: ${fmtF(c.v)} ${u}, partial month, not compared`}>{fmtC(c.v)}</div>
                );
                return (
                  <div key={m} {...common} className={"dd-c" + (isFocus ? " dd-focus" : "")} style={cellStyle(c.v, meds[m].med)} onClick={() => onPick?.(y, m)}
                    aria-label={`${MONTHS[m]} ${y}: ${fmtF(c.v)} ${u}${meds[m].med > 0 ? `, ${(c.v / meds[m].med).toFixed(2)} times the median` : ""}`}>{fmtC(c.v)}</div>
                );
              })}
              {a.total === null ? <div className="dd-c dd-ann dd-nodata" role="gridcell" />
                : a.complete && rk ? (
                  <div className="dd-c dd-ann" role="gridcell" style={cellStyle(a.total, annMed)} onMouseEnter={show("annual", y, 0)} onMouseLeave={() => setTip(null)}>
                    {fmtC(a.total)} <small>#{rk.rank}</small>
                  </div>
                ) : (
                  <div className="dd-c dd-ann dd-partial" role="gridcell" onMouseEnter={show("annual", y, 0)} onMouseLeave={() => setTip(null)}>
                    {fmtC(a.total)} <small>{a.complete ? "" : monthSpan(a.firstM, a.lastM)}</small>
                  </div>
                )}
            </React.Fragment>
          );
        })}
      </div>

      <div className="dd-legend" aria-label="Colour legend">
        <span className="dd-leg-ramp">
          {DIV.map((c, i) => <i key={c} style={{ background: c }} title={i === 0 ? `≤ ${EDGE_RATIOS[0].toFixed(2)}× median (incl. 0)` : i === 8 ? `> ${EDGE_RATIOS[7].toFixed(2)}× median` : `${EDGE_RATIOS[i - 1].toFixed(2)}–${EDGE_RATIOS[i].toFixed(2)}× median`} />)}
        </span>
        <span className="dd-leg-ticks">
          <span>¼×</span><span>½×</span><span>1× (0.84–1.19)</span><span>2×</span><span>4×</span>
        </span>
        <span className="dd-leg-txt">value ÷ monthly median, log₂ scale clipped at ¼× and 4×; class edges {EDGE_RATIOS.map((r) => r.toFixed(2)).join(" · ")}</span>
        <span className="dd-leg-item"><b className="dd-sw dd-nodata" />no data (before MODIS Aqua, Jul 2002)</span>
        <span className="dd-leg-item"><b className="dd-sw dd-partial" />partial month / year, not compared</span>
        <span className="dd-leg-item"><b className="dd-sw" style={{ background: NEUTRAL }} />median = 0 (ratio n.d.)</span>
      </div>

      {tip && <PopBox pos={tip.pos} wide><CalTip tip={tip} g={g} metrique={metrique} mz={mz} bandOf={bandOf} meds={meds} annMed={annMed} smallZone={smallZone} frpBandNote={frpBandNote} focus={focus} /></PopBox>}
    </>
  );
}

function Row({ k, v, dim }: { k: React.ReactNode; v: React.ReactNode; dim?: boolean }) {
  return <div className={"dd-tr" + (dim ? " dim" : "")}><span>{k}</span><b>{v}</b></div>;
}

function CalTip({ tip, g, metrique, mz, bandOf, meds, annMed, smallZone, frpBandNote }: CommonProps & { tip: Tip; meds: { n: number; med: number }[]; annMed: number; smallZone: boolean; frpBandNote: boolean }) {
  const u = unitOf(metrique);
  if (tip.kind === "median") {
    const b = S.summarize(S.monthBaseline(g, tip.m));
    return <>
      <div className="dd-tt">Median of {MONTHS[tip.m]}, {B0}–{B1}</div>
      <Row k="Median (HF8)" v={`${fmtF(b?.median)} ${u}`} />
      <Row k="95 % CI of the median" v={b?.medianCI ? `${fmtF(b.medianCI.lo)} – ${fmtF(b.medianCI.hi)}` : "—"} dim />
      <Row k="Years" v={b ? b.n : 0} dim />
      <div className="dd-tn">Shown rounded in the top row; the cells of this column are coloured by value ÷ this median.</div>
    </>;
  }
  if (tip.kind === "medianAnnual") {
    return <>
      <div className="dd-tt">Median annual total, {B0}–{B1}</div>
      <Row k="Median (HF8)" v={`${fmtF(annMed)} ${u}`} />
      <Row k="Complete years" v={S.annualBaseline(g).totals.length} dim />
      <div className="dd-tn">Annual totals are coloured by total ÷ this median. No band: monthly errors are correlated.</div>
    </>;
  }
  if (tip.kind === "annual") {
    const a = S.annualPoints(g).find((p) => p.y === tip.y)!;
    const rk = S.annualRank(g, tip.y);
    return <>
      <div className="dd-tt">{tip.y} {a.complete ? "· annual total" : `· partial (${monthSpan(a.firstM, a.lastM)})`}</div>
      <Row k={a.complete ? "Total" : "Sum of available months"} v={`${fmtF(a.total)} ${u}`} />
      {a.complete && <Row k="÷ median annual" v={annMed > 0 && a.total !== null ? `${(a.total / annMed).toFixed(2)}×` : "n.d."} dim />}
      {rk && <Row k={`Rank among ${rk.n} complete years`} v={`#${rk.rank}`} dim />}
      {!a.complete && <div className="dd-tn">Partial year: not extrapolated, not ranked. Compare with the year-to-date indicator.</div>}
      <div className="dd-tn">No band for an annual total (same k for all months: correlated errors).</div>
    </>;
  }
  const c = mz(tip.y, tip.m);
  if (!c) return <><div className="dd-tt">{MONTHS[tip.m]} {tip.y}</div><div className="dd-tn">No data (month not covered by MODIS Aqua or not yet available).</div></>;
  const x = c[metrique];
  const band = bandOf(c);
  const med = meds[tip.m];
  const cmp = c.partiel ? null : S.monthComparison(g, tip.y, tip.m);
  const br = cmp && band ? S.bandRank(S.sortAsc(cmp.base), band[0], band[1]) : null;
  const inBase = tip.y >= B0 && tip.y <= B1;
  const cls = !c.partiel && med.med > 0 ? S.anomalyClass(x, med.med) : null;
  return <>
    <div className="dd-tt">{MONTHS[tip.m]} {tip.y}{c.partiel ? " · partial" : ""}</div>
    <Row k={nameOf(metrique)} v={`${fmtF(x)} ${u}`} />
    {band && <Row k={`80 % band${smallZone ? " (indicative)" : ""}`} v={`${fmtF(band[0])} – ${fmtF(band[1])}`} dim />}
    {c.converti && metrique === "hotspots" && c.bas95 !== null && c.haut95 !== null && <Row k="95 % band" v={`${fmtF(c.bas95)} – ${fmtF(c.haut95)}`} dim />}
    {c.converti && frpBandNote && <div className="dd-tn">FRP band validated at country × month only.</div>}
    <Row k="Source" v={c.converti ? "VIIRS converted" : "MODIS Aqua observed"} dim />
    {metrique === "hotspots" ? <Row k="Σ FRP" v={`${fmtF(c.frp)} MW`} dim /> : <Row k="Hotspots" v={`${fmtF(c.hotspots)} detections`} dim />}
    {c.hotspots > 0 && <Row k="Intensity" v={`${(c.frp / c.hotspots).toFixed(1)} MW/det`} dim />}
    <div className="dd-sep" />
    {c.partiel ? <div className="dd-tn">Partial month (incomplete data): not compared with complete months, not coloured.</div> : <>
      <Row k={`Median ${MONTHS[tip.m]} (top row, n=${med.n})`} v={isNaN(med.med) ? "—" : fmtF(med.med)} />
      <Row k="Value ÷ median" v={med.med > 0 ? `${(x / med.med).toFixed(2)}× (log₂ ${x > 0 ? fmtSigned(Math.log2(x / med.med), 2) : "−∞"})` : "n.d. (median = 0)"} dim />
      {cls !== null && <Row k="Colour class" v={`${cls - 4 >= 0 ? "+" : "−"}${Math.abs(cls - 4)} of ±4`} dim />}
      {cmp ? <>
        <Row k={`Percentile rank ${inBase ? `vs the other ${cmp.base.length} yrs` : `vs ${cmp.base.length} yrs`}`} v={`${Math.round(cmp.pr)}${br ? ` (band ${Math.round(br.prLo)}–${Math.round(br.prHi)})` : ""}`} />
        <Row k="Class" v={cmp.cls} dim />
        {inBase && <div className="dd-tn">Rank and class leave {tip.y} out of the baseline (median {fmtF(cmp.median)}); the colour uses the top-row median with all 23 years.</div>}
      </> : null}
    </>}
  </>;
}

/* ── Annual series ────────────────────────────────────────────────────── */

const tipStyle: React.CSSProperties = { fontSize: 11, background: "rgba(15,23,42,.94)", border: 0, color: "#f8fafc", borderRadius: 6, padding: "6px 9px" };

function AnnualChart({ g, metrique, index }: { g: S.Grid; metrique: Metrique; index: IndexV2 }) {
  const u = unitOf(metrique);
  const pts = S.annualPoints(g);
  const base = S.annualBaseline(g);
  const sb = S.sortAsc(base.totals);
  const ok = sb.length >= 10;
  const med = ok ? S.quantileHF8(sb, 0.5) : NaN, p10 = ok ? S.quantileHF8(sb, 0.1) : NaN, p90 = ok ? S.quantileHF8(sb, 0.9) : NaN;
  const tr = S.trend(g);
  const data = pts.map((p) => ({
    y: p.y,
    full: p.complete ? p.total : null,
    part: !p.complete && p.total !== null ? p.total : null,
    sen: tr && p.y >= B0 && p.y <= B1 ? tr.sen.intercept + tr.sen.slope * p.y : null,
    span: p.complete ? "" : p.total !== null ? monthSpan(p.firstM, p.lastM) : "",
  }));
  const b = new Date(index.bascule_viirs + "T00:00:00Z");
  const xSwitch = b.getUTCFullYear() + b.getUTCMonth() / 12;
  const y0 = pts[0]?.y ?? 2002, y1 = pts[pts.length - 1]?.y ?? 2026;
  return (
    <>
      <div className="dd-sec-head">
        <Def def={<>Sum of the complete months of each year ({u}, Aqua equivalent). Solid = complete years; hollow = partial years, observed months only (NOT extrapolated). Shaded band = P10–P90 of the annual totals {B0}–{B1}, line = their median (HF8); dashed = Theil–Sen trend. Vertical line = switch to converted VIIRS.</>}>
          <span className="dd-sec-title">Annual totals</span></Def>
      </div>
      <div className="dd-chart">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 6, right: 10, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="rgba(15,23,42,.12)" strokeDasharray="2 2" vertical={false} />
            <XAxis dataKey="y" type="number" domain={[y0 - 0.5, y1 + 0.5]} ticks={pts.filter((p) => p.y % 4 === 2).map((p) => p.y)} tick={{ fontSize: 10, fill: "#000" }} tickLine={false} axisLine={false} />
            <YAxis tick={{ fontSize: 10, fill: "#000" }} tickLine={false} axisLine={false} width={42} tickFormatter={(v: number) => fmtC(v)} />
            {ok && <ReferenceArea y1={p10} y2={p90} fill="#94a3b8" fillOpacity={0.18} stroke="none" ifOverflow="extendDomain" />}
            {ok && <ReferenceLine y={med} stroke="#475569" strokeDasharray="4 3" label={{ value: `median ${fmtC(med)}`, position: "insideTopLeft", fontSize: 10, fill: "#334155" }} />}
            <ReferenceLine x={xSwitch} stroke="#b91c1c" strokeDasharray="3 3" label={{ value: "VIIRS converted →", position: "insideTopRight", fontSize: 10, fill: "#b91c1c" }} />
            <Line dataKey="sen" stroke="#64748b" strokeWidth={1} strokeDasharray="6 4" dot={false} isAnimationActive={false} connectNulls={false} />
            <Line dataKey="full" stroke="#ea580c" strokeWidth={2} dot={{ r: 2.5, fill: "#ea580c", stroke: "#ea580c" }} isAnimationActive={false} connectNulls={false} />
            <Line dataKey="part" stroke="none" dot={{ r: 4, fill: "#ffffff", stroke: "#ea580c", strokeWidth: 1.6 }} activeDot={{ r: 5, fill: "#ffffff", stroke: "#ea580c" }} isAnimationActive={false} />
            <Tooltip contentStyle={tipStyle} content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const d = payload[0].payload as (typeof data)[number];
              return (
                <div style={tipStyle}>
                  <div style={{ fontWeight: 700 }}>{d.y}</div>
                  {d.full !== null && <div>Total {fmtF(d.full)} {u}</div>}
                  {d.part !== null && <div>Partial ({d.span}) {fmtF(d.part)} {u} — not extrapolated</div>}
                  {d.full === null && d.part === null && <div>No data</div>}
                  {ok && <div style={{ color: "#94a3b8" }}>median {fmtF(med)} · P10–P90 {fmtF(p10)}–{fmtF(p90)}</div>}
                </div>
              );
            }} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="dd-chart-leg">
        <span><i className="dd-l-line" />complete year</span>
        <span><i className="dd-l-hollow" />partial year (observed months only)</span>
        <span><i className="dd-l-band" />P10–P90 {B0}–{B1}</span>
        <span><i className="dd-l-dash" />Sen trend</span>
      </div>
    </>
  );
}

/* ── FRP block ─────────────────────────────────────────────────────────── */

function FrpBlock({ grids, focusY }: { grids: Grids; focusY: number }) {
  const data = MONTHS.map((name, m) => {
    const f = S.summarize(S.monthBaseline(grids.frp, m));
    const i = S.summarize(S.monthBaseline(grids.inten, m));
    return {
      name,
      frpMed: f?.median ?? null, frpIQR: f ? [f.q1, f.q3] : null,
      intMed: i?.median ?? null, intIQR: i ? [i.q1, i.q3] : null, intN: i?.n ?? 0,
      frpFocus: S.completeValue(grids.frp, focusY, m), intFocus: S.completeValue(grids.inten, focusY, m),
    };
  });
  const chart = (med: "frpMed" | "intMed", iqr: "frpIQR" | "intIQR", foc: "frpFocus" | "intFocus", fmt: (v: number) => string, unit: string) => (
    <div className="dd-chart dd-chart-sm">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="rgba(15,23,42,.12)" strokeDasharray="2 2" vertical={false} />
          <XAxis dataKey="name" tick={{ fontSize: 9, fill: "#000" }} tickLine={false} axisLine={false} interval={0} tickFormatter={(v: string) => v[0]} />
          <YAxis tick={{ fontSize: 9, fill: "#000" }} tickLine={false} axisLine={false} width={40} tickFormatter={fmt} />
          <Area dataKey={iqr} stroke="none" fill="#ea580c" fillOpacity={0.18} isAnimationActive={false} />
          <Line dataKey={med} stroke="#ea580c" strokeWidth={2} dot={{ r: 2 }} isAnimationActive={false} />
          <Line dataKey={foc} stroke="#0f172a" strokeWidth={0} dot={{ r: 2.6, fill: "#0f172a" }} isAnimationActive={false} />
          <Tooltip content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const d = payload[0].payload as (typeof data)[number];
            const r = d[iqr] as number[] | null;
            return (
              <div style={tipStyle}>
                <div style={{ fontWeight: 700 }}>{d.name}</div>
                <div>median {d[med] !== null ? fmt(d[med] as number) : "—"} {unit}</div>
                <div style={{ color: "#94a3b8" }}>Q1–Q3 {r ? `${fmt(r[0])}–${fmt(r[1])}` : "—"}</div>
                <div>{focusY}: {d[foc] !== null ? fmt(d[foc] as number) : "—"} {unit}</div>
                {med === "intMed" && <div style={{ color: "#94a3b8" }}>n={d.intN} yrs (months with ≥ 1 detection)</div>}
              </div>
            );
          }} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
  return (
    <>
      <div className="dd-sec-head">
        <Def def={<>Monthly profile {B0}–{B1}: median (line) and interquartile range Q1–Q3 (shaded) of the monthly Σ FRP (sum of Fire Radiative Power of the detections, MW, Aqua equivalent — a power summed over detections, not an energy), and of the mean FRP per detection (Σ FRP / hotspots). Dots: the focus year.</>}>
          <span className="dd-sec-title">FRP · monthly profile</span></Def>
      </div>
      <div className="dd-frp2">
        <div><div className="dd-mini">Σ FRP (MW) · median, Q1–Q3</div>{chart("frpMed", "frpIQR", "frpFocus", fmtC, "MW")}</div>
        <div><div className="dd-mini">Intensity (MW / detection)</div>{chart("intMed", "intIQR", "intFocus", (v) => (v < 10 ? v.toFixed(1) : String(Math.round(v))), "MW/det")}</div>
      </div>
      <div className="dd-chart-leg"><span><i className="dd-l-line" />median {B0}–{B1}</span><span><i className="dd-l-band dd-l-or" />Q1–Q3</span><span><i className="dd-l-dot" />{focusY}</span></div>
    </>
  );
}

/* ── Monthly climatology table ─────────────────────────────────────────── */

function Climatology({ g, metrique, focus, mz, bandOf }: CommonProps) {
  const u = unitOf(metrique);
  const se = S.season(g);
  const rows = MONTHS.map((name, m) => {
    const sm = S.summarize(S.monthBaseline(g, m));
    const c = mz(focus.y, m);
    const v = S.completeValue(g, focus.y, m);
    const base = S.sortAsc(S.monthBaseline(g, m, focus.y));
    const band = c && !c.partiel ? bandOf(c) : null;
    const br = band && base.length ? S.bandRank(base, band[0], band[1]) : null;
    return { name, m, sm, v, partial: !!c?.partiel, pr: v !== null && base.length >= 10 ? S.percentileRank(base, v) : null, br };
  });
  const ann = S.summarize(S.annualBaseline(g).totals);
  const ap = S.annualPoints(g).find((p) => p.y === focus.y);
  const annBase = S.annualBaseline(g).totals.filter((_, i) => S.annualBaseline(g).years[i] !== focus.y);
  const annPr = ap?.complete && ap.total !== null && annBase.length >= 10 ? S.percentileRank(annBase, ap.total) : null;
  const H = ({ t, d, cls }: { t: string; d: React.ReactNode; cls?: string }) => <th className={cls} scope="col"><Def def={d}>{t}</Def></th>;
  const sec = "dd-secondary";
  const heavy = " Heavy-tailed data: prefer the median and the IQR.";
  const cells = (sm: S.Summary | null) => sm ? <>
    <td>{sm.n}</td>
    <td className="dd-strong">{fmtF(sm.median)} <small>[{sm.medianCI ? `${fmtF(sm.medianCI.lo)}–${fmtF(sm.medianCI.hi)}` : "—"}]</small></td>
    <td>{fmtF(sm.q1)}</td><td>{fmtF(sm.q3)}</td><td>{fmtF(sm.iqr)}</td>
    <td>{fmtF(sm.p10)}</td><td>{fmtF(sm.p90)}</td><td>{fmtF(sm.min)}</td><td>{fmtF(sm.max)}</td>
    <td className={sec}>{fmtF(sm.mean)}</td><td className={sec}>{fmtF(sm.sd)}</td><td className={sec}>{sm.cv !== null ? sm.cv.toFixed(2) : "—"}</td>
  </> : <td colSpan={12}>insufficient data</td>;
  const ci = rows[0].sm?.medianCI;
  return (
    <>
      <div className="dd-sec-head">
        <Def def={<>Distribution of each calendar month over the complete years {B0}–{B1} ({u}, Aqua equivalent), and of the annual totals. Quantiles Hyndman–Fan type 8. The focus-year column gives its value and its percentile rank against the other years.</>}>
          <span className="dd-sec-title">Monthly climatology {B0}–{B1} · {nameOf(metrique)} ({u})</span></Def>
      </div>
      <div className="dd-table-wrap">
        <table className="dd-table">
          <thead><tr>
            <th scope="col">Month</th>
            <H t="n" d={<>Number of complete years in the baseline {B0}–{B1} for this month.</>} />
            <H t="Median [95 % CI]" d={<>Median (HF8). 95 % CI: distribution-free order-statistic interval [x(k), x(n−k+1)], k the largest rank with P(Binomial(n,½) ≤ k−1) ≤ 2.5 %{ci ? ` (n=${rows[0].sm?.n}: x(${ci.rankLo}), x(${ci.rankHi}), exact coverage ${(100 * ci.coverage).toFixed(1)} %)` : ""}.</>} />
            <H t="Q1" d="First quartile (25 %, HF8)." />
            <H t="Q3" d="Third quartile (75 %, HF8)." />
            <H t="IQR" d="Interquartile range Q3 − Q1: robust spread of the middle half of the years." />
            <H t="P10" d="10th percentile (HF8): 1 year in 10 is lower." />
            <H t="P90" d="90th percentile (HF8): 1 year in 10 is higher." />
            <H t="Min" d="Lowest value of the baseline years." />
            <H t="Max" d="Highest value of the baseline years." />
            <H t="Mean" cls={sec} d={<>Arithmetic mean.{heavy}</>} />
            <H t="SD" cls={sec} d={<>Sample standard deviation (n − 1).{heavy}</>} />
            <H t="CV" cls={sec} d={<>Coefficient of variation SD / mean (unitless).{heavy}</>} />
            <H t={String(focus.y)} cls="dd-focus-col" d={<>Value of {focus.y} for this month ({u}); hatched when partial.</>} />
            <H t="PR" cls="dd-focus-col" d={<>Percentile rank of the {focus.y} value, 100·(b + 0.5·e)/n against the baseline without {focus.y}; for converted months the PR of the 80 % band bounds in brackets.</>} />
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.m} className={r.m === focus.m ? "dd-row-focus" : undefined}>
                <th scope="row">{r.name}{se && r.m === se.peak ? <span className="dd-tag" title="peak month (highest median)">peak</span> : null}{se?.months.includes(r.m) ? <span className="dd-dot" title="fire season month (mean ≥ 10 % of mean annual total)" /> : null}</th>
                {cells(r.sm)}
                <td className="dd-focus-col">{r.partial ? <span className="dd-partial-txt">partial</span> : fmtF(r.v)}</td>
                <td className="dd-focus-col">{r.pr !== null ? Math.round(r.pr) : "—"}{r.br ? <small> ({Math.round(r.br.prLo)}–{Math.round(r.br.prHi)})</small> : null}</td>
              </tr>
            ))}
            <tr className="dd-row-annual">
              <th scope="row">Annual</th>
              {cells(ann)}
              <td className="dd-focus-col">{ap?.complete ? fmtF(ap.total) : <span className="dd-partial-txt">{ap?.total !== null && ap ? `partial (${monthSpan(ap.firstM, ap.lastM)})` : "—"}</span>}</td>
              <td className="dd-focus-col">{annPr !== null ? Math.round(annPr) : "—"}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="dd-note">Season months are marked with a dot, the peak month with a tag. No band for the annual row (monthly errors are correlated). Mean, SD and CV are shown for completeness: fire counts are heavy-tailed, so the median and IQR are the reference.</p>
    </>
  );
}

/* ── Weather context (descriptive only) ───────────────────────────────── */

function Weather({ index, ring, bbox, focus }: { index: IndexV2; ring: Ring; bbox: [number, number, number, number]; focus: { y: number; m: number } }) {
  const [wx, setWx] = useState<Record<string, MonthRecord[]> | null>(null);
  const [status, setStatus] = useState<"loading" | "ok" | "unavailable">("loading");
  const [err, setErr] = useState<string | null>(null);
  const [nCells, setNCells] = useState(0);
  useEffect(() => {
    let alive = true;
    setStatus("loading"); setErr(null);
    const closed = ring.length > 1 && (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) ? [...ring, ring[0]] : ring;
    let cells: string[] = [];
    try { cells = polygonToCells(closed, 5, true); } catch { /* invalid ring */ }
    if (!cells.length) { try { cells = gridDisk(latLngToCell((bbox[0] + bbox[1]) / 2, (bbox[2] + bbox[3]) / 2, 5), 2); } catch { /* noop */ } }
    if (!cells.length) { setStatus("unavailable"); return; }
    // ≤ 50 cells spread evenly over the zone (the first 50 of polygonToCells would cluster in one corner)
    const stride = Math.max(1, Math.ceil(cells.length / 50));
    const used = cells.filter((_, i) => i % stride === 0).slice(0, 50);
    setNCells(used.length);
    fetch(`/api/weather?cells=${encodeURIComponent(used.join(","))}&from=${B0}-01&to=${index.mois[index.mois.length - 1]}`)
      .then((r) => r.json())
      .then((d: unknown) => {
        if (!alive) return;
        if (!d || typeof d !== "object" || "error" in d) { setErr(d && typeof d === "object" && "error" in d ? String((d as { error: unknown }).error) : "empty response"); setStatus("unavailable"); return; }
        setWx(d as Record<string, MonthRecord[]>); setStatus("ok");
      })
      .catch((e: unknown) => { if (alive) { setErr(e instanceof Error ? e.message : "network error"); setStatus("unavailable"); } });
    return () => { alive = false; };
  }, [ring, bbox, index]);

  const rows = useMemo(() => {
    if (!wx) return null;
    const by = new Map<string, { tmax: number[]; precip: number[]; rh: number[] }>();
    for (const r of Object.values(wx).flat()) {
      const k = `${r.y}-${r.m - 1}`;
      if (!by.has(k)) by.set(k, { tmax: [], precip: [], rh: [] });
      const e = by.get(k)!;
      if (isFinite(r.tmax)) e.tmax.push(r.tmax);
      if (isFinite(r.precip)) e.precip.push(r.precip);
      if (isFinite(r.rh)) e.rh.push(r.rh);
    }
    const mean = (xs?: number[]) => (xs && xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    const one = (f: "tmax" | "precip" | "rh") => {
      const cur = mean(by.get(`${focus.y}-${focus.m}`)?.[f]);
      const base: number[] = [];
      for (let y = B0; y <= B1; y++) { if (y === focus.y) continue; const v = mean(by.get(`${y}-${focus.m}`)?.[f]); if (v !== null) base.push(v); }
      const med = base.length ? S.quantileHF8(S.sortAsc(base), 0.5) : null;
      return { cur, med, n: base.length, pr: cur !== null && base.length ? S.percentileRank(base, cur) : null };
    };
    return { tmax: one("tmax"), precip: one("precip"), rh: one("rh") };
  }, [wx, focus.y, focus.m]);

  const tile = (label: string, def: string, r: { cur: number | null; med: number | null; n: number; pr: number | null } | undefined, unit: string) => (
    <div className="dd-kpi dd-kpi-wx">
      <Def def={def}><span className="dd-kpi-lbl">{label} · {MONTHS[focus.m]} {focus.y}</span></Def>
      <span className="dd-kpi-val">{r?.cur != null ? r.cur.toFixed(1) : "—"} <small>{unit}</small></span>
      <span className="dd-kpi-sub">{r?.med != null ? `median ${r.med.toFixed(1)} ${unit} · PR ${r.pr !== null ? Math.round(r.pr) : "—"} · n=${r.n}` : "—"}</span>
    </div>
  );
  return (
    <>
      <div className="dd-sec-head">
        <Def def={<>Monthly weather of the zone from the Meteomatics API, averaged over ≤ 50 H3 res-5 cell centres of the zone ({nCells || "?"} used). Descriptive only: compared with the same month {B0}–{B1} (focus year left out). No correlation or attribution is computed: monthly fire and weather series share the seasonal cycle and are autocorrelated.</>}>
          <span className="dd-sec-title">Weather context · descriptive</span></Def>
      </div>
      {status === "ok" && rows ? (
        <div className="dd-wx">
          {tile("Daily max temperature", "Mean over the month and the cell centres of the 24-h maximum 2-m temperature (°C).", rows.tmax, "°C")}
          {tile("Precipitation", "Mean over the cell centres of the monthly mean of the 24-h precipitation (mm/day).", rows.precip, "mm/d")}
          {tile("Relative humidity", "Mean 2-m relative humidity over the month and the cell centres (%).", rows.rh, "%")}
        </div>
      ) : (
        <p className="dd-note">{status === "loading" ? "Loading weather…" : `Weather unavailable${err ? ` (${err})` : ""}. The fire statistics above do not depend on it.`}</p>
      )}
      <p className="dd-note">Weather: Meteomatics API, ≤ 50 cell centres of the zone. Correlation ≠ causation; no weather–fire correlation is shown on purpose.</p>
    </>
  );
}

/* ── Styles (dashboard only; visual language of Vigil.tsx: glass panels, mono numbers) ── */

const DD_CSS = `
.hd-dash-pane{overflow:auto;padding:12px 14px 16px}
.dd-root{display:flex;flex-direction:column;gap:10px;min-width:0}
.dd-empty{padding:24px;color:var(--mut);font-style:italic}
.dd-head{display:flex;justify-content:space-between;align-items:flex-end;gap:12px}
.dd-title{font-size:14px;font-weight:750;letter-spacing:.02em}
.dd-title-sub{font-weight:450;font-size:12px;color:#334155}
.dd-note{font-size:11px;color:#334155;line-height:1.4;margin:2px 0 0}
.dd-foot{font-size:10.5px;color:#334155;font-style:italic;margin:0}
.dd-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}
@media (min-width:1500px){.dd-kpis{grid-template-columns:repeat(8,minmax(0,1fr))}}
.dd-kpi{min-width:0;background:rgba(255,255,255,.62);border:1px solid rgba(15,23,42,.08);border-radius:8px;padding:7px 9px;display:flex;flex-direction:column;gap:2px}
.dd-kpi-lbl{font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#1e293b}
.dd-kpi-val{font-size:17px;font-weight:750;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums;color:#0f172a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dd-kpi-val small{font-size:10.5px;font-weight:500;color:#334155}
.dd-kpi-sub{font-size:10.5px;color:#334155;line-height:1.35}
.dd-badge{display:inline-block;padding:0 6px;border-radius:999px;font-size:10px;font-weight:650;border:1px solid rgba(15,23,42,.15)}
.dd-grid{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(0,1fr);gap:8px}
.dd-full{grid-column:1 / -1}
.dd-side{display:flex;flex-direction:column;gap:8px;min-width:0}
.dd-panel{background:rgba(255,255,255,.62);border:1px solid rgba(15,23,42,.08);border-radius:9px;padding:9px 11px;min-width:0;display:flex;flex-direction:column;gap:6px}
.dd-sec-head{display:flex;justify-content:space-between;align-items:center;gap:10px}
.dd-sec-title{font-size:10.5px;font-weight:750;text-transform:uppercase;letter-spacing:.07em;color:#0f172a}
.dd-hint{font-size:10px;color:#475569}
.dd-def{cursor:help;border-bottom:1px dotted rgba(15,23,42,.45);outline:none;border-radius:2px}
.dd-def:focus-visible{outline:2px solid #ea580c;outline-offset:2px}
.dd-pop{position:fixed;z-index:80;background:rgba(15,23,42,.96);color:#f8fafc;border-radius:8px;padding:8px 10px;font:12px/1.4 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;box-shadow:0 8px 24px rgba(15,23,42,.25);pointer-events:none;text-transform:none;letter-spacing:0;font-weight:400}
.dd-tt{font-weight:700;margin-bottom:4px;font-family:ui-monospace,Menlo,monospace}
.dd-tr{display:flex;justify-content:space-between;gap:10px;padding:1px 0}
.dd-tr span{color:#cbd5e1}
.dd-tr b{font-weight:650;font-variant-numeric:tabular-nums;text-align:right}
.dd-tr.dim{font-size:11px}
.dd-tn{font-size:10.5px;color:#fde68a;margin-top:3px}
.dd-sep{height:1px;background:rgba(148,163,184,.35);margin:5px 0}
.dd-cal{display:grid;grid-template-columns:62px repeat(12,minmax(30px,1fr)) minmax(70px,1.25fr);gap:2px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums;user-select:none}
.dd-cal-panel{overflow-x:auto}
.dd-ch{font-size:10px;font-weight:650;text-align:center;color:#1e293b;font-family:Inter,ui-sans-serif,system-ui,sans-serif}
.dd-rh{font-size:10.5px;display:flex;align-items:center;color:#1e293b}
.dd-med-lbl{font-family:Inter,ui-sans-serif,system-ui,sans-serif;font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.03em}
.dd-c{height:19px;border-radius:2px;font-size:10px;display:flex;align-items:center;justify-content:center;cursor:pointer;outline:none;white-space:nowrap;overflow:hidden}
.dd-c:hover,.dd-c:focus-visible{box-shadow:inset 0 0 0 1.5px #0f172a}
.dd-med{background:#fff;border:1px solid #cbd5e1;font-weight:700;color:#0f172a;cursor:help}
.dd-ann{justify-content:flex-end;padding:0 5px;gap:4px;cursor:help}
.dd-ann small{font-size:9px;opacity:.85}
.dd-ann-h{text-align:right;padding-right:4px}
.dd-nodata{background:repeating-linear-gradient(45deg,#f1f5f9 0 3px,#d9dee5 3px 4px);cursor:default}
.dd-partial{background:#fff7ed repeating-linear-gradient(45deg,rgba(234,88,12,.28) 0 2px,transparent 2px 5px);color:#7c2d12;font-style:italic}
.dd-focus{box-shadow:inset 0 0 0 2px #0f172a!important;font-weight:800}
.dd-legend{display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;font-size:10.5px;color:#1e293b;margin-top:4px}
.dd-leg-ramp{display:inline-flex}
.dd-leg-ramp i{width:22px;height:11px;display:inline-block}
.dd-leg-ticks{display:inline-flex;gap:10px;font-family:ui-monospace,Menlo,monospace;font-size:10px}
.dd-leg-txt{flex-basis:100%;font-size:10px;color:#334155}
.dd-leg-item{display:inline-flex;align-items:center;gap:5px}
.dd-sw{display:inline-block;width:14px;height:10px;border-radius:2px;border:1px solid rgba(15,23,42,.15)}
.dd-chart{height:220px;min-width:0}
.dd-chart-sm{height:150px}
.dd-chart-leg{display:flex;flex-wrap:wrap;gap:12px;font-size:10.5px;color:#1e293b}
.dd-chart-leg span{display:inline-flex;align-items:center;gap:5px}
.dd-chart-leg i{display:inline-block}
.dd-l-line{width:18px;height:2px;background:#ea580c}
.dd-l-hollow{width:9px;height:9px;border-radius:50%;border:1.6px solid #ea580c;background:#fff}
.dd-l-band{width:16px;height:9px;background:rgba(148,163,184,.4)}
.dd-l-or{background:rgba(234,88,12,.25)}
.dd-l-dash{width:18px;border-top:1.5px dashed #64748b}
.dd-l-dot{width:6px;height:6px;border-radius:50%;background:#0f172a}
.dd-frp2{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.dd-mini{font-size:10px;font-weight:650;color:#1e293b;margin-bottom:2px}
.dd-table-wrap{overflow-x:auto}
.dd-table{border-collapse:collapse;width:100%;font-size:11px;font-variant-numeric:tabular-nums}
.dd-table th,.dd-table td{padding:3px 7px;text-align:right;white-space:nowrap;border-bottom:1px solid rgba(15,23,42,.07)}
.dd-table thead th{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#0f172a;border-bottom:1px solid rgba(15,23,42,.25);position:sticky;top:0;background:rgba(248,250,252,.95)}
.dd-table tbody th{text-align:left;font-weight:650}
.dd-table td{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.dd-table small{color:#475569;font-size:10px}
.dd-strong{font-weight:750}
.dd-secondary{color:#64748b}
.dd-table thead th.dd-secondary{color:#64748b}
.dd-focus-col{background:rgba(234,88,12,.06)}
.dd-row-focus{background:rgba(15,23,42,.06)}
.dd-row-annual th,.dd-row-annual td{border-top:1px solid rgba(15,23,42,.3);font-weight:650}
.dd-tag{margin-left:5px;font-size:8.5px;font-weight:700;text-transform:uppercase;color:#9a3412;background:#ffedd5;border-radius:3px;padding:0 3px}
.dd-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:#ea580c;margin-left:5px;vertical-align:middle}
.dd-partial-txt{font-style:italic;color:#9a3412}
.dd-wx{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}
@media (max-width:1100px){.dd-grid{grid-template-columns:minmax(0,1fr)}.dd-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:640px){.dd-kpis,.dd-wx,.dd-frp2{grid-template-columns:minmax(0,1fr)}.dd-cal{grid-template-columns:40px repeat(12,minmax(22px,1fr)) 52px}.dd-c{font-size:8.5px}}
`;
