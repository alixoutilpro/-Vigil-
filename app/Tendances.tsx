"use client";

/**
 * Vigil Trends. Same map, tools and visual language as the Analytics view (app/Vigil.tsx, through the generated
 * toolkit app/tfCommun.tsx), on the same harmonized data, but asking another question: WHERE do real wildfire
 * episodes come back, and how exposed is each of those places?
 *  - Hubs: space-time clusters of unusual bursts of detections (pipeline/tf/hubs.py). Regular seasonal burning
 *    (mostly agricultural) is removed by construction. Each hub has an exposure score 1-100 and a bootstrap confidence.
 *  - Context layers: denoised local trend (Theil-Sen + Mann-Kendall, false discovery rate controlled), trajectory
 *    shapes and fire regimes (k-means), per ~42 km territory.
 * No forecast is shown: tested on Greek years the models never saw, forecasts did not anticipate the extreme years
 * (docs/methode_tf.md). Data: public/data/tf (app/tf.ts).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Map as MLMap, GeoJSONSource, MapLayerMouseEvent, Marker } from "maplibre-gl";
import OrbitOverlay from "./OrbitOverlay";
import { contourHex, type Ring } from "./donnees";
import { initDaltonien, palette, setDaltonien, useDaltonien } from "./palette";
import { mannKendall, quantileHF8, senSlope, sortAsc } from "./stats";
import {
  CSS, CollapseIcon, CoordFields, EMPTY_FC, ExpandIcon, LIEUX, MORPH_MS, RegionName, Seg, bboxFromCorner, bboxToSizeKm, clamp,
  enregistrerGallPeters, fmtCompact, fmtInt, fmtLat, fmtLon, fmtVal, gpDeCarte, gpGeoJSON, gpVersCarte, inViewport, niceTicks, rectRing,
  regionFromRing, styleInitial, tuilesPour, useDrag, type Lieu, type Projection2D, type RegionDef,
} from "./tfCommun";
import {
  cellulesDeZone, centreHex, chargerCellulesTF, chargerHubs, chargerModeleTF, f32, hubsDeZone, libConfiance, lisser, serieZone, tendanceLocale,
  type CellulesTF, type Hub, type HubsTF, type ModeleTF, type SerieTF,
} from "./tf";
import TendancesDive from "./TendancesDive";

export type Couche = "hubs" | "tendance" | "trajectoire" | "regime";
const COUCHES: { v: Couche; t: string }[] = [{ v: "hubs", t: "Wildfire hubs" }, { v: "tendance", t: "Local trend" }, { v: "trajectoire", t: "Trajectory" }, { v: "regime", t: "Fire regime" }];
/** Score classes (1-100): 10 classes of 10 points, on the upper 10 colours of the map ramp. */
const SCORE_BREAKS = [10, 20, 30, 40, 50, 60, 70, 80, 90];
const SEN_BREAKS = [-6, -4, -2, -0.5, 0.5, 2, 4, 6];
export const CATEG = ["#94a3b8", "#d55e00", "#e69f00", "#0072b2", "#009e73", "#cc79a7", "#56b4e9"];
const GRIS = "#cbd5e1";
const NEW_REGION = "New region";
const MAX_ETIQUETTES = 60;
type Tool = "none" | "box" | "poly";
interface Selection { region: RegionDef; ring: Ring; wasPolygon: boolean }
type FC = { type: "FeatureCollection"; features: unknown[] };

const ALIAS_NE: Record<string, string> = {
  "United States": "United States of America", "Democratic Republic of Congo": "Democratic Republic of the Congo", "Congo": "Republic of the Congo",
  "Czech Republic": "Czechia", "Tanzania": "United Republic of Tanzania", "Serbia": "Republic of Serbia",
};
const paysNE = (nom: string, liste: string[]) => (liste.includes(ALIAS_NE[nom] ?? nom) ? ALIAS_NE[nom] ?? nom : undefined);
const pct = (p: number) => `${Math.round(100 * p)} %`;
const signe = (x: number, d = 1) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(d)}`;
const fmtP = (p: number) => (p < 0.001 ? "<0.001" : p.toFixed(3));
const MOIS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const moisTxt = (s: string) => `${MOIS[Number(s.slice(5)) - 1]} ${s.slice(0, 4)}`;
export const couleurScore = (s: number) => { const h = palette().hex; return h[2 + SCORE_BREAKS.filter((b) => s > b).length]; };

function couleurCellules(couche: Couche): unknown {
  const p = palette();
  if (couche === "tendance") return ["case", ["==", ["get", "s"], 0], GRIS, ["step", ["get", "c"], p.div[0], ...SEN_BREAKS.flatMap((v, i) => [v, p.div[i + 1]])]];
  return ["match", ["get", "c"], 1, CATEG[1], 2, CATEG[2], 3, CATEG[3], 4, CATEG[4], 5, CATEG[5], 6, CATEG[6], CATEG[0]];
}
const exprScore = () => { const h = palette().hex; return ["step", ["get", "score"], h[2], ...SCORE_BREAKS.flatMap((v, i) => [v + 0.5, h[3 + i]])]; };

function valeurCouche(t: CellulesTF, i: number, couche: Couche): { c: number; s: number } | null {
  if (couche === "tendance") { const x = tendanceLocale(t, i); return x.classe === -128 || !isFinite(x.sen) ? null : { c: x.sen, s: x.classe === 0 ? 0 : 1 }; }
  const r = Number((couche === "regime" ? t.col.regime : t.col.trajectoire)[i]);
  return r > 0 ? { c: r, s: 1 } : null;
}

export default function Tendances() {
  const daltonien = useDaltonien();
  const pal = palette();
  useEffect(() => { initDaltonien(); }, []);
  const leftDrag = useDrag();
  const rightDrag = useDrag();
  const [t, setT] = useState<CellulesTF | null>(null);
  const [modele, setModele] = useState<ModeleTF | null>(null);
  const [hubs, setHubs] = useState<HubsTF | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [couche, setCouche] = useState<Couche>("hubs");
  /** Year of the timeline: null = all years. */
  const [annee, setAnnee] = useState<number | null>(null);
  const [lecture, setLecture] = useState(false);
  /** Hubs under this bootstrap confidence are hidden. */
  const [confMin, setConfMin] = useState(0);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [selectionName, setSelectionName] = useState("");
  const [cellule, setCellule] = useState<number | null>(null);
  const [hubSel, setHubSel] = useState<number | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [panelLeftOpen, setPanelLeftOpen] = useState(true);
  const [split, setSplit] = useState(false);
  const [tool, setTool] = useState<Tool>("none");
  const [polyN, setPolyN] = useState(0);
  const [ready, setReady] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [newName, setNewName] = useState(NEW_REGION);
  const [flat, setFlat] = useState(false);
  const flatRef = useRef(false);
  const [proj2D, setProj2D] = useState<Projection2D>("gall");
  const proj2DRef = useRef<Projection2D>("gall");
  const gpActifRef = useRef(false);
  const [mapBounds, setMapBounds] = useState<[number, number, number, number] | null>(null);
  const [zoomCarte, setZoomCarte] = useState(2.4);
  const [hoverAn, setHoverAn] = useState<number | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const mlRef = useRef<unknown>(null);
  const src = useRef<Record<string, unknown>>({ hex: EMPTY_FC, hub: EMPTY_FC, hubpt: EMPTY_FC, sel: EMPTY_FC, draft: EMPTY_FC });
  const sent = useRef<Record<string, unknown>>({});
  const toolRef = useRef<Tool>("none");
  const polyPts = useRef<Ring>([]);
  const panelOpenRef = useRef(true);
  const loadedRef = useRef(false);
  const pendingFit = useRef<[number, number, number, number] | null>(null);
  const fitRef = useRef<(b: [number, number, number, number]) => void>(() => {});
  const finalizeRef = useRef<(ring: Ring, fromBox?: boolean) => void>(() => {});
  const regionCounterRef = useRef(0);
  const tRef = useRef<CellulesTF | null>(null);
  const hubsRef = useRef<HubsTF | null>(null);
  const pickRef = useRef<{ cell: (i: number) => void; hub: (id: number) => void }>({ cell: () => {}, hub: () => {} });
  toolRef.current = tool;
  panelOpenRef.current = panelOpen;
  tRef.current = t;
  hubsRef.current = hubs;

  useEffect(() => {
    let vivant = true;
    Promise.all([chargerCellulesTF(), chargerHubs(), chargerModeleTF().catch(() => null)]).then(([c, h, m]) => { if (vivant) { setT(c); setHubs(h); setModele(m); } })
      .catch((e) => { if (vivant) setErreur(String((e as Error).message || e)); });
    return () => { vivant = false; };
  }, []);
  const A0 = hubs?.annees[0] ?? 2003, A1 = hubs?.annees[1] ?? 2025;

  /* ── Zone: territories (res 4) for the trend, hubs (res 5) for the exposure ── */
  const zoneRows = useMemo(() => (t && selection ? cellulesDeZone(t, selection.region.bbox, selection.ring, selection.region.pays) : null), [t, selection]);
  const rows = useMemo(() => (cellule !== null ? [cellule] : zoneRows), [cellule, zoneRows]);
  const serie: SerieTF | null = useMemo(() => (t && rows ? serieZone(t, rows, modele) : null), [t, rows, modele]);
  const hubParId = useMemo(() => new Map((hubs?.hubs ?? []).map((h) => [h.id, h])), [hubs]);
  const hubsVisibles = useMemo(() => {
    if (!hubs) return [] as Hub[];
    const base = selection ? hubsDeZone(hubs.hubs, selection.region.bbox, selection.ring, selection.region.pays) : hubs.hubs;
    return base.filter((h) => h.confiance >= confMin);
  }, [hubs, selection, confMin]);
  const hub = hubSel !== null ? hubParId.get(hubSel) ?? null : null;

  /* ── Map features ── */
  const hubFeatures = useMemo(() => {
    const cells: unknown[] = [], pts: unknown[] = [];
    const vb = !selection && zoomCarte >= 3 ? mapBounds : null;
    const iy = annee !== null ? annee - A0 : -1;
    for (const h of hubsVisibles) {
      if (vb && !inViewport(h.lon, h.lat, vb, 0.3)) continue;
      const actif = iy < 0 ? 1 : h.serie[iy] > 0 ? 1 : 0;
      const props = { id: h.id, score: h.score, conf: h.confiance, actif, sel: h.id === hubSel ? 1 : 0 };
      pts.push({ type: "Feature", geometry: { type: "Point", coordinates: [h.lon, h.lat] }, properties: props });
      if (zoomCarte >= 4.2 || selection) for (const c of h.h3) { const ct = contourHex(c); cells.push({ type: "Feature", geometry: { type: "Polygon", coordinates: [[...ct, ct[0]]] }, properties: props }); }
    }
    return { cells: { type: "FeatureCollection", features: cells } as FC, pts: { type: "FeatureCollection", features: pts } as FC };
  }, [hubsVisibles, annee, A0, hubSel, mapBounds, zoomCarte, selection]);
  const hexes = useMemo((): FC => {
    if (!t || couche === "hubs") return { type: "FeatureCollection", features: [] };
    const vb = !zoneRows && zoomCarte >= 3 ? mapBounds : null;
    const features: unknown[] = [];
    const ajoute = (i: number) => {
      const v = valeurCouche(t, i, couche);
      if (!v) return;
      const h = t.h3[i];
      if (vb) { const [lo, la] = centreHex(h); if (!inViewport(lo, la, vb, 0.25)) return; }
      const ct = contourHex(h);
      features.push({ type: "Feature", geometry: { type: "Polygon", coordinates: [[...ct, ct[0]]] }, properties: { i, c: v.c, s: v.s } });
    };
    if (zoneRows) zoneRows.forEach(ajoute); else for (let i = 0; i < t.n; i++) ajoute(i);
    return { type: "FeatureCollection", features };
  }, [t, zoneRows, couche, mapBounds, zoomCarte]);

  const pushSources = useCallback(() => {
    const m = mapRef.current;
    if (!m) return;
    const g = (fc: unknown) => (gpActifRef.current ? gpGeoJSON(fc) : fc) as never;
    for (const k of Object.keys(src.current)) if (src.current[k] !== sent.current[k]) { sent.current[k] = src.current[k]; (m.getSource(k) as GeoJSONSource | undefined)?.setData(g(src.current[k])); }
  }, []);
  const setDraft = useCallback((fc: unknown) => { src.current.draft = fc; pushSources(); }, [pushSources]);
  const draftBox = (a: [number, number], b: [number, number]) => ({ type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [rectRing([Math.min(a[1], b[1]), Math.max(a[1], b[1]), Math.min(a[0], b[0]), Math.max(a[0], b[0])])] } }] });
  const draftPoly = (pts: Ring, cursor?: [number, number]) => {
    const feats: unknown[] = pts.map((p) => ({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: p } }));
    const line = cursor ? [...pts, cursor] : pts;
    if (line.length > 1) feats.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: line } });
    if (pts.length > 2) feats.push({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[...pts, pts[0]]] } });
    return { type: "FeatureCollection", features: feats };
  };
  const fitTo = useCallback((b: [number, number, number, number]) => {
    const m = mapRef.current;
    if (!m) return;
    if (!loadedRef.current) { pendingFit.current = b; return; }
    const wide = window.innerWidth > 900;
    const v = gpActifRef.current ? gpVersCarte : (l: number) => l;
    m.fitBounds([[b[2], v(b[0])], [b[3], v(b[1])]], { padding: { top: 90, left: 60, bottom: wide ? 60 : 340, right: wide && panelOpenRef.current ? 520 : 60 }, duration: 1400, maxZoom: 9 });
  }, []);
  const applySelection = useCallback((region: RegionDef, ring: Ring, name?: string, wasPolygon = false) => {
    setSearchOpen(false); setCellule(null); setHubSel(null);
    setSelection({ region, ring, wasPolygon });
    setSelectionName(name ?? region.name);
    setPanelOpen(true); panelOpenRef.current = true;
    src.current.sel = { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } }] };
    setDraft(EMPTY_FC);
    fitTo(region.bbox);
  }, [fitTo, setDraft]);
  const handleApplyBbox = useCallback((bbox: [number, number, number, number], currentName: string) => {
    if (currentName === NEW_REGION) currentName = `${fmtLat(bbox[1])} ${fmtLon(bbox[3])}`;
    const ring = rectRing(bbox);
    applySelection({ ...regionFromRing(ring), name: currentName, bbox }, ring, currentName, false);
  }, [applySelection]);
  fitRef.current = fitTo;
  finalizeRef.current = (ring: Ring, fromBox = false) => {
    if (ring.length < 3) return;
    const closed: Ring = [...ring, ring[0]];
    regionCounterRef.current += 1;
    applySelection(regionFromRing(closed), closed, `Region ${regionCounterRef.current}`, !fromBox);
    setTool("none"); polyPts.current = []; setPolyN(0);
  };
  const clearSelection = () => {
    setSplit(false); setSelection(null); setSelectionName(""); setCellule(null); setHubSel(null);
    src.current.sel = EMPTY_FC; setDraft(EMPTY_FC); polyPts.current = []; setPolyN(0); setTool("none");
  };
  const pickTool = (x: Tool) => { polyPts.current = []; setPolyN(0); setDraft(EMPTY_FC); setTool(tool === x ? "none" : x); };
  const finishPoly = () => finalizeRef.current(polyPts.current.filter((p, i, a) => i === 0 || Math.hypot(p[0] - a[i - 1][0], p[1] - a[i - 1][1]) > 1e-6), false);
  const selectPlace = useCallback((l: Lieu) => {
    const ring = rectRing(l.bbox);
    const pays = l.kind === "Country" && tRef.current ? paysNE(l.name, tRef.current.meta.pays) : undefined;
    applySelection({ ...regionFromRing(ring), name: l.name, pays }, ring, l.name, false);
  }, [applySelection]);
  const ouvrirHub = useCallback((id: number, zoom = false) => {
    setHubSel(id); setCellule(null); setPanelOpen(true);
    const h = hubsRef.current?.hubs.find((x) => x.id === id);
    if (h && zoom) fitRef.current([h.lat - 0.45, h.lat + 0.45, h.lon - 0.6, h.lon + 0.6]);
  }, []);
  pickRef.current = { cell: (i) => { setCellule(i); setHubSel(null); setPanelOpen(true); }, hub: (id) => ouvrirHub(id) };

  /* Demo: the view opens on Greece (the showcase country of the project); "Clear" shows the world. */
  const demoFaite = useRef(false);
  useEffect(() => {
    if (!t || !hubs || !ready || demoFaite.current) return;
    demoFaite.current = true;
    const g = LIEUX.find((l) => l.name === "Greece" && l.kind === "Country");
    if (g) setTimeout(() => selectPlace(g), 900);
  }, [t, hubs, ready, selectPlace]);

  useEffect(() => {
    let cancelled = false;
    let map: MLMap | null = null;
    let moveendTimer: ReturnType<typeof setTimeout> | null = null;
    (async () => {
      const maplibregl = (await import("maplibre-gl")).default;
      if (cancelled || !containerRef.current) return;
      mlRef.current = maplibregl;
      enregistrerGallPeters(maplibregl as never);
      map = new maplibregl.Map({ container: containerRef.current, style: styleInitial(false), center: [12, 24], zoom: 2.4, maxPitch: 75, attributionControl: { compact: true }, fadeDuration: 0 });
      mapRef.current = map;
      map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
      map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");
      const install = () => {
        if (!map) return;
        try {
          if (flatRef.current) map.setProjection({ type: "mercator" });
          else if (!Array.isArray(map.getProjection()?.type)) map.setProjection({ type: ["interpolate", ["linear"], ["zoom"], 11, "vertical-perspective", 12, "mercator"] } as never);
        } catch { /* older style spec */ }
        if (!map.getSource("hex")) {
          for (const k of Object.keys(src.current)) map.addSource(k, { type: "geojson", data: src.current[k] as never });
          map.addLayer({ id: "sel-fill", type: "fill", source: "sel", paint: { "fill-color": palette().alert, "fill-opacity": 0.04 } });
          map.addLayer({ id: "hex", type: "fill", source: "hex", paint: { "fill-color": GRIS, "fill-opacity": 0.8 } });
          map.addLayer({ id: "hex-line", type: "line", source: "hex", paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 2, 0.2, 8, 0.9], "line-opacity": 0.55 } });
          // hubs: hexagons filled by score; faded when not active in the timeline year or of low confidence
          map.addLayer({ id: "hub", type: "fill", source: "hub", paint: { "fill-color": GRIS, "fill-opacity": ["case", ["==", ["get", "actif"], 0], 0.12, ["<", ["get", "conf"], 0.7], 0.55, 0.9] } });
          map.addLayer({ id: "hub-line", type: "line", source: "hub", paint: { "line-color": ["case", ["==", ["get", "sel"], 1], "#0f172a", "#ffffff"], "line-width": ["case", ["==", ["get", "sel"], 1], 2.4, 1], "line-opacity": ["case", ["==", ["get", "actif"], 0], 0.25, 0.9] } });
          // a disc per hub, so that hubs are visible from the globe; radius grows with the score
          map.addLayer({ id: "hubpt", type: "circle", source: "hubpt", paint: {
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 1.5, ["interpolate", ["linear"], ["get", "score"], 1, 1.4, 100, 4.2], 6, ["interpolate", ["linear"], ["get", "score"], 1, 4, 100, 11], 9, ["interpolate", ["linear"], ["get", "score"], 1, 7, 100, 16]],
            "circle-color": GRIS, "circle-opacity": ["case", ["==", ["get", "actif"], 0], 0.1, ["<", ["get", "conf"], 0.7], 0.6, 0.95],
            "circle-stroke-color": ["case", ["==", ["get", "sel"], 1], "#0f172a", "#ffffff"], "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 2, ["case", ["==", ["get", "sel"], 1], 2.2, 0.3], 6, ["case", ["==", ["get", "sel"], 1], 2.4, 1.2]],
            "circle-stroke-opacity": ["case", ["==", ["get", "actif"], 0], 0.2, 1] } });
          map.addLayer({ id: "sel-line", type: "line", source: "sel", paint: { "line-color": palette().alert, "line-width": 1.6, "line-dasharray": [3, 2] } });
          map.addLayer({ id: "draft-fill", type: "fill", source: "draft", filter: ["==", ["geometry-type"], "Polygon"], paint: { "fill-color": "#0f172a", "fill-opacity": 0.08 } });
          map.addLayer({ id: "draft-line", type: "line", source: "draft", filter: ["any", ["==", ["geometry-type"], "Polygon"], ["==", ["geometry-type"], "LineString"]], paint: { "line-color": "#0f172a", "line-width": 2, "line-dasharray": [2, 2] } });
          map.addLayer({ id: "draft-pts", type: "circle", source: "draft", filter: ["==", ["geometry-type"], "Point"], paint: { "circle-radius": 4.5, "circle-color": "#ffffff", "circle-stroke-color": "#0f172a", "circle-stroke-width": 2 } });
        }
        colorRef.current();
      };
      map.on("style.load", install);
      const vue = () => { if (!map) return; const b = map.getBounds(); setMapBounds([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]); setZoomCarte(map.getZoom()); };
      map.on("moveend", () => { if (moveendTimer) clearTimeout(moveendTimer); moveendTimer = setTimeout(vue, 150); });
      map.on("load", () => {
        install(); pushSources(); loadedRef.current = true; setReady(true); vue();
        if (pendingFit.current) { const b = pendingFit.current; pendingFit.current = null; setTimeout(() => fitRef.current(b), 50); }
      });

      const survol = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 12, className: "hd-popup", maxWidth: "320px" });
      const esc = (v: unknown) => String(v).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
      const row = (k: string, v: string) => `<tr><td>${k}</td><td>${v}</td></tr>`;
      let dernier = "";
      const montrerHub = (e: MapLayerMouseEvent) => {
        if (toolRef.current !== "none" || !map || !e.features?.length) return;
        const id = Number((e.features[0].properties as { id: number }).id);
        const h = hubsRef.current?.hubs.find((x) => x.id === id);
        if (!h) return;
        survol.setLngLat(e.lngLat);
        if (dernier === "h" + h.id && survol.isOpen()) return;
        dernier = "h" + h.id;
        survol.setHTML(
          `<div class="hd-pop-h"><b>Wildfire hub · ${esc(h.pays ?? "—")}</b><span>${fmtLat(h.lat)} ${fmtLon(h.lon)}</span></div><table>` +
          row("Exposure score", `<i class="hd-pop-sw" style="background:${couleurScore(h.score)}"></i>${h.score} <small>/ 100</small>`) +
          row("Confidence", `${pct(h.confiance)} <small>${libConfiance(h.confiance)} · bootstrap over years</small>`) +
          row("Years with an episode", `${h.annees_episode} <small>of ${(hubsRef.current?.annees[1] ?? 2025) - (hubsRef.current?.annees[0] ?? 2003) + 1}</small>`) +
          row("Largest episode", `${esc(moisTxt(h.pic.mois))} · ${fmtInt(h.pic.detections)} <small>detections</small>`) +
          row("Last episode", esc(moisTxt(h.dernier))) +
          row("Intensity", `${fmtVal(h.frp_det)} <small>MW / detection</small>`) +
          row("Extent", `${h.h3.length} hexagon${h.h3.length > 1 ? "s" : ""} · ${fmtInt(h.aire_km2)} km²`) +
          `</table><div style="font-size:10.5px;color:#475569;margin-top:3px">Click: record of this hub</div>`);
        if (!survol.isOpen()) survol.addTo(map);
      };
      const montrerCell = (e: MapLayerMouseEvent) => {
        const tt = tRef.current;
        if (toolRef.current !== "none" || !map || !e.features?.length || !tt || map.getZoom() < 3.2) return;
        const i = Number((e.features[0].properties as { i: number }).i);
        survol.setLngLat(e.lngLat);
        if (dernier === "c" + i && survol.isOpen()) return;
        dernier = "c" + i;
        const [lo, la] = centreHex(tt.h3[i]);
        const tr = tendanceLocale(tt, i);
        const lc = Number(tt.col.lc[i]);
        survol.setHTML(
          `<div class="hd-pop-h"><b>${esc(tt.meta.pays[Number(tt.col.pays[i])] ?? "—")}</b><span>${fmtLat(la)} ${fmtLon(lo)}</span></div><table>` +
          row("Local trend 2003–2025", tr.classe === -128 ? "too few detections to test" : `${signe(tr.sen)} %/yr · ${tr.classe === 0 ? "not significant" : tr.classe > 0 ? "significant increase" : "significant decrease"} <small>(q=${fmtP(tr.q)})</small>`) +
          row("Trajectory", esc(tt.meta.trajectoires[Number(tt.col.trajectoire[i])] ?? "—")) +
          row("Fire regime", esc(tt.meta.regimes[Number(tt.col.regime[i])] ?? "—")) +
          row("Mean density", `${fmtVal(f32(tt, "dens", i))} <small>/1,000 km²/mo</small>`) +
          row("Land cover", esc(lc < 255 ? tt.meta.occupation_du_sol[lc] : "—")) +
          row("H3 res 4", `~42 km · ${fmtInt(f32(tt, "aire", i))} km²`) + `</table>`);
        if (!survol.isOpen()) survol.addTo(map);
      };
      const quitter = () => { if (map && toolRef.current === "none") map.getCanvas().style.cursor = ""; survol.remove(); dernier = ""; };
      for (const l of ["hub", "hubpt"]) {
        map.on("mousemove", l, montrerHub);
        map.on("click", l, (e) => { if (toolRef.current === "none" && e.features?.length) pickRef.current.hub(Number((e.features[0].properties as { id: number }).id)); });
        map.on("mouseenter", l, () => { if (map && toolRef.current === "none") map.getCanvas().style.cursor = "pointer"; });
        map.on("mouseleave", l, quitter);
      }
      map.on("mousemove", "hex", montrerCell);
      map.on("click", "hex", (e) => {
        if (toolRef.current !== "none" || !e.features?.length || !map) return;
        if (map.queryRenderedFeatures(e.point, { layers: ["hub", "hubpt"] }).length) return; // a hub is on top
        pickRef.current.cell(Number((e.features[0].properties as { i: number }).i));
      });
      map.on("mouseenter", "hex", () => { if (map && toolRef.current === "none") map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", "hex", quitter);

      const reel = (ll: { lng: number; lat: number }): [number, number] => [ll.lng, gpActifRef.current ? gpDeCarte(ll.lat) : ll.lat];
      map.on("click", (e) => {
        if (toolRef.current !== "poly" || !map) return;
        const pts = polyPts.current;
        if (pts.length >= 3) {
          const first = map.project([pts[0][0], gpActifRef.current ? gpVersCarte(pts[0][1]) : pts[0][1]]);
          if (Math.hypot(first.x - e.point.x, first.y - e.point.y) < 12) { finalizeRef.current(pts, false); return; }
        }
        pts.push(reel(e.lngLat)); setPolyN(pts.length); src.current.draft = draftPoly(pts); pushSources();
      });
      map.on("dblclick", (e) => { if (toolRef.current !== "poly") return; e.preventDefault(); finalizeRef.current(polyPts.current.filter((p, i, a) => i === 0 || Math.hypot(p[0] - a[i - 1][0], p[1] - a[i - 1][1]) > 1e-6), false); });
      map.on("mousemove", (e) => { if (toolRef.current !== "poly" || !polyPts.current.length) return; src.current.draft = draftPoly(polyPts.current, reel(e.lngLat)); pushSources(); });
      const el = map.getCanvasContainer();
      let start: { x: number; y: number; ll: [number, number] } | null = null;
      const local = (ev: PointerEvent) => { const r = el.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; };
      el.addEventListener("pointerdown", (ev) => { if (toolRef.current !== "box" || !map) return; const p = local(ev); start = { x: p.x, y: p.y, ll: reel(map.unproject([p.x, p.y])) }; el.setPointerCapture(ev.pointerId); });
      el.addEventListener("pointermove", (ev) => { if (!start || !map) return; const p = local(ev); src.current.draft = draftBox(start.ll, reel(map.unproject([p.x, p.y]))); pushSources(); });
      el.addEventListener("pointerup", (ev) => {
        if (!start || !map) return;
        const p = local(ev), s = start;
        start = null;
        if (Math.hypot(p.x - s.x, p.y - s.y) < 8) { src.current.draft = EMPTY_FC; pushSources(); return; }
        const [lng, lat] = reel(map.unproject([p.x, p.y]));
        finalizeRef.current(rectRing([Math.min(s.ll[1], lat), Math.max(s.ll[1], lat), Math.min(s.ll[0], lng), Math.max(s.ll[0], lng)]).slice(0, 4), true);
      });
    })();
    return () => { cancelled = true; if (moveendTimer) clearTimeout(moveendTimer); map?.remove(); mapRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const colorRef = useRef<() => void>(() => {});
  colorRef.current = () => {
    const m = mapRef.current;
    if (!m?.getLayer("hex")) return;
    if (couche !== "hubs") {
      m.setPaintProperty("hex", "fill-color", couleurCellules(couche) as never);
      m.setPaintProperty("hex", "fill-opacity", (couche === "tendance" ? ["case", ["==", ["get", "s"], 0], 0.3, 0.85] : 0.8) as never);
    }
    m.setPaintProperty("hub", "fill-color", exprScore() as never);
    m.setPaintProperty("hubpt", "circle-color", exprScore() as never);
    const p = palette();
    m.setPaintProperty("sel-fill", "fill-color", p.alert);
    m.setPaintProperty("sel-line", "line-color", p.alert);
  };
  useEffect(() => { colorRef.current(); }, [couche, ready, daltonien]);
  useEffect(() => { src.current.hex = hexes; src.current.hub = hubFeatures.cells; src.current.hubpt = hubFeatures.pts; pushSources(); }, [hexes, hubFeatures, ready, pushSources]);
  useEffect(() => { pushSources(); }, [selection, ready, pushSources]);

  /* Score labels: the hubs of the zone carry their score on the map (HTML markers, at most MAX_ETIQUETTES) */
  const etiquettes = useRef<Marker[]>([]);
  useEffect(() => {
    const m = mapRef.current, ml = mlRef.current as { Marker: new (o: { element: HTMLElement; anchor: "center" }) => Marker } | null;
    if (!m || !ml || !ready || (!selection && zoomCarte < 5)) return;
    const vb = mapBounds;
    const liste = hubsVisibles.filter((h) => selection || (vb && inViewport(h.lon, h.lat, vb, 0))).slice().sort((a, b) => b.score - a.score).slice(0, MAX_ETIQUETTES);
    for (const h of liste) {
      const el = document.createElement("button");
      el.className = "tf-score" + (h.id === hubSel ? " sel" : "") + (annee !== null && !(h.serie[annee - A0] > 0) ? " off" : "");
      el.textContent = String(h.score);
      el.title = `Exposure score ${h.score}/100 · confidence ${pct(h.confiance)}`;
      el.style.background = couleurScore(h.score);
      el.style.color = h.score > 50 ? "#fff" : "#0f172a";
      el.onclick = (ev) => { ev.stopPropagation(); pickRef.current.hub(h.id); };
      etiquettes.current.push(new ml.Marker({ element: el, anchor: "center" }).setLngLat([h.lon, gpActifRef.current ? gpVersCarte(h.lat) : h.lat]).addTo(m));
    }
    return () => { etiquettes.current.forEach((x) => x.remove()); etiquettes.current = []; };
  }, [hubsVisibles, selection, zoomCarte, mapBounds, ready, hubSel, annee, A0, daltonien, flat, proj2D]);

  /* ── 2D / 3D and Gall-Peters: same behaviour as the Analytics view ── */
  const appliquerGeo = useCallback(() => {
    const m = mapRef.current;
    const gp = flatRef.current && proj2DRef.current === "gall";
    if (!m || gp === gpActifRef.current) return;
    const c = m.getCenter();
    const latReelle = gpActifRef.current ? gpDeCarte(c.lat) : c.lat;
    gpActifRef.current = gp;
    try { for (const id of ["sat", "roads", "places"]) (m.getSource(id) as unknown as { setTiles?: (x: string[]) => void } | undefined)?.setTiles?.(tuilesPour(id, gp)); } catch { /* source not ready */ }
    m.jumpTo({ center: [c.lng, gp ? gpVersCarte(latReelle) : latReelle] });
    sent.current = {};
    pushSources();
  }, [pushSources]);
  useEffect(() => { proj2DRef.current = proj2D; if (ready) appliquerGeo(); }, [proj2D, ready, appliquerGeo]);
  const prevFlatRef = useRef(false);
  const morphTRef = useRef(0);
  useEffect(() => {
    flatRef.current = flat;
    const m = mapRef.current;
    if (!m || !ready) return;
    const from = prevFlatRef.current;
    prevFlatRef.current = flat;
    if (!flat) appliquerGeo();
    const GLOBE_EXPR = ["interpolate", ["linear"], ["zoom"], 11, "vertical-perspective", 12, "mercator"];
    type Internal = { style?: { stylesheet?: { projection?: unknown }; projection?: { name?: string; setProjection?: (p: unknown) => void; _transitionable?: { untransitioned: () => unknown }; _transitioning?: unknown } }; _update?: (u: boolean) => void };
    const setGlobeExpr = (type: unknown, name: string) => {
      const im = m as unknown as Internal;
      const proj = im.style?.projection;
      if (proj?.name === "globe" && proj.setProjection && proj._transitionable && im._update && im.style?.stylesheet) {
        proj.setProjection({ type }); proj._transitioning = proj._transitionable.untransitioned(); im.style.stylesheet.projection = { type: name }; im._update(true);
      } else m.setProjection({ type } as never);
    };
    const settle = () => {
      try {
        if (flat) { m.setProjection({ type: "mercator" }); appliquerGeo(); } else setGlobeExpr(GLOBE_EXPR, "globe");
        morphTRef.current = flat ? 1 : 0;
        m.setMaxPitch(flat ? 0 : 75);
      } catch { /* older style spec */ }
    };
    const refreshTiles = () => { try { for (const id of ["sat", "roads", "places"]) (m.getSource(id) as unknown as { setTiles?: (x: string[]) => void } | undefined)?.setTiles?.(tuilesPour(id, gpActifRef.current)); m.triggerRepaint(); } catch { /* noop */ } };
    try {
      if (flat) { m.dragRotate.disable(); m.touchZoomRotate.disableRotation(); m.easeTo({ pitch: 0, bearing: 0, duration: MORPH_MS }); }
      else { m.setMaxPitch(75); m.dragRotate.enable(); m.touchZoomRotate.enableRotation(); }
    } catch { /* noop */ }
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (from === flat || reduce) { settle(); if (from !== flat) refreshTiles(); return; }
    let raf = 0;
    const tStart = morphTRef.current, tEnd = flat ? 1 : 0, dur = Math.max(1, MORPH_MS * Math.abs(tEnd - tStart)), t0 = performance.now();
    const step = (now: number) => {
      const p = clamp((now - t0) / dur, 0, 1), e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2, x = tStart + (tEnd - tStart) * e;
      morphTRef.current = x;
      if (p >= 1) { settle(); refreshTiles(); return; }
      const z = m.getZoom();
      try { setGlobeExpr(["interpolate", ["linear"], ["zoom"], z - x, "vertical-perspective", z + 1 - x, "mercator"], "globe"); } catch { settle(); refreshTiles(); return; }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [flat, ready, appliquerGeo]);

  useEffect(() => {
    const m = mapRef.current;
    if (m) {
      m.getCanvas().style.cursor = tool === "none" ? "" : "crosshair";
      if (tool === "box") m.dragPan.disable(); else m.dragPan.enable();
      if (tool === "poly") m.doubleClickZoom.disable(); else m.doubleClickZoom.enable();
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { polyPts.current = []; setPolyN(0); setDraft(EMPTY_FC); setTool("none"); setSplit(false); }
      if (e.key === "Enter" && toolRef.current === "poly") finishPoly();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, ready]);

  /* ── Timeline of the hubs: one year at a time, or all years ── */
  useEffect(() => {
    if (!lecture) return;
    const id = setInterval(() => setAnnee((y) => (y === null || y >= A1 ? A0 : y + 1)), 800);
    return () => clearInterval(id);
  }, [lecture, A0, A1]);
  const parAn = useMemo(() => {
    const nn = A1 - A0 + 1, det = new Array(nn).fill(0), nb = new Array(nn).fill(0);
    for (const h of hubsVisibles) h.serie.forEach((v, k) => { if (v > 0) { det[k] += v; nb[k]++; } });
    return { det, nb, max: Math.max(1, ...det) };
  }, [hubsVisibles, A0, A1]);

  /* ── Trend of the zone total (territories summed first) ── */
  const stats = useMemo(() => {
    if (!serie) return null;
    const obs = serie.valeurs, ans = serie.annees;
    const mk = mannKendall(obs), sen = senSlope(ans, obs);
    const moy = obs.reduce((a, b) => a + b, 0) / obs.length;
    return { obs, ans, mk, sen, med: quantileHF8(sortAsc(obs), 0.5), lisse: lisser(obs), pctAn: sen && moy > 0 ? (100 * sen.slope) / moy : null,
      pctLo: sen && moy > 0 ? (100 * sen.lo) / moy : null, pctHi: sen && moy > 0 ? (100 * sen.hi) / moy : null };
  }, [serie]);
  const verdict = !stats?.mk || stats.pctAn === null ? null : stats.mk.p < 0.05 ? (stats.pctAn > 0 ? "rising" : "declining") : "no significant trend";
  const classement = useMemo(() => hubsVisibles.slice().sort((a, b) => b.score - a.score), [hubsVisibles]);

  const exporter = () => {
    if (!hubs) return;
    let csv = `# Vigil Trends - wildfire hubs - ${selectionName || "world"} - generated ${hubs.genere_le}\n` +
      `# Hub = space-time cluster of unusual bursts of harmonized detections (MODIS-Aqua eq., VIGIL-K1), ${A0}-${A1}; regular seasonal burning is excluded by construction.\n` +
      `# score = exposure 1-100 (percentile among all hubs of: share of years with an episode, episode detections per 1,000 km2 per year, FRP per detection).\n` +
      `# confidence = bootstrap over years (share of ${hubs.parametres.n_boot} resamples in which the hub is still detected). Method: docs/methode_tf.md\n` +
      "hub_id,lat,lon,country,score,confidence,years_with_episode,episode_detections,area_km2,hexagons,frp_per_detection_MW,largest_episode_month,largest_episode_detections,last_episode_month,h3_res5_cells\n";
    for (const h of classement) csv += [h.id, h.lat, h.lon, `"${h.pays ?? ""}"`, h.score, h.confiance, h.annees_episode, h.detections, h.aire_km2, h.h3.length, h.frp_det, h.pic.mois, h.pic.detections, h.dernier, `"${h.h3.join(" ")}"`].join(",") + "\n";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `vigil_trends_hubs_${(selectionName || "world").replace(/[^a-z0-9]/gi, "_")}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  if (erreur) {
    return (
      <div className="hd-root">
        <style dangerouslySetInnerHTML={{ __html: CSS + TF_CSS }} />
        <div className="hd-fatal" role="alert"><b>Vigil Trends data could not be loaded.</b><p className="hd-mono">{erreur}</p>
          <p>Expected files under <code>/data/tf/</code>: hubs.json, cellules.bin.gz, modele.json (<code>python -m pipeline.tf.hubs</code>, <code>python -m pipeline.tf.executer</code>).</p></div>
      </div>
    );
  }

  const W = 340, H = 118, ml = 30, mr = 6, mt = 8, mb = 16, pw = W - ml - mr, ph = H - mt - mb;
  const n = serie?.annees.length ?? 1;
  const ticks = niceTicks(Math.max(1, ...(serie?.valeurs ?? [1])) * 1.05), yMax = ticks[ticks.length - 1];
  const xAt = (k: number) => ml + (k / Math.max(1, n - 1)) * pw, yAt = (v: number) => mt + ph - (Math.min(v, yMax) / yMax) * ph;
  const chemin = (v: number[]) => v.map((x, k) => `${k === 0 ? "M" : "L"}${xAt(k).toFixed(1)},${yAt(x).toFixed(1)}`).join("");
  const nomZone = hub ? `Hub · ${hub.pays ?? ""} ${fmtLat(hub.lat)} ${fmtLon(hub.lon)}` : cellule !== null && t ? `${t.meta.pays[Number(t.col.pays[cellule])] ?? "Territory"} · ${fmtLat(f32(t, "lat", cellule))} ${fmtLon(f32(t, "lon", cellule))}` : selectionName;
  const NY = A1 - A0 + 1;
  const rangMonde = hub && hubs ? (100 * hubs.hubs.filter((x) => x.score < hub.score).length) / hubs.hubs.length : null;
  const nAn = annee === null ? hubsVisibles.length : parAn.nb[annee - A0];

  return (
    <div className={"hd-root" + (flat && proj2D === "gall" ? " hd-gp" : "")}>
      <style dangerouslySetInnerHTML={{ __html: CSS + TF_CSS }} />
      <div ref={containerRef} className="hd-map" />
      <OrbitOverlay mapRef={mapRef} ready={ready} visible={!selection && !flat && !hub && cellule === null} enterDelayMs={MORPH_MS} />
      <button className={"hd-cvd" + (daltonien ? " on" : "")} onClick={() => setDaltonien(!daltonien)} aria-pressed={daltonien} title={daltonien ? "Colour-blind mode on (click for standard colours)" : "Colour-blind mode"} aria-label="Colour-blind mode">
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>
      </button>

      {!split && <div className="hd-toolbar">
        <img className="hd-logo" src="/vigil-logo.png" alt="Vigil" />
        <div className="hd-search">
          <button className={"hd-search-toggle" + (searchOpen ? " on" : "")} aria-label="Search a country, region or coordinates" aria-expanded={searchOpen} title="Search"
            onClick={() => { if (selection) setPanelLeftOpen(true); else { setSearchOpen(!searchOpen); setNewName(NEW_REGION); } setTimeout(() => searchInputRef.current?.focus(), 0); }}>
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="6" cy="6" r="4.5" /><line x1="9.5" y1="9.5" x2="13" y2="13" /></svg>
          </button>
        </div>
        <div className="hd-group">
          <button className={"hd-btn" + (tool === "box" ? " on" : "")} onClick={() => pickTool("box")}>Box</button>
          <button className={"hd-btn" + (tool === "poly" ? " on" : "")} onClick={() => pickTool("poly")}>Polygon</button>
          {tool === "poly" && polyN >= 3 && <button className="hd-btn accent" onClick={finishPoly}>Finish</button>}
          {(selection || cellule !== null || hub) && <button className="hd-btn" onClick={clearSelection}>Clear</button>}
          <button className="hd-btn" onClick={() => setFlat(!flat)} aria-pressed={flat} title={flat ? "Switch to 3D globe" : "Switch to 2D map"}>{flat ? "3D" : "2D"}</button>
          {flat && <span className="hd-proj" role="group" aria-label="2D map projection">
            <button className={"hd-btn" + (proj2D === "gall" ? " on" : "")} onClick={() => setProj2D("gall")} aria-pressed={proj2D === "gall"} title="Gall-Peters: equal-area projection, true relative sizes of countries">Gall-Peters</button>
            <button className={"hd-btn" + (proj2D === "mercator" ? " on" : "")} onClick={() => setProj2D("mercator")} aria-pressed={proj2D === "mercator"} title="Mercator: true shapes and angles, areas inflated toward the poles">Mercator</button>
          </span>}
        </div>
        <div className="tf-layers"><Seg<Couche> label="Map layer" value={couche} onChange={setCouche} options={COUCHES} /></div>
      </div>}

      {!split && tool !== "none" && <div className="hd-hintbar">{tool === "box" ? "Drag on the map" : polyN < 3 ? `Click to add vertices (${polyN})` : "Click first vertex, double-click, or Enter to close"}<span>Esc to cancel</span></div>}

      {/* Map key: score ramp, timeline of episodes, confidence filter */}
      {hubs && (
        <div className="hd-mapkey hd-glass tf-key" aria-label="Map key">
          <div className="hd-mapkey-row">
            <b className="hd-mono">{annee ?? `${A0}–${A1}`}</b>
            <span className="hd-mono hd-mapkey-tot">{fmtInt(nAn)} hub{nAn > 1 ? "s" : ""}{annee !== null ? ` with an episode · ${fmtInt(parAn.det[annee - A0])} detections` : selection ? ` in ${selectionName}` : " worldwide"}</span>
          </div>
          <div className="hd-mapkey-ramp" style={{ gridTemplateColumns: "repeat(10,1fr)" }} role="img" aria-label="Exposure score from 1 to 100, ten classes">{pal.hex.slice(2).map((c, i) => <i key={i} style={{ background: c }} title={`${i * 10 + 1}–${(i + 1) * 10}`} />)}</div>
          <div className="hd-mapkey-ticks hd-mono" aria-hidden="true">{[1, 20, 40, 60, 80, 100].map((v) => <span key={v} style={{ left: `${v === 1 ? 2 : v === 100 ? 97 : v}%` }}>{v}</span>)}</div>
          <div className="hd-mapkey-note">Exposure score of each wildfire hub (1–100) · pale = confidence under 70 % · disc size grows with the score</div>
          <div className="tf-frise" role="group" aria-label="Timeline of wildfire episodes">
            <button className="tf-play" onClick={() => { if (!lecture && annee === null) setAnnee(A0); setLecture(!lecture); }} aria-pressed={lecture} aria-label={lecture ? "Pause" : "Play the years"} title={lecture ? "Pause" : `Play ${A0} → ${A1}`}>{lecture ? "❚❚" : "▶"}</button>
            <div className="tf-bars">{parAn.det.map((v, k) => (
              <button key={k} className={annee === A0 + k ? "on" : ""} onClick={() => { setLecture(false); setAnnee(annee === A0 + k ? null : A0 + k); }} title={`${A0 + k}: ${parAn.nb[k]} hubs with an episode, ${fmtInt(v)} detections`} aria-label={`${A0 + k}`}>
                <i style={{ height: `${Math.max(4, (100 * v) / parAn.max)}%` }} /></button>))}</div>
            <button className="tf-all" onClick={() => { setLecture(false); setAnnee(null); }} disabled={annee === null && !lecture}>All</button>
          </div>
          <div className="tf-axis hd-mono" aria-hidden="true"><span>{A0}</span><span>episode detections per year · click a year</span><span>{A1}</span></div>
          <label className="tf-conf"><span>Min. confidence</span>
            <input type="range" min={0} max={95} step={5} value={Math.round(confMin * 100)} onChange={(e) => setConfMin(Number(e.target.value) / 100)} aria-label="Hide hubs under this confidence" />
            <b className="hd-mono">{Math.round(confMin * 100)} %</b></label>
          {couche !== "hubs" && t && (
            <div className="tf-under">
              <div className="tf-comp-t">Background · {COUCHES.find((c) => c.v === couche)?.t}</div>
              {couche === "tendance" ? (
                <><div className="hd-mapkey-ramp" style={{ gridTemplateColumns: "repeat(9,1fr)" }}>{pal.div.map((c, i) => <i key={i} style={{ background: c }} />)}</div>
                  <div className="hd-mapkey-ticks hd-mono" aria-hidden="true">{SEN_BREAKS.map((v, i) => <span key={v} style={{ left: `${((i + 1) * 100) / 9}%` }}>{v > 0 ? `+${v}` : v}</span>)}</div>
                  <div className="hd-mapkey-note">% per year (Theil–Sen), each ~42 km territory pooled with its 6 neighbours. Grey = not significant (Mann–Kendall, false discovery rate ≤ 10 %).</div></>
              ) : <div className="tf-cat">{(couche === "regime" ? t.meta.regimes : t.meta.trajectoires).slice(1).map((nom, i) => <span key={nom}><i style={{ background: CATEG[i + 1] }} />{nom}</span>)}</div>}
            </div>
          )}
        </div>
      )}

      {!split && (selection || searchOpen) && (
        <aside ref={leftDrag.ref} style={leftDrag.style} className={"hd-panel-left hd-glass" + (panelLeftOpen ? "" : " collapsed") + (leftDrag.dragging ? " dragging" : "")} aria-label="Region settings">
          <div className="hd-panel-head" {...leftDrag.handle}>
            <RegionName name={selection ? selectionName : newName} onRename={selection ? setSelectionName : setNewName} />
            <button className="hd-icon" onClick={() => setPanelLeftOpen(!panelLeftOpen)} aria-label={panelLeftOpen ? "Collapse region panel" : "Expand region panel"} aria-expanded={panelLeftOpen}>
              <svg width="12" height="12" viewBox="0 0 14 14"><path d={panelLeftOpen ? "M2 5l5 5 5-5" : "M2 9l5-5 5 5"} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" /></svg>
            </button>
          </div>
          {panelLeftOpen && <div className="hd-panel-body"><CarteRegion selection={selection} searchRef={searchInputRef} onPick={selectPlace} name={selection ? selectionName : newName} onApplyBbox={handleApplyBbox} onExport={exporter} /></div>}
        </aside>
      )}

      {/* Right panel: record of a hub, or ranking of the hubs of the zone with its trend */}
      {!split && hubs && (hub || selection || cellule !== null) && (
        <aside ref={rightDrag.ref} style={rightDrag.style} className={"hd-panel hd-glass" + (panelOpen ? "" : " collapsed") + (rightDrag.dragging ? " dragging" : "")} aria-label="Vigil Trends">
          <div className="hd-panel-head" {...rightDrag.handle}>
            <span className="hd-mono hd-name tf-zone-name">{nomZone}</span>
            <div className="hd-head-actions">
              {(hub || cellule !== null) && selection && <button className="hd-btn tf-back" onClick={() => { setHubSel(null); setCellule(null); fitTo(selection.region.bbox); }} title="Back to the whole zone">← {selectionName}</button>}
              <button className="hd-icon" onClick={() => setSplit(true)} aria-label="Dashboard: every hub, method and diagnostics" title="Dashboard"><ExpandIcon /></button>
              <button className="hd-icon" onClick={() => setPanelOpen(!panelOpen)} aria-label={panelOpen ? "Collapse panel" : "Expand panel"} aria-expanded={panelOpen}>
                <svg width="12" height="12" viewBox="0 0 14 14"><path d={panelOpen ? "M2 5l5 5 5-5" : "M2 9l5-5 5 5"} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" /></svg>
              </button>
            </div>
          </div>
          {panelOpen && (
            <div className="hd-panel-body">
              {hub ? (
                <>
                  <div className="tf-hubhead">
                    <div className="tf-big" style={{ background: couleurScore(hub.score), color: hub.score > 50 ? "#fff" : "#0f172a" }}><b>{hub.score}</b><small>/ 100</small></div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="tf-comp-t">Exposure score</div>
                      <div className="hd-median-row hd-mono">above {rangMonde !== null ? Math.round(rangMonde) : "—"} % of the {fmtInt(hubs.hubs.length)} hubs worldwide</div>
                      <div className="tf-confbar" title="Bootstrap over years: share of resamples in which this hub is still detected"><i style={{ width: `${Math.round(100 * hub.confiance)}%` }} /></div>
                      <div className="hd-median-row hd-mono dim">confidence {pct(hub.confiance)} · {libConfiance(hub.confiance)}{hub.annees_episode === 1 ? " · rests on a single year" : ""}</div>
                    </div>
                  </div>
                  <div className="tf-kv">
                    <div><span>Years with an episode</span><b>{hub.annees_episode} / {NY}</b></div>
                    <div><span>Episode detections</span><b>{fmtInt(hub.detections)}</b></div>
                    <div><span>Largest episode</span><b>{moisTxt(hub.pic.mois)} · {fmtInt(hub.pic.detections)}</b></div>
                    <div><span>Last episode</span><b>{moisTxt(hub.dernier)}</b></div>
                    <div><span>Intensity</span><b>{fmtVal(hub.frp_det)} MW / det.</b></div>
                    <div><span>Extent</span><b>{hub.h3.length} hex · {fmtInt(hub.aire_km2)} km²</b></div>
                    <div title="Share of all the detections of these hexagons that belongs to episodes; the rest is ordinary, recurrent burning"><span>Episodic share</span><b>{pct(hub.part_episodique)}</b></div>
                    <div><span>Country</span><b>{hub.pays ?? "—"}</b></div>
                  </div>
                  <div className="tf-comp">
                    <div className="tf-comp-t">Episode detections per year</div>
                    <div className="tf-hist">{hub.serie.map((v, k) => <i key={k} className={annee === A0 + k ? "on" : ""} style={{ height: `${v > 0 ? Math.max(6, (100 * v) / Math.max(...hub.serie)) : 2}%`, background: v > 0 ? couleurScore(hub.score) : "#cbd5e1" }} title={`${A0 + k}: ${fmtVal(v)} detections`} onClick={() => setAnnee(annee === A0 + k ? null : A0 + k)} />)}</div>
                    <div className="tf-axis hd-mono" style={{ padding: 0 }} aria-hidden="true"><span>{A0}</span><span>{A0 + Math.round(NY / 2)}</span><span>{A1}</span></div>
                  </div>
                  <p className="tf-foot">A hub is a group of neighbouring ~17 km hexagons hit by bursts of detections far above what they usually show in that month. Fields burnt every year at the same season never qualify. The score ranks exposure among hubs; it is not a probability of fire.</p>
                </>
              ) : (
                <>
                  {cellule === null && (
                    <div className="tf-comp">
                      <div className="tf-comp-t">{classement.length} wildfire hub{classement.length > 1 ? "s" : ""} · ranked by exposure</div>
                      {classement.length === 0 ? <p className="hd-zone-note" style={{ margin: 0 }}>No hub in this zone at this confidence: no burst of detections stood out from its usual burning.</p> : (
                        <div className="tf-list"><table className="tf-top"><thead><tr><th>Score</th><th>Where</th><th>Conf.</th><th>Years</th><th>Largest episode</th></tr></thead><tbody>
                          {classement.slice(0, 40).map((h) => (
                            <tr key={h.id} onClick={() => ouvrirHub(h.id, true)} tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") ouvrirHub(h.id, true); }} className={annee !== null && !(h.serie[annee - A0] > 0) ? "off" : ""}>
                              <td><span className="tf-chip" style={{ background: couleurScore(h.score), color: h.score > 50 ? "#fff" : "#0f172a" }}>{h.score}</span></td>
                              <td>{fmtLat(h.lat)} {fmtLon(h.lon)}</td><td>{pct(h.confiance)}</td><td>{h.annees_episode}</td><td>{moisTxt(h.pic.mois)} · {fmtCompact(h.pic.detections)}</td>
                            </tr>))}</tbody></table></div>)}
                      {classement.length > 40 && <div className="hd-mapkey-note">40 highest of {classement.length}; all of them in the dashboard and the CSV.</div>}
                    </div>
                  )}
                  {serie && stats && (
                    <>
                      <div className="hd-median">
                        <div className="hd-median-head"><b>Activity trend {A0}–{A1}</b>
                          {verdict && <span className="hd-median-cls" style={{ background: verdict === "rising" ? pal.div[7] : verdict === "declining" ? pal.div[1] : "#f1f5f9", color: verdict === "no significant trend" ? "#0f172a" : "#fff" }}>{verdict}</span>}</div>
                        <div className="hd-median-row hd-mono">{stats.pctAn !== null ? `${signe(stats.pctAn)} % / yr` : "—"}{stats.pctLo !== null && stats.pctHi !== null ? ` · 95 % CI ${signe(stats.pctLo)} to ${signe(stats.pctHi)}` : ""}</div>
                        <div className="hd-median-row hd-mono dim">all harmonized detections of {cellule !== null ? "this ~42 km territory" : "the zone"} · Theil–Sen · Mann–Kendall p={stats.mk ? fmtP(stats.mk.p) : "—"}</div>
                      </div>
                      <div className="hd-chart-wrap">
                        <svg viewBox={`0 0 ${W} ${H}`} className="hd-chart" role="img" aria-label="Annual harmonized detections: observed, smoothed and trend">
                          {ticks.map((v) => <g key={v}><line x1={ml} x2={W - mr} y1={yAt(v)} y2={yAt(v)} stroke="#e2e8f0" /><text x={ml - 6} y={yAt(v) + 3.5} textAnchor="end" className="hd-axis">{fmtCompact(v)}</text></g>)}
                          {serie.annees.map((y, k) => (y % 5 === 0 ? <text key={y} x={xAt(k)} y={H - 3} textAnchor="middle" className="hd-axis">{y}</text> : null))}
                          <line x1={ml} x2={W - mr} y1={yAt(stats.med)} y2={yAt(stats.med)} stroke="#475569" strokeDasharray="4 3" />
                          <path d={chemin(stats.obs)} fill="none" stroke="#94a3b8" strokeWidth={1} />
                          {stats.sen && <line x1={xAt(0)} x2={xAt(n - 1)} y1={yAt(Math.max(0, stats.sen.intercept + stats.sen.slope * A0))} y2={yAt(Math.max(0, stats.sen.intercept + stats.sen.slope * A1))} stroke="#0f172a" strokeWidth={1} strokeDasharray="6 4" />}
                          <path d={chemin(stats.lisse)} fill="none" stroke={pal.accent} strokeWidth={2.2} strokeLinejoin="round" />
                          {hoverAn !== null && <line x1={xAt(hoverAn)} x2={xAt(hoverAn)} y1={mt} y2={mt + ph} stroke="#0f172a" opacity={0.25} />}
                          <rect x={ml} y={mt} width={pw} height={ph} fill="transparent" onMouseLeave={() => setHoverAn(null)} onMouseMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); setHoverAn(clamp(Math.round(((e.clientX - r.left) / r.width) * (n - 1)), 0, n - 1)); }} />
                        </svg>
                        <div className="hd-chart-legend tf-leg">
                          <span><svg width="18" height="6"><line x1="0" y1="3" x2="18" y2="3" stroke="#94a3b8" strokeWidth="1.2" /></svg>observed</span>
                          <span><svg width="18" height="6"><line x1="0" y1="3" x2="18" y2="3" stroke={pal.accent} strokeWidth="2.4" /></svg>5-yr smoothed</span>
                          <span><svg width="18" height="6"><line x1="0" y1="3" x2="18" y2="3" stroke="#0f172a" strokeWidth="1.2" strokeDasharray="5 3" /></svg>Sen trend</span>
                          <span className="hd-mono">{hoverAn !== null ? `${serie.annees[hoverAn]}: ${fmtVal(serie.valeurs[hoverAn])}` : `median ${fmtVal(stats.med)}`}</span>
                        </div>
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          )}
        </aside>
      )}

      {split && hubs && (
        <div className="hd-split" role="dialog" aria-label="Vigil Trends dashboard">
          <div className="hd-split-head hd-split-head-bar hd-glass">
            <span className="hd-mono hd-name">{selectionName || "World"} · Vigil Trends</span>
            <div className="hd-split-head-end">
              <button className="hd-fb-btn" onClick={exporter}>Hubs (CSV)</button>
              <button className="hd-icon hd-split-close" onClick={() => setSplit(false)} aria-label="Exit dashboard (Esc)" title="Back (Esc)"><CollapseIcon /></button>
            </div>
          </div>
          <div className="hd-split-body"><section className="hd-split-pane hd-dash-pane hd-glass" aria-label="Vigil Trends dashboard">
            <TendancesDive hubs={hubs} liste={classement} modele={modele} titre={selectionName || "World"} onHub={(id) => { setSplit(false); ouvrirHub(id, true); }} />
          </section></div>
        </div>
      )}
      {!selection && !hub && cellule === null && hubs && !split && (
        <button className="tf-open hd-glass" onClick={() => setSplit(true)} title="Every hub, the method and its diagnostics"><ExpandIcon /> Hubs &amp; method</button>
      )}
    </div>
  );
}

function CarteRegion({ selection, searchRef, onPick, name, onApplyBbox, onExport }: {
  selection: Selection | null; searchRef: React.RefObject<HTMLInputElement>; onPick: (l: Lieu) => void; name: string;
  onApplyBbox: (bbox: [number, number, number, number], name: string) => void; onExport: () => void;
}) {
  const bboxSel = selection?.region.bbox ?? null;
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [] as Lieu[];
    return LIEUX.filter((l) => l.name.toLowerCase().includes(q)).sort((x, y) => Number(!x.name.toLowerCase().startsWith(q)) - Number(!y.name.toLowerCase().startsWith(q))).slice(0, 8);
  }, [query]);
  useEffect(() => { setActive(0); }, [query]);
  const pick = (l: Lieu) => { setQuery(""); onPick(l); };
  const [latMax, setLatMax] = useState(bboxSel ? bboxSel[1].toFixed(2) : "");
  const [lonMax, setLonMax] = useState(bboxSel ? bboxSel[3].toFixed(2) : "");
  const [sizeKm, setSizeKm] = useState(bboxSel ? bboxToSizeKm(bboxSel).toFixed(1) : "300.0");
  const [err, setErr] = useState({ latMax: "", lonMax: "", sizeKm: "" });
  useEffect(() => { if (!bboxSel) return; setLatMax(bboxSel[1].toFixed(2)); setLonMax(bboxSel[3].toFixed(2)); setSizeKm(bboxToSizeKm(bboxSel).toFixed(1)); }, [bboxSel]);
  const appliquer = () => { const r = bboxFromCorner(latMax, lonMax, sizeKm); setErr(r.err); if (r.bbox) onApplyBbox(r.bbox, name); };
  return (
    <div className="hd-region-card">
      <div className="hd-rc-section">
        <label htmlFor="tf-search-place" className="hd-rc-seclabel">Country or region</label>
        <div className="hd-search-field">
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="6" cy="6" r="4.5" /><line x1="9.5" y1="9.5" x2="13" y2="13" /></svg>
          <input ref={searchRef} id="tf-search-place" className="hd-search-input" placeholder="Search country or region…" aria-label="Search a country or region" autoComplete="off" value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setQuery("");
              else if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(matches.length - 1, i + 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
              else if (e.key === "Enter" && matches[active]) pick(matches[active]);
            }} />
          {query && <button className="hd-search-clear" onClick={() => setQuery("")} aria-label="Clear">×</button>}
        </div>
        {matches.length > 0 && <div className="hd-search-results" role="listbox">{matches.map((l, i) => (
          <button key={l.kind + l.name} role="option" aria-selected={i === active} className={"hd-search-result" + (i === active ? " on" : "")} onMouseEnter={() => setActive(i)} onClick={() => pick(l)}><span>{l.name}</span><span className="hd-search-kind">{l.kind}</span></button>))}</div>}
        {query.trim() && matches.length === 0 && <p className="hd-rc-note">No country or region matches “{query.trim()}”.</p>}
      </div>
      <div className="hd-rc-section">
        <div className="hd-rc-seclabel">Coordinates</div>
        <CoordFields idPrefix="tf-bbox" latMax={latMax} lonMax={lonMax} sizeKm={sizeKm} setLatMax={setLatMax} setLonMax={setLonMax} setSizeKm={setSizeKm} err={err} onEnter={appliquer} />
        <button className="hd-rc-apply" aria-label="Apply coordinate changes to map" onClick={appliquer}>Apply</button>
      </div>
      <div className="hd-rc-section">
        <button className="hd-rc-export" onClick={onExport} aria-label="Export the wildfire hubs of the zone as CSV">Export hubs (CSV)</button>
        <p className="hd-rc-hint">Every hub of the zone: position, score, confidence, episodes and its H3 hexagons.</p>
      </div>
    </div>
  );
}

const TF_CSS = `
.tf-layers{display:flex;align-items:center;gap:6px;padding:3px}
.tf-layers .hd-seg{border:0;background:transparent;padding:0}
.tf-layers .hd-seg button{padding:5px 10px;font-size:12px}
.tf-key{max-width:300px}
.tf-key .hd-mapkey-ramp,.tf-key .hd-mapkey-ticks{width:276px}
.tf-frise{display:flex;align-items:flex-end;gap:5px;margin-top:4px}
.tf-play,.tf-all{border:0;background:rgba(15,23,42,.08);height:22px;border-radius:6px;padding:0 7px;font-size:10px;font-weight:650;flex:0 0 auto}
.tf-all:disabled{opacity:.4;cursor:default}
.tf-bars{flex:1;display:flex;align-items:flex-end;gap:1.5px;height:34px}
.tf-bars button{flex:1;height:100%;border:0;padding:0;background:transparent;display:flex;align-items:flex-end;border-radius:2px}
.tf-bars button i{display:block;width:100%;background:#64748b;border-radius:1.5px 1.5px 0 0}
.tf-bars button:hover i{background:#0f172a}
.tf-bars button.on i{background:var(--or)}
.tf-bars button.on{box-shadow:0 2px 0 var(--or)}
.tf-axis{display:flex;justify-content:space-between;font-size:9.5px;color:#334155}
.tf-conf{display:flex;align-items:center;gap:8px;font-size:10.5px;margin-top:2px}
.tf-conf input{flex:1;accent-color:#0f172a;height:14px}
.tf-under{margin-top:4px;padding-top:6px;border-top:1px solid rgba(15,23,42,.12);display:flex;flex-direction:column;gap:4px}
.tf-cat{display:flex;flex-direction:column;gap:3px;font-size:11px}
.tf-cat span{display:inline-flex;align-items:center;gap:6px}
.tf-cat i{flex:0 0 12px;height:10px;border-radius:2px;box-shadow:inset 0 0 0 1px rgba(15,23,42,.2)}
.tf-score{border:1.5px solid #fff;border-radius:999px;min-width:26px;height:20px;padding:0 5px;font:700 11px ui-monospace,SFMono-Regular,Menlo,monospace;box-shadow:0 1px 6px rgba(15,23,42,.45);cursor:pointer;margin-top:-34px}
.tf-score.sel{border-color:#0f172a;box-shadow:0 0 0 2px #fff,0 2px 8px rgba(15,23,42,.6)}
.tf-score.off{opacity:.25}
.tf-zone-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:190px}
.tf-back{font-size:11px;padding:3px 7px;max-width:110px;overflow:hidden;text-overflow:ellipsis}
.tf-leg{flex-wrap:wrap;gap:4px 10px!important;font-size:10px!important}
.tf-comp{margin:0 14px;display:flex;flex-direction:column;gap:5px}
.tf-comp-t{font-size:10px;font-weight:650;text-transform:uppercase;letter-spacing:.06em}
.tf-list{max-height:236px;overflow:auto;border:1px solid rgba(15,23,42,.1);border-radius:7px;background:rgba(255,255,255,.55)}
.tf-top{width:100%;border-collapse:collapse;font:11px ui-monospace,Menlo,monospace}
.tf-top th{position:sticky;top:0;background:rgba(248,250,252,.96);font:650 9.5px Inter,ui-sans-serif,system-ui,sans-serif;text-transform:uppercase;letter-spacing:.05em;text-align:left;padding:4px 6px}
.tf-top td{padding:3px 6px;border-top:1px solid rgba(15,23,42,.07);white-space:nowrap}
.tf-top tr{cursor:pointer}
.tf-top tbody tr:hover,.tf-top tbody tr:focus-visible{background:rgba(15,23,42,.07);outline:none}
.tf-top tr.off{opacity:.35}
.tf-chip{display:inline-block;min-width:26px;text-align:center;border-radius:999px;padding:1px 5px;font-weight:700;box-shadow:inset 0 0 0 1px rgba(15,23,42,.15)}
.tf-hubhead{margin:2px 14px 0;display:flex;gap:12px;align-items:center}
.tf-big{flex:0 0 76px;height:76px;border-radius:14px;display:flex;flex-direction:column;align-items:center;justify-content:center;box-shadow:inset 0 0 0 1px rgba(15,23,42,.15)}
.tf-big b{font:800 30px/1 ui-monospace,SFMono-Regular,Menlo,monospace}
.tf-big small{font-size:10px;opacity:.85}
.tf-confbar{height:6px;border-radius:3px;background:rgba(15,23,42,.1);margin:6px 0 3px;overflow:hidden}
.tf-confbar i{display:block;height:100%;background:#0f172a}
.tf-kv{margin:0 14px;display:grid;grid-template-columns:1fr 1fr;gap:1px;background:rgba(15,23,42,.1);border:1px solid rgba(15,23,42,.1);border-radius:8px;overflow:hidden}
.tf-kv div{background:rgba(255,255,255,.78);padding:5px 8px;display:flex;flex-direction:column;gap:1px}
.tf-kv span{font-size:9.5px;text-transform:uppercase;letter-spacing:.05em;color:#334155;font-weight:650}
.tf-kv b{font:650 12px ui-monospace,Menlo,monospace}
.tf-hist{display:flex;align-items:flex-end;gap:2px;height:54px}
.tf-hist i{flex:1;border-radius:1.5px 1.5px 0 0;cursor:pointer}
.tf-hist i.on{outline:1.5px solid #0f172a}
.tf-foot{margin:0 14px;font-size:10.5px;line-height:1.35;color:#334155}
.tf-open{position:absolute;right:12px;bottom:28px;z-index:6;border:0;display:flex;align-items:center;gap:7px;padding:8px 12px;font-weight:600;font-size:12px;color:#0f172a}
.tf-open:hover{background:rgba(255,255,255,.85)}
`;
