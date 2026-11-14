"use client";

/**
 * Deep-dive analytics of a zone (Aramis, PR #6), on the contract-v2 series (app/zone.ts):
 * KPI tiles of the focus month (hotspots, vs median 2003-2025, class) + weather of the zone
 * (/api/weather, Meteomatics, H3 res-5 cell centres) and three charts. Kept in its own file so that
 * map / panel work (app/Vigil.tsx) and analytics work do not edit the same file.
 * The former "2012 sensor check" chart needed raw per-sensor counts, absent from the v2 files: removed.
 */
import React, { useEffect, useMemo, useState } from "react";
import { gridDisk, latLngToCell, polygonToCells } from "h3-js";
import {
  ResponsiveContainer, ComposedChart, ScatterChart, Bar, Line, Scatter,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ReferenceLine, Cell as RCell,
} from "recharts";
import { indiceMois, type IndexV2, type Ring } from "./donnees";
import type { SerieZone, StatMois } from "./zone";

type MonthRecord = { y: number; m: number; tmax: number; precip: number; rh: number; wind: number };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const H3_RES = 5;
const BASE_Y0 = 2003, BASE_Y1 = 2025; // same reference years as the median of app/zone.ts (E7)
const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");

function spearman(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 3) return NaN;
  const rnk = (arr: number[]) => {
    const sorted = arr.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
    const r = new Array<number>(n);
    sorted.forEach((e, ri) => { r[e.i] = ri + 1; });
    return r;
  };
  const rx = rnk(xs), ry = rnk(ys);
  const mean = (n + 1) / 2;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) {
    cov += (rx[i] - mean) * (ry[i] - mean);
    vx += (rx[i] - mean) ** 2;
    vy += (ry[i] - mean) ** 2;
  }
  return vx && vy ? cov / Math.sqrt(vx * vy) : NaN;
}
const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export interface DeepDiveProps {
  index: IndexV2;
  serie: SerieZone | null;
  ring: Ring;
  bbox: [number, number, number, number];
  y0: number;
  y1: number;
  focus: { y: number; m: number };
  /** statMois(serie, index, focus, "hotspots") — the same E7 numbers as the panel and the tooltip. */
  stat: StatMois | null;
}

export default function DeepDive({ index, serie, ring, bbox, y0, y1, focus, stat }: DeepDiveProps) {
  const [wxData, setWxData] = useState<Record<string, MonthRecord[]> | null>(null);
  const [wxStatus, setWxStatus] = useState<"idle" | "loading" | "ok" | "unavailable">("idle");
  const [wxError, setWxError] = useState<string | null>(null);

  /* Weather of the zone: H3 res-5 cells of the ring (fallback: around the zone centre), at most 50 */
  useEffect(() => {
    let vivant = true;
    setWxStatus("loading"); setWxError(null);
    const closed = ring.length > 1 && (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) ? [...ring, ring[0]] : ring;
    let cells: string[] = [];
    try { cells = polygonToCells(closed, H3_RES, true); } catch { /* invalid ring */ }
    if (!cells.length) {
      try { cells = gridDisk(latLngToCell((bbox[0] + bbox[1]) / 2, (bbox[2] + bbox[3]) / 2, H3_RES), 2); } catch { /* noop */ }
    }
    if (!cells.length) { setWxStatus("unavailable"); return; }
    const last = index.mois[index.mois.length - 1];
    fetch(`/api/weather?cells=${encodeURIComponent(cells.slice(0, 50).join(","))}&from=${y0}-01&to=${last}`)
      .then((r) => r.json())
      .then((d: unknown) => {
        if (!vivant) return;
        if (d && typeof d === "object" && "error" in d) { setWxError(String((d as { error: unknown }).error)); setWxStatus("unavailable"); return; }
        setWxData(d as Record<string, MonthRecord[]>); setWxStatus("ok");
      })
      .catch((e: unknown) => { if (vivant) { setWxError(e instanceof Error ? e.message : "Network error"); setWxStatus("unavailable"); } });
    return () => { vivant = false; };
  }, [ring, bbox, index, y0]);

  /* Harmonized hotspots of the zone, complete months only (a partial month is not comparable) */
  const fires = (y: number, m: number): number | null => {
    if (!serie) return null;
    const c = serie.mois[indiceMois(index, y, m)];
    return c && !c.partiel ? c.hotspots : null;
  };

  const dd = useMemo(() => {
    const wxYM = new Map<string, { tmax: number[]; precip: number[]; rh: number[]; wind: number[] }>();
    for (const r of wxData ? Object.values(wxData).flat() : []) {
      const k = `${r.y}-${r.m}`;
      if (!wxYM.has(k)) wxYM.set(k, { tmax: [], precip: [], rh: [], wind: [] });
      const e = wxYM.get(k)!;
      e.tmax.push(r.tmax); e.precip.push(r.precip); e.rh.push(r.rh); e.wind.push(r.wind);
    }
    const wmean = (y: number, m1: number, f: "tmax" | "precip" | "rh" | "wind") => mean(wxYM.get(`${y}-${m1}`)?.[f] ?? []);

    const c1: { label: string; fires: number; tmax: number | null; precip: number | null }[] = [];
    for (let y = y0; y <= y1; y++) for (let m = 0; m < 12; m++) {
      const f = fires(y, m);
      if (f === null) continue;
      c1.push({ label: `${y}-${String(m + 1).padStart(2, "0")}`, fires: f, tmax: wmean(y, m + 1, "tmax"), precip: wmean(y, m + 1, "precip") });
    }
    const tV = c1.map((p) => p.tmax).filter((v): v is number => v !== null);
    const pV = c1.map((p) => p.precip).filter((v): v is number => v !== null);
    const [tMin, tMax, pMin, pMax] = [Math.min(...tV), Math.max(...tV), Math.min(...pV), Math.max(...pV)];
    const nT = (v: number) => (tMax > tMin ? (v - tMin) / (tMax - tMin) : 0);
    const nP = (v: number) => (pMax > pMin ? (v - pMin) / (pMax - pMin) : 0);
    // Hot/dry index: normalised Tmax x (1 - normalised rain), split at the VIIRS conversion date
    const bascule = new Date(index.bascule_viirs + "T00:00:00Z");
    const kB = bascule.getUTCFullYear() * 12 + bascule.getUTCMonth();
    const c3pre: { hdi: number; fires: number; label: string }[] = [], c3post: typeof c3pre = [];
    for (const p of c1) {
      if (p.tmax === null || p.precip === null) continue;
      const [y, m] = p.label.split("-").map(Number);
      ((y * 12 + m - 1) < kB ? c3pre : c3post).push({ hdi: nT(p.tmax) * Math.max(0, 1 - nP(p.precip)), fires: p.fires, label: p.label });
    }
    const all = [...c3pre, ...c3post];
    const spR = all.length >= 3 ? spearman(all.map((p) => p.hdi), all.map((p) => p.fires)) : NaN;

    // Seasonal profile: median of each calendar month over the reference years
    const c2 = MONTHS.map((name, mi) => {
      const fv: number[] = [], tv: number[] = [], pv: number[] = [];
      for (let y = BASE_Y0; y <= BASE_Y1; y++) {
        const f = fires(y, mi); if (f !== null) fv.push(f);
        const t = wmean(y, mi + 1, "tmax"); if (t !== null) tv.push(t);
        const r = wmean(y, mi + 1, "precip"); if (r !== null) pv.push(r);
      }
      return { name, fires: median(fv) ?? 0, tmax: median(tv), precip: median(pv), sel: mi === focus.m };
    });

    // Weather of the focus month vs the median of the same month 2003-2025 (focus year excluded)
    const ref = (f: "tmax" | "precip" | "rh" | "wind") => {
      const xs: number[] = [];
      for (let y = BASE_Y0; y <= BASE_Y1; y++) { if (y === focus.y) continue; const v = wmean(y, focus.m + 1, f); if (v !== null) xs.push(v); }
      return median(xs);
    };
    const delta = (f: "tmax" | "precip" | "rh" | "wind", unit: string, pct: boolean) => {
      const cur = wmean(focus.y, focus.m + 1, f), r = ref(f);
      if (cur === null || r === null || r === 0) return null;
      const d = cur - r, s = d >= 0 ? "+" : "−";
      return pct ? `${s}${Math.abs(Math.round((d / r) * 100))} %` : `${s}${Math.abs(d).toFixed(1)} ${unit}`;
    };
    return { c1, c2, c3pre, c3post, spR, wx: { tmax: delta("tmax", "°C", false), rain: delta("precip", "", true), rh: delta("rh", "%p", false) } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wxData, serie, index, y0, y1, focus.y, focus.m]);

  const focusLabel = `${focus.y}-${String(focus.m + 1).padStart(2, "0")}`;
  const wxVal = (v: string | null) => (wxStatus === "ok" ? v ?? "—" : wxStatus === "loading" ? "…" : "—");
  const noWx = wxStatus === "unavailable" ? <div className="hd-dd-nowx">Weather unavailable{wxError ? ` — ${wxError}` : ""}</div> : null;
  const tipStyle = { fontSize: 10, background: "rgba(15,23,42,.92)", border: 0, color: "#f8fafc", borderRadius: 6, padding: "5px 9px" };

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: DD_CSS }} />
      <div className="hd-dd-kpi6">
        <div className="hd-kpi-cell"><span className="hd-kpi-lbl">Hotspots · {MONTHS[focus.m]} {focus.y}</span>
          <span className="hd-kpi-val">{fires(focus.y, focus.m) !== null ? fmtInt(fires(focus.y, focus.m)!) : "—"}</span>
          <span className="hd-kpi-sub">harmonized, MODIS-Aqua eq.</span></div>
        <div className="hd-kpi-cell"><span className="hd-kpi-lbl">vs median {BASE_Y0}–{BASE_Y1}</span>
          <span className="hd-kpi-val">{stat?.pctMediane != null ? `${Math.round(stat.pctMediane)} %` : "—"}</span>
          <span className="hd-kpi-sub">{stat ? `median ${fmtInt(stat.mediane)}` : ""}</span></div>
        <div className="hd-kpi-cell"><span className="hd-kpi-lbl">Class</span>
          <span className="hd-kpi-val hd-kpi-txt">{stat?.classe ?? "—"}</span>
          <span className="hd-kpi-sub">{stat ? `percentile ${Math.round(stat.rang)} · ${stat.n} yrs` : ""}</span></div>
        <div className="hd-kpi-cell"><span className="hd-kpi-lbl">Tmax</span><span className="hd-kpi-val">{wxVal(dd.wx.tmax)}</span><span className="hd-kpi-sub">vs median</span></div>
        <div className="hd-kpi-cell"><span className="hd-kpi-lbl">Rain</span><span className="hd-kpi-val">{wxVal(dd.wx.rain)}</span><span className="hd-kpi-sub">vs median</span></div>
        <div className="hd-kpi-cell"><span className="hd-kpi-lbl">Humidity</span><span className="hd-kpi-val">{wxVal(dd.wx.rh)}</span><span className="hd-kpi-sub">vs median</span></div>
      </div>

      <div className="hd-dd-charts">
        <div className="hd-dd-chart">
          <div className="hd-dd-ctitle">Hotspots vs temperature</div>
          <div className="hd-dd-chartbody">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={dd.c1} margin={{ top: 4, right: 32, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="rgba(15,23,42,0.1)" strokeDasharray="2 2" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 8, fill: "#94a3b8" }} interval={23} tickLine={false} axisLine={false} />
                <YAxis yAxisId="fires" tick={{ fontSize: 8, fill: "#94a3b8" }} tickLine={false} axisLine={false} width={30} />
                <YAxis yAxisId="temp" orientation="right" tick={{ fontSize: 8, fill: "#94a3b8" }} tickLine={false} axisLine={false} width={22} unit="°" />
                <Tooltip contentStyle={tipStyle} labelStyle={{ color: "#94a3b8", marginBottom: 2 }} />
                <Legend iconSize={7} wrapperStyle={{ fontSize: 9, color: "#64748b" }} />
                <Line yAxisId="fires" type="monotone" dataKey="fires" stroke="#ea580c" strokeWidth={1} dot={false} name="Hotspots (harmonized)" />
                {wxStatus === "ok" && <Line yAxisId="temp" type="monotone" dataKey="tmax" stroke="#94a3b8" strokeWidth={1} dot={false} name="Tmax °C" connectNulls />}
                <ReferenceLine yAxisId="fires" x={focusLabel} stroke="#0f172a" strokeWidth={1.5} strokeOpacity={0.4} />
              </ComposedChart>
            </ResponsiveContainer>
            {noWx}
          </div>
        </div>

        <div className="hd-dd-chart">
          <div className="hd-dd-ctitle">Seasonal profile (median {BASE_Y0}–{BASE_Y1})</div>
          <div className="hd-dd-chartbody">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={dd.c2} margin={{ top: 4, right: 32, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="rgba(15,23,42,0.1)" strokeDasharray="2 2" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 8, fill: "#94a3b8" }} tickLine={false} axisLine={false} />
                <YAxis yAxisId="fires" tick={{ fontSize: 8, fill: "#94a3b8" }} tickLine={false} axisLine={false} width={30} />
                <YAxis yAxisId="wx" orientation="right" tick={{ fontSize: 8, fill: "#94a3b8" }} tickLine={false} axisLine={false} width={22} />
                <Tooltip contentStyle={tipStyle} labelStyle={{ color: "#94a3b8", marginBottom: 2 }} />
                <Legend iconSize={7} wrapperStyle={{ fontSize: 9, color: "#64748b" }} />
                <Bar yAxisId="fires" dataKey="fires" name="Hotspots (median)" radius={[2, 2, 0, 0]}>
                  {dd.c2.map((e, i) => <RCell key={i} fill="#ea580c" fillOpacity={e.sel ? 1 : 0.5} />)}
                </Bar>
                {wxStatus === "ok" && <Line yAxisId="wx" type="monotone" dataKey="tmax" stroke="#94a3b8" strokeWidth={1.5} dot={false} name="Tmax (med.)" connectNulls />}
                {wxStatus === "ok" && <Line yAxisId="wx" type="monotone" dataKey="precip" stroke="#94a3b8" strokeWidth={1.5} strokeDasharray="4 3" dot={false} name="Precip (med.)" connectNulls />}
              </ComposedChart>
            </ResponsiveContainer>
            {noWx}
          </div>
        </div>

        <div className="hd-dd-chart hd-dd-wide">
          <div className="hd-dd-ctitle">
            Hotspots vs hot/dry index
            {!isNaN(dd.spR) && <span className="hd-dd-corr"> · ρ = {dd.spR.toFixed(2)} (Spearman)</span>}
          </div>
          <div className="hd-dd-chartbody">
            {dd.c3pre.length + dd.c3post.length < 3 ? (
              <div className="hd-dd-nowx">Weather unavailable{wxError ? ` — ${wxError}` : ""}</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <ScatterChart margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke="rgba(15,23,42,0.1)" strokeDasharray="2 2" />
                  <XAxis type="number" dataKey="hdi" name="Hot/dry index" tick={{ fontSize: 8, fill: "#94a3b8" }} tickLine={false} axisLine={false} domain={[0, "dataMax"]} tickFormatter={(v: number) => v.toFixed(2)} />
                  <YAxis type="number" dataKey="fires" name="Hotspots" tick={{ fontSize: 8, fill: "#94a3b8" }} tickLine={false} axisLine={false} width={30} />
                  <Tooltip cursor={{ strokeDasharray: "3 3" }} content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const d = payload[0]?.payload as { hdi: number; fires: number; label: string };
                    return <div style={tipStyle}><div style={{ color: "#94a3b8", marginBottom: 2 }}>{d.label}</div><div>Hotspots: {fmtInt(d.fires)}</div><div>HDI: {d.hdi.toFixed(3)}</div></div>;
                  }} />
                  <Legend iconSize={7} wrapperStyle={{ fontSize: 9, color: "#64748b" }} />
                  <Scatter name="MODIS Aqua observed" data={dd.c3pre} fill="#ea580c" fillOpacity={0.65} />
                  <Scatter name="VIIRS converted" data={dd.c3post} fill="#64748b" fillOpacity={0.65} />
                </ScatterChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </div>
      <p className="hd-wx-attr">Weather: Meteomatics API (H3 res-5 cell centres, ≤ 50 cells). Hotspots: NASA FIRMS, VIGIL-K1 harmonized.</p>
    </>
  );
}

const DD_CSS = `
.hd-split-body{gap:8px}
.hd-split-pane:not(.hd-split-analytics){flex:0 0 44%}
.hd-split-analytics{flex:1;overflow:hidden;min-width:0;display:flex;flex-direction:column;gap:6px}
.hd-dd-kpi6{display:grid;grid-template-columns:repeat(6,1fr);gap:4px;flex-shrink:0}
.hd-kpi-cell{min-width:0;background:rgba(15,23,42,.03);border:1px solid var(--bd);border-radius:6px;padding:5px 7px;display:flex;flex-direction:column;gap:2px}
.hd-kpi-lbl{font-size:9px;font-weight:650;text-transform:uppercase;letter-spacing:.06em;color:var(--mut);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hd-kpi-val{font-size:13px;font-weight:700;font-variant-numeric:tabular-nums;font-family:ui-monospace,Menlo,monospace;color:var(--tx)}
.hd-kpi-txt{font-size:11px;font-family:inherit}
.hd-kpi-sub{font-size:9px;color:var(--mut)}
.hd-dd-charts{flex:1;min-height:0;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:6px}
.hd-dd-wide{grid-column:1 / span 2}
.hd-dd-chart{background:var(--bg);border:1px solid rgba(15,23,42,0.1);border-radius:8px;padding:7px 9px 5px;display:flex;flex-direction:column;gap:3px;min-height:0;overflow:hidden}
.hd-dd-ctitle{font-size:9px;font-weight:650;text-transform:uppercase;letter-spacing:.07em;color:var(--mut);flex-shrink:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hd-dd-corr{font-weight:400;text-transform:none;letter-spacing:0;font-size:9px}
.hd-dd-chartbody{flex:1;min-height:0;position:relative}
.hd-dd-nowx{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:10px;color:var(--mut);font-style:italic;text-align:center;padding:8px;pointer-events:none}
.hd-wx-attr{font-size:9.5px;color:var(--mut);font-style:italic;margin:0;margin-top:auto;padding-top:4px}
@media (max-width:900px){.hd-split-body{flex-direction:column}.hd-split-pane:not(.hd-split-analytics){flex:0 0 auto}.hd-dd-kpi6{grid-template-columns:repeat(3,1fr)}}
`;
