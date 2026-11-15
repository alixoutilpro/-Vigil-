/**
 * Trends & Forecasts data (docs/methode_tf.md §9): two static files written by `python -m pipeline.tf.executer`
 * into public/data/tf, built from the SAME harmonized files as the Analytics view.
 *   tf/cellules.bin.gz  columnar table, one row per H3 res-4 cell (history 2003-2025, regime, trend, forecasts)
 *   tf/modele.json      model card (protocol, validation metrics, clustering diagnostics, feature importance)
 */
import { BASE, centreHex, chargerBinaire, chargerJSON, dansZone, type Ring } from "./donnees";

type Col = Float32Array | Uint8Array | Int8Array | Uint16Array | BigUint64Array;

export interface MetaTF {
  genere_le: string;
  n: number;
  h3_resolution: number;
  annees: [number, number];
  horizons: number[];
  annees_prevues: number[];
  annee_en_cours: { annee: number; mois_observes: number };
  seuil_densite: number;
  pays: string[];
  occupation_du_sol: string[];
  regimes: string[];
  trajectoires: string[];
  echelle_p: number;
  colonnes: { nom: string; type: "u8" | "i8" | "u16" | "f32" | "u64"; decalage: number }[];
}

export interface CellulesTF {
  meta: MetaTF;
  n: number;
  /** H3 index of each row, as the hexadecimal string used by h3-js. */
  h3: string[];
  col: Record<string, Col>;
  /** Row of a cell. */
  rang: Map<string, number>;
}

const TAILLE = { u8: 1, i8: 1, u16: 2, f32: 4, u64: 8 } as const;

let cellulesP: Promise<CellulesTF> | null = null;
export function chargerCellulesTF(): Promise<CellulesTF> {
  if (!cellulesP) {
    cellulesP = (async () => {
      const v = await chargerBinaire(`${BASE}/tf/cellules.bin.gz`);
      const magie = String.fromCharCode(v.getUint8(0), v.getUint8(1), v.getUint8(2), v.getUint8(3));
      if (magie !== "VTF1") throw new Error("tf/cellules.bin.gz: unknown format");
      const lt = v.getUint32(4, true);
      const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(v.buffer, v.byteOffset + 8, lt))) as MetaTF;
      const base = v.byteOffset + 8 + lt, n = meta.n;
      const col: Record<string, Col> = {};
      for (const c of meta.colonnes) {
        const b = v.buffer.slice(base + c.decalage, base + c.decalage + n * TAILLE[c.type]); // copy: aligned typed arrays
        col[c.nom] = c.type === "f32" ? new Float32Array(b) : c.type === "u8" ? new Uint8Array(b) : c.type === "i8" ? new Int8Array(b)
          : c.type === "u16" ? new Uint16Array(b) : new BigUint64Array(b);
      }
      const h3 = Array.from(col.h3 as BigUint64Array, (x) => x.toString(16));
      const rang = new Map<string, number>();
      h3.forEach((h, i) => rang.set(h, i));
      return { meta, n, h3, col, rang };
    })();
    cellulesP.catch(() => { cellulesP = null; });
  }
  return cellulesP;
}

/* ── Model card (only the fields the interface reads are typed) ─────────── */

export interface MetReg { n: number; deviance_poisson: number; rmse_log: number; mae_log: number; r2_log: number; rmse_sur_ecart_type_log: number; rmse: number; mae: number; r2: number; biais_total_pct: number; r2_anomalies_log?: number; objectif?: string; hyperparametres?: Record<string, number> }
export interface MetClf { n: number; prevalence: number; brier: number; brier_reference_prevalence: number; log_loss: number; roc_auc: number; pr_auc: number; seuil: number; vp: number; fp: number; fn: number; vn: number; exactitude: number; exactitude_classe_majoritaire: number; sensibilite: number; specificite: number; precision: number; f1: number; exactitude_equilibree: number; hyperparametres?: Record<string, number> }
export interface QuantilesTF { [niveau: string]: { [classe: string]: { q_bas: number; q_haut: number; n: number } } }
export interface Couverture { [niveau: string]: { globale: number; par_classe: Record<string, number>; largeur_relative_mediane: number } }
export interface RapportHorizon {
  horizon: number;
  origines: Record<string, [number, number]>;
  lignes: Record<string, number>;
  regression_validation: Record<string, MetReg>;
  regression_test: Record<string, MetReg> & Record<string, unknown>;
  courbe_apprentissage: { arbres: number; deviance_validation: number; deviance_apprentissage?: number }[];
  intervalles: { quantiles: QuantilesTF; couverture_test: Couverture; classes: string[]; bornes_classes: number[] };
  intervalles_zone: { quantiles: QuantilesTF; couverture_test: Record<string, Couverture>; classes: string[]; bornes_classes: number[]; metriques_test: Record<string, MetReg> };
  classification_validation: Record<string, MetClf>;
  classification_test: Record<string, MetClf> & { fiabilite: { de: number; a: number; n: number; p_moyenne: number; frequence: number }[]; fiabilite_cellules_en_jeu: { de: number; a: number; n: number; p_moyenne: number; frequence: number }[]; roc: { tfp: number; tvp: number }[]; skill_brier_vs_frequence_historique: number; skill_brier_vs_frequence_historique_cellules_en_jeu: number };
  production: { origine: number; annee_prevue: number; quantiles_cellule: QuantilesTF; quantiles_zone: QuantilesTF; total_prevu: number; cellules_proba_sup_50: number };
  coefficients_standardises_regression_lineaire?: Record<string, number>;
}
export interface DiagK { k: number; inertie: number; silhouette: number; davies_bouldin: number; stabilite_ari: number; gain_inertie: number | null }
export interface ModeleTF {
  genere_le: string;
  donnees: Record<string, unknown> & { cellules_exportees: number; site_genere_le: string; covariables: Record<string, unknown> };
  parametres: { seuil_annee_forte_densite: number; min_detections_par_an: number; q_fdr: number; origine_min: number; decoupage: { apprentissage_cibles_max: number; validation: [number, number]; test: [number, number] } };
  variables: { libelles: Record<string, string>; familles: Record<string, string[]>; noms_familles: Record<string, string>; nombre: number };
  regimes: { k: number; variables: string[]; diagnostics: DiagK[]; cellules_classees: number; cellules_sporadiques: number;
    profil: { regime: number; nom: string; n: number; densite: number; cv: number; frp: number; saison_R: number; saison_longueur: number; saison_centre: number; part_annees_fortes: number; part_hotspots: number; occupation_du_sol: Record<string, number>; climat: { vpd_kPa: number; pluie_mm: number; aridite: number } }[];
    pca: { variance_expliquee: number[]; points: [number, number, number][] } };
  tendances: ResumeTendances;
  tendances_locales_lissees?: ResumeTendances;
  trajectoires: { k: number; diagnostics: DiagK[]; noms: string[]; tailles: Record<string, number>; annees: number[]; centres: { trajectoire: number; nom: string; valeurs: number[] }[] };
  previsions: { horizons: RapportHorizon[]; choix_des_modeles: Record<string, unknown>;
    controle_annee_en_cours: null | { annee: number; mois_observes: string; observe: number; prevu_a_date: number; climatologie_a_date: number; ecart_pct: number; cellules: number; prevision: MetReg; climatologie: MetReg } };
  importance: Record<string, { deviance_de_base: number; par_variable: Record<string, number>; par_famille: Record<string, number> }>;
  ablation: Record<string, Record<string, { deviance_poisson: number; r2_log: number; rmse_log: number; r2_anomalies_log: number; n_variables: number }>>;
}
export interface ResumeTendances { cellules_testees: number; p_inf_0_05: number; attendu_par_hasard: number; q_fdr: number; hausse_significative: number; baisse_significative: number; part_hotspots_hausse: number; part_hotspots_baisse: number; serie?: string; monde: { sen_pct_an: number; mk_p: number; annees: [number, number] } }
export const chargerModeleTF = () => chargerJSON<ModeleTF>("tf/modele.json");

/* ── Reading a cell ─────────────────────────────────────────────────────── */

export const f32 = (t: CellulesTF, nom: string, i: number): number => { const c = t.col[nom]; return c ? Number(c[i]) : NaN; };
/** Annual harmonized detections of row i: observed year, or expected value of a forecast year. */
export function valeurAnnee(t: CellulesTF, i: number, an: number): number {
  if (an <= t.meta.annees[1]) return f32(t, `a${an}`, i);
  return f32(t, `mu${an - t.meta.annees[1]}`, i);
}
/** Density (detections / 1,000 km² / month, annual mean): the colour value of the Analytics map. */
export const densite = (v: number, aire: number) => (v / aire) * 1000 / 12;
export const proba = (t: CellulesTF, i: number, h: number) => f32(t, `p${h}`, i) / t.meta.echelle_p;
/** Local trend: neighbourhood-pooled (denoised) when exported, else the cell alone. */
export function tendanceLocale(t: CellulesTF, i: number): { classe: number; sen: number; q: number; lissee: boolean } {
  if (t.col.tendance_l) return { classe: Number(t.col.tendance_l[i]), sen: f32(t, "sen_l", i), q: f32(t, "q_l", i), lissee: true };
  return { classe: Number(t.col.tendance[i]), sen: f32(t, "sen", i), q: f32(t, "q", i), lissee: false };
}

/* ── Zone ───────────────────────────────────────────────────────────────── */

/** Rows of the cells of a zone: a country (Natural Earth name of the cell centre) or a drawn ring (centre inside). */
export function cellulesDeZone(t: CellulesTF, bbox: [number, number, number, number], ring: Ring, pays?: string): number[] {
  const out: number[] = [];
  if (pays) {
    const code = t.meta.pays.indexOf(pays);
    const cp = t.col.pays;
    for (let i = 0; i < t.n; i++) if (cp[i] === code) out.push(i);
    return out;
  }
  for (let i = 0; i < t.n; i++) if (dansZone(t.h3[i], bbox, ring)) out.push(i);
  return out;
}

/** Conformal band of a predicted total x (same formula as the harmonization band): exp(log(1+x) + q) − 1. */
export function bande(x: number, q: QuantilesTF | undefined, bornes: number[], classes: string[], niveau = "0.8"): [number, number] | null {
  const tq = q?.[niveau];
  if (!tq) return null;
  let c = 0;
  while (c < bornes.length && x > bornes[c]) c++;
  let nom = classes[Math.min(c, classes.length - 1)];
  if (!tq[nom]) { const dispo = classes.filter((k) => tq[k]); nom = dispo[dispo.length - 1]; }
  if (!nom || !tq[nom]) return null;
  const l = Math.log1p(x);
  return [Math.max(0, Math.expm1(l + tq[nom].q_bas)), Math.max(0, Math.expm1(l + tq[nom].q_haut))];
}

export interface SerieTF {
  annees: number[];                 // observed years then forecast years
  valeurs: number[];                // zone totals
  prevu: boolean[];
  bas: (number | null)[]; haut: (number | null)[];
  /** Mean probability of a high-activity year over the cells of the zone, and cells with p >= 50 %, per forecast year. */
  pMoy: (number | null)[]; nRisque: (number | null)[];
  n: number;
  ytd: number; ytdMed: number;
}

/** History and forecast of a zone: cells are summed FIRST, the band comes from the zone-scale conformal table. */
export function serieZone(t: CellulesTF, rows: number[], modele: ModeleTF | null): SerieTF {
  const [a0, a1] = t.meta.annees;
  const annees: number[] = [], valeurs: number[] = [], prevu: boolean[] = [], bas: (number | null)[] = [], haut: (number | null)[] = [], pMoy: (number | null)[] = [], nRisque: (number | null)[] = [];
  for (let an = a0; an <= a1 + t.meta.horizons.length; an++) {
    let s = 0;
    for (const i of rows) s += valeurAnnee(t, i, an);
    annees.push(an); valeurs.push(s); prevu.push(an > a1);
    if (an > a1) {
      const h = an - a1, r = modele?.previsions.horizons.find((x) => x.horizon === h);
      // one cell: cell-scale table; several cells: zone-scale table (learnt on sums of cells)
      const b = rows.length === 1 && r ? [f32(t, `bas${h}`, rows[0]), f32(t, `haut${h}`, rows[0])] as [number, number]
        : r ? bande(s, r.production.quantiles_zone, r.intervalles_zone.bornes_classes, r.intervalles_zone.classes) : null;
      bas.push(b ? b[0] : null); haut.push(b ? b[1] : null);
      let sp = 0, nr = 0;
      for (const i of rows) { const p = proba(t, i, h); sp += p; if (p >= 0.5) nr++; }
      pMoy.push(rows.length ? sp / rows.length : null); nRisque.push(nr);
    } else { bas.push(null); haut.push(null); pMoy.push(null); nRisque.push(null); }
  }
  let ytd = 0, ytdMed = 0;
  for (const i of rows) { ytd += f32(t, "ytd", i); ytdMed += f32(t, "ytd_med", i); }
  return { annees, valeurs, prevu, bas, haut, pMoy, nRisque, n: rows.length, ytd, ytdMed };
}

/** Centred moving average (window 5, shorter at the ends): the smoothed curve drawn over the noisy annual totals. */
export function lisser(v: number[], demi = 2): number[] {
  return v.map((_, i) => { let s = 0, n = 0; for (let j = Math.max(0, i - demi); j <= Math.min(v.length - 1, i + demi); j++) { s += v[j]; n++; } return s / n; });
}

export { centreHex };

/* ── Wildfire hubs (pipeline/tf/hubs.py): space-time clusters of unusual bursts, scored and with a confidence ── */

export interface Hub {
  id: number; lat: number; lon: number; pays: string | null;
  /** H3 res-5 hexagons of the hub. */
  h3: string[];
  aire_km2: number;
  /** Exposure score 1-100 (percentile among all hubs of frequency, density and intensity). */
  score: number;
  /** Bootstrap confidence (0-1): share of year-resamples in which the hub is still detected. */
  confiance: number;
  annees_episode: number; detections: number; densite: number; frp_det: number; part_episodique: number;
  pic: { mois: string; detections: number }; dernier: string;
  /** Episode detections per year, from annees[0]. */
  serie: number[];
}
export interface HubsTF {
  genere_le: string; annees: [number, number];
  parametres: { v_min: number; ratio: number; episode_min: number; hex_min: number; hub_min: number; taille_max: number; n_boot: number };
  resume: { hexagones_mois: number; sursauts: number; episodes: number; hubs: number; part_detections_episodiques: number; confiance_mediane: number; hubs_confiance_90: number; taille_mediane_hexagones: number; annees_episode_mediane: number };
  hubs: Hub[];
}
export const chargerHubs = () => chargerJSON<HubsTF>("tf/hubs.json");
/** Hubs of a zone: country of the hub centre, or centre inside the drawn ring. */
export function hubsDeZone(hubs: Hub[], bbox: [number, number, number, number], ring: Ring, pays?: string): Hub[] {
  if (pays) return hubs.filter((h) => h.pays === pays);
  return hubs.filter((h) => h.lat >= bbox[0] && h.lat <= bbox[1] && [0, -360, 360].some((d) => { const x = h.lon + d; return x >= bbox[2] && x <= bbox[3] && pipTF(x, h.lat, ring); }));
}
function pipTF(x: number, y: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export const libConfiance = (c: number) => (c >= 0.9 ? "high" : c >= 0.7 ? "medium" : "low");
