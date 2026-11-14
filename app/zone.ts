/**
 * Monthly series of a zone from the v2 files, and the statistics of docs/contrat_donnees_v2.md §4–5:
 * hexagons are summed month by month FIRST, the band and the statistics are computed on that total
 * (never a sum of bounds, never a median of medians).
 */
import {
  cleMois, dansZone, estConverti, indiceMois, moisPartiel, texteMois,
  type IncertitudeV2, type IndexV2, type Ring, type SeriePays, type TableQuantiles, type Tuile,
} from "./donnees";

export type Metrique = "hotspots" | "frp";

export interface MoisZone {
  y: number;
  m: number;
  hotspots: number;
  frp: number;
  /** Bands of the zone total (equal to the value when Aqua is observed). null = not available. */
  bas80: number | null; haut80: number | null;
  bas95: number | null; haut95: number | null;
  frpBas80: number | null; frpHaut80: number | null;
  converti: boolean;
  partiel: boolean;
  /** Days with data in the month (country mode only). */
  couverture: number | null;
}

export interface SerieZone {
  /** One entry per month index of the contract (0 = mois_index_0); null = month not exported (no data). */
  mois: (MoisZone | null)[];
  source: "pays" | "h3";
  /** Hexagons whose centre is inside the zone (h3 mode). */
  hexagones: string[];
  /** Which uncertainty table gave the hotspots band. */
  table: "hotspots" | "hotspots_sous_pays" | null;
  fiabilite?: string;
  fiabiliteFrp?: string | null;
  sousRegion?: string;
}

/* ── Conformal band (incertitude.json) ─────────────────────────────────── */

/** Class of a total: number of inner bounds strictly below x (pandas.cut, right-closed intervals). */
function classe(x: number, table: { classes_bornes: number[]; noms?: string[]; quantiles: TableQuantiles["quantiles"] }, niveau: string): string | null {
  const q = table.quantiles[niveau];
  if (!q) return null;
  const noms = table.noms ?? Object.keys(q);
  let bornes = table.classes_bornes;
  if (bornes.length === noms.length + 1) bornes = bornes.slice(1, -1); // full edges given
  let c = 0;
  while (c < bornes.length && x > bornes[c]) c++;
  return noms[Math.min(c, noms.length - 1)] ?? null;
}

/** [low, high] of a zone total x for a converted month: exp(log(1+x) + q) − 1, floored at 0. */
export function fourchette(
  x: number, table: { classes_bornes: number[]; noms?: string[]; quantiles: TableQuantiles["quantiles"] } | undefined, niveau: "0.8" | "0.95",
): [number, number] | null {
  if (!table) return null;
  const c = classe(x, table, niveau);
  const q = c ? table.quantiles[niveau]?.[c] : undefined;
  if (!q) return null;
  const l = Math.log1p(x);
  return [Math.max(0, Math.expm1(l + q.q_bas)), Math.max(0, Math.expm1(l + q.q_haut))];
}

/* ── Building the series ───────────────────────────────────────────────── */

function vide(index: IndexV2): (MoisZone | null)[] {
  const dernier = cleMois(index.mois[index.mois.length - 1]);
  return new Array(indiceMois(index, dernier.y, dernier.m) + 1).fill(null);
}
const moisDe = (index: IndexV2, i: number) => {
  const o = cleMois(index.mois_index_0);
  const k = o.y * 12 + o.m + i;
  return { y: Math.floor(k / 12), m: k % 12 };
};

/** Zone drawn or picked on the map: sum of the hexagons whose centre is inside, then bands on the total. */
export function serieH3(
  index: IndexV2, inc: IncertitudeV2 | null, tuiles: Tuile[], bbox: [number, number, number, number], ring: Ring,
): SerieZone {
  const out = vide(index);
  const sh = new Float64Array(out.length), sf = new Float64Array(out.length);
  const hexagones: string[] = [];
  for (const t of tuiles) {
    for (const [h, parMois] of t) {
      if (!dansZone(h, bbox, ring)) continue;
      hexagones.push(h);
      for (const [i, v] of parMois) if (i < out.length) { sh[i] += v.hotspots; sf[i] += v.frp; }
    }
  }
  const presents = new Set(index.mois);
  const partiel = moisPartiel(index);
  const tableH = inc?.hotspots_sous_pays ?? inc?.hotspots;
  for (let i = 0; i < out.length; i++) {
    const { y, m } = moisDe(index, i);
    const t = texteMois(y, m);
    if (!presents.has(t)) continue; // month not exported: no data, not zero
    const converti = estConverti(index, y, m);
    const b80 = converti ? fourchette(sh[i], tableH, "0.8") : [sh[i], sh[i]];
    const b95 = converti ? fourchette(sh[i], tableH, "0.95") : [sh[i], sh[i]];
    const f80 = converti ? fourchette(sf[i], inc?.frp_MW, "0.8") : [sf[i], sf[i]];
    out[i] = {
      y, m, hotspots: sh[i], frp: sf[i],
      bas80: b80?.[0] ?? null, haut80: b80?.[1] ?? null, bas95: b95?.[0] ?? null, haut95: b95?.[1] ?? null,
      frpBas80: f80?.[0] ?? null, frpHaut80: f80?.[1] ?? null,
      converti, partiel: t === partiel, couverture: null,
    };
  }
  return { mois: out, source: "h3", hexagones, table: inc ? (inc.hotspots_sous_pays ? "hotspots_sous_pays" : "hotspots") : null };
}

/** Country mode: validated country × month series of pays.json, bands as exported. */
export function seriePays(index: IndexV2, p: SeriePays): SerieZone {
  const out = vide(index);
  const d = cleMois(p.premier_mois);
  const i0 = indiceMois(index, d.y, d.m);
  const partiel = moisPartiel(index);
  const n = (v: number | null | undefined) => (v === null || v === undefined ? null : v);
  for (let j = 0; j < p.hotspots.length; j++) {
    const i = i0 + j;
    if (i < 0 || i >= out.length) continue;
    const { y, m } = moisDe(index, i);
    const v = p.hotspots[j];
    if (v === null || v === undefined) continue;
    out[i] = {
      y, m, hotspots: v, frp: p.frp_MW?.[j] ?? 0,
      bas80: n(p.bas_80?.[j]), haut80: n(p.haut_80?.[j]), bas95: n(p.bas_95?.[j]), haut95: n(p.haut_95?.[j]),
      frpBas80: n(p.frp_bas_80?.[j]), frpHaut80: n(p.frp_haut_80?.[j]),
      converti: estConverti(index, y, m), partiel: texteMois(y, m) === partiel, couverture: n(p.couverture_jours?.[j]),
    };
  }
  return { mois: out, source: "pays", hexagones: [], table: "hotspots", fiabilite: p.fiabilite, fiabiliteFrp: p.fiabilite_frp, sousRegion: p.sous_region };
}

/* ── Statistics of a month against its normal (§5) ─────────────────────── */

/** Hyndman–Fan type 8 quantile of a sorted array. */
export function quantileHF8(t: number[], p: number): number {
  const n = t.length;
  if (!n) return NaN;
  const h = (n + 1 / 3) * p + 1 / 3; // 1-based position
  if (h <= 1) return t[0];
  if (h >= n) return t[n - 1];
  const j = Math.floor(h);
  return t[j - 1] + (h - j) * (t[j] - t[j - 1]);
}

export const CLASSES_NORMALE = ["much below normal", "below normal", "near normal", "above normal", "much above normal"] as const;

export interface StatMois {
  n: number;
  mediane: number;
  p10: number; p25: number; p75: number; p90: number;
  min: number; max: number;
  ecart: number;
  pctMediane: number | null;
  rang: number;
  classe: (typeof CLASSES_NORMALE)[number];
}

/** Reference: complete calendar years 2003–2025, same month, without the year of x. */
export function statMois(serie: SerieZone, index: IndexV2, y: number, m: number, metrique: Metrique): StatMois | null {
  const i = indiceMois(index, y, m);
  const cur = serie.mois[i];
  if (!cur || cur.partiel) return null;
  const x = cur[metrique];
  const base: number[] = [];
  for (let a = 2003; a <= 2025; a++) {
    if (a === y) continue;
    const c = serie.mois[indiceMois(index, a, m)];
    if (c && !c.partiel) base.push(c[metrique]);
  }
  if (base.length < 10) return null;
  base.sort((a, b) => a - b);
  const q = (p: number) => quantileHF8(base, p);
  const med = q(0.5);
  const b = base.filter((v) => v < x).length, e = base.filter((v) => v === x).length;
  const p10 = q(0.1), p33 = q(1 / 3), p67 = q(2 / 3), p90 = q(0.9);
  const classe = x < p10 ? 0 : x < p33 ? 1 : x <= p67 ? 2 : x <= p90 ? 3 : 4;
  return {
    n: base.length, mediane: med, p10, p25: q(0.25), p75: q(0.75), p90, min: base[0], max: base[base.length - 1],
    ecart: x - med, pctMediane: med > 0 ? (100 * x) / med : null, rang: (100 * (b + 0.5 * e)) / base.length,
    classe: CLASSES_NORMALE[classe],
  };
}
