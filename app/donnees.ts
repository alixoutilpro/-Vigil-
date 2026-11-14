/**
 * Data contract v2 (docs/contrat_donnees_v2.md): static files written by `python -m pipeline.v2.export_site`
 * into public/data and served by Vercel at /data. Nothing is bundled: index.json and incertitude.json are
 * loaded at start, months, tiles and pays.json on demand. Every file is fetched once and cached.
 */
import { cellToBoundary, cellToLatLng, gridDisk, latLngToCell } from "h3-js";

export const BASE = (process.env.NEXT_PUBLIC_VIGIL_DATA_BASE || "/data").replace(/\/$/, "");

/* ── Types of the contract ─────────────────────────────────────────────── */

export interface IndexV2 {
  genere_le: string;
  methode: string;
  unites: { hotspots: string; frp_MW: string };
  h3_resolution: number;
  tuile_parent_resolution: number;
  mois_index_0: string;            // "2002-01"
  bascule_viirs: string;           // "2020-11-01"
  provenance: { avant_bascule: string; apres: string };
  mois: string[];                  // "YYYY-MM"
  tuiles: string[];
  seuils_couleur_quantiles: { hotspots: Record<string, number>; frp_MW: Record<string, number> };
  validation?: unknown;
  tailles_octets?: Record<string, number>;
  points_grece?: number;
  /** Optional: last month whose data is incomplete ("YYYY-MM"). Derived from genere_le when absent. */
  mois_partiel?: string | null;
  /** Set only by scripts/fixture_v2.mjs (local demo data). */
  fixture?: boolean;
}

export interface TableQuantiles {
  classes_bornes: number[];
  noms: string[];
  quantiles: Record<string, Record<string, { q_bas: number; q_haut: number }>>;
  couverture_observee?: unknown;
  valide_pour?: unknown;
  usage?: string;
}
export interface IncertitudeV2 {
  espace: string;
  valide_a_l_echelle: string;
  hotspots: TableQuantiles;
  frp_MW: { classes_bornes: number[]; quantiles: TableQuantiles["quantiles"]; noms?: string[]; couverture_observee?: unknown };
  hotspots_sous_pays?: TableQuantiles;
}

export interface SeriePays {
  sous_region: string;
  fiabilite: "elevee" | "moyenne" | "faible" | string;
  fiabilite_frp: string | null;
  premier_mois: string;
  hotspots: (number | null)[];
  bas_80: (number | null)[]; haut_80: (number | null)[];
  bas_95: (number | null)[]; haut_95: (number | null)[];
  frp_MW: (number | null)[];
  frp_bas_80: (number | null)[]; frp_haut_80: (number | null)[];
  couverture_jours: (number | null)[];
}
export type PaysV2 = Record<string, SeriePays>;

/** One hexagon of one month. */
export interface HexMois { h3: string; hotspots: number; frp: number }
/** A tile: h3 -> (month index -> values). */
export type Tuile = Map<string, Map<number, { hotspots: number; frp: number }>>;

/* ── Loading ───────────────────────────────────────────────────────────── */

export class ErreurDonnees extends Error {
  url: string;
  statut: number | string;
  constructor(url: string, statut: number | string) {
    super(`${url} : ${statut}`);
    this.url = url;
    this.statut = statut;
  }
}

const cache = new Map<string, Promise<unknown>>();
function unique<T>(cle: string, f: () => Promise<T>): Promise<T> {
  let p = cache.get(cle) as Promise<T> | undefined;
  if (!p) {
    p = f();
    cache.set(cle, p);
    p.catch(() => cache.delete(cle)); // a failed download can be retried
  }
  return p;
}

async function telecharger(url: string): Promise<Response> {
  let r: Response;
  try { r = await fetch(url); } catch (e) { throw new ErreurDonnees(url, (e as Error).message || "réseau"); }
  if (!r.ok) throw new ErreurDonnees(url, r.status);
  return r;
}

export function chargerJSON<T>(chemin: string): Promise<T> {
  const url = `${BASE}/${chemin}`;
  return unique(url, async () => (await telecharger(url)).json() as Promise<T>);
}

/** Binary file, gunzipped in the browser when the host served it without Content-Encoding (gzip signature test). */
export async function chargerBinaire(url: string): Promise<DataView> {
  const brut = new Uint8Array(await (await telecharger(url)).arrayBuffer());
  if (brut[0] === 0x1f && brut[1] === 0x8b) {
    const flux = new Blob([brut]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new DataView(await new Response(flux).arrayBuffer());
  }
  return new DataView(brut.buffer, brut.byteOffset, brut.byteLength);
}

const hex = (v: DataView, o: number) => v.getBigUint64(o, true).toString(16);

/** 16-byte records: uint64 h3 | float32 hotspots | float32 frp. */
export function decoderMois(v: DataView): HexMois[] {
  if (v.byteLength % 16) throw new Error(`taille ${v.byteLength} non multiple de 16`);
  const out: HexMois[] = new Array(v.byteLength / 16);
  for (let o = 0, i = 0; o < v.byteLength; o += 16, i++)
    out[i] = { h3: hex(v, o), hotspots: v.getFloat32(o + 8, true), frp: v.getFloat32(o + 12, true) };
  return out;
}

/** 18-byte records (unaligned): uint64 h3 | uint16 month index | float32 hotspots | float32 frp. */
export function decoderTuile(v: DataView): Tuile {
  if (v.byteLength % 18) throw new Error(`taille ${v.byteLength} non multiple de 18`);
  const out: Tuile = new Map();
  for (let o = 0; o < v.byteLength; o += 18) {
    const h = hex(v, o);
    let m = out.get(h);
    if (!m) out.set(h, (m = new Map()));
    m.set(v.getUint16(o + 8, true), { hotspots: v.getFloat32(o + 10, true), frp: v.getFloat32(o + 14, true) });
  }
  return out;
}

export const chargerIndex = () => chargerJSON<IndexV2>("index.json");
export const chargerIncertitude = () => chargerJSON<IncertitudeV2>("incertitude.json");
export const chargerPays = () => chargerJSON<PaysV2>("pays.json");
export const chargerMois = (mois: string) => {
  const url = `${BASE}/h3_5/mois/${mois}.bin.gz`;
  return unique(url, async () => decoderMois(await chargerBinaire(url)));
};
export const chargerTuile = (parent: string) => {
  const url = `${BASE}/h3_5/tuiles/${parent}.bin.gz`;
  return unique(url, async () => decoderTuile(await chargerBinaire(url)));
};

/* ── Months ────────────────────────────────────────────────────────────── */

export const cleMois = (s: string) => { const [y, m] = s.split("-").map(Number); return { y, m: m - 1 }; };
export const texteMois = (y: number, m: number) => `${y}-${String(m + 1).padStart(2, "0")}`;
/** Month index of the contract (0 = mois_index_0). */
export function indiceMois(index: IndexV2, y: number, m: number): number {
  const o = cleMois(index.mois_index_0);
  return (y - o.y) * 12 + (m - o.m);
}
/** Last month still incomplete: explicit field, else the month of genere_le when it is the last listed month. */
export function moisPartiel(index: IndexV2): string | null {
  if (index.mois_partiel !== undefined) return index.mois_partiel;
  const dernier = index.mois[index.mois.length - 1];
  return dernier && index.genere_le?.slice(0, 7) === dernier ? dernier : null;
}
/** True when the month is converted VIIRS (on or after the switch date). */
export function estConverti(index: IndexV2, y: number, m: number): boolean {
  const b = new Date(index.bascule_viirs + "T00:00:00Z");
  return y * 12 + m >= b.getUTCFullYear() * 12 + b.getUTCMonth();
}

/* ── Geometry ──────────────────────────────────────────────────────────── */

export type Ring = [number, number][];

export function pip(x: number, y: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Hexagon outline as a GeoJSON ring, unwrapped so that hexagons on the antimeridian do not span the globe. */
export function contourHex(h: string): Ring {
  const b = cellToBoundary(h, true) as Ring;
  const lon0 = b[0][0];
  return b.map(([lo, la]) => [lo - lon0 > 180 ? lo - 360 : lon0 - lo > 180 ? lo + 360 : lo, la]);
}

const centres = new Map<string, [number, number]>();
/** Hexagon centre [lon, lat] (memoised: the same cells come back at each zone). */
export function centreHex(h: string): [number, number] {
  let c = centres.get(h);
  if (!c) { const [la, lo] = cellToLatLng(h); centres.set(h, (c = [lo, la])); }
  return c;
}

/**
 * Res-1 tiles that may hold hexagons whose centre lies in the zone: res-1 cells under a grid of sample
 * points (step < half a res-1 edge) and the ring vertices, plus their neighbours, kept if the export has them.
 */
export function tuilesDeZone(bbox: [number, number, number, number], ring: Ring, disponibles: Set<string>, res = 1): string[] {
  const [la0, la1, lo0, lo1] = bbox;
  const pas = 1.5;
  const vus = new Set<string>();
  const ajoute = (la: number, lo: number) => vus.add(latLngToCell(Math.max(-89.9, Math.min(89.9, la)), ((lo + 540) % 360) - 180, res));
  for (let la = la0; la <= la1 + pas; la += pas) for (let lo = lo0; lo <= lo1 + pas; lo += pas) ajoute(Math.min(la, la1), Math.min(lo, lo1));
  for (const [lo, la] of ring) ajoute(la, lo);
  const out = new Set<string>();
  for (const c of vus) for (const n of gridDisk(c, 1)) if (disponibles.has(n)) out.add(n);
  return [...out].sort();
}

/** Inside test of the zone: centre of the hexagon in the drawn ring (contract rule), longitudes compared modulo 360. */
export function dansZone(h: string, bbox: [number, number, number, number], ring: Ring): boolean {
  const [lo, la] = centreHex(h);
  if (la < bbox[0] || la > bbox[1]) return false;
  for (const d of [0, -360, 360]) {
    const x = lo + d;
    if (x >= bbox[2] && x <= bbox[3] && pip(x, la, ring)) return true;
  }
  return false;
}
