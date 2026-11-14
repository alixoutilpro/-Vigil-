"use client";

/**
 * Vigil - MODIS / VIIRS hotspot harmonization. Map-first single-file component.
 * Map: MapLibre GL (globe / 2D plan), Esri satellite imagery.
 * Data: contract v2 (docs/contrat_donnees_v2.md), static files of `python -m pipeline.v2.export_site`
 * served at /data (app/donnees.ts). Nothing is bundled: index.json + incertitude.json at start, the
 * month map, the H3 tiles of a zone and pays.json on demand.
 * - Map without selection: H3 res-5 hexagons of the month shown (h3_5/mois/YYYY-MM.bin.gz).
 * - Zone (box, polygon, coordinates): sum of the hexagons whose centre is inside (h3_5/tuiles), then the
 *   band of incertitude.json (hotspots_sous_pays) on the zone total.
 * - Country (search): validated country x month series of pays.json, with its reliability.
 * Calendar, map and CSV export of a zone come from the same hexagons, so they agree.
 */

import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Map as MLMap, GeoJSONSource, StyleSpecification, MapLayerMouseEvent } from "maplibre-gl";
import OrbitOverlay from "./OrbitOverlay";
import {
  BASE, ErreurDonnees, centreHex, chargerIncertitude, chargerIndex, chargerMois, chargerPays, chargerTuile,
  cleMois, contourHex, dansZone, estConverti, indiceMois, moisPartiel, texteMois, tuilesDeZone,
  type HexMois, type IncertitudeV2, type IndexV2, type PaysV2, type Ring, type Tuile,
} from "./donnees";
import { serieH3, seriePays, statMois, type Metrique, type MoisZone, type SerieZone } from "./zone";
import DeepDive from "./DeepDive";

/* ────────────────────────────────────────────────────────────────────────── */
/* Types & constants                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

export interface RegionDef {
  id: string;
  name: string;
  /** [latMin, latMax, lonMin, lonMax] */
  bbox: [number, number, number, number];
  /** FIRMS country key of pays.json (country mode). */
  pays?: string;
}

interface DateRange {
  from: { y: number; m: number };
  to: { y: number; m: number };
}

/** First and last month of the export (from index.json). */
interface Bornes { first: { y: number; m: number }; last: { y: number; m: number } }

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Below this number of hexagons a drawn zone is smaller than the zones the band was tested on. */
const MIN_HEX_FOURCHETTE = 3;

/** A zone with its series and the tiles it was computed from (map and CSV reuse them). */
interface ZoneChargee { region: RegionDef; serie: SerieZone; tuiles: Tuile[] }

/* ────────────────────────────────────────────────────────────────────────── */
/* Country search data  [latMin, latMax, lonMin, lonMax]                       */
/* ────────────────────────────────────────────────────────────────────────── */

const COUNTRIES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: "Afghanistan", bbox: [29.4, 38.5, 60.5, 74.9] },
  { name: "Albania", bbox: [39.6, 42.7, 19.3, 21.1] },
  { name: "Algeria", bbox: [18.9, 37.1, -8.7, 12.0] },
  { name: "Angola", bbox: [-18.1, -4.4, 11.6, 24.1] },
  { name: "Argentina", bbox: [-55.1, -21.8, -73.6, -53.6] },
  { name: "Armenia", bbox: [38.8, 41.3, 43.4, 46.6] },
  { name: "Australia", bbox: [-43.7, -10.7, 113.3, 153.6] },
  { name: "Austria", bbox: [46.4, 49.0, 9.5, 17.2] },
  { name: "Azerbaijan", bbox: [38.4, 41.9, 44.8, 50.4] },
  { name: "Bangladesh", bbox: [20.6, 26.6, 88.0, 92.7] },
  { name: "Belarus", bbox: [51.3, 56.2, 23.2, 32.8] },
  { name: "Belgium", bbox: [49.5, 51.5, 2.5, 6.4] },
  { name: "Benin", bbox: [6.2, 12.4, 0.8, 3.9] },
  { name: "Bolivia", bbox: [-22.9, -9.7, -69.6, -57.5] },
  { name: "Bosnia and Herzegovina", bbox: [42.6, 45.3, 15.7, 19.6] },
  { name: "Botswana", bbox: [-26.9, -17.8, 19.9, 29.4] },
  { name: "Brazil", bbox: [-33.8, 5.3, -73.1, -29.3] },
  { name: "Bulgaria", bbox: [41.2, 44.2, 22.4, 28.6] },
  { name: "Burkina Faso", bbox: [9.4, 15.1, -5.5, 2.4] },
  { name: "Burundi", bbox: [-4.5, -2.3, 29.0, 30.9] },
  { name: "Cambodia", bbox: [10.4, 14.7, 102.3, 107.6] },
  { name: "Cameroon", bbox: [1.6, 13.1, 8.5, 16.2] },
  { name: "Canada", bbox: [41.7, 83.1, -141.0, -52.6] },
  { name: "Central African Republic", bbox: [2.2, 11.0, 14.4, 27.5] },
  { name: "Chad", bbox: [7.5, 23.5, 13.5, 24.0] },
  { name: "Chile", bbox: [-55.9, -17.5, -75.7, -66.4] },
  { name: "China", bbox: [18.2, 53.6, 73.5, 134.8] },
  { name: "Colombia", bbox: [-4.2, 13.4, -79.0, -66.9] },
  { name: "Congo", bbox: [-5.0, 3.7, 11.2, 18.6] },
  { name: "Costa Rica", bbox: [8.0, 11.2, -85.9, -82.6] },
  { name: "Croatia", bbox: [42.4, 46.6, 13.5, 19.5] },
  { name: "Cuba", bbox: [19.8, 23.3, -85.0, -74.1] },
  { name: "Czech Republic", bbox: [48.6, 51.1, 12.1, 18.9] },
  { name: "Democratic Republic of Congo", bbox: [-13.5, 5.4, 12.2, 31.3] },
  { name: "Denmark", bbox: [54.6, 57.8, 8.1, 15.2] },
  { name: "Dominican Republic", bbox: [17.5, 20.0, -72.0, -68.3] },
  { name: "Ecuador", bbox: [-5.0, 1.5, -81.0, -75.2] },
  { name: "Egypt", bbox: [22.0, 31.7, 24.7, 37.1] },
  { name: "El Salvador", bbox: [13.1, 14.5, -90.1, -87.7] },
  { name: "Ethiopia", bbox: [3.4, 15.0, 33.0, 48.0] },
  { name: "Finland", bbox: [59.8, 70.1, 19.1, 31.6] },
  { name: "France", bbox: [41.3, 51.1, -5.1, 9.6] },
  { name: "Gabon", bbox: [-3.9, 2.3, 8.7, 14.5] },
  { name: "Georgia", bbox: [41.1, 43.6, 40.0, 46.7] },
  { name: "Germany", bbox: [47.3, 55.1, 5.9, 15.0] },
  { name: "Ghana", bbox: [4.7, 11.2, -3.3, 1.2] },
  { name: "Greece", bbox: [34.8, 41.7, 19.4, 28.3] },
  { name: "Guatemala", bbox: [13.7, 17.8, -92.3, -88.2] },
  { name: "Guinea", bbox: [7.2, 12.7, -15.1, -7.6] },
  { name: "Haiti", bbox: [18.0, 20.1, -74.5, -71.6] },
  { name: "Honduras", bbox: [13.0, 16.5, -89.4, -83.2] },
  { name: "Hungary", bbox: [45.7, 48.6, 16.1, 22.9] },
  { name: "India", bbox: [6.8, 35.5, 68.1, 97.4] },
  { name: "Indonesia", bbox: [-11.0, 6.1, 95.0, 141.0] },
  { name: "Iran", bbox: [25.1, 39.8, 44.0, 63.3] },
  { name: "Iraq", bbox: [29.1, 37.4, 38.8, 48.6] },
  { name: "Ireland", bbox: [51.4, 55.4, -10.5, -6.0] },
  { name: "Israel", bbox: [29.5, 33.3, 34.3, 35.9] },
  { name: "Italy", bbox: [36.6, 47.1, 6.6, 18.5] },
  { name: "Ivory Coast", bbox: [4.3, 10.7, -8.6, -2.5] },
  { name: "Jamaica", bbox: [17.7, 18.5, -78.4, -76.2] },
  { name: "Japan", bbox: [24.0, 45.5, 122.9, 145.8] },
  { name: "Jordan", bbox: [29.2, 33.4, 35.0, 39.3] },
  { name: "Kazakhstan", bbox: [40.6, 55.4, 50.3, 87.4] },
  { name: "Kenya", bbox: [-4.7, 5.0, 33.9, 42.0] },
  { name: "Kosovo", bbox: [41.9, 43.3, 20.0, 21.8] },
  { name: "Kuwait", bbox: [28.5, 30.1, 46.6, 48.4] },
  { name: "Kyrgyzstan", bbox: [39.2, 43.3, 69.3, 80.3] },
  { name: "Laos", bbox: [13.9, 22.5, 100.1, 107.7] },
  { name: "Latvia", bbox: [55.7, 58.1, 21.0, 28.2] },
  { name: "Lebanon", bbox: [33.1, 34.7, 35.1, 36.6] },
  { name: "Libya", bbox: [19.5, 33.2, 9.4, 25.2] },
  { name: "Lithuania", bbox: [53.9, 56.5, 20.9, 26.9] },
  { name: "Madagascar", bbox: [-25.6, -11.9, 43.2, 50.5] },
  { name: "Malawi", bbox: [-17.1, -9.4, 32.7, 35.9] },
  { name: "Malaysia", bbox: [0.9, 7.4, 99.6, 119.3] },
  { name: "Mali", bbox: [10.1, 25.0, -4.2, 4.3] },
  { name: "Mauritania", bbox: [14.7, 27.3, -17.1, -4.8] },
  { name: "Mexico", bbox: [14.5, 32.7, -117.1, -86.7] },
  { name: "Moldova", bbox: [45.5, 48.5, 26.6, 30.1] },
  { name: "Mongolia", bbox: [41.6, 52.1, 87.7, 119.9] },
  { name: "Morocco", bbox: [27.7, 35.9, -13.2, -1.1] },
  { name: "Mozambique", bbox: [-26.9, -10.5, 32.3, 40.9] },
  { name: "Myanmar", bbox: [9.8, 28.5, 92.2, 101.2] },
  { name: "Namibia", bbox: [-29.1, -16.9, 11.7, 25.3] },
  { name: "Nepal", bbox: [26.3, 30.5, 80.1, 88.2] },
  { name: "Netherlands", bbox: [50.8, 53.6, 3.3, 7.2] },
  { name: "New Zealand", bbox: [-47.3, -34.4, 166.4, 178.6] },
  { name: "Nicaragua", bbox: [10.7, 15.0, -87.7, -83.1] },
  { name: "Niger", bbox: [11.7, 23.5, 0.2, 15.9] },
  { name: "Nigeria", bbox: [4.3, 13.9, 2.7, 14.7] },
  { name: "North Korea", bbox: [37.7, 42.7, 124.2, 130.7] },
  { name: "North Macedonia", bbox: [40.9, 42.4, 20.5, 23.1] },
  { name: "Norway", bbox: [57.9, 71.2, 4.6, 31.1] },
  { name: "Oman", bbox: [16.6, 26.4, 52.0, 59.8] },
  { name: "Pakistan", bbox: [23.7, 37.1, 60.9, 77.1] },
  { name: "Palestine", bbox: [31.2, 32.6, 34.2, 35.6] },
  { name: "Panama", bbox: [7.2, 9.7, -83.1, -77.2] },
  { name: "Papua New Guinea", bbox: [-11.7, -1.3, 141.0, 155.7] },
  { name: "Paraguay", bbox: [-27.6, -19.3, -62.6, -54.3] },
  { name: "Peru", bbox: [-18.4, -0.1, -81.3, -68.7] },
  { name: "Philippines", bbox: [4.6, 21.1, 116.9, 126.6] },
  { name: "Poland", bbox: [49.0, 54.9, 14.1, 24.1] },
  { name: "Portugal", bbox: [36.8, 42.2, -9.5, -6.2] },
  { name: "Romania", bbox: [43.6, 48.3, 20.3, 29.7] },
  { name: "Russia", bbox: [41.2, 81.9, 19.6, 180.0] },
  { name: "Rwanda", bbox: [-2.8, -1.1, 28.9, 30.9] },
  { name: "Saudi Arabia", bbox: [16.4, 32.2, 34.6, 55.7] },
  { name: "Senegal", bbox: [12.3, 16.7, -17.5, -11.4] },
  { name: "Serbia", bbox: [42.2, 46.2, 18.8, 23.0] },
  { name: "Sierra Leone", bbox: [6.9, 10.0, -13.3, -10.3] },
  { name: "Slovakia", bbox: [47.7, 49.6, 16.8, 22.6] },
  { name: "Slovenia", bbox: [45.4, 46.9, 13.4, 16.6] },
  { name: "Somalia", bbox: [-1.7, 11.5, 40.9, 51.5] },
  { name: "South Africa", bbox: [-34.8, -22.1, 16.5, 32.9] },
  { name: "South Korea", bbox: [33.1, 38.6, 125.1, 129.6] },
  { name: "South Sudan", bbox: [3.5, 12.2, 23.9, 35.9] },
  { name: "Spain", bbox: [35.9, 43.8, -9.3, 4.3] },
  { name: "Sri Lanka", bbox: [5.9, 9.8, 79.7, 81.9] },
  { name: "Sudan", bbox: [8.7, 22.2, 21.8, 38.6] },
  { name: "Sweden", bbox: [55.3, 69.1, 11.1, 24.2] },
  { name: "Switzerland", bbox: [45.8, 47.8, 6.0, 10.5] },
  { name: "Syria", bbox: [32.3, 37.3, 35.7, 42.4] },
  { name: "Taiwan", bbox: [21.9, 25.3, 120.0, 122.0] },
  { name: "Tajikistan", bbox: [36.7, 41.0, 67.4, 75.2] },
  { name: "Tanzania", bbox: [-11.7, -1.0, 29.3, 40.4] },
  { name: "Thailand", bbox: [5.6, 20.5, 97.4, 105.7] },
  { name: "Togo", bbox: [5.9, 11.1, -0.1, 1.8] },
  { name: "Tunisia", bbox: [30.2, 37.5, 7.5, 11.6] },
  { name: "Turkey", bbox: [35.8, 42.1, 25.7, 44.8] },
  { name: "Turkmenistan", bbox: [35.1, 42.8, 52.4, 66.7] },
  { name: "Uganda", bbox: [-1.5, 4.2, 29.5, 35.0] },
  { name: "Ukraine", bbox: [44.4, 52.4, 22.1, 40.2] },
  { name: "United Arab Emirates", bbox: [22.6, 26.1, 51.6, 56.4] },
  { name: "United Kingdom", bbox: [49.9, 60.9, -8.6, 1.8] },
  { name: "United States", bbox: [24.5, 49.4, -124.8, -66.9] },
  { name: "Uruguay", bbox: [-34.9, -30.1, -58.4, -53.1] },
  { name: "Uzbekistan", bbox: [37.2, 45.6, 55.9, 73.1] },
  { name: "Venezuela", bbox: [0.7, 12.2, -73.4, -59.8] },
  { name: "Vietnam", bbox: [8.6, 23.4, 102.1, 109.5] },
  { name: "Yemen", bbox: [12.5, 19.0, 42.6, 54.0] },
  { name: "Zambia", bbox: [-18.1, -8.2, 22.0, 33.7] },
  { name: "Zimbabwe", bbox: [-22.4, -15.6, 25.2, 33.1] },
];

/** Continents and large fire regions (not FIRMS countries: always studied in hexagon mode). */
const REGIONS: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: "Africa", bbox: [-35.0, 37.5, -18.0, 52.0] },
  { name: "Europe", bbox: [35.0, 71.5, -25.0, 45.0] },
  { name: "Asia", bbox: [-11.0, 77.0, 25.0, 180.0] },
  { name: "North America", bbox: [7.0, 72.0, -168.0, -52.0] },
  { name: "South America", bbox: [-56.0, 13.0, -82.0, -34.0] },
  { name: "Oceania", bbox: [-48.0, 0.0, 110.0, 180.0] },
  { name: "Mediterranean Basin", bbox: [30.0, 46.0, -10.0, 37.0] },
  { name: "Sahel", bbox: [10.0, 20.0, -17.0, 40.0] },
  { name: "Amazon", bbox: [-18.0, 5.0, -79.0, -44.0] },
  { name: "Cerrado", bbox: [-24.0, -2.0, -60.0, -41.0] },
  { name: "Gran Chaco", bbox: [-33.0, -17.0, -67.0, -57.0] },
  { name: "Congo Basin", bbox: [-8.0, 6.0, 12.0, 31.0] },
  { name: "Miombo (Southern Africa)", bbox: [-20.0, -5.0, 12.0, 40.0] },
  { name: "Siberia", bbox: [50.0, 75.0, 60.0, 180.0] },
  { name: "Boreal Canada", bbox: [49.0, 70.0, -141.0, -55.0] },
  { name: "Alaska", bbox: [51.0, 71.5, -168.0, -130.0] },
  { name: "California", bbox: [32.5, 42.0, -124.5, -114.1] },
  { name: "Iberian Peninsula", bbox: [36.0, 43.8, -9.5, 3.3] },
  { name: "Balkans", bbox: [39.5, 46.5, 13.5, 29.7] },
  { name: "Indo-Gangetic Plain", bbox: [24.0, 32.5, 72.0, 88.5] },
  { name: "Mainland Southeast Asia", bbox: [8.5, 28.5, 92.0, 109.5] },
  { name: "Borneo", bbox: [-4.2, 7.1, 108.8, 119.3] },
  { name: "Sumatra", bbox: [-6.0, 6.0, 95.0, 106.1] },
  { name: "Northern Australia", bbox: [-23.0, -10.7, 113.3, 153.6] },
  { name: "Patagonia", bbox: [-55.1, -37.5, -75.6, -62.0] },
];

type Lieu = { name: string; bbox: [number, number, number, number]; kind: "Country" | "Region" };
const LIEUX: Lieu[] = [
  ...COUNTRIES.map((c) => ({ ...c, kind: "Country" as const })),
  ...REGIONS.map((r) => ({ ...r, kind: "Region" as const })),
];


/* ────────────────────────────────────────────────────────────────────────── */
/* Utilities                                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

const fmtLat = (v: number) => `${Math.abs(v).toFixed(1)}°${v >= 0 ? "N" : "S"}`;
const fmtLon = (v: number) => `${Math.abs(v).toFixed(1)}°${v >= 0 ? "E" : "W"}`;
const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");
function fmtCompact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (a >= 1e4) return (n / 1e3).toFixed(0) + "k";
  if (a >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(Math.round(n));
}
/** Value with one decimal under 10 (converted totals are not integers). */
const fmtVal = (n: number) => (Math.abs(n) < 10 && n % 1 ? n.toFixed(1) : fmtInt(n));
const unit = (m: Metrique) => (m === "hotspots" ? "detections" : "MW");
const LIB_FIAB: Record<string, string> = { elevee: "high", moyenne: "medium", faible: "low" };

/** FIRMS country key (pays.json) of a display name: same letters once "_", "the", "of", "and" are ignored. */
const normPays = (s: string) => s.toLowerCase().replace(/[_\-'’]/g, " ").replace(/\b(the|of|and)\b/g, "").replace(/[^a-z]/g, "");
const ALIAS_PAYS: Record<string, string[]> = {
  "Ivory Coast": ["Cote_d'Ivoire", "Côte_d'Ivoire", "Cote_dIvoire"],
  "Czech Republic": ["Czechia"],
  "Democratic Republic of Congo": ["Democratic_Republic_of_the_Congo"],
  "Congo": ["Republic_of_the_Congo", "Republic_of_Congo"],
  "United States": ["United_States_of_America", "USA"],
  "Russia": ["Russian_Federation"],
  "Turkey": ["Turkiye", "Türkiye"],
  "North Macedonia": ["Macedonia"],
  "Laos": ["Lao_PDR", "Lao_People's_Democratic_Republic"],
};
function clePays(nom: string, pays: PaysV2 | null): string | undefined {
  if (!pays) return undefined;
  if (pays[nom.replace(/ /g, "_")]) return nom.replace(/ /g, "_");
  const voulus = [nom, ...(ALIAS_PAYS[nom] ?? [])].map(normPays);
  return Object.keys(pays).find((k) => voulus.includes(normPays(k)));
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Geometry helpers                                                           */
/* ────────────────────────────────────────────────────────────────────────── */

const rectRing = (b: [number, number, number, number]): Ring => {
  const [la0, la1, lo0, lo1] = b;
  return [[lo0, la0], [lo1, la0], [lo1, la1], [lo0, la1], [lo0, la0]];
};
function regionFromRing(ring: Ring): RegionDef {
  const lons = ring.map((p) => p[0]), lats = ring.map((p) => p[1]);
  const bbox: [number, number, number, number] = [Math.min(...lats), Math.max(...lats), Math.min(...lons), Math.max(...lons)];
  return { id: `zone:${bbox.map((v) => v.toFixed(2)).join(",")}`, name: "Custom Selection", bbox };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Hexagon map and CSV export                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

const MORPH_MS = 1100; // globe <-> plan animation
const monthKey = (y: number, m: number) => y * 12 + m;
const ym = (k: number) => texteMois(Math.floor(k / 12), k % 12);

interface HexFeature {
  type: "Feature";
  geometry: { type: "Polygon"; coordinates: Ring[] };
  /** c = colour value (monthly mean over the period), n = hotspots over the period. */
  properties: { h3: string; n: number; frp: number; c: number; months: number; period: string };
}
type HexCollection = { type: "FeatureCollection"; features: HexFeature[] };

function hexFeatures(rows: Map<string, { n: number; frp: number }>, months: number, period: string, metrique: Metrique): HexCollection {
  const features: HexFeature[] = [];
  for (const [h3, a] of rows) {
    const v = metrique === "hotspots" ? a.n : a.frp;
    if (v <= 0) continue;
    features.push({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [[...contourHex(h3), contourHex(h3)[0]]] },
      properties: { h3, n: Math.round(a.n * 100) / 100, frp: Math.round(a.frp * 10) / 10, c: v / Math.max(1, months), months, period },
    });
  }
  return { type: "FeatureCollection", features };
}

/** One month of the world (no selection). */
function hexDuMois(rows: HexMois[], period: string, metrique: Metrique): HexCollection {
  const m = new Map<string, { n: number; frp: number }>();
  for (const r of rows) m.set(r.h3, { n: r.hotspots, frp: r.frp });
  return hexFeatures(m, 1, period, metrique);
}

/** Hexagons of the zone summed over the study period (from the tiles already loaded for the calendar). */
function hexDeZone(zone: ZoneChargee, index: IndexV2, range: DateRange, metrique: Metrique): HexCollection {
  const i0 = indiceMois(index, range.from.y, range.from.m), i1 = indiceMois(index, range.to.y, range.to.m);
  const m = new Map<string, { n: number; frp: number }>();
  const dans = new Set(zone.serie.hexagones);
  for (const t of zone.tuiles) for (const [h, parMois] of t) {
    if (!dans.has(h)) continue;
    let a = m.get(h);
    for (const [i, v] of parMois) {
      if (i < i0 || i > i1) continue;
      if (!a) m.set(h, (a = { n: 0, frp: 0 }));
      a.n += v.hotspots; a.frp += v.frp;
    }
  }
  const period = i0 === i1 ? ym(monthKey(range.from.y, range.from.m)) : `${ym(monthKey(range.from.y, range.from.m))} → ${ym(monthKey(range.to.y, range.to.m))}`;
  return hexFeatures(m, i1 - i0 + 1, period, metrique);
}

const r2 = (v: number | null) => (v === null ? "" : String(Math.round(v * 100) / 100));
const PROV = (c: MoisZone) => (c.converti ? "viirs_converted" : "modis_observed");

/** CSV of a zone: the monthly zone series (with bands and provenance), then every hexagon x month of the period. */
function exportCsv(zone: ZoneChargee, index: IndexV2, range: DateRange): string | null {
  const i0 = indiceMois(index, range.from.y, range.from.m), i1 = indiceMois(index, range.to.y, range.to.m);
  const serie: string[] = [];
  for (let i = Math.max(0, i0); i <= Math.min(i1, zone.serie.mois.length - 1); i++) {
    const c = zone.serie.mois[i];
    if (!c) continue;
    serie.push([texteMois(c.y, c.m), r2(c.hotspots), r2(c.bas80), r2(c.haut80), r2(c.bas95), r2(c.haut95),
      r2(c.frp), r2(c.frpBas80), r2(c.frpHaut80), PROV(c), c.partiel ? "partial" : "", c.couverture ?? ""].join(","));
  }
  if (!serie.length) return null;
  const tete = `# Vigil ${index.methode} - ${zone.serie.source === "pays" ? `country ${zone.region.pays} (pays.json, validated scale)` : `zone of ${zone.serie.hexagones.length} H3 res-5 hexagons (centre inside)`}\n` +
    `# hotspots = ${index.unites.hotspots}; frp_MW = ${index.unites.frp_MW}; bands = ${zone.serie.table ?? "n/a"}; generated ${index.genere_le}\n`;
  let csv = tete + "month,hotspots,low_80,high_80,low_95,high_95,frp_MW,frp_low_80,frp_high_80,provenance,partial,coverage_days\n" + serie.join("\n") + "\n";
  if (zone.serie.source === "h3") {
    const dans = new Set(zone.serie.hexagones), lignes: string[] = [];
    for (const t of zone.tuiles) for (const [h, parMois] of t) {
      if (!dans.has(h)) continue;
      const [lo, la] = centreHex(h);
      for (const [i, v] of parMois) {
        if (i < i0 || i > i1) continue;
        const k = monthKey(cleMois(index.mois_index_0).y, cleMois(index.mois_index_0).m) + i;
        lignes.push([h, la.toFixed(4), lo.toFixed(4), ym(k), r2(v.hotspots), r2(v.frp)].join(","));
      }
    }
    csv += "\nh3,lat,lon,month,hotspots,frp_MW\n" + lignes.sort().join("\n") + "\n";
  }
  return csv;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Map styles                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services";
const SAT_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    sat: { type: "raster", tiles: [`${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`], tileSize: 256, maxzoom: 19, attribution: "Esri, Maxar, Earthstar Geographics" },
    roads: { type: "raster", tiles: [`${ESRI}/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}`], tileSize: 256, maxzoom: 19 },
    places: { type: "raster", tiles: [`${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`], tileSize: 256, maxzoom: 19 },
  },
  layers: [
    { id: "sat", type: "raster", source: "sat" },
    { id: "roads", type: "raster", source: "roads", paint: { "raster-opacity": 0.85 } },
    { id: "places", type: "raster", source: "places" },
  ],
};


/* ────────────────────────────────────────────────────────────────────────── */
/* UI helpers                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

/** Sequential YlOrRd-like ramp (colour-blind safe, never red–green). */
const HEAT_STOPS: [number, [number, number, number]][] = [
  [0, [254, 243, 199]], [0.25, [252, 211, 77]], [0.5, [251, 146, 60]], [0.72, [234, 88, 12]], [0.88, [220, 38, 38]], [1, [127, 29, 29]],
];
/** Calendar scale of a zone: log(1 + x) / log(1 + P98 of its monthly values) (contract §6: log scale). */
function heatMaxOf(mois: (MoisZone | null)[], metrique: Metrique): number {
  const v = mois.filter((c): c is MoisZone => !!c && !c.partiel).map((c) => c[metrique]).filter((x) => x > 0).sort((a, b) => a - b);
  return v.length ? v[Math.min(v.length - 1, Math.floor(v.length * 0.98))] : 1;
}
const heatT = (x: number, max: number) => (x <= 0 ? 0 : Math.log1p(x) / Math.log1p(Math.max(max, 1)));

/** Map fill colour: steps at the quantiles of non-zero hexagon-months of index.json (log-spaced by nature). */
const HEX_COLORS = ["#fed976", "#feb24c", "#fd8d3c", "#f03b20", "#bd0026", "#800026"];
function hexColorExpr(seuils: Record<string, number> | undefined): unknown {
  const q = ["0.5", "0.75", "0.9", "0.95", "0.99"].map((k) => seuils?.[k]).filter((v): v is number => typeof v === "number");
  const stops: unknown[] = [];
  let last = -Infinity;
  q.forEach((v, i) => { if (v > last) { stops.push(v, HEX_COLORS[i + 1]); last = v; } });
  return stops.length ? ["step", ["get", "c"], HEX_COLORS[0], ...stops] : HEX_COLORS[2];
}

interface AnnualPt {
  value: number | null;
  est: boolean;
}
/** Annual totals; incomplete years (2002, current year, partial month) are scaled up from the mean seasonal share. */
function annualSeries(vals: (number | null)[][]): AnnualPt[] {
  const sums = vals.map((r) => r.reduce<number>((a, c) => a + (c ?? 0), 0));
  const isFull = vals.map((r) => r.every((c) => c !== null));
  return vals.map((row, yi) => {
    if (isFull[yi]) return { value: sums[yi], est: false };
    const obsMonths = row.map((c, m) => (c !== null ? m : -1)).filter((m) => m >= 0);
    if (!obsMonths.length) return { value: null, est: true };
    const ratios: number[] = [];
    vals.forEach((r2, yj) => {
      if (!isFull[yj] || sums[yj] <= 0) return;
      ratios.push(obsMonths.reduce((a, m) => a + (r2[m] as number), 0) / sums[yj]);
    });
    const frac = ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : 0;
    if (frac < 0.2) return { value: null, est: true };
    return { value: sums[yi] / frac, est: true };
  });
}

function heatColor(t: number): string {
  t = clamp(t, 0, 1);
  for (let i = 1; i < HEAT_STOPS.length; i++) {
    if (t <= HEAT_STOPS[i][0]) {
      const [t0, c0] = HEAT_STOPS[i - 1];
      const [t1, c1] = HEAT_STOPS[i];
      const f = (t - t0) / (t1 - t0);
      return `rgb(${c0.map((c, k) => Math.round(c + (c1[k] - c) * f)).join(",")})`;
    }
  }
  return "rgb(127,29,29)";
}

function niceTicks(max: number, n = 3): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / n;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / p;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
  const out: number[] = [];
  for (let v = 0; v <= max + step * 0.999; v += step) out.push(v);
  return out;
}
function Seg<T extends string>(props: { label: string; value: T; options: { v: T; t: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="hd-seg" role="radiogroup" aria-label={props.label}>
      {props.options.map((o) => (
        <button key={o.v} role="radio" aria-checked={props.value === o.v} className={props.value === o.v ? "on" : ""} onClick={() => props.onChange(o.v)}>
          {o.t}
        </button>
      ))}
    </div>
  );
}


/* ────────────────────────────────────────────────────────────────────────── */
/* RegionCard                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

const bboxToSizeKm = (bbox: [number, number, number, number]) =>
  Math.round((bbox[1] - bbox[0]) * 111.32 * 10) / 10;

type CoordErr = { latMax: string; lonMax: string; sizeKm: string };
/** Square box whose north-east corner is (lat max, lon max), `size` km a side; errors per field when invalid. */
function bboxFromCorner(latMax: string, lonMax: string, sizeKm: string): { err: CoordErr; bbox: [number, number, number, number] | null } {
  const lat1 = parseFloat(latMax), lon1 = parseFloat(lonMax), sz = parseFloat(sizeKm);
  const err: CoordErr = { latMax: "", lonMax: "", sizeKm: "" };
  if (isNaN(lat1) || lat1 < -90 || lat1 > 90) err.latMax = "Must be −90 to 90";
  if (isNaN(lon1) || lon1 < -180 || lon1 > 180) err.lonMax = "Must be −180 to 180";
  if (isNaN(sz) || sz <= 0 || sz > 20000) err.sizeKm = "Must be 1–20 000";
  if (err.latMax || err.lonMax || err.sizeKm) return { err, bbox: null };
  const latSpan = sz / 111.32;
  const lonSpan = sz / (111.32 * Math.cos(lat1 * Math.PI / 180));
  return { err, bbox: [Math.max(-90, lat1 - latSpan), lat1, lon1 - lonSpan, lon1] };
}

/** Lon max / Lat max / Size (km) inputs, shared by the region card and the search panel. */
function CoordFields({ idPrefix, latMax, lonMax, sizeKm, setLatMax, setLonMax, setSizeKm, err, onEnter }: {
  idPrefix: string; latMax: string; lonMax: string; sizeKm: string;
  setLatMax: (v: string) => void; setLonMax: (v: string) => void; setSizeKm: (v: string) => void;
  err: CoordErr; onEnter: () => void;
}) {
  return (
    <div className="hd-rc-grid3">
      {([
        { id: "lonMax", label: "Lon max", val: lonMax, onChange: setLonMax, err: err.lonMax, step: "0.01" },
        { id: "latMax", label: "Lat max", val: latMax, onChange: setLatMax, err: err.latMax, step: "0.01" },
        { id: "sizeKm", label: "Size (km)", val: sizeKm, onChange: setSizeKm, err: err.sizeKm, step: "1" },
      ] as Array<{ id: string; label: string; val: string; onChange: (v: string) => void; err: string; step: string }>).map(({ id, label, val, onChange, err, step }) => (
        <div key={id} className="hd-rc-field">
          <label htmlFor={`${idPrefix}-${id}`} className="hd-rc-fieldlabel">{label}</label>
          <input
            id={`${idPrefix}-${id}`}
            type="number"
            step={step}
            className={"hd-rc-fieldinput" + (err ? " err" : "")}
            value={val}
            aria-describedby={err ? `${idPrefix}-${id}-err` : undefined}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onEnter()}
          />
          {err && <span id={`${idPrefix}-${id}-err`} role="alert" className="hd-rc-fielderr">{err}</span>}
        </div>
      ))}
    </div>
  );
}

interface RegionCardProps {
  /** Null for a new region opened from the search button (nothing on the map yet). */
  selection: { region: RegionDef; ring: Ring; wasPolygon: boolean } | null;
  /** Focus target of the search button. */
  searchRef: React.RefObject<HTMLInputElement>;
  /** A country or region picked in the search field. */
  onPick: (l: Lieu) => void;
  /** Escape in an empty search field. */
  onSearchEscape: () => void;
  name: string;
  range: DateRange;
  onRangeChange: (r: DateRange) => void;
  onApplyBbox: (bbox: [number, number, number, number], name: string) => void;
  /** First and last month of the export. */
  bornes: Bornes;
  /** CSV of the zone for the current study period, null when there is nothing to export. */
  onExport: () => string | null;
  /** False while the zone is loading. */
  ready: boolean;
}

/** Region name with its Rename button, shown once in the panel header. */
function RegionName({ name, onRename }: { name: string; onRename: (name: string) => void }) {
  /* ── Rename ── */
  const [renaming, setRenaming] = useState(false);
  const [nameInput, setNameInput] = useState(name);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setNameInput(name); setRenaming(false); }, [name]);
  useEffect(() => { if (renaming) nameInputRef.current?.focus(); }, [renaming]);

  const commitRename = () => {
    const v = nameInput.trim().slice(0, 40);
    if (v) onRename(v); else setNameInput(name);
    setRenaming(false);
  };
  const cancelRename = () => { setNameInput(name); setRenaming(false); };

  return (
    <div className="hd-rc-titlerow">
      {renaming ? (
        <input
          ref={nameInputRef}
          id="hd-rc-nameinput"
          className="hd-rc-nameinput hd-mono"
          value={nameInput}
          maxLength={40}
          aria-label="Region name"
          onChange={(e) => setNameInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") commitRename(); if (e.key === "Escape") cancelRename(); }}
          onBlur={commitRename}
        />
      ) : (
        <span className="hd-mono hd-name">{name}</span>
      )}
      {!renaming && (
        <button
          className="hd-rc-rename"
          aria-label="Rename region"
          onClick={() => { setNameInput(name); setRenaming(true); }}
        >
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M9.5 2.5l2 2-7 7H2.5v-2l7-7z" />
          </svg>
          Rename
        </button>
      )}
    </div>
  );
}

function RegionCard({ selection, searchRef, onPick, onSearchEscape, name, range, onRangeChange, onApplyBbox, bornes, onExport, ready }: RegionCardProps) {
  const bboxSel = selection?.region.bbox ?? null;
  const wasPolygon = !!selection?.wasPolygon;

  /* ── Country / region search ── */
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [] as Lieu[];
    // Names starting with the query first, then the ones containing it.
    const hits = LIEUX.filter((l) => l.name.toLowerCase().includes(q));
    return hits.sort((x, y) => Number(!x.name.toLowerCase().startsWith(q)) - Number(!y.name.toLowerCase().startsWith(q))).slice(0, 8);
  }, [query]);
  useEffect(() => { setActive(0); }, [query]);
  const pick = (l: Lieu) => { setQuery(""); onPick(l); };

  /* ── Bbox inputs (lon max, lat max, size in km) ── */
  const [latMax, setLatMax] = useState(bboxSel ? bboxSel[1].toFixed(2) : "");
  const [lonMax, setLonMax] = useState(bboxSel ? bboxSel[3].toFixed(2) : "");
  const [sizeKm, setSizeKm] = useState(bboxSel ? bboxToSizeKm(bboxSel).toFixed(1) : "100.0");
  const [bboxErr, setBboxErr] = useState({ latMax: "", lonMax: "", sizeKm: "" });

  useEffect(() => {
    if (!bboxSel) return;
    setLatMax(bboxSel[1].toFixed(2));
    setLonMax(bboxSel[3].toFixed(2));
    setSizeKm(bboxToSizeKm(bboxSel).toFixed(1));
    setBboxErr({ latMax: "", lonMax: "", sizeKm: "" });
  }, [bboxSel]);

  const validateAndApplyBbox = () => {
    const { err, bbox } = bboxFromCorner(latMax, lonMax, sizeKm);
    setBboxErr(err);
    if (bbox) onApplyBbox(bbox, name);
  };

  const hasErr = Object.values(bboxErr).some(Boolean);

  /* ── Date range ── */
  const toMonthStr = (y: number, m: number) => `${y}-${String(m + 1).padStart(2, "0")}`;
  const [rangeErr, setRangeErr] = useState("");

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const YEARS = Array.from({ length: bornes.last.y - bornes.first.y + 1 }, (_, i) => bornes.first.y + i);
  const key = (d: { y: number; m: number }) => d.y * 12 + d.m;
  const minKey = key(bornes.first), maxKey = key(bornes.last);
  const fromKey = (k: number) => ({ y: Math.floor(k / 12), m: k % 12 });
  const clampKey = (k: number) => Math.min(maxKey, Math.max(minKey, k));

  // Draft range: edited freely in the selects, only pushed to the map on "Apply".
  const [draft, setDraftRange] = useState<DateRange>(range);
  useEffect(() => { setDraftRange(range); }, [range]);
  const dirty = key(draft.from) !== key(range.from) || key(draft.to) !== key(range.to);

  // Changing one bound never gets rejected: if it crosses the other bound, the other one follows.
  const setBound = (which: "from" | "to", part: "y" | "m", value: number) => {
    const next = fromKey(clampKey(key({ ...draft[which], [part]: value })));
    let { from, to } = draft;
    if (which === "from") { from = next; if (key(from) > key(to)) to = next; }
    else { to = next; if (key(to) < key(from)) from = next; }
    setDraftRange({ from, to });
  };
  const applyRange = () => { setRangeErr(""); onRangeChange(draft); };

  /* ── Export ── */
  const [exportErr, setExportErr] = useState("");

  const handleExport = () => {
    setExportErr("");
    if (!selection) { setExportErr("Search a country or region, or enter coordinates first."); return; }
    const csv = onExport();
    if (!csv) {
      setExportErr(ready ? "No data for this area and period." : "The zone is still loading.");
      return;
    }
    const safeName = name.replace(/[^a-z0-9]/gi, "_");
    const fromStr = toMonthStr(range.from.y, range.from.m);
    const toStr = toMonthStr(range.to.y, range.to.m);
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `vigil_${safeName}_${fromStr}_${toStr}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="hd-region-card">
      {/* 2. Country / region search */}
      <div className="hd-rc-section">
        <label htmlFor="hd-search-place" className="hd-rc-seclabel">Country or region</label>
        <div className="hd-search-field">
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <circle cx="6" cy="6" r="4.5" /><line x1="9.5" y1="9.5" x2="13" y2="13" />
          </svg>
          <input
            ref={searchRef}
            id="hd-search-place"
            className="hd-search-input"
            placeholder="Search country or region…"
            autoComplete="off"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") { if (query) setQuery(""); else onSearchEscape(); }
              else if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(matches.length - 1, i + 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
              else if (e.key === "Enter" && matches[active]) pick(matches[active]);
            }}
          />
          {query && <button className="hd-search-clear" onClick={() => setQuery("")} aria-label="Clear">×</button>}
        </div>
        {matches.length > 0 && (
          <div className="hd-search-results" role="listbox">
            {matches.map((l, i) => (
              <button key={l.kind + l.name} role="option" aria-selected={i === active}
                className={"hd-search-result" + (i === active ? " on" : "")}
                onMouseEnter={() => setActive(i)} onClick={() => pick(l)}>
                <span>{l.name}</span><span className="hd-search-kind">{l.kind}</span>
              </button>
            ))}
          </div>
        )}
        {query.trim() && matches.length === 0 && <p className="hd-rc-note">No country or region matches “{query.trim()}”.</p>}
      </div>

      {/* 3. Coordinates */}
      <div className="hd-rc-section">
        <div className="hd-rc-seclabel">Coordinates</div>
        {wasPolygon && (
          <p className="hd-rc-note">Editing coordinates converts the polygon to a rectangle</p>
        )}
        <CoordFields idPrefix="hd-bbox" latMax={latMax} lonMax={lonMax} sizeKm={sizeKm}
          setLatMax={setLatMax} setLonMax={setLonMax} setSizeKm={setSizeKm} err={bboxErr} onEnter={validateAndApplyBbox} />
        <button
          className="hd-rc-apply"
          aria-label="Apply coordinate changes to map"
          disabled={hasErr}
          onClick={validateAndApplyBbox}
        >
          Apply
        </button>
      </div>

      {/* 4. Study period */}
      <div className="hd-rc-section">
        <div className="hd-rc-seclabel">Study period</div>
        <div className="hd-rc-rangerow">
          <div className="hd-rc-field">
            <label htmlFor="hd-range-from-m" className="hd-rc-fieldlabel">From</label>
            <div className="hd-rc-datepair">
              <select id="hd-range-from-m" className="hd-rc-monthinput" aria-label="From month"
                value={draft.from.m} onChange={(e) => setBound("from", "m", Number(e.target.value))}>
                {MONTHS.map((n, i) => <option key={n} value={i}>{n}</option>)}
              </select>
              <select id="hd-range-from-y" className="hd-rc-monthinput" aria-label="From year"
                value={draft.from.y} onChange={(e) => setBound("from", "y", Number(e.target.value))}>
                {YEARS.map((y) => <option key={y} value={y}>{y}</option>)}
              </select>
            </div>
          </div>
          <div className="hd-rc-field">
            <label htmlFor="hd-range-to-m" className="hd-rc-fieldlabel">To</label>
            <div className="hd-rc-datepair">
              <select id="hd-range-to-m" className="hd-rc-monthinput" aria-label="To month"
                value={draft.to.m} onChange={(e) => setBound("to", "m", Number(e.target.value))}>
                {MONTHS.map((n, i) => <option key={n} value={i}>{n}</option>)}
              </select>
              <select id="hd-range-to-y" className="hd-rc-monthinput" aria-label="To year"
                value={draft.to.y} onChange={(e) => setBound("to", "y", Number(e.target.value))}>
                {YEARS.map((y) => <option key={y} value={y}>{y}</option>)}
              </select>
            </div>
          </div>
        </div>
        <button className="hd-rc-apply" aria-label="Apply study period to map" disabled={!dirty} onClick={applyRange}>
          Apply
        </button>
        {rangeErr && <span role="alert" className="hd-rc-fielderr">{rangeErr}</span>}
      </div>

      {/* 5. Export CSV */}
      <div className="hd-rc-section">
        <button className="hd-rc-export" aria-label="Export hotspots as CSV" onClick={handleExport}>
          Export CSV
        </button>
        {exportErr && <p role="alert" className="hd-rc-fielderr" style={{ marginTop: 6 }}>{exportErr}</p>}
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Main application                                                           */
/* ────────────────────────────────────────────────────────────────────────── */

interface Selection { region: RegionDef; ring: Ring; wasPolygon: boolean }
const NEW_REGION = "New region";
type Tool = "none" | "box" | "poly";

/** Hexagon mode refuses zones whose tiles would be too heavy to download (use country mode instead). */
const MAX_TUILES = 80;
const MAX_OCTETS_ZONE = 120e6;
const EMPTY_FC = { type: "FeatureCollection" as const, features: [] as unknown[] };

function ExpandIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M8.5 1.5h4v4M12.5 1.5L8 6M5.5 12.5h-4v-4M1.5 12.5L6 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square" />
    </svg>
  );
}
function CollapseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M13 5H9V1M9 5l4-4M1 9h4v4M5 9l-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square" />
    </svg>
  );
}

/** Drag a floating panel by its header. Offset is applied as a CSS transform; the header stays on screen. */
function useDrag() {
  const ref = useRef<HTMLElement>(null);
  const [off, setOff] = useState({ x: 0, y: 0 });
  const start = useRef<{ px: number; py: number; ox: number; oy: number; r: DOMRect } | null>(null);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button,input,select,a")) return;
    const el = ref.current;
    if (!el) return;
    start.current = { px: e.clientX, py: e.clientY, ox: off.x, oy: off.y, r: el.getBoundingClientRect() };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const s = start.current;
    if (!s) return;
    const dx = clamp(e.clientX - s.px, 48 - s.r.right, window.innerWidth - 48 - s.r.left);
    const dy = clamp(e.clientY - s.py, -s.r.top, window.innerHeight - 40 - s.r.top);
    setOff({ x: s.ox + dx, y: s.oy + dy });
  };
  const end = () => { start.current = null; setDragging(false); };

  return {
    ref,
    style: { transform: `translate(${off.x}px, ${off.y}px)` } as React.CSSProperties,
    dragging,
    handle: {
      onPointerDown, onPointerMove, onPointerUp: end, onPointerCancel: end,
      onDoubleClick: (e: React.MouseEvent) => { if (!(e.target as HTMLElement).closest("button,input,select,a")) setOff({ x: 0, y: 0 }); },
      title: "Drag to move · double-click to reset",
    },
  };
}


export default function Vigil() {
  const leftDrag = useDrag();
  const rightDrag = useDrag();
  const [metrique, setMetrique] = useState<Metrique>("hotspots");
  const [index, setIndex] = useState<IndexV2 | null>(null);
  const [inc, setInc] = useState<IncertitudeV2 | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [selectionName, setSelectionName] = useState("");
  const [selRange, setSelRange] = useState<DateRange>({ from: { y: 2002, m: 0 }, to: { y: 2002, m: 0 } });
  const [zone, setZone] = useState<ZoneChargee | null>(null);
  const [zoneErr, setZoneErr] = useState<string | null>(null);
  const [zoneProg, setZoneProg] = useState<{ done: number; total: number } | null>(null);
  const [moisRows, setMoisRows] = useState<HexMois[] | null>(null);
  const [moisErr, setMoisErr] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [split, setSplit] = useState(false);
  const [panelLeftOpen, setPanelLeftOpen] = useState(true);
  const [tool, setTool] = useState<Tool>("none");
  const [polyN, setPolyN] = useState(0);
  const [date, setDate] = useState({ y: 2002, m: 0 });
  const [ready, setReady] = useState(false);
  const [tip, setTip] = useState<{ x: number; y: number; yi: number; m: number } | null>(null);
  const [hoverYear, setHoverYear] = useState<number | null>(null);
  /** Region card opened from the search button while nothing is selected yet. */
  const [searchOpen, setSearchOpen] = useState(false);
  const [newName, setNewName] = useState(NEW_REGION);
  const [flat, setFlat] = useState(false);
  const flatRef = useRef(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const hexRef = useRef<HexCollection>({ type: "FeatureCollection", features: [] });
  const selFcRef = useRef<unknown>(EMPTY_FC);
  const draftRef = useRef<unknown>(EMPTY_FC);
  const toolRef = useRef<Tool>("none");
  const polyPts = useRef<Ring>([]);
  const panelOpenRef = useRef(true);
  const loadedRef = useRef(false);
  const fitRef = useRef<(b: [number, number, number, number]) => void>(() => {});
  const pendingFit = useRef<[number, number, number, number] | null>(null);
  const finalizeRef = useRef<(ring: Ring, fromBox?: boolean) => void>(() => {});
  const regionCounterRef = useRef(0);
  const zoneReq = useRef(0);
  toolRef.current = tool;
  panelOpenRef.current = panelOpen;

  /* ── Data: index.json + incertitude.json at start ── */
  const bornes: Bornes | null = useMemo(() => index && index.mois.length
    ? { first: cleMois(index.mois[0]), last: cleMois(index.mois[index.mois.length - 1]) } : null, [index]);
  const fullRange = useCallback((): DateRange => bornes ? { from: bornes.first, to: bornes.last } : selRange, [bornes, selRange]);
  const partiel = index ? moisPartiel(index) : null;

  useEffect(() => {
    let vivant = true;
    (async () => {
      try {
        const [ix, ic] = await Promise.all([chargerIndex(), chargerIncertitude().catch(() => null)]);
        if (!vivant) return;
        if (!ix.mois?.length) throw new Error("index.json lists no month");
        setIndex(ix);
        setInc(ic);
        const last = cleMois(ix.mois[ix.mois.length - 1]);
        setDate(last);
        setSelRange({ from: cleMois(ix.mois[0]), to: last });
      } catch (e) {
        if (vivant) setErreur(e instanceof ErreurDonnees ? `${e.url} (${e.statut})` : String((e as Error).message || e));
      }
    })();
    return () => { vivant = false; };
  }, []);

  /* ── Zone: country series (pays.json) or sum of the H3 tiles under the zone ── */
  useEffect(() => {
    const req = ++zoneReq.current;
    setZone(null); setZoneErr(null); setZoneProg(null);
    if (!selection || !index) return;
    const { region, ring } = selection;
    const encore = () => req === zoneReq.current;
    (async () => {
      try {
        if (region.pays) {
          const s = (await chargerPays())[region.pays];
          if (s) { if (encore()) setZone({ region, serie: seriePays(index, s), tuiles: [] }); return; }
        }
        const liste = tuilesDeZone(region.bbox, ring, new Set(index.tuiles), index.tuile_parent_resolution);
        const moyenne = (index.tailles_octets?.h3_tuiles ?? 0) / Math.max(1, index.tuiles.length);
        const estime = moyenne * liste.length;
        if (liste.length > MAX_TUILES || estime > MAX_OCTETS_ZONE)
          throw new Error(`Zone too large for the hexagon mode (${liste.length} tiles, ~${Math.round(estime / 1e6)} MB): draw a smaller zone or search a country.`);
        let done = 0;
        if (encore()) setZoneProg({ done, total: liste.length });
        const tuiles = await Promise.all(liste.map((t) => chargerTuile(t).then((x) => {
          done++;
          if (encore()) setZoneProg({ done, total: liste.length });
          return x;
        })));
        if (!encore()) return;
        setZone({ region, serie: serieH3(index, inc, tuiles, region.bbox, ring), tuiles });
        setZoneProg(null);
      } catch (e) {
        if (encore()) { setZoneErr(e instanceof ErreurDonnees ? `Download failed: ${e.url} (${e.statut})` : String((e as Error).message || e)); setZoneProg(null); }
      }
    })();
  }, [selection, index, inc]);

  /* ── Map month file: the slider month, or the end of the study period in country mode ── */
  const deferredRange = useDeferredValue(selRange); // keep the date selects responsive while the map rebuilds
  const modeH3 = !!selection && !selection.region.pays;
  const moisCarte = !index ? null : !selection ? texteMois(date.y, date.m) : modeH3 ? null : texteMois(deferredRange.to.y, deferredRange.to.m);
  useEffect(() => {
    setMoisErr(null);
    if (!index || !moisCarte) { setMoisRows(null); return; }
    if (!index.mois.includes(moisCarte)) { setMoisRows([]); return; }
    let vivant = true;
    chargerMois(moisCarte).then((r) => { if (vivant) setMoisRows(r); })
      .catch((e) => { if (vivant) { setMoisRows([]); setMoisErr(e instanceof ErreurDonnees ? `${e.url} (${e.statut})` : String(e)); } });
    return () => { vivant = false; };
  }, [index, moisCarte]);

  /* ── Derived data ── */
  const region = selection?.region ?? null;
  const serie = zone?.serie ?? null;
  const Y0 = bornes?.first.y ?? 2002, Y1 = bornes?.last.y ?? 2002;
  const NY = Y1 - Y0 + 1;
  /** Calendar values: [year][month] of the chosen metric, null = no data. */
  const vals = useMemo(() => Array.from({ length: NY }, (_, yi) => Array.from({ length: 12 }, (_, m): number | null => {
    if (!serie || !index) return null;
    const c = serie.mois[indiceMois(index, Y0 + yi, m)];
    return c ? c[metrique] : null;
  })), [serie, index, metrique, NY, Y0]);
  const cellOf = (yi: number, m: number): MoisZone | null => (serie && index ? serie.mois[indiceMois(index, Y0 + yi, m)] ?? null : null);
  // A partial month is not a complete month: left out of the annual totals (the year becomes estimated).
  const annual = useMemo(() => annualSeries(vals.map((row, yi) => row.map((v, m) => (cellOf(yi, m)?.partiel ? null : v)))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [vals]);
  const heatMax = useMemo(() => (serie ? heatMaxOf(serie.mois, metrique) : 1), [serie, metrique]);

  const hexes = useMemo((): HexCollection => {
    if (!index) return { type: "FeatureCollection", features: [] };
    if (selection && zone && zone.serie.source === "h3") return hexDeZone(zone, index, deferredRange, metrique);
    if (!moisRows || !moisCarte) return { type: "FeatureCollection", features: [] };
    const rows = selection ? moisRows.filter((r) => dansZone(r.h3, selection.region.bbox, selection.ring)) : moisRows;
    return hexDuMois(rows, moisCarte, metrique);
  }, [index, selection, zone, deferredRange, metrique, moisRows, moisCarte]);
  const seuils = index?.seuils_couleur_quantiles?.[metrique === "hotspots" ? "hotspots" : "frp_MW"];

  /* ── Map: push GeoJSON into sources ── */
  const pushSources = useCallback(() => {
    const m = mapRef.current;
    if (!m) return;
    (m.getSource("hex") as GeoJSONSource | undefined)?.setData(hexRef.current as never);
    (m.getSource("sel") as GeoJSONSource | undefined)?.setData(selFcRef.current as never);
    (m.getSource("draft") as GeoJSONSource | undefined)?.setData(draftRef.current as never);
  }, []);

  const setDraft = useCallback((fc: unknown) => { draftRef.current = fc; pushSources(); }, [pushSources]);
  const draftBox = (a: [number, number], b: [number, number]) => ({
    type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [rectRing([Math.min(a[1], b[1]), Math.max(a[1], b[1]), Math.min(a[0], b[0]), Math.max(a[0], b[0])])] } }],
  });
  const draftPoly = (pts: Ring, cursor?: [number, number]) => {
    const feats: unknown[] = pts.map((p) => ({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: p } }));
    const line = cursor ? [...pts, cursor] : pts;
    if (line.length > 1) feats.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: line } });
    if (pts.length > 2) feats.push({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[...pts, pts[0]]] } });
    return { type: "FeatureCollection", features: feats };
  };

  /* ── Selection actions ── */
  const fitTo = useCallback((b: [number, number, number, number]) => {
    const m = mapRef.current;
    if (!m) return;
    if (!loadedRef.current) { pendingFit.current = b; return; }
    const wide = window.innerWidth > 900;
    m.fitBounds([[b[2], b[0]], [b[3], b[1]]], {
      padding: { top: 90, left: 60, bottom: wide ? 60 : 340, right: wide && panelOpenRef.current ? 520 : 60 },
      duration: 1400, maxZoom: 11,
    });
  }, []);

  const applySelection = useCallback((
    region: RegionDef,
    ring: Ring,
    name?: string,
    wasPolygon = false,
    resetRange = true,
  ) => {
    setSearchOpen(false);
    setSelection({ region, ring, wasPolygon });
    setSelectionName(name ?? region.name);
    if (resetRange) setSelRange(fullRange());
    setPanelOpen(true);
    panelOpenRef.current = true;
    selFcRef.current = { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } }] };
    setDraft(EMPTY_FC);
    fitTo(region.bbox);
  }, [fitTo, setDraft, fullRange]);

  const handleApplyBbox = useCallback((bbox: [number, number, number, number], currentName: string) => {
    setSearchOpen(false);
    // A new region not renamed yet is named after its corner.
    if (currentName === NEW_REGION) currentName = `${fmtLat(bbox[1])} ${fmtLon(bbox[3])}`;
    const ring = rectRing(bbox);
    const newRegion = { ...regionFromRing(ring), name: currentName, bbox };
    applySelection(newRegion, ring, currentName, false, false);
  }, [applySelection]);

  fitRef.current = fitTo;
  finalizeRef.current = (ring: Ring, fromBox = false) => {
    if (ring.length < 3) return;
    const closed: Ring = [...ring, ring[0]];
    regionCounterRef.current += 1;
    const name = `Region ${regionCounterRef.current}`;
    applySelection(regionFromRing(closed), closed, name, !fromBox);
    setTool("none");
    polyPts.current = [];
    setPolyN(0);
  };

  const clearSelection = () => {
    setSplit(false);
    setSelection(null);
    setSelectionName("");
    selFcRef.current = EMPTY_FC;
    setDraft(EMPTY_FC);
    polyPts.current = [];
    setPolyN(0);
    setTool("none");
  };
  const pickTool = (t: Tool) => {
    polyPts.current = [];
    setPolyN(0);
    setDraft(EMPTY_FC);
    setTool(tool === t ? "none" : t);
  };
  const finishPoly = () => {
    const pts = polyPts.current.filter((p, i, a) => i === 0 || Math.hypot(p[0] - a[i - 1][0], p[1] - a[i - 1][1]) > 1e-6);
    finalizeRef.current(pts, false);
  };

  /* ── Map lifecycle ── */
  useEffect(() => {
    let cancelled = false;
    let map: MLMap | null = null;
    (async () => {
      const maplibregl = (await import("maplibre-gl")).default;
      if (cancelled || !containerRef.current) return;
      map = new maplibregl.Map({
        container: containerRef.current, style: SAT_STYLE, center: [12, 24], zoom: 2.4, maxPitch: 75,
        attributionControl: { compact: true },
      });
      mapRef.current = map;
      map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
      map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");

      const install = () => {
        if (!map) return;
        try {
          const want = flatRef.current ? "mercator" : "globe";
          if (map.getProjection()?.type !== want) map.setProjection({ type: want });
        } catch { /* older style spec */ }
        if (!map.getSource("hex")) {
          map.addSource("hex", { type: "geojson", data: hexRef.current as never });
          map.addSource("sel", { type: "geojson", data: selFcRef.current as never });
          map.addSource("draft", { type: "geojson", data: draftRef.current as never });
          map.addLayer({ id: "sel-fill", type: "fill", source: "sel", paint: { "fill-color": "#dc2626", "fill-opacity": 0.07 } });
          map.addLayer({
            id: "hex", type: "fill", source: "hex",
            paint: { "fill-color": HEX_COLORS[2], "fill-opacity": ["interpolate", ["linear"], ["zoom"], 2, 0.85, 9, 0.6] },
          });
          map.addLayer({
            id: "hex-line", type: "line", source: "hex", minzoom: 5,
            paint: { "line-color": "#ffffff", "line-width": 0.4, "line-opacity": 0.6 },
          });
          map.addLayer({ id: "sel-line", type: "line", source: "sel", paint: { "line-color": "#dc2626", "line-width": 2 } });
          map.addLayer({ id: "draft-fill", type: "fill", source: "draft", filter: ["==", ["geometry-type"], "Polygon"], paint: { "fill-color": "#0f172a", "fill-opacity": 0.08 } });
          map.addLayer({ id: "draft-line", type: "line", source: "draft", filter: ["any", ["==", ["geometry-type"], "Polygon"], ["==", ["geometry-type"], "LineString"]], paint: { "line-color": "#0f172a", "line-width": 2, "line-dasharray": [2, 2] } });
          map.addLayer({ id: "draft-pts", type: "circle", source: "draft", filter: ["==", ["geometry-type"], "Point"], paint: { "circle-radius": 4.5, "circle-color": "#ffffff", "circle-stroke-color": "#0f172a", "circle-stroke-width": 2 } });
        }
        colorRef.current();
      };
      map.on("style.load", install);
      map.on("load", () => {
        install(); pushSources(); loadedRef.current = true; setReady(true);
        if (pendingFit.current) { const b = pendingFit.current; pendingFit.current = null; setTimeout(() => fitRef.current(b), 50); }
      });

      // Hexagon popup
      map.on("mouseenter", "hex", () => { if (map && toolRef.current === "none") map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", "hex", () => { if (map && toolRef.current === "none") map.getCanvas().style.cursor = ""; });
      map.on("click", "hex", (e: MapLayerMouseEvent) => {
        if (toolRef.current !== "none" || !map || !e.features?.length) return;
        const p = e.features[0].properties as { h3: string; n: number; frp: number; months: number; period: string };
        const esc = (v: unknown) => String(v).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
        const [lo, la] = centreHex(String(p.h3));
        const moy = Number(p.months) > 1 ? `<tr><td>Per month</td><td>${fmtVal(Number(p.n) / Number(p.months))}</td></tr>` : "";
        new maplibregl.Popup({ closeButton: false, offset: 8, className: "hd-popup" })
          .setLngLat(e.lngLat)
          .setHTML(`<table><tr><td>Hotspots</td><td>${fmtVal(Number(p.n))} <small>Aqua eq.</small></td></tr>${moy}<tr><td>FRP</td><td>${fmtInt(Number(p.frp))} MW</td></tr><tr><td>Period</td><td>${esc(p.period)}</td></tr><tr><td>H3 res 5</td><td>${esc(p.h3)}<br><small>${la.toFixed(3)}, ${lo.toFixed(3)}</small></td></tr></table>`)
          .addTo(map);
      });

      // Polygon tool
      map.on("click", (e) => {
        if (toolRef.current !== "poly" || !map) return;
        const pts = polyPts.current;
        if (pts.length >= 3) {
          const first = map.project(pts[0]);
          if (Math.hypot(first.x - e.point.x, first.y - e.point.y) < 12) { finalizeRef.current(pts, false); return; }
        }
        pts.push([e.lngLat.lng, e.lngLat.lat]);
        setPolyN(pts.length);
        draftRef.current = draftPoly(pts);
        pushSources();
      });
      map.on("dblclick", (e) => {
        if (toolRef.current !== "poly") return;
        e.preventDefault();
        const pts = polyPts.current.filter((p, i, a) => i === 0 || Math.hypot(p[0] - a[i - 1][0], p[1] - a[i - 1][1]) > 1e-6);
        finalizeRef.current(pts, false);
      });
      map.on("mousemove", (e) => {
        if (toolRef.current !== "poly" || !polyPts.current.length) return;
        draftRef.current = draftPoly(polyPts.current, [e.lngLat.lng, e.lngLat.lat]);
        pushSources();
      });

      // Box tool
      const el = map.getCanvasContainer();
      let start: { x: number; y: number; ll: [number, number] } | null = null;
      const local = (ev: PointerEvent) => { const r = el.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; };
      el.addEventListener("pointerdown", (ev) => {
        if (toolRef.current !== "box" || !map) return;
        const p = local(ev);
        const ll = map.unproject([p.x, p.y]);
        start = { x: p.x, y: p.y, ll: [ll.lng, ll.lat] };
        el.setPointerCapture(ev.pointerId);
      });
      el.addEventListener("pointermove", (ev) => {
        if (!start || !map) return;
        const p = local(ev);
        const ll = map.unproject([p.x, p.y]);
        draftRef.current = draftBox(start.ll, [ll.lng, ll.lat]);
        pushSources();
      });
      el.addEventListener("pointerup", (ev) => {
        if (!start || !map) return;
        const p = local(ev);
        const s = start;
        start = null;
        if (Math.hypot(p.x - s.x, p.y - s.y) < 8) { draftRef.current = EMPTY_FC; pushSources(); return; }
        const ll = map.unproject([p.x, p.y]);
        const b = rectRing([Math.min(s.ll[1], ll.lat), Math.max(s.ll[1], ll.lat), Math.min(s.ll[0], ll.lng), Math.max(s.ll[0], ll.lng)]);
        finalizeRef.current(b.slice(0, 4), true);
      });
    })();
    return () => { cancelled = true; map?.remove(); mapRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Hexagon colours follow the metric (thresholds of index.json)
  const colorRef = useRef<() => void>(() => {});
  colorRef.current = () => {
    const m = mapRef.current;
    if (!m?.getLayer("hex")) return;
    m.setPaintProperty("hex", "fill-color", hexColorExpr(seuils) as never);
  };
  useEffect(() => { colorRef.current(); }, [seuils, ready]);


  // 2D plan / 3D globe projection toggle, animated: the globe flattens into the plan, the plan wraps back.
  // MapLibre morphs globe <-> mercator through a zoom-driven expression, so each frame we slide the
  // two stops around the current zoom to put the morph at ratio t (0 = globe, 1 = plan) without moving the view.
  const prevFlatRef = useRef(false);
  useEffect(() => {
    flatRef.current = flat;
    const m = mapRef.current;
    if (!m || !ready) return;
    const from = prevFlatRef.current;
    prevFlatRef.current = flat;

    const settle = () => {
      try {
        m.setProjection({ type: flat ? "mercator" : "globe" });
        // A flat plan stays north-up and top-down; the globe keeps tilt and rotation.
        m.setMaxPitch(flat ? 0 : 75);
      } catch { /* older style spec */ }
    };
    // After a morph MapLibre can keep the tile coverage computed for an intermediate projection,
    // leaving blank rectangles: re-set the raster tile URLs so every source re-requests its tiles.
    const refreshTiles = () => {
      try {
        for (const id of ["sat", "roads", "places"]) {
          const src = SAT_STYLE.sources[id] as { tiles: string[] };
          (m.getSource(id) as unknown as { setTiles?: (t: string[]) => void } | undefined)?.setTiles?.(src.tiles);
        }
        m.triggerRepaint();
      } catch { /* source not ready */ }
    };
    try {
      if (flat) {
        m.dragRotate.disable();
        m.touchZoomRotate.disableRotation();
        m.easeTo({ pitch: 0, bearing: 0, duration: MORPH_MS });
      } else {
        m.setMaxPitch(75);
        m.dragRotate.enable();
        m.touchZoomRotate.enableRotation();
      }
    } catch { /* older style spec */ }

    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (from === flat || reduce) { settle(); if (from !== flat) refreshTiles(); return; }

    let raf = 0;
    const t0 = performance.now();
    const step = (now: number) => {
      const p = clamp((now - t0) / MORPH_MS, 0, 1);
      const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2; // easeInOutCubic
      const t = flat ? e : 1 - e;
      const z = m.getZoom();
      try {
        m.setProjection({
          type: ["interpolate", ["linear"], ["zoom"], z - t, "vertical-perspective", z + 1 - t, "mercator"],
        } as never);
      } catch { settle(); refreshTiles(); return; }
      if (p < 1) raf = requestAnimationFrame(step); else { settle(); refreshTiles(); }
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [flat, ready]);

  // Tool side effects
  useEffect(() => {
    const m = mapRef.current;
    if (m) {
      m.getCanvas().style.cursor = tool === "none" ? "" : "crosshair";
      if (tool === "box") m.dragPan.disable(); else m.dragPan.enable();
      if (tool === "poly") m.doubleClickZoom.disable(); else m.doubleClickZoom.enable();
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { polyPts.current = []; setPolyN(0); setDraft(EMPTY_FC); setTool("none"); }
      if (e.key === "Enter" && toolRef.current === "poly") finishPoly();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, ready]);

  // Esc closes the split view
  useEffect(() => {
    if (!split) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSplit(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [split]);


  // Data → map
  useEffect(() => { hexRef.current = hexes; pushSources(); }, [hexes, ready, pushSources]);
  useEffect(() => { pushSources(); }, [selection, ready, pushSources]);

  /* ── Trend chart geometry ── */
  const W = 340, H = 112, ml = 30, mr = 4, mt = 6, mb = 16;
  const pw = W - ml - mr, ph = H - mt - mb;
  const seriesMax = Math.max(...annual.map((p) => p.value ?? 0), 1);
  const ticks = niceTicks(seriesMax * 1.05);
  const yMax = ticks[ticks.length - 1];
  const xAt = (i: number) => ml + (i / Math.max(1, NY - 1)) * pw;
  const yAt = (v: number) => mt + ph - (v / yMax) * ph;
  const pathOf = (s: (number | null)[]) => {
    let d = "", pen = false;
    s.forEach((v, i) => {
      if (v === null) { pen = false; return; }
      d += `${pen ? "L" : "M"}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const line = annual.map((p) => p.value);
  const bascule = index ? new Date(index.bascule_viirs + "T00:00:00Z") : null;
  const xBascule = bascule ? xAt(bascule.getUTCFullYear() - Y0 + bascule.getUTCMonth() / 12) : null;
  const onChartMove = (e: React.MouseEvent<SVGRectElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setHoverYear(clamp(Math.round(((e.clientX - r.left) / r.width) * (NY - 1)), 0, NY - 1));
  };
  const yearTicks = Array.from({ length: NY }, (_, i) => Y0 + i).filter((y) => y % 5 === 0);

  /* ── Calendar tooltip data ── */
  const tipCell = tip ? cellOf(tip.yi, tip.m) : null;
  const tipStat = tip && tipCell && serie && index ? statMois(serie, index, Y0 + tip.yi, tip.m, metrique) : null;
  const petiteZone = serie?.source === "h3" && serie.hexagones.length < MIN_HEX_FOURCHETTE;
  const band = (c: MoisZone): [number | null, number | null] => metrique === "hotspots" ? [c.bas80, c.haut80] : [c.frpBas80, c.frpHaut80];

  /* ── E7: focus month vs the median 2003–2025 (single month picked, else the last COMPLETE month) ── */
  const focus = (() => {
    if (!bornes) return { y: 2002, m: 0 };
    if (selection && monthKey(selRange.from.y, selRange.from.m) === monthKey(selRange.to.y, selRange.to.m)) return selRange.from;
    const l = bornes.last;
    return partiel === texteMois(l.y, l.m) ? (l.m === 0 ? { y: l.y - 1, m: 11 } : { y: l.y, m: l.m - 1 }) : l;
  })();
  const focusStat = serie && index ? statMois(serie, index, focus.y, focus.m, metrique) : null;
  const focusStatHot = serie && index ? statMois(serie, index, focus.y, focus.m, "hotspots") : null;
  const focusCell = serie && index ? serie.mois[indiceMois(index, focus.y, focus.m)] ?? null : null;
  const CLASS_COLORS: Record<string, string> = { "much below normal": "#2166ac", "below normal": "#92c5de", "near normal": "#f7f7f7", "above normal": "#f4a582", "much above normal": "#b2182b" };

  /* ── E8: download the calendar as a PNG image ── */
  const downloadCalendarPng = () => {
    const cw = 22, ch = 13, left = 44, top = 46, rows = vals.length;
    const cv = document.createElement("canvas");
    cv.width = left + 12 * cw + 16; cv.height = top + rows * ch + 40;
    const g = cv.getContext("2d");
    if (!g) return;
    g.fillStyle = "#ffffff"; g.fillRect(0, 0, cv.width, cv.height);
    g.fillStyle = "#0f172a"; g.font = "bold 13px sans-serif";
    g.fillText(`Vigil · ${selectionName} · ${metrique === "hotspots" ? "hotspots" : "FRP (MW)"} per month, MODIS-Aqua equivalent`, 8, 18);
    g.font = "10px sans-serif"; g.fillStyle = "#64748b";
    g.fillText(`NASA FIRMS MODIS & VIIRS · ${index?.methode ?? "VIGIL-K1"} · log colour scale`, 8, 32);
    MONTHS.forEach((mn, i) => g.fillText(mn[0], left + i * cw + 8, top - 4));
    vals.forEach((row, yi) => {
      g.fillStyle = "#64748b";
      g.fillText(String(Y0 + yi), 6, top + yi * ch + 10);
      row.forEach((v, mi) => {
        g.fillStyle = v === null ? "#e2e8f0" : v <= 0 ? "#e8edf3" : heatColor(heatT(v, heatMax));
        g.fillRect(left + mi * cw, top + yi * ch, cw - 1, ch - 1);
      });
    });
    g.fillStyle = "#64748b";
    g.fillText(`Scale: 0 → ≥ ${fmtCompact(heatMax)} ${unit(metrique)} / month (this zone). Grey = no data.`, 8, top + rows * ch + 18);
    const a = document.createElement("a");
    a.href = cv.toDataURL("image/png");
    a.download = `vigil_${selectionName.replace(/[^a-z0-9]/gi, "_")}_calendar_${metrique}.png`;
    a.click();
  };

  /* ── Calendar (year × month heatmap), shared by the panel and the split view ── */
  const renderCalendar = (large: boolean) => (
    <div className={"hd-heat" + (large ? " lg" : "")} onMouseLeave={() => setTip(null)}>
      <div />
      {MONTHS.map((m) => <div key={m} className="hd-heat-col">{m[0]}</div>)}
      {vals.map((row, yi) => (
        <React.Fragment key={yi}>
          <div className="hd-heat-row">{large || (Y0 + yi) % 2 === 0 ? Y0 + yi : ""}</div>
          {row.map((v, m) => {
            const c = cellOf(yi, m);
            const bg = v === null ? undefined : v <= 0 ? "#e8edf3" : heatColor(heatT(v, heatMax));
            const k = (Y0 + yi) * 12 + m;
            const inRange = k >= selRange.from.y * 12 + selRange.from.m && k <= selRange.to.y * 12 + selRange.to.m;
            const sel = selection ? inRange && selRange.from.y * 12 + selRange.from.m === selRange.to.y * 12 + selRange.to.m : date.y === Y0 + yi && date.m === m;
            return (
              <div
                key={m}
                className={"hd-cell" + (v === null ? " empty" : "") + (c?.partiel ? " partial" : "") + (sel ? " sel" : "") + (selection && !inRange ? " out" : "")}
                style={{ background: bg }}
                onMouseMove={(e) => setTip({ x: e.clientX, y: e.clientY, yi, m })}
                onClick={(e) => {
                  if (v === null) return;
                  if (!selection) { setDate({ y: Y0 + yi, m }); return; }
                  // With a selection the calendar edits the study period: click = that month, shift+click = extend.
                  const cur = { y: Y0 + yi, m };
                  if (e.shiftKey) {
                    const a = selRange.from, lo = k < a.y * 12 + a.m;
                    setSelRange(lo ? { from: cur, to: selRange.to } : { from: selRange.from, to: cur });
                  } else setSelRange({ from: cur, to: cur });
                }}
                aria-label={v !== null ? `${MONTHS[m]} ${Y0 + yi}: ${fmtVal(v)} ${unit(metrique)}${c?.partiel ? " (partial month)" : ""}` : `${MONTHS[m]} ${Y0 + yi}: no data`}
              />
            );
          })}
        </React.Fragment>
      ))}
      <div className="hd-heat-legend">
        <span>0</span><i />
        <span>{serie ? `≥ ${fmtCompact(heatMax)} ${unit(metrique)} / month · log scale, this zone` : zoneProg ? "Loading…" : "No data"}</span>
        {partiel && <span className="hd-heat-partial"><b />partial month</span>}
      </div>
    </div>
  );

  /* ── Search (country or region) ── */
  const selectPlace = useCallback(async (l: Lieu) => {
    setSearchOpen(false);
    const pays = l.kind === "Country" ? await chargerPays().catch(() => null) : null;
    const ring = rectRing(l.bbox);
    // Keep the study period shown in the card.
    applySelection({ ...regionFromRing(ring), name: l.name, pays: l.kind === "Country" ? clePays(l.name, pays) : undefined }, ring, l.name, false, false);
  }, [applySelection]);

  const toggleSearch = () => {
    if (selection) { setPanelLeftOpen(true); setTimeout(() => searchInputRef.current?.focus(), 0); return; }
    if (!searchOpen) { setSelRange(fullRange()); setNewName(NEW_REGION); }
    setSearchOpen(!searchOpen);
  };

  useEffect(() => {
    if (searchOpen) { setPanelLeftOpen(true); setTimeout(() => searchInputRef.current?.focus(), 0); chargerPays().catch(() => null); } // warm pays.json
  }, [searchOpen]);

  /* ── Zone description (scale and band actually used) ── */
  const zoneNote = !selection ? "" : zoneErr ? zoneErr
    : zoneProg ? `Loading ${zoneProg.done}/${zoneProg.total} H3 tiles…`
    : !serie ? "Loading…"
    : serie.source === "pays"
      ? `Country series (pays.json, validated country × month) · reliability ${LIB_FIAB[serie.fiabilite ?? ""] ?? serie.fiabilite}${metrique === "frp" && serie.fiabiliteFrp ? ` · FRP ${LIB_FIAB[serie.fiabiliteFrp] ?? serie.fiabiliteFrp}` : ""}`
      : serie.hexagones.length === 0 ? "No H3 hexagon with fire has its centre in this zone."
      : `${fmtInt(serie.hexagones.length)} H3 res-5 hexagons (centre inside) · band: ${serie.table === "hotspots_sous_pays" ? "sub-country table" : serie.table === "hotspots" ? "country table (not validated below country scale)" : "unavailable"}${petiteZone ? " · indicative band (zone smaller than the tested zones)" : ""}`;
  const fiabFaible = serie?.source === "pays" && serie.fiabilite === "faible";
  const exporter = () => (zone && index ? exportCsv(zone, index, selRange) : null);

  if (erreur) {
    return (
      <div className="hd-root">
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
        <div className="hd-fatal" role="alert">
          <b>Vigil data (contract v2) could not be loaded.</b>
          <p className="hd-mono">{erreur}</p>
          <p>Expected files under <code>{BASE}/</code> (index.json, incertitude.json, pays.json, h3_5/…). On the backend PC run
            <code> python -m pipeline.v2.export_site --site public/data</code>, or for a local demo
            <code> node scripts/fixture_v2.mjs</code> then <code>NEXT_PUBLIC_VIGIL_DATA_BASE=/data-fixture npm run dev</code>.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="hd-root">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div ref={containerRef} className="hd-map" />
      {/* Decorative MODIS / VIIRS orbits over the globe until a region is picked */}
      <OrbitOverlay mapRef={mapRef} ready={ready} visible={!selection && !flat} enterDelayMs={MORPH_MS} />

      {/* Toolbar */}
      <div className="hd-toolbar">
        <img className="hd-logo" src="/vigil-logo.png" alt="Vigil" />

        {/* Search: opens the search card in the region card's slot */}
        <div className="hd-search">
          <button className={"hd-search-toggle" + (searchOpen ? " on" : "")} onClick={toggleSearch}
            aria-label="Search a country, region or coordinates" aria-expanded={searchOpen} title="Search">
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <circle cx="6" cy="6" r="4.5" />
              <line x1="9.5" y1="9.5" x2="13" y2="13" />
            </svg>
          </button>
        </div>

        <div className="hd-group">
          <button className={"hd-btn" + (tool === "box" ? " on" : "")} onClick={() => pickTool("box")}>Box</button>
          <button className={"hd-btn" + (tool === "poly" ? " on" : "")} onClick={() => pickTool("poly")}>Polygon</button>
          {tool === "poly" && polyN >= 3 && <button className="hd-btn accent" onClick={finishPoly}>Finish</button>}
          {selection && <button className="hd-btn" onClick={clearSelection}>Clear</button>}
          <button className="hd-btn" onClick={() => setFlat(!flat)} aria-pressed={flat} title={flat ? "Switch to 3D globe" : "Switch to 2D map"}>{flat ? "3D" : "2D"}</button>
        </div>
        {index?.fixture && <span className="hd-fixture" title={`${BASE}/index.json is marked fixture: true`}>Demo data (fixture), not the real export</span>}
      </div>

      {tool !== "none" && (
        <div className="hd-hintbar">
          {tool === "box" ? "Drag on the map" : polyN < 3 ? `Click to add vertices (${polyN})` : "Click first vertex, double-click, or Enter to close"}
          <span>Esc to cancel</span>
        </div>
      )}

      {/* Left panel: Region card */}
      {(selection || searchOpen) && bornes && (
        <aside ref={leftDrag.ref} style={leftDrag.style} className={"hd-panel-left" + (panelLeftOpen ? "" : " collapsed") + (leftDrag.dragging ? " dragging" : "")} aria-label="Region settings">
          <div className="hd-panel-head" {...leftDrag.handle}>
            <RegionName name={selection ? selectionName : newName} onRename={selection ? setSelectionName : setNewName} />
            <button className="hd-icon" onClick={() => setPanelLeftOpen(!panelLeftOpen)} aria-label={panelLeftOpen ? "Collapse region panel" : "Expand region panel"} aria-expanded={panelLeftOpen}>
              <svg width="12" height="12" viewBox="0 0 14 14"><path d={panelLeftOpen ? "M2 5l5 5 5-5" : "M2 9l5-5 5 5"} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" /></svg>
            </button>
          </div>
          {panelLeftOpen && (
            <div className="hd-panel-body">
              <RegionCard
                selection={selection}
                searchRef={searchInputRef}
                onPick={selectPlace}
                onSearchEscape={() => { if (!selection) setSearchOpen(false); }}
                name={selection ? selectionName : newName}
                range={selRange}
                onRangeChange={setSelRange}
                onApplyBbox={handleApplyBbox}
                bornes={bornes}
                onExport={exporter}
                ready={!!zone}
              />
            </div>
          )}
        </aside>
      )}

      {/* Analytics panel */}
      {selection && (
        <aside ref={rightDrag.ref} style={rightDrag.style} className={"hd-panel" + (panelOpen ? "" : " collapsed") + (rightDrag.dragging ? " dragging" : "")} aria-label="Analytics">
          <div className="hd-panel-head" {...rightDrag.handle}>
            <div className="hd-head-actions">
              <button className="hd-icon" onClick={() => setSplit(true)} aria-label="Deep dive: calendar full screen" title="Deep dive">
                <ExpandIcon />
              </button>
              <button className="hd-icon" onClick={() => setPanelOpen(!panelOpen)} aria-label={panelOpen ? "Collapse panel" : "Expand panel"} aria-expanded={panelOpen}>
              <svg width="12" height="12" viewBox="0 0 14 14"><path d={panelOpen ? "M2 5l5 5 5-5" : "M2 9l5-5 5 5"} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" /></svg>
              </button>
            </div>
          </div>

          {panelOpen && (
            <div className="hd-panel-body">
              <Seg<Metrique> label="Metric" value={metrique} onChange={setMetrique} options={[{ v: "hotspots", t: "Hotspots" }, { v: "frp", t: "FRP (MW)" }]} />
              {zoneNote && <p className={"hd-zone-note" + (zoneErr || fiabFaible ? " warn" : "")} role={zoneErr ? "alert" : undefined}>{zoneNote}{fiabFaible ? " — little data, conversion less certain" : ""}</p>}

              {focusStat && focusCell && (
                <div className="hd-median" aria-live="polite">
                  <div className="hd-median-head">
                    <b className="hd-mono">{MONTHS[focus.m]} {focus.y}</b> vs median 2003–2025
                    <span className="hd-median-cls" style={{ background: CLASS_COLORS[focusStat.classe], color: focusStat.classe.startsWith("much") ? "#fff" : "#0f172a" }}>{focusStat.classe}</span>
                  </div>
                  <div className="hd-median-row hd-mono">
                    {fmtVal(focusCell[metrique])} {unit(metrique)} · median {fmtVal(focusStat.mediane)}{focusStat.pctMediane !== null ? ` · ${Math.round(focusStat.pctMediane)} % of median` : ""}
                  </div>
                  <div className="hd-median-row hd-mono dim">
                    percentile {Math.round(focusStat.rang)} ({focusStat.n} yrs) · usual range (P10–P90) {fmtVal(focusStat.p10)}–{fmtVal(focusStat.p90)}
                  </div>
                </div>
              )}

              {renderCalendar(false)}
              {serie && <button className="hd-rc-apply hd-png" onClick={downloadCalendarPng} aria-label="Download the calendar as a PNG image">Download PNG</button>}

              <div className="hd-chart-wrap">
                <svg viewBox={`0 0 ${W} ${H}`} className="hd-chart" role="img" aria-label={`Annual ${metrique === "hotspots" ? "hotspot" : "FRP"} totals, MODIS-Aqua equivalent`}>
                  {ticks.map((t) => (
                    <g key={t}>
                      <line x1={ml} x2={W - mr} y1={yAt(t)} y2={yAt(t)} stroke="#e2e8f0" />
                      <text x={ml - 6} y={yAt(t) + 3.5} textAnchor="end" className="hd-axis">{fmtCompact(t)}</text>
                    </g>
                  ))}
                  {yearTicks.map((y) => <text key={y} x={xAt(y - Y0)} y={H - 3} textAnchor="middle" className="hd-axis">{y}</text>)}
                  {xBascule !== null && (
                    <>
                      <line x1={xBascule} x2={xBascule} y1={mt} y2={mt + ph} stroke="#dc2626" strokeDasharray="3 3" opacity={0.6} />
                      <text x={xBascule - 4} y={mt + 8} textAnchor="end" className="hd-annot">VIIRS converted →</text>
                    </>
                  )}
                  <path d={pathOf(line)} fill="none" stroke="#ea580c" strokeWidth={2.2} strokeLinejoin="round" />
                  {annual.map((p, i) => p.value !== null && p.est ? <circle key={i} cx={xAt(i)} cy={yAt(p.value)} r={2.6} fill="#fff" stroke="#ea580c" strokeWidth={1.2} /> : null)}
                  {hoverYear !== null && line[hoverYear] != null && (
                    <g>
                      <line x1={xAt(hoverYear)} x2={xAt(hoverYear)} y1={mt} y2={mt + ph} stroke="#0f172a" opacity={0.25} />
                      <circle cx={xAt(hoverYear)} cy={yAt(line[hoverYear]!)} r={3.5} fill="#ea580c" stroke="#fff" strokeWidth={1.2} />
                    </g>
                  )}
                  <rect x={ml} y={mt} width={pw} height={ph} fill="transparent" onMouseMove={onChartMove} onMouseLeave={() => setHoverYear(null)} />
                </svg>
                <div className="hd-chart-legend">
                  <span><svg width="22" height="6"><line x1="0" y1="3" x2="22" y2="3" stroke="#ea580c" strokeWidth="2.4" /></svg>Harmonized, MODIS-Aqua eq.</span>
                  <span><svg width="8" height="8"><circle cx="4" cy="4" r="2.6" fill="#fff" stroke="#ea580c" strokeWidth="1.2" /></svg>estimated (partial year)</span>
                  {hoverYear !== null && (
                    <span className="hd-mono hd-hover-read">
                      {Y0 + hoverYear}: {line[hoverYear] != null ? fmtCompact(line[hoverYear]!) : "—"} {unit(metrique)}
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}
        </aside>
      )}

      {/* Deep dive: full-screen calendar */}
      {split && selection && (
        <div className="hd-split" role="dialog" aria-label="Calendar deep dive">
          <div className="hd-split-head">
            <span className="hd-word-sm">Vigil</span>
            <span className="hd-mono hd-name">{selectionName}</span>
            <Seg<Metrique> label="Metric" value={metrique} onChange={setMetrique} options={[{ v: "hotspots", t: "Hotspots" }, { v: "frp", t: "FRP (MW)" }]} />
            <button className="hd-icon hd-split-close" onClick={() => setSplit(false)} aria-label="Exit deep dive (Esc)" title="Back (Esc)">
              <CollapseIcon />
            </button>
          </div>
          <div className="hd-split-body">
            <section className="hd-split-pane" aria-label="Calendar">
              <div className="hd-sec-head"><span className="hd-sec-title">Calendar</span>{zoneNote && <span className="hd-zone-note inline">{zoneNote}</span>}</div>
              <div className="hd-split-cal">{renderCalendar(true)}</div>
            </section>
            {index && (
              <section className="hd-split-pane hd-split-analytics" aria-label="Analytics">
                <DeepDive index={index} serie={serie} ring={selection.ring} bbox={selection.region.bbox} y0={Y0} y1={Y1} focus={focus} stat={focusStatHot} />
              </section>
            )}
          </div>
        </div>
      )}

      {/* Calendar tooltip */}
      {tip && selection && (panelOpen || split) && (
        <div className="hd-tip" style={{ left: Math.max(8, tip.x - 270), top: Math.max(8, tip.y - 12), transform: "translateY(-100%)" }}>
          <div className="hd-tip-title">{texteMois(Y0 + tip.yi, tip.m)}{tipCell?.partiel ? " · partial" : ""}</div>
          {tipCell ? (
            <>
              <div className="hd-tip-r"><span>{metrique === "hotspots" ? "Hotspots" : "FRP"}</span><b>{fmtVal(tipCell[metrique])} {unit(metrique)}</b></div>
              {tipCell.converti ? (() => {
                const [lo, hi] = band(tipCell);
                return lo !== null && hi !== null
                  ? <div className="hd-tip-r"><span>80 % band{petiteZone ? " (indicative)" : ""}</span><b>{fmtVal(lo)} – {fmtVal(hi)}</b></div>
                  : <div className="hd-tip-r dim"><span>Band</span><b>n/a</b></div>;
              })() : null}
              {tipCell.converti && metrique === "hotspots" && tipCell.bas95 !== null && tipCell.haut95 !== null && (
                <div className="hd-tip-r dim"><span>95 % band</span><b>{fmtVal(tipCell.bas95)} – {fmtVal(tipCell.haut95)}</b></div>
              )}
              {tipCell.converti && metrique === "frp" && serie?.source === "h3" && <div className="hd-tip-note">FRP band validated at country × month only</div>}
              <div className="hd-tip-r"><span>Source</span><b>{tipCell.converti ? "VIIRS converted" : "MODIS Aqua observed"}</b></div>
              <div className="hd-tip-r dim"><span>{metrique === "hotspots" ? "FRP" : "Hotspots"}</span><b>{metrique === "hotspots" ? `${fmtInt(tipCell.frp)} MW` : fmtVal(tipCell.hotspots)}</b></div>
              {tipCell.couverture !== null && <div className="hd-tip-r dim"><span>Days with data</span><b>{fmtInt(tipCell.couverture)}</b></div>}
              {tipStat ? (
                <>
                  <div className="hd-tip-sep" />
                  <div className="hd-tip-r"><span>vs 2003–2025</span><b>{tipStat.classe}</b></div>
                  <div className="hd-tip-r dim"><span>Median {MONTHS[tip.m]}</span><b>{fmtVal(tipStat.mediane)}</b></div>
                  <div className="hd-tip-r dim"><span>% of median</span><b>{tipStat.pctMediane === null ? "n.d." : `${Math.round(tipStat.pctMediane)} %`}</b></div>
                  <div className="hd-tip-r dim"><span>Percentile rank</span><b>{Math.round(tipStat.rang)} ({tipStat.n} yrs)</b></div>
                </>
              ) : tipCell.partiel ? <div className="hd-tip-note">Partial month: not compared with complete months</div> : null}
            </>
          ) : (
            <div className="hd-tip-r"><span>No data</span></div>
          )}
        </div>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Styles                                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

const CSS = `
.hd-root{--bg:#ffffff;--bg2:#f8fafc;--bd:#e2e8f0;--tx:#0f172a;--mut:#64748b;--or:#ea580c;--cr:#dc2626;--gr:#16a34a;
  position:fixed;inset:0;overflow:hidden;background:var(--bg2);color:var(--tx);font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  font-size:13px;line-height:1.4;-webkit-font-smoothing:antialiased;color-scheme:light}
.hd-root *{box-sizing:border-box}
.hd-root h2,.hd-root h3,.hd-root p{margin:0}
.hd-root button{font:inherit;color:inherit;cursor:pointer}
.hd-root button:focus-visible{outline:2px solid var(--or);outline-offset:2px}
.hd-map{position:absolute;inset:0}
.hd-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;font-variant-numeric:tabular-nums}

.hd-toolbar{position:absolute;top:12px;left:12px;right:60px;display:flex;flex-wrap:wrap;gap:8px;align-items:center;pointer-events:none;z-index:5}
.hd-toolbar>*{pointer-events:auto;background:rgba(255,255,255,.78);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);border-radius:8px;box-shadow:0 2px 12px rgba(15,23,42,.12)}
.hd-word{padding:7px 12px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;font-size:12px}
.hd-logo{display:block;height:32px;width:auto;padding:0 4px;background:#fff!important}
.hd-group{display:flex;gap:2px;padding:3px}
.hd-btn{border:0;background:transparent;border-radius:7px;padding:5px 10px;font-weight:550;color:#334155;white-space:nowrap}
.hd-btn:hover{background:var(--bg2)}
.hd-btn.on{background:var(--tx);color:#fff}
.hd-btn.accent{background:var(--or);color:#fff}
.hd-seg{display:inline-flex;background:var(--bg2);border:1px solid var(--bd);border-radius:9px;padding:2px;gap:2px}
.hd-toolbar .hd-seg{border:0;padding:3px;border-radius:8px}
.hd-seg button{border:0;background:transparent;padding:5px 11px;border-radius:7px;font-weight:550;color:var(--mut);white-space:nowrap}
.hd-seg button:hover{color:var(--tx)}
.hd-seg button.on{background:var(--tx);color:#fff}

.hd-hintbar{position:absolute;top:62px;left:50%;transform:translateX(-50%);z-index:5;background:var(--tx);color:#fff;border-radius:999px;padding:6px 14px;display:flex;gap:14px;font-size:12px}
.hd-hintbar span{color:#94a3b8}

.hd-panel{position:absolute;right:12px;bottom:28px;z-index:6;width:min(372px,calc(100vw - 24px));max-height:calc(100vh - 80px);display:flex;flex-direction:column;
  background:rgba(255,255,255,.78);-webkit-backdrop-filter:blur(14px) saturate(1.2);backdrop-filter:blur(14px) saturate(1.2);border-radius:10px;box-shadow:0 6px 28px rgba(15,23,42,.16)}
.hd-panel-left{position:absolute;left:12px;top:70px;max-height:calc(100vh - 170px);z-index:6;width:min(372px,calc(100vw - 24px));display:flex;flex-direction:column;overflow:hidden;
  background:rgba(255,255,255,.52);-webkit-backdrop-filter:blur(14px) saturate(1.2);backdrop-filter:blur(14px) saturate(1.2);border-radius:10px;box-shadow:0 6px 28px rgba(15,23,42,.16)}
.hd-panel-left .hd-panel-body{overflow-y:auto;padding:0 0 4px;display:flex;flex-direction:column;gap:0}
.hd-panel-left .hd-region-card{border-bottom:0}
.hd-panel-head{cursor:grab;touch-action:none;user-select:none;display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 10px 4px 14px}
.hd-name{font-weight:700;text-transform:uppercase;letter-spacing:.08em;font-size:11px}
.dragging .hd-panel-head{cursor:grabbing}
.hd-panel.dragging,.hd-panel-left.dragging{box-shadow:0 10px 36px rgba(15,23,42,.28)}
.hd-icon{border:0;background:transparent;width:24px;height:24px;border-radius:6px;display:grid;place-items:center;padding:0;color:var(--tx)}
.hd-icon:hover{background:rgba(15,23,42,.07)}
.hd-panel-body{overflow:auto;padding:4px 0 14px;display:flex;flex-direction:column;gap:12px}
.hd-panel-body .hd-seg{display:flex;background:rgba(15,23,42,.06);border:0;border-radius:7px;margin:0 14px}
.hd-panel-body .hd-seg button{flex:1;padding:5px 8px;font-size:12px;border-radius:5px}
.hd-panel-body .hd-heat{margin:0 14px}
.hd-panel-body .hd-chart-wrap{margin:0 14px}

.hd-search{position:relative;display:flex;flex-direction:column}
.hd-search-toggle{border:0;background:transparent;width:30px;height:30px;display:grid;place-items:center;border-radius:6px;color:var(--tx);cursor:pointer}
.hd-search-toggle:hover{background:rgba(15,23,42,.07)}
.hd-search-toggle.on{background:rgba(15,23,42,.1)}
.hd-search-field{display:flex;align-items:center;gap:6px;background:var(--bg2);border:1px solid var(--bd);border-radius:6px;padding:5px 6px 5px 9px;color:var(--mut)}
.hd-search-field:focus-within{border-color:var(--or)}
.hd-search-input{flex:1;min-width:0;border:0;background:transparent;outline:none;font:inherit;font-size:12px;color:var(--tx)}
.hd-search-input::placeholder{color:var(--mut)}
.hd-search-clear{border:0;background:transparent;padding:1px 5px;border-radius:5px;color:var(--mut);font-size:14px;line-height:1;cursor:pointer}
.hd-search-clear:hover{color:var(--tx)}
.hd-search-results{display:flex;flex-direction:column;border:1px solid var(--bd);border-radius:6px;overflow:hidden;background:var(--bg2)}
.hd-search-result{display:flex;justify-content:space-between;gap:10px;width:100%;border:0;background:transparent;text-align:left;padding:6px 10px;font-size:12px;color:var(--tx);cursor:pointer}
.hd-search-result.on{background:rgba(15,23,42,.07)}
.hd-search-kind{font-size:10px;color:var(--mut);text-transform:uppercase;letter-spacing:.05em}

.hd-heat{display:grid;grid-template-columns:26px repeat(12,minmax(0,1fr));gap:1px;user-select:none}
.hd-heat-col{font-size:9px;color:var(--mut);text-align:center;line-height:1.2}
.hd-heat-row{font-size:9px;color:var(--mut);display:flex;align-items:center;font-variant-numeric:tabular-nums;line-height:1;font-family:ui-monospace,Menlo,monospace}
.hd-cell{height:8px;border-radius:1px;cursor:pointer}
.hd-cell.empty{background:repeating-linear-gradient(45deg,#f1f5f9 0 2px,#e2e8f0 2px 3px);cursor:default}
.hd-heat-legend{grid-column:1 / -1;display:flex;align-items:center;gap:6px;margin-top:4px;font-size:9.5px;color:var(--mut)}
.hd-heat-legend i{flex:0 0 46px;height:6px;border-radius:2px;background:linear-gradient(90deg,#e8edf3,rgb(254,243,199) 4%,rgb(252,211,77) 25%,rgb(251,146,60) 50%,rgb(234,88,12) 72%,rgb(220,38,38) 88%,rgb(127,29,29))}
.hd-cell.out{opacity:.35}
.hd-cell.sel{outline:1.5px solid var(--tx);outline-offset:0;position:relative;z-index:1}
.hd-cell:hover{outline:1px solid var(--tx);outline-offset:0;position:relative;z-index:1}

.hd-chart-wrap{position:relative}
.hd-chart{width:100%;height:auto;display:block}
.hd-axis{font-size:9px;fill:#64748b;font-variant-numeric:tabular-nums}
.hd-annot{font-size:9px;fill:#b91c1c;font-weight:600}
.hd-chart-legend{display:flex;gap:12px;align-items:center;font-size:10.5px;color:#334155;margin-top:2px;font-family:ui-monospace,Menlo,monospace}
.hd-chart-legend span{display:inline-flex;align-items:center;gap:5px}
.hd-hover-read{margin-left:auto;color:var(--tx)}

.hd-head-actions{display:flex;gap:2px;margin-left:auto}
.hd-sec-head{display:flex;justify-content:space-between;align-items:center;margin:-2px 0 -6px}
.hd-sec-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--mut)}

.hd-split{position:absolute;inset:0;z-index:20;display:flex;flex-direction:column;background:var(--bg2)}
.hd-split-head{display:flex;align-items:center;gap:14px;padding:10px 16px;background:var(--bg);border-bottom:1px solid var(--bd)}
.hd-word-sm{font-weight:800;letter-spacing:.06em;text-transform:uppercase;font-size:12px}
.hd-split-head .hd-seg{margin-left:auto}
.hd-split-body{flex:1;min-height:0;display:flex;padding:12px}
.hd-split-pane{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;gap:10px;background:var(--bg);border:1px solid var(--bd);border-radius:10px;padding:12px 14px}
.hd-split-pane .hd-sec-head{margin:0}
.hd-split-cal{flex:1;min-height:0;display:flex}
.hd-split-cal .hd-heat{flex:1}
.hd-heat.lg{grid-template-columns:34px repeat(12,minmax(0,1fr));grid-auto-rows:1fr;grid-template-rows:auto;gap:2px}
.hd-heat.lg .hd-cell{height:auto;min-height:6px;border-radius:2px}
.hd-heat.lg .hd-heat-col,.hd-heat.lg .hd-heat-row{font-size:11px}

.hd-tip{position:fixed;z-index:50;width:230px;background:rgba(15,23,42,.94);color:#f8fafc;border-radius:8px;padding:9px 11px;box-shadow:0 8px 24px rgba(15,23,42,.16);pointer-events:none;font-size:12px}
.hd-tip-title{font-weight:700;margin-bottom:4px;font-family:ui-monospace,Menlo,monospace}
.hd-tip-r{display:flex;justify-content:space-between;gap:10px;padding:1px 0}
.hd-tip-r span{color:#94a3b8}
.hd-tip-r b{font-weight:650;font-variant-numeric:tabular-nums;text-align:right}
.hd-tip-r.dim{font-size:11px}

.hd-popup .maplibregl-popup-content{border-radius:10px;border:1px solid var(--bd);padding:8px 10px;font-size:12px;box-shadow:0 8px 24px rgba(15,23,42,.18);color:var(--tx)}
.hd-popup table{border-collapse:collapse}
.hd-popup td{padding:1px 0}
.hd-popup td:first-child{color:var(--mut);padding-right:14px}
.hd-popup td:last-child{font-weight:650;font-variant-numeric:tabular-nums}
.maplibregl-ctrl-top-right{top:6px}
.maplibregl-ctrl-bottom-right{bottom:0}

/* ── Region Card ── */
.hd-region-card{display:flex;flex-direction:column;gap:10px;padding:6px 14px 10px;border-bottom:1px solid var(--bd)}
.hd-rc-titlerow{flex:1;min-width:0;display:flex;align-items:center;gap:8px;min-height:26px}
.hd-rc-nameinput{flex:1;background:transparent;border:1px solid var(--or);border-radius:5px;padding:3px 7px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--tx);outline:none;min-width:0}
.hd-rc-rename{margin-left:auto;border:0;background:transparent;display:flex;align-items:center;gap:4px;font-size:11px;color:var(--mut);padding:3px 7px;border-radius:5px;white-space:nowrap;flex-shrink:0}
.hd-rc-rename:hover{background:rgba(15,23,42,.07);color:var(--tx)}
.hd-rc-section{display:flex;flex-direction:column;gap:6px}
.hd-rc-seclabel{font-size:10px;font-weight:650;text-transform:uppercase;letter-spacing:.06em;color:var(--mut)}
.hd-rc-grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:5px 8px}
.hd-rc-field{display:flex;flex-direction:column;gap:2px}
.hd-rc-fieldlabel{font-size:10px;color:var(--mut)}
.hd-rc-fieldinput{background:var(--bg2);border:1px solid var(--bd);border-radius:5px;padding:4px 7px;font:inherit;font-size:12px;color:var(--tx);outline:none;width:100%}
.hd-rc-fieldinput:focus{border-color:var(--or)}
.hd-rc-fieldinput.err{border-color:var(--cr)}
.hd-rc-monthinput{background:var(--bg2);border:1px solid var(--bd);border-radius:5px;padding:4px 7px;font:inherit;font-size:12px;color:var(--tx);outline:none;width:100%}
.hd-rc-monthinput:focus{border-color:var(--or)}
.hd-rc-fielderr{font-size:10px;color:var(--cr);line-height:1.3}
.hd-rc-apply{align-self:flex-end;border:1px solid var(--bd);background:var(--bg2);border-radius:6px;padding:4px 14px;font-size:12px;font-weight:600;color:var(--tx)}
.hd-rc-apply:not(:disabled):hover{background:var(--tx);color:#fff;border-color:var(--tx)}
.hd-rc-apply:disabled{opacity:.4;cursor:default}
.hd-rc-rangerow{display:flex;gap:10px}
.hd-rc-datepair{display:flex;gap:4px}
.hd-rc-datepair select{min-width:0;flex:1}
.hd-rc-rangerow .hd-rc-field{flex:1}
.hd-rc-note{font-size:10.5px;color:var(--mut);font-style:italic}
.hd-analysis-slot{background:rgba(15,23,42,.03);border:1px solid var(--bd);border-radius:7px;padding:9px 11px;display:flex;flex-direction:column;gap:3px}
.hd-analysis-title{font-size:10px;font-weight:650;text-transform:uppercase;letter-spacing:.06em;color:var(--mut)}
.hd-analysis-soon{font-size:11px;color:var(--mut);font-style:italic}
.hd-rc-export{width:100%;background:var(--or);color:#fff;border:0;border-radius:7px;padding:9px;font-weight:650;font-size:13px}
.hd-rc-export:hover{background:#c2410c}
.hd-rc-simnote{font-size:10px;color:var(--mut);text-align:center;margin:4px 0 0;font-style:italic}

@media (max-width:900px){
  .hd-panel{right:8px;left:8px;width:auto;bottom:8px;max-height:50vh}
  .hd-panel-left{left:8px;right:8px;width:auto;top:auto;bottom:calc(50vh + 24px);max-height:36vh}
  .hd-toolbar{right:50px}
}
/* ── E7 block and PNG button ── */
.hd-median{margin:0 14px;padding:8px 10px;border:1px solid var(--bd);border-radius:7px;background:rgba(255,255,255,.6);display:flex;flex-direction:column;gap:3px;font-size:12px}
.hd-median-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.hd-median-cls{margin-left:auto;padding:1px 7px;border-radius:999px;font-size:11px;font-weight:650;border:1px solid rgba(15,23,42,.15)}
.hd-median-row{font-size:11.5px}
.hd-median-row.dim{color:var(--mut);font-size:10.5px}
.hd-panel-body>.hd-png{margin:0 14px;align-self:flex-end}
/* ── Contract v2 ── */
.hd-fatal{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:min(560px,calc(100% - 32px));background:#fff;border:1px solid #fecaca;border-radius:10px;padding:18px 20px;box-shadow:0 8px 24px rgba(15,23,42,.12);display:flex;flex-direction:column;gap:8px}
.hd-fatal code{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;background:#f1f5f9;border-radius:4px;padding:1px 4px}
.hd-fixture{padding:6px 10px;font-size:11px;font-weight:650;color:#92400e;background:rgba(254,243,199,.92)!important}
.hd-zone-note{margin:6px 14px 8px;font-size:11px;color:var(--mut);line-height:1.35}
.hd-zone-note.warn{color:#b45309}
.hd-zone-note.inline{margin:0 0 0 12px}
.hd-cell.partial{background-image:repeating-linear-gradient(45deg,rgba(255,255,255,.75) 0 1.5px,transparent 1.5px 4px)!important}
.hd-heat-partial{display:inline-flex;align-items:center;gap:4px;margin-left:auto}
.hd-heat-partial b{width:10px;height:6px;border-radius:1px;background:#fb923c repeating-linear-gradient(45deg,rgba(255,255,255,.75) 0 1.5px,transparent 1.5px 4px)}
.hd-tip-sep{height:1px;background:rgba(148,163,184,.3);margin:5px 0}
.hd-tip-note{font-size:10.5px;color:#fbbf24;margin-top:2px}
.hd-popup small{color:var(--mut);font-weight:400}
@media (prefers-reduced-motion:reduce){.hd-root *{transition:none!important}}
`;
