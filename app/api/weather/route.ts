import { NextRequest, NextResponse } from "next/server";
import { cellToLatLng } from "h3-js";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

const CACHE_DIR = path.join(process.cwd(), "data", "weather-cache");
const MAX_CELLS = 50;
const PARAMS = "t_max_2m_24h:C,precip_24h:mm,relative_humidity_2m:p,wind_speed_10m:ms";

type MonthRecord = { y: number; m: number; tmax: number; precip: number; rh: number; wind: number };

function loadCache(cellId: string): MonthRecord[] {
  const p = path.join(CACHE_DIR, `${cellId}.json`);
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8")) as MonthRecord[];
  } catch { /* ignore corrupt cache */ }
  return [];
}

function saveCache(cellId: string, data: MonthRecord[]) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(path.join(CACHE_DIR, `${cellId}.json`), JSON.stringify(data));
}

function mk(y: number, m: number) { return `${y}-${m}`; }

function requestedMonths(from: string, to: string): { y: number; m: number }[] {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  const months: { y: number; m: number }[] = [];
  let y = fy, m = fm;
  while (y < ty || (y === ty && m <= tm)) {
    months.push({ y, m });
    if (++m > 12) { m = 1; y++; }
  }
  return months;
}

function extractLocKey(stationId: string): string | null {
  // "lat_{X}_lon_{Y}" format used by Meteomatics multi-point CSV
  const m1 = stationId.match(/lat_(-?[\d.]+)_lon_(-?[\d.]+)/i);
  if (m1) return `${parseFloat(m1[1]).toFixed(4)},${parseFloat(m1[2]).toFixed(4)}`;
  // plain "X,Y" format
  const m2 = stationId.match(/^(-?[\d.]+),(-?[\d.]+)$/);
  if (m2) return `${parseFloat(m2[1]).toFixed(4)},${parseFloat(m2[2]).toFixed(4)}`;
  return null;
}

function parseMeteoCsv(
  text: string,
  singleLocKey?: string,
): Map<string, { date: string; tmax: number; precip: number; rh: number; wind: number }[]> {
  const lines = text.trim().split("\n");
  if (lines.length < 2) return new Map();
  const sep = lines[0].includes(";") ? ";" : ",";
  const header = lines[0].trim().toLowerCase();
  // Single-point format: first column is "validdate", no location prefix
  const singlePoint = header.startsWith("validdate");
  const result = new Map<
    string,
    { date: string; tmax: number; precip: number; rh: number; wind: number }[]
  >();
  if (singlePoint && singleLocKey) result.set(singleLocKey, []);
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].trim().split(sep);
    if (singlePoint) {
      if (!singleLocKey || parts.length < 5) continue;
      result.get(singleLocKey)!.push({
        date: parts[0].trim(),
        tmax: parseFloat(parts[1]),
        precip: parseFloat(parts[2]),
        rh: parseFloat(parts[3]),
        wind: parseFloat(parts[4]),
      });
    } else {
      if (parts.length < 6) continue;
      const locKey = extractLocKey(parts[0].trim());
      if (!locKey) continue;
      if (!result.has(locKey)) result.set(locKey, []);
      result.get(locKey)!.push({
        date: parts[1].trim(),
        tmax: parseFloat(parts[2]),
        precip: parseFloat(parts[3]),
        rh: parseFloat(parts[4]),
        wind: parseFloat(parts[5]),
      });
    }
  }
  return result;
}

export async function GET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const cells = (sp.get("cells") ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean)
    .slice(0, MAX_CELLS);
  const from = sp.get("from") ?? "";
  const to = sp.get("to") ?? "";

  if (!cells.length || !from || !to) {
    return NextResponse.json({ error: "Missing params: cells, from, to" }, { status: 400 });
  }

  const user = process.env.MM_USER;
  const pass = process.env.MM_PASS;
  if (!user || !pass) {
    return NextResponse.json(
      { error: "Weather credentials not configured (MM_USER / MM_PASS in .env.local)" },
      { status: 503 },
    );
  }

  try {
    const allMonths = requestedMonths(from, to);
    const caches = new Map<string, MonthRecord[]>(cells.map((c) => [c, loadCache(c)]));

    // Cells that need any months fetched
    const toFetch = cells.filter((c) => {
      const covered = new Set(caches.get(c)!.map((r) => mk(r.y, r.m)));
      return allMonths.some((mo) => !covered.has(mk(mo.y, mo.m)));
    });

    if (toFetch.length > 0) {
      const coordMap = new Map(toFetch.map((c) => [c, cellToLatLng(c)]));
      // reverse: "lat,lon" string → cellId
      const locKeyToCell = new Map(
        toFetch.map((c) => {
          const [lat, lon] = coordMap.get(c)!;
          return [`${lat.toFixed(4)},${lon.toFixed(4)}`, c];
        }),
      );
      const locStr = toFetch
        .map((c) => {
          const [lat, lon] = coordMap.get(c)!;
          return `${lat.toFixed(4)},${lon.toFixed(4)}`;
        })
        .join("+");

      // Collect all missing year-month keys
      const missingSet = new Set<string>();
      for (const c of toFetch) {
        const covered = new Set(caches.get(c)!.map((r) => mk(r.y, r.m)));
        for (const mo of allMonths) {
          if (!covered.has(mk(mo.y, mo.m))) missingSet.add(mk(mo.y, mo.m));
        }
      }

      // Group by year → find min/max month per year
      const byYear = new Map<number, { min: number; max: number }>();
      for (const key of missingSet) {
        const [y, m] = key.split("-").map(Number);
        const e = byYear.get(y);
        byYear.set(y, e ? { min: Math.min(e.min, m), max: Math.max(e.max, m) } : { min: m, max: m });
      }

      const auth = Buffer.from(`${user}:${pass}`).toString("base64");
      let reqCount = 0;

      for (const [year, { min, max }] of Array.from(byYear).sort(([a], [b]) => a - b)) {
        const startStr = `${year}-${String(min).padStart(2, "0")}-01T00:00:00Z`;
        const endYear = max === 12 ? year + 1 : year;
        const endMon = max === 12 ? 1 : max + 1;
        const endStr = `${endYear}-${String(endMon).padStart(2, "0")}-01T00:00:00Z`;
        const url = `https://api.meteomatics.com/${startStr}--${endStr}:P1D/${PARAMS}/${locStr}/csv`;

        const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
        reqCount++;
        if (!res.ok) {
          throw new Error(`Meteomatics ${res.status}: ${(await res.text()).slice(0, 300)}`);
        }

        const rawCsv = await res.text();
        const singleLocKey = toFetch.length === 1
          ? (() => { const [lat, lon] = coordMap.get(toFetch[0])!; return `${lat.toFixed(4)},${lon.toFixed(4)}`; })()
          : undefined;
        const parsed = parseMeteoCsv(rawCsv, singleLocKey);

        for (const [locKey, days] of parsed) {
          const cellId = locKeyToCell.get(locKey);
          if (!cellId) continue;
          const existing = caches.get(cellId)!;
          const coveredSet = new Set(existing.map((r) => mk(r.y, r.m)));

          // Aggregate daily → monthly
          const byMonth = new Map<
            string,
            { tmax: number[]; precip: number[]; rh: number[]; wind: number[] }
          >();
          for (const { date, tmax, precip, rh, wind } of days) {
            const d = new Date(date);
            const k = mk(d.getFullYear(), d.getMonth() + 1);
            if (!byMonth.has(k)) byMonth.set(k, { tmax: [], precip: [], rh: [], wind: [] });
            const mo = byMonth.get(k)!;
            if (!isNaN(tmax)) mo.tmax.push(tmax);
            if (!isNaN(precip)) mo.precip.push(precip);
            if (!isNaN(rh)) mo.rh.push(rh);
            if (!isNaN(wind)) mo.wind.push(wind);
          }

          for (const [k, v] of byMonth) {
            if (coveredSet.has(k)) continue;
            const [y, m] = k.split("-").map(Number);
            const avg = (a: number[]) =>
              a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
            const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
            existing.push({
              y,
              m,
              tmax: +avg(v.tmax).toFixed(1),
              precip: +sum(v.precip).toFixed(1),
              rh: +avg(v.rh).toFixed(1),
              wind: +avg(v.wind).toFixed(1),
            });
          }

          saveCache(cellId, existing.sort((a, b) => (a.y !== b.y ? a.y - b.y : a.m - b.m)));
        }
      }

      console.log(
        `[weather] ${reqCount} Meteomatics request(s) sent for ${toFetch.length} cell(s)`,
      );
    }

    // Build response filtered to requested period
    const coveredSet = new Set(allMonths.map((mo) => mk(mo.y, mo.m)));
    const result: Record<string, MonthRecord[]> = {};
    for (const c of cells) {
      result[c] = (caches.get(c) ?? [])
        .filter((r) => coveredSet.has(mk(r.y, r.m)))
        .sort((a, b) => (a.y !== b.y ? a.y - b.y : a.m - b.m));
    }

    return NextResponse.json(result);
  } catch (err) {
    console.error("[weather] error:", err);
    return NextResponse.json({ error: String(err) }, { status: 503 });
  }
}
