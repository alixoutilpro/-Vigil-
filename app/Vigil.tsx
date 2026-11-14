"use client";

/**
 * Vigil - MODIS / VIIRS hotspot harmonization. Map-first single-file component.
 * Map: MapLibre GL (globe / 2D plan), Esri satellite imagery.
 * Single source of truth: data/data.json (pipeline v2 export, one row per 0.25 deg cell x month,
 * hotspot COUNTS). The calendar, the map points and the CSV export are all built from it, so they
 * always agree. Outside the area covered by data.json the app shows "no data", never invented fires.
 */

import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import "maplibre-gl/dist/maplibre-gl.css";
import contractData from "../data/data.json";
import type { Map as MLMap, GeoJSONSource, StyleSpecification, MapLayerMouseEvent } from "maplibre-gl";

/* ────────────────────────────────────────────────────────────────────────── */
/* Types & constants                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

type Variant = "raw" | "harm";
type Metric = "count" | "frp";
type FireType = "all" | "wild" | "agri";
type Ring = [number, number][];

interface AnomalyDef {
  y: number;
  m: number[];
  k: number;
}

export interface RegionDef {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** [latMin, latMax, lonMin, lonMax] */
  bbox: [number, number, number, number];
  scale: number;
  peak: number;
  width: number;
  floor: number;
  ext: number;
  earlier: number;
  trend: number;
  wild: number;
  frp: number;
  anomalies: AnomalyDef[];
  color: string;
  custom?: boolean;
}

export interface Cell {
  y: number;
  m: number;
  modis: number;
  viirs: number;
  mFrp: number;
  vFrp: number;
  mEff: number; // MODIS coverage efficiency (Terra-only era = 0.6)
  hasV: boolean;
  wild: number;
  /** Harmonized total from the pillar 6 contract (sum of harmonized_fire_days); overrides the nominal-ratio conversion. */
  harm?: number;
}

/** One row of data/data.json — the frozen pillar 6 output contract. */
interface ContractRow {
  cell_id: string;
  lat: number;
  lon: number;
  iso_year: number;
  iso_week: number;
  modis_fire_days: number | null;
  viirs_fire_days: number | null;
  harmonized_fire_days: number;
  harmonized_low: number;
  harmonized_high: number;
  land_cover_class: "forest" | "cropland" | "shrub_grass" | "other";
  source: "modis_only" | "viirs_converted" | "both";
}

interface CellVal {
  total: number;
  modis: number;
  viirs: number;
}

interface DateRange {
  from: { y: number; m: number };
  to: { y: number; m: number };
}

const Y0 = 2000;
const Y1 = 2026;
const NY = Y1 - Y0 + 1;
const LAST_MONTH_Y1 = 9; // data through Oct 2026
const FIRST_MONTH_Y0 = 10; // MODIS active fire starts Nov 2000
const VIIRS_START = { y: 2012, m: 1 }; // Feb 2012
/** Backend switch (VIGIL-K1): harmonized values are MODIS Aqua as observed before Nov 2020, converted VIIRS from then on. */
const SWITCH = { y: 2020, m: 10 }; // Nov 2020
/** Reference period of the historical median (E7): complete Aqua years, current year excluded. */
const BASE_Y0 = 2003, BASE_Y1 = 2025;
const isViirsMonth = (y: number, m: number) => y > VIIRS_START.y || (y === VIIRS_START.y && m >= VIIRS_START.m);
const isConvertedMonth = (y: number, m: number) => y > SWITCH.y || (y === SWITCH.y && m >= SWITCH.m);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const REGIONS: RegionDef[] = [
  {
    id: "med", name: "Mediterranean Basin", lat: 38, lon: 15, bbox: [30, 46, -10, 36],
    scale: 1800, peak: 7.3, width: 1.35, floor: 0.04, ext: 0.32, earlier: 0.45, trend: 0.012,
    wild: 0.62, frp: 22, color: "#ea580c",
    anomalies: [{ y: 2007, m: [6, 7], k: 1.9 }, { y: 2021, m: [6, 7], k: 2.2 }, { y: 2026, m: [6, 7, 8], k: 2.9 }],
  },
  {
    id: "cal", name: "California", lat: 37, lon: -120, bbox: [32, 42.5, -124.5, -114],
    scale: 900, peak: 8.6, width: 1.5, floor: 0.05, ext: 0.4, earlier: 0.5, trend: 0.015,
    wild: 0.85, frp: 38, color: "#dc2626",
    anomalies: [{ y: 2018, m: [7, 8, 10], k: 2.4 }, { y: 2020, m: [7, 8, 9], k: 2.9 }, { y: 2021, m: [7, 8], k: 1.8 }],
  },
  {
    id: "amz", name: "Amazon", lat: -8, lon: -60, bbox: [-18, 5, -74, -46],
    scale: 6000, peak: 8.6, width: 1.15, floor: 0.06, ext: 0.25, earlier: 0.25, trend: 0.006,
    wild: 0.35, frp: 30, color: "#f97316",
    anomalies: [{ y: 2005, m: [7, 8, 9], k: 1.9 }, { y: 2010, m: [7, 8, 9], k: 2.1 }, { y: 2019, m: [7, 8], k: 1.9 }, { y: 2024, m: [7, 8, 9], k: 2.3 }],
  },
  {
    id: "aus", name: "Australia", lat: -25, lon: 135, bbox: [-39, -10, 113, 154],
    scale: 3500, peak: 10.6, width: 1.7, floor: 0.07, ext: 0.3, earlier: 0.4, trend: 0.008,
    wild: 0.75, frp: 26, color: "#ea580c",
    anomalies: [{ y: 2019, m: [8, 9, 10, 11], k: 2.5 }, { y: 2020, m: [0], k: 2.4 }, { y: 2023, m: [9, 10], k: 1.7 }],
  },
  {
    id: "pam", name: "Argentine Pampas & Patagonia", lat: -36, lon: -64, bbox: [-42, -30, -75, -55],
    scale: 1400, peak: 8.4, width: 1.3, floor: 0.05, ext: 0.3, earlier: 0.3, trend: 0.008,
    wild: 0.4, frp: 22, color: "#f97316",
    anomalies: [{ y: 2022, m: [0, 1, 2], k: 2.2 }],
  },
  {
    id: "afr", name: "Sub-Saharan Africa", lat: 0, lon: 15, bbox: [-15, 15, -8, 38],
    scale: 9000, peak: 0.8, width: 1.6, floor: 0.08, ext: 0.2, earlier: 0.2, trend: 0.004,
    wild: 0.3, frp: 24, color: "#ea580c", anomalies: [],
  },
  {
    id: "sea", name: "Southeast Asia", lat: 10, lon: 106, bbox: [-3, 24, 95, 118],
    scale: 3000, peak: 2.8, width: 1.2, floor: 0.06, ext: 0.25, earlier: 0.3, trend: 0.006,
    wild: 0.45, frp: 20, color: "#dc2626",
    anomalies: [{ y: 2015, m: [8, 9], k: 2.4 }, { y: 2019, m: [8, 9], k: 2.0 }],
  },
];

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

/* ────────────────────────────────────────────────────────────────────────── */
/* Utilities                                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(r: () => number) {
  const u = Math.max(r(), 1e-9);
  const v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

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
const unit = (m: Metric) => (m === "count" ? "hotspots" : "MW");

/** Where a monthly value comes from (shown instead of a sensor split, which would be wrong once harmonized). */
function provenance(y: number, m: number, variant: Variant): string {
  if (variant === "harm") return isConvertedMonth(y, m) ? "VIIRS converted to MODIS-Aqua equivalent (VIGIL-K1)" : "MODIS Aqua, as observed";
  return isViirsMonth(y, m) ? "VIIRS (S-NPP, NOAA-20 on S-NPP gaps)" : "MODIS Aqua";
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Mock data generation                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

export function makeCustomRegion(lat: number, lon: number): RegionDef {
  const la = Math.round(lat * 10) / 10;
  const lo = Math.round(lon * 10) / 10;
  const id = `custom:${la},${lo}`;
  const rng = mulberry32(hashStr(id));
  const a = Math.abs(la);
  const peak = la >= 0 ? (a > 45 ? 6.9 : a > 20 ? 7.9 : 8.4) : a > 20 ? 10.6 : 8.8;
  const pm = Math.round(peak - 0.5);
  const anomalies: AnomalyDef[] = [{ y: 2010 + Math.floor(rng() * 10), m: [pm, (pm + 1) % 12], k: 1.8 + rng() * 0.6 }];
  if (rng() < 0.55) {
    anomalies.push(pm > 8 ? { y: 2025, m: [10, 11], k: 2.4 + rng() } : { y: 2026, m: [pm - 1, pm], k: 2.4 + rng() });
  }
  return {
    id, custom: true,
    name: `Custom ${fmtLat(la)} ${fmtLon(lo)}`,
    lat: la, lon: lo,
    bbox: [clamp(la - 8, -90, 90), clamp(la + 8, -90, 90), lo - 10, lo + 10],
    scale: 600 + rng() * 3000, peak, width: 1.1 + rng() * 0.6, floor: 0.04,
    ext: 0.2 + rng() * 0.2, earlier: 0.2 + rng() * 0.3, trend: 0.004 + rng() * 0.01,
    wild: 0.4 + rng() * 0.4, frp: 18 + rng() * 20, anomalies, color: "#dc2626",
  };
}

/* ── Pillar 6 contract → monthly cells ───────────────────────────────────── */

const CONTRACT = contractData as unknown as ContractRow[];
const WILD_BY_LC: Record<ContractRow["land_cover_class"], number> = { forest: 0.85, shrub_grass: 0.85, cropland: 0.15, other: 0.5 };

/** Month index (0-11) and year of the Thursday of an ISO week (ISO year / month attribution). */
function isoWeekMonth(isoYear: number, isoWeek: number): { y: number; m: number } {
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const dow = jan4.getUTCDay() || 7;
  const thu = new Date(Date.UTC(isoYear, 0, 4 + (isoWeek - 1) * 7 + (4 - dow)));
  return { y: thu.getUTCFullYear(), m: thu.getUTCMonth() };
}

let CONTRACT_END: { y: number; m: number } | null = null;
function contractEnd() {
  if (CONTRACT_END) return CONTRACT_END;
  let best = { y: 0, m: 0 };
  for (const r of CONTRACT) {
    const k = isoWeekMonth(r.iso_year, r.iso_week);
    if (k.y > best.y || (k.y === best.y && k.m > best.m)) best = k;
  }
  return (CONTRACT_END = best);
}

/** Area and period covered by data/data.json (cells are CELL_DEG wide, lat/lon = cell centre). */
interface Coverage { la0: number; la1: number; lo0: number; lo1: number; first: { y: number; m: number }; last: { y: number; m: number } }
let COVERAGE: Coverage | null = null;
function cellDeg(): number {
  const lats = Array.from(new Set(CONTRACT.map((c) => c.lat))).sort((a, b) => a - b);
  let gap = Infinity;
  for (let i = 1; i < lats.length; i++) gap = Math.min(gap, lats[i] - lats[i - 1]);
  return Number.isFinite(gap) && gap > 0 ? Math.round(gap * 1000) / 1000 : 0.25;
}
const CELL_DEG = cellDeg();
function coverage(): Coverage | null {
  if (COVERAGE || !CONTRACT.length) return COVERAGE;
  const h = CELL_DEG / 2;
  let la0 = 90, la1 = -90, lo0 = 180, lo1 = -180, first = { y: 9999, m: 0 };
  for (const c of CONTRACT) {
    la0 = Math.min(la0, c.lat - h); la1 = Math.max(la1, c.lat + h);
    lo0 = Math.min(lo0, c.lon - h); lo1 = Math.max(lo1, c.lon + h);
    const k = isoWeekMonth(c.iso_year, c.iso_week);
    if (k.y < first.y || (k.y === first.y && k.m < first.m)) first = k;
  }
  return (COVERAGE = { la0, la1, lo0, lo1, first, last: contractEnd() });
}
/** True when the bbox [la0, la1, lo0, lo1] overlaps the area covered by data.json. */
export function overlapsCoverage(b: [number, number, number, number]): boolean {
  const cv = coverage();
  return !!cv && b[0] < cv.la1 && b[1] > cv.la0 && b[2] < cv.lo1 && b[3] > cv.lo0;
}
/** True when the bbox lies entirely inside the area covered by data.json. */
export function insideCoverage(b: [number, number, number, number]): boolean {
  const cv = coverage();
  const t = CELL_DEG / 2; // half a cell of tolerance: a country box that ends inside the edge cells is covered
  return !!cv && b[0] >= cv.la0 - t && b[1] <= cv.la1 + t && b[2] >= cv.lo0 - t && b[3] <= cv.lo1 + t;
}

/** Rows of data.json whose cell centre is inside the region (bbox, then drawn polygon if any). */
function contractRows(bbox: [number, number, number, number] | null, ring?: Ring): ContractRow[] {
  if (!bbox) return CONTRACT;
  const [la0, la1, lo0, lo1] = bbox;
  return CONTRACT.filter((c) => c.lat >= la0 && c.lat <= la1 && c.lon >= lo0 && c.lon <= lo1 && (!ring || pip(c.lon, c.lat, ring)));
}

/**
 * Monthly cells of a region, from data/data.json only.
 * - Region outside the covered area: every month is null ("no data"), never a synthetic series.
 * - Inside: months of the covered period are summed over the cells in the region; a month without
 *   a row is a real 0 (the export only writes cell-months with at least one detection).
 */
function regionData(r: RegionDef, ring?: Ring): (Cell | null)[][] {
  const cv = coverage();
  const empty = () => Array.from({ length: NY }, () => Array.from({ length: 12 }, (): Cell | null => null));
  if (!cv || !overlapsCoverage(r.bbox)) return empty();
  const acc = Array.from({ length: NY }, () =>
    Array.from({ length: 12 }, () => ({ modis: 0, viirs: 0, harm: 0, wild: 0 })));
  for (const c of contractRows(r.bbox, ring)) {
    const k = isoWeekMonth(c.iso_year, c.iso_week);
    if (k.y < Y0 || k.y > Y1) continue;
    const a = acc[k.y - Y0][k.m];
    a.modis += c.modis_fire_days ?? 0;
    a.viirs += c.viirs_fire_days ?? 0;
    a.harm += c.harmonized_fire_days;
    a.wild += c.harmonized_fire_days * WILD_BY_LC[c.land_cover_class];
  }
  const { first, last } = cv;
  return acc.map((row, yi) =>
    row.map((a, m): Cell | null => {
      const y = Y0 + yi;
      if (y < first.y || (y === first.y && m < first.m) || y > last.y || (y === last.y && m > last.m)) return null;
      const hasV = isViirsMonth(y, m);
      return {
        y, m, modis: a.modis, viirs: a.viirs,
        // FRP is not in data.json: never shown from it (the real harmonized FRP comes with the v2 data files).
        mFrp: 0, vFrp: 0,
        mEff: 1, hasV, wild: a.harm > 0 ? a.wild / a.harm : r.wild, harm: a.harm,
      };
    }));
}

/** Value of a cell for a given harmonization variant / metric / fire-type filter. */
/**
 * Value of a month for a data series.
 * - harm: the backend's harmonized count (MODIS-Aqua equivalent, VIGIL-K1) — no conversion in the browser.
 * - raw: the record as each era saw it, ONE sensor at a time (MODIS Aqua before Feb 2012, VIIRS after):
 *   adding MODIS + VIIRS would count the same fires twice.
 */
export function cellStats(c: Cell, variant: Variant, metric: Metric, type: FireType): CellVal {
  const m = metric === "count" ? c.modis : c.mFrp;
  const v = metric === "count" ? c.viirs : c.vFrp;
  const f = type === "all" ? 1 : type === "wild" ? c.wild : 1 - c.wild;
  const total = variant === "harm" ? (metric === "count" ? c.harm ?? m : 0) : c.hasV ? v : m;
  return { total: total * f, modis: m * f, viirs: v * f };
}

function monthlyValues(data: (Cell | null)[][], variant: Variant, metric: Metric, type: FireType): (CellVal | null)[][] {
  return data.map((row) => row.map((c) => (c ? cellStats(c, variant, metric, type) : null)));
}

interface AnnualPt {
  value: number | null;
  est: boolean;
}
function annualSeries(vals: (CellVal | null)[][]): AnnualPt[] {
  const sums = vals.map((r) => r.reduce((a, c) => a + (c ? c.total : 0), 0));
  const isFull = vals.map((r) => r.every((c) => c !== null));
  return vals.map((row, yi) => {
    if (isFull[yi]) return { value: sums[yi], est: false };
    const obsMonths = row.map((c, m) => (c ? m : -1)).filter((m) => m >= 0);
    const ratios: number[] = [];
    vals.forEach((r2, yj) => {
      if (!isFull[yj] || sums[yj] <= 0) return;
      ratios.push(obsMonths.reduce((a, m) => a + (r2[m] as CellVal).total, 0) / sums[yj]);
    });
    const frac = ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : 0;
    if (frac < 0.2) return { value: null, est: true };
    return { value: sums[yi] / frac, est: true };
  });
}

/* ── Comparison with the historical median (E7) ──────────────────────────── */

/** Hyndman & Fan (1996) type-8 quantile (median-unbiased, as in the backend method), xs sorted ascending. */
function quantile8(xs: number[], p: number): number {
  const n = xs.length;
  if (!n) return NaN;
  const h = (n + 1 / 3) * p + 1 / 3; // 1-based position
  const j = Math.floor(h), g = h - j;
  if (j < 1) return xs[0];
  if (j >= n) return xs[n - 1];
  return xs[j - 1] + g * (xs[j] - xs[j - 1]);
}

const CLASSES5 = ["much below normal", "below normal", "near normal", "above normal", "much above normal"] as const;

export interface MedianCompare {
  y: number; m: number; value: number; median: number; p10: number; p90: number;
  pctMedian: number | null; rank: number; nYears: number; percentile: number; cls: number;
}

/**
 * A month against the same calendar month of the reference years (BASE_Y0..BASE_Y1, the month's own year
 * excluded): median, P10/P90, % of median, rank (1 = most active), mid-rank percentile, 5-level class
 * (< P10 | P10-P33 | P33-P67 | P67-P90 | > P90). Computed on the series given (use the harmonized one).
 */
export function compareToMedian(vals: (CellVal | null)[][], y: number, m: number): MedianCompare | null {
  const cur = vals[y - Y0]?.[m];
  if (!cur) return null;
  const base: number[] = [];
  for (let by = BASE_Y0; by <= BASE_Y1; by++) {
    if (by === y) continue;
    const c = vals[by - Y0]?.[m];
    if (c) base.push(c.total);
  }
  if (base.length < 10) return null;
  base.sort((a, b) => a - b);
  const x = cur.total, q = (p: number) => quantile8(base, p);
  const median = q(0.5), p10 = q(0.1), p33 = q(1 / 3), p67 = q(2 / 3), p90 = q(0.9);
  const below = base.filter((v) => v < x).length, equal = base.filter((v) => v === x).length;
  const cls = x < p10 ? 0 : x < p33 ? 1 : x <= p67 ? 2 : x <= p90 ? 3 : 4;
  return {
    y, m, value: x, median, p10, p90, pctMedian: median > 0 ? (100 * x) / median : null,
    rank: 1 + base.filter((v) => v > x).length, nYears: base.length + 1,
    percentile: (100 * (below + 0.5 * equal)) / base.length, cls,
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Map points: one per data.json cell                                         */
/* ────────────────────────────────────────────────────────────────────────── */

interface HotFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  /** n = value shown (raw: MODIS + VIIRS, harmonized: harmonized count), same rule as the calendar. */
  properties: { n: number; modis: number; viirs: number; harm: number; cell: string; period: string };
}
type HotCollection = { type: "FeatureCollection"; features: HotFeature[] };

/* ────────────────────────────────────────────────────────────────────────── */
/* Geometry helpers                                                           */
/* ────────────────────────────────────────────────────────────────────────── */

const rectRing = (b: [number, number, number, number]): Ring => {
  const [la0, la1, lo0, lo1] = b;
  return [[lo0, la0], [lo1, la0], [lo1, la1], [lo0, la1], [lo0, la0]];
};
function pip(x: number, y: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function regionFromRing(ring: Ring): RegionDef {
  const lons = ring.map((p) => p[0]), lats = ring.map((p) => p[1]);
  const lonMin = Math.min(...lons), lonMax = Math.max(...lons), latMin = Math.min(...lats), latMax = Math.max(...lats);
  const base = makeCustomRegion((latMin + latMax) / 2, (lonMin + lonMax) / 2);
  const area = (latMax - latMin) * (lonMax - lonMin);
  return {
    ...base, name: "Custom Selection", bbox: [latMin, latMax, lonMin, lonMax],
    scale: base.scale * clamp(Math.sqrt(area / 320), 0.4, 3),
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Points and CSV export, both from data/data.json                            */
/* ────────────────────────────────────────────────────────────────────────── */

const MORPH_MS = 1100; // globe <-> plan animation
const monthKey = (y: number, m: number) => y * 12 + m;
const ym = (k: number) => `${Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, "0")}`;

/**
 * Map points for a month range: one point per data.json cell (at the cell centre, data.json has no
 * finer position), carrying the cell's hotspot count over the range. Summing n over the points gives
 * exactly the calendar total for the same region, period and mode.
 */
function contractPoints(bbox: [number, number, number, number] | null, ring: Ring | undefined, kLo: number, kHi: number, variant: Variant): HotCollection {
  const acc = new Map<string, { lat: number; lon: number; modis: number; viirs: number; harm: number; raw: number }>();
  for (const c of contractRows(bbox, ring)) {
    const k = isoWeekMonth(c.iso_year, c.iso_week);
    const key = monthKey(k.y, k.m);
    if (key < kLo || key > kHi) continue;
    let a = acc.get(c.cell_id);
    if (!a) acc.set(c.cell_id, (a = { lat: c.lat, lon: c.lon, modis: 0, viirs: 0, harm: 0, raw: 0 }));
    a.modis += c.modis_fire_days ?? 0;
    a.viirs += c.viirs_fire_days ?? 0;
    a.harm += c.harmonized_fire_days;
    // raw record = one sensor per era (same rule as cellStats): never MODIS + VIIRS added together
    a.raw += isViirsMonth(k.y, k.m) ? c.viirs_fire_days ?? 0 : c.modis_fire_days ?? 0;
  }
  const period = kLo === kHi ? ym(kLo) : `${ym(kLo)} → ${ym(kHi)}`;
  const features: HotFeature[] = [];
  for (const [cell, a] of acc) {
    const n = variant === "raw" ? a.raw : a.harm;
    if (n <= 0) continue;
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [a.lon, a.lat] },
      properties: { n: Math.round(n * 100) / 100, modis: a.modis, viirs: a.viirs, harm: Math.round(a.harm * 100) / 100, cell, period },
    });
  }
  return { type: "FeatureCollection", features };
}

/** CSV rows of data.json for the selection and study period (one row per cell x month). */
function exportRows(sel: { region: RegionDef; ring: Ring }, range: DateRange): string[] {
  const kLo = monthKey(range.from.y, range.from.m), kHi = monthKey(range.to.y, range.to.m);
  const out: string[] = [];
  for (const c of contractRows(sel.region.bbox, sel.ring)) {
    const k = isoWeekMonth(c.iso_year, c.iso_week);
    const key = monthKey(k.y, k.m);
    if (key < kLo || key > kHi) continue;
    out.push([c.cell_id, c.lat, c.lon, ym(key), c.modis_fire_days ?? "", c.viirs_fire_days ?? "",
      c.harmonized_fire_days, c.harmonized_low, c.harmonized_high, c.source].join(","));
  }
  return out.sort();
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

const HEAT_STOPS: [number, [number, number, number]][] = [
  [0, [254, 243, 199]], [0.25, [252, 211, 77]], [0.5, [251, 146, 60]], [0.72, [234, 88, 12]], [0.88, [220, 38, 38]], [1, [127, 29, 29]],
];
/**
 * Absolute calendar scale, shared by every region: the 98th percentile of monthly totals over all
 * preset regions (per data series). A cell is dark when the month is strong in absolute terms,
 * not just relative to its own region.
 */
const HEAT_REF: Partial<Record<Variant, number>> = {};
function absoluteHeatMax(variant: Variant): number {
  const cached = HEAT_REF[variant];
  if (cached) return cached;
  const all: number[] = [];
  for (const r of REGIONS) {
    for (const row of monthlyValues(regionData(r), variant, "count", "all")) for (const c of row) if (c) all.push(c.total);
  }
  all.sort((a, b) => a - b);
  return (HEAT_REF[variant] = all.length ? all[Math.floor(all.length * 0.98)] || 1 : 1);
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
/** Diverging blue → white → red scale of the "warming stripes" (ColorBrewer RdBu, 9 classes). */
const STRIPE_STOPS: [number, number, number][] = [
  [8, 48, 107], [33, 102, 172], [67, 147, 195], [146, 197, 222], [247, 247, 247],
  [253, 219, 199], [244, 165, 130], [214, 96, 77], [178, 24, 43], [103, 0, 13],
];
/** t in [-1, 1]: -1 = far fewer fires than the region's average year, +1 = far more. */
function stripeColor(t: number): string {
  const x = ((clamp(t, -1, 1) + 1) / 2) * (STRIPE_STOPS.length - 1);
  const i = Math.min(Math.floor(x), STRIPE_STOPS.length - 2), f = x - i;
  const [a, b] = [STRIPE_STOPS[i], STRIPE_STOPS[i + 1]];
  return `rgb(${a.map((c, k) => Math.round(c + (b[k] - c) * f)).join(",")})`;
}
/**
 * One colour per year from the annual fire totals of the region: centred on the mean year,
 * scaled by the largest deviation, so the palest stripe is a typical year and the darkest
 * red / blue are the most / least active years. Years without data stay null (grey).
 */
function stripeColors(annual: AnnualPt[]): (string | null)[] {
  const vs = annual.map((p) => p.value).filter((v): v is number => v !== null);
  if (!vs.length) return annual.map(() => null);
  const mean = vs.reduce((a, b) => a + b, 0) / vs.length;
  const dev = Math.max(...vs.map((v) => Math.abs(v - mean))) || 1;
  return annual.map((p) => (p.value === null ? null : stripeColor((p.value - mean) / dev)));
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

interface RegionCardProps {
  selection: { region: RegionDef; ring: Ring; wasPolygon: boolean };
  name: string;
  onRename: (name: string) => void;
  range: DateRange;
  onRangeChange: (r: DateRange) => void;
  onApplyBbox: (bbox: [number, number, number, number], name: string) => void;
}

function RegionCard({ selection, name, onRename, range, onRangeChange, onApplyBbox }: RegionCardProps) {
  const { region, wasPolygon } = selection;

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

  /* ── Bbox inputs (lon max, lat max, size in km) ── */
  const [latMax, setLatMax] = useState(region.bbox[1].toFixed(2));
  const [lonMax, setLonMax] = useState(region.bbox[3].toFixed(2));
  const [sizeKm, setSizeKm] = useState(bboxToSizeKm(region.bbox).toFixed(1));
  const [bboxErr, setBboxErr] = useState({ latMax: "", lonMax: "", sizeKm: "" });

  useEffect(() => {
    setLatMax(region.bbox[1].toFixed(2));
    setLonMax(region.bbox[3].toFixed(2));
    setSizeKm(bboxToSizeKm(region.bbox).toFixed(1));
    setBboxErr({ latMax: "", lonMax: "", sizeKm: "" });
  }, [region.bbox]);

  const validateAndApplyBbox = () => {
    const lat1 = parseFloat(latMax), lon1 = parseFloat(lonMax), sz = parseFloat(sizeKm);
    const e = { latMax: "", lonMax: "", sizeKm: "" };
    if (isNaN(lat1) || lat1 < -90 || lat1 > 90) e.latMax = "Must be −90 to 90";
    if (isNaN(lon1) || lon1 < -180 || lon1 > 180) e.lonMax = "Must be −180 to 180";
    if (isNaN(sz) || sz <= 0 || sz > 20000) e.sizeKm = "Must be 1–20 000";
    setBboxErr(e);
    if (!e.latMax && !e.lonMax && !e.sizeKm) {
      const latSpan = sz / 111.32;
      const lonSpan = sz / (111.32 * Math.cos(lat1 * Math.PI / 180));
      const lat0 = Math.max(-90, lat1 - latSpan);
      const lon0 = lon1 - lonSpan;
      onApplyBbox([lat0, lat1, lon0, lon1], name);
    }
  };

  const hasErr = Object.values(bboxErr).some(Boolean);

  /* ── Date range ── */
  const toMonthStr = (y: number, m: number) => `${y}-${String(m + 1).padStart(2, "0")}`;
  const [rangeErr, setRangeErr] = useState("");

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const YEARS = Array.from({ length: LATEST.y - Y0 + 1 }, (_, i) => Y0 + i);
  const key = (d: { y: number; m: number }) => d.y * 12 + d.m;
  const minKey = key({ y: Y0, m: FIRST_MONTH_Y0 }), maxKey = key(LATEST);
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
    const rows = exportRows(selection, range);
    if (!rows.length) {
      setExportErr("No data.json hotspots in this area and period.");
      return;
    }
    const safeName = name.replace(/[^a-z0-9]/gi, "_");
    const fromStr = toMonthStr(range.from.y, range.from.m);
    const toStr = toMonthStr(range.to.y, range.to.m);
    const header = "cell_id,lat,lon,month,modis_hotspots,viirs_hotspots,harmonized_hotspots,harmonized_low,harmonized_high,source\n";
    const blob = new Blob([header + rows.join("\n") + "\n"], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `vigil_${safeName}_${fromStr}_${toStr}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="hd-region-card">
      {/* 1. Title + Rename */}
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

      {/* 2. Coordinates */}
      <div className="hd-rc-section">
        <div className="hd-rc-seclabel">Coordinates</div>
        {wasPolygon && (
          <p className="hd-rc-note">Editing coordinates converts the polygon to a rectangle</p>
        )}
        <div className="hd-rc-grid3">
          {([
            { id: "lonMax", label: "Lon max", val: lonMax, onChange: setLonMax, err: bboxErr.lonMax, step: "0.01" },
            { id: "latMax", label: "Lat max", val: latMax, onChange: setLatMax, err: bboxErr.latMax, step: "0.01" },
            { id: "sizeKm", label: "Size (km)", val: sizeKm, onChange: setSizeKm, err: bboxErr.sizeKm, step: "1" },
          ] as Array<{ id: string; label: string; val: string; onChange: (v: string) => void; err: string; step: string }>).map(({ id, label, val, onChange, err, step }) => (
            <div key={id} className="hd-rc-field">
              <label htmlFor={`hd-bbox-${id}`} className="hd-rc-fieldlabel">{label}</label>
              <input
                id={`hd-bbox-${id}`}
                type="number"
                step={step}
                className={"hd-rc-fieldinput" + (err ? " err" : "")}
                value={val}
                aria-describedby={err ? `hd-bbox-${id}-err` : undefined}
                onChange={(e) => onChange(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && validateAndApplyBbox()}
              />
              {err && <span id={`hd-bbox-${id}-err`} role="alert" className="hd-rc-fielderr">{err}</span>}
            </div>
          ))}
        </div>
        <button
          className="hd-rc-apply"
          aria-label="Apply coordinate changes to map"
          disabled={hasErr}
          onClick={validateAndApplyBbox}
        >
          Apply
        </button>
      </div>

      {/* 3. Study period */}
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

      {/* 4. Export CSV */}
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
type Tool = "none" | "box" | "poly";

const LATEST = { y: Y1, m: LAST_MONTH_Y1 };
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
  const [mode, setMode] = useState<Variant>("raw");
  const metric: Metric = "count";
  const [selection, setSelection] = useState<Selection | null>(null);
  const [selectionName, setSelectionName] = useState("");
  const [selRange, setSelRange] = useState<DateRange>({
    from: { y: Y0, m: FIRST_MONTH_Y0 },
    to: { y: LATEST.y, m: LATEST.m },
  });
  const [panelOpen, setPanelOpen] = useState(true);
  const [split, setSplit] = useState(false);
  const [panelLeftOpen, setPanelLeftOpen] = useState(true);
  const [tool, setTool] = useState<Tool>("none");
  const [polyN, setPolyN] = useState(0);
  const [date, setDate] = useState(LATEST);
  const [ready, setReady] = useState(false);
  const [tip, setTip] = useState<{ x: number; y: number; yi: number; m: number } | null>(null);
  const [hoverYear, setHoverYear] = useState<number | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [flat, setFlat] = useState(false);
  const flatRef = useRef(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const hotRef = useRef<HotCollection>({ type: "FeatureCollection", features: [] });
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
  toolRef.current = tool;
  panelOpenRef.current = panelOpen;

  /* ── Derived data ── */
  const region = selection?.region ?? REGIONS[0];
  const data = useMemo(() => regionData(region, selection?.ring), [region, selection]);
  const rawVals = useMemo(() => monthlyValues(data, "raw", metric, "all"), [data, metric]);
  const harmVals = useMemo(() => monthlyValues(data, "harm", metric, "all"), [data, metric]);
  const vals = mode === "raw" ? rawVals : harmVals;
  const rawAnnual = useMemo(() => annualSeries(rawVals), [rawVals]);
  const harmAnnual = useMemo(() => annualSeries(harmVals), [harmVals]);
  const heatMax = useMemo(() => absoluteHeatMax(mode), [mode]);
  const annual = mode === "raw" ? rawAnnual : harmAnnual;
  const stripes = useMemo(() => stripeColors(annual), [annual]);

  const deferredRange = useDeferredValue(selRange); // keep the date selects responsive while points rebuild
  // With a selection, the Region card's study period drives the map; otherwise the single-month slider does.
  const hotspots = useMemo(() => {
    if (selection) {
      return contractPoints(selection.region.bbox, selection.ring,
        monthKey(deferredRange.from.y, deferredRange.from.m), monthKey(deferredRange.to.y, deferredRange.to.m), mode);
    }
    return contractPoints(null, undefined, monthKey(date.y, date.m), monthKey(date.y, date.m), mode);
  }, [selection, deferredRange, date, mode]);
  const pointTotal = useMemo(() => hotspots.features.reduce((a, f) => a + f.properties.n, 0), [hotspots]);
  const covered = selection ? overlapsCoverage(selection.region.bbox) : true;
  const fullyCovered = selection ? insideCoverage(selection.region.bbox) : true;
  const cov = coverage();
  const covText = cov ? `data.json covers ${fmtLat(cov.la0)}–${fmtLat(cov.la1)}, ${fmtLon(cov.lo0)}–${fmtLon(cov.lo1)}` : "data.json is empty";
  const coverageNote = !covered
    ? `No data for this area: ${covText}.`
    : !fullyCovered ? `Partial coverage: only the part inside data.json is counted (${covText}).` : "";

  /* ── Map: push GeoJSON into sources ── */
  const pushSources = useCallback(() => {
    const m = mapRef.current;
    if (!m) return;
    (m.getSource("hotspots") as GeoJSONSource | undefined)?.setData(hotRef.current as never);
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
    setSelection({ region, ring, wasPolygon });
    setSelectionName(name ?? region.name);
    if (resetRange) setSelRange({ from: { y: Y0, m: FIRST_MONTH_Y0 }, to: { y: LATEST.y, m: LATEST.m } });
    setPanelOpen(true);
    panelOpenRef.current = true;
    selFcRef.current = { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } }] };
    setDraft(EMPTY_FC);
    fitTo(region.bbox);
  }, [fitTo, setDraft]);

  const handleApplyBbox = useCallback((bbox: [number, number, number, number], currentName: string) => {
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
        container: containerRef.current, style: SAT_STYLE, center: [12, 24], zoom: 2.1, maxPitch: 75,
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
        if (!map.getSource("hotspots")) {
          map.addSource("hotspots", { type: "geojson", data: hotRef.current as never });
          map.addSource("sel", { type: "geojson", data: selFcRef.current as never });
          map.addSource("draft", { type: "geojson", data: draftRef.current as never });
          map.addLayer({ id: "sel-fill", type: "fill", source: "sel", paint: { "fill-color": "#dc2626", "fill-opacity": 0.07 } });
          map.addLayer({ id: "sel-line", type: "line", source: "sel", paint: { "line-color": "#dc2626", "line-width": 2 } });
          map.addLayer({
            id: "hotspots", type: "circle", source: "hotspots",
            paint: {
              "circle-radius": ["interpolate", ["linear"], ["zoom"],
                2, ["interpolate", ["linear"], ["sqrt", ["get", "n"]], 0, 1.5, 30, 8],
                8, ["interpolate", ["linear"], ["sqrt", ["get", "n"]], 0, 3, 30, 20]],
              "circle-color": ["step", ["get", "n"], "#fbbf24", 5, "#f97316", 20, "#ea580c", 100, "#dc2626"],
              "circle-opacity": 0.85, "circle-stroke-color": "#ffffff", "circle-stroke-width": 0.5, "circle-stroke-opacity": 0.8,
            },
          });
          map.addLayer({ id: "draft-fill", type: "fill", source: "draft", filter: ["==", ["geometry-type"], "Polygon"], paint: { "fill-color": "#0f172a", "fill-opacity": 0.08 } });
          map.addLayer({ id: "draft-line", type: "line", source: "draft", filter: ["any", ["==", ["geometry-type"], "Polygon"], ["==", ["geometry-type"], "LineString"]], paint: { "line-color": "#0f172a", "line-width": 2, "line-dasharray": [2, 2] } });
          map.addLayer({ id: "draft-pts", type: "circle", source: "draft", filter: ["==", ["geometry-type"], "Point"], paint: { "circle-radius": 4.5, "circle-color": "#ffffff", "circle-stroke-color": "#0f172a", "circle-stroke-width": 2 } });
        }
      };
      map.on("style.load", install);
      map.on("load", () => {
        install(); pushSources(); loadedRef.current = true; setReady(true);
        if (pendingFit.current) { const b = pendingFit.current; pendingFit.current = null; setTimeout(() => fitRef.current(b), 50); }
      });

      // Hotspot popup
      map.on("mouseenter", "hotspots", () => { if (map && toolRef.current === "none") map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", "hotspots", () => { if (map && toolRef.current === "none") map.getCanvas().style.cursor = ""; });
      map.on("click", "hotspots", (e: MapLayerMouseEvent) => {
        if (toolRef.current !== "none" || !map || !e.features?.length) return;
        const f = e.features[0];
        const p = f.properties as { modis: number; viirs: number; harm: number; cell: string; period: string };
        const [lng, lat] = (f.geometry as unknown as { coordinates: [number, number] }).coordinates;
        const num = (v: unknown) => fmtInt(Number(v) || 0);
        const esc = (v: unknown) => String(v).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
        new maplibregl.Popup({ closeButton: false, offset: 8, className: "hd-popup" })
          .setLngLat([lng, lat])
          .setHTML(`<table><tr><td>Harmonized</td><td>${Number(p.harm).toFixed(1)} hotspots</td></tr><tr><td>MODIS</td><td>${num(p.modis)}</td></tr><tr><td>VIIRS</td><td>${num(p.viirs)}</td></tr><tr><td>Period</td><td>${esc(p.period)}</td></tr><tr><td>Cell</td><td>${CELL_DEG}° · ${lat.toFixed(3)}, ${lng.toFixed(3)}</td></tr></table>`)
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
  useEffect(() => { hotRef.current = hotspots; pushSources(); }, [hotspots, ready, pushSources]);
  useEffect(() => { pushSources(); }, [selection, ready, pushSources]);

  const stepDate = (d: number) => {
    let i = date.y * 12 + date.m + d;
    const min = Y0 * 12 + FIRST_MONTH_Y0, max = Y1 * 12 + LAST_MONTH_Y1;
    i = clamp(i, min, max);
    setDate({ y: Math.floor(i / 12), m: i % 12 });
  };

  /* ── Trend chart geometry ── */
  const W = 340, H = 112, ml = 30, mr = 4, mt = 6, mb = 16;
  const pw = W - ml - mr, ph = H - mt - mb;
  const seriesMax = Math.max(...rawAnnual.map((p) => p.value ?? 0), ...harmAnnual.map((p) => p.value ?? 0), 1);
  const ticks = niceTicks(seriesMax * 1.05);
  const yMax = ticks[ticks.length - 1];
  const xAt = (i: number) => ml + (i / (NY - 1)) * pw;
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
  const rawLine = rawAnnual.map((p) => p.value);
  const harmLine = harmAnnual.map((p) => p.value);
  const onChartMove = (e: React.MouseEvent<SVGRectElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setHoverYear(clamp(Math.round(((e.clientX - r.left) / r.width) * (NY - 1)), 0, NY - 1));
  };

  /* ── Heatmap tooltip data ── */
  const tipCell = tip ? data[tip.yi][tip.m] : null;
  const tipStats = tipCell ? { count: cellStats(tipCell, mode, "count", "all") } : null;

  /* ── E7: focus month vs the historical median (always on the harmonized series, the only comparable one) ── */
  const focus = selection && monthKey(selRange.from.y, selRange.from.m) === monthKey(selRange.to.y, selRange.to.m) ? selRange.from : LATEST;
  const med = useMemo(() => compareToMedian(harmVals, focus.y, focus.m), [harmVals, focus.y, focus.m]);
  const CLASS_COLORS = ["#2166ac", "#92c5de", "#f7f7f7", "#f4a582", "#b2182b"]; // RdBu, colour-blind safe

  /* ── E8: download the calendar as a PNG image ── */
  const downloadCalendarPng = () => {
    const cw = 22, ch = 13, left = 44, top = 46, rows = vals.length;
    const cv = document.createElement("canvas");
    cv.width = left + 12 * cw + 16; cv.height = top + rows * ch + 40;
    const g = cv.getContext("2d");
    if (!g) return;
    g.fillStyle = "#ffffff"; g.fillRect(0, 0, cv.width, cv.height);
    g.fillStyle = "#0f172a"; g.font = "bold 13px sans-serif";
    g.fillText(`Vigil · ${selectionName} · ${mode === "harm" ? "harmonized hotspots (MODIS-Aqua equivalent)" : "raw hotspots"}`, 8, 18);
    g.font = "10px sans-serif"; g.fillStyle = "#64748b";
    g.fillText("NASA FIRMS MODIS & VIIRS · VIGIL-K1 · hotspots per month", 8, 32);
    MONTHS.forEach((mn, i) => g.fillText(mn[0], left + i * cw + 8, top - 4));
    vals.forEach((row, yi) => {
      g.fillStyle = "#64748b";
      g.fillText(String(Y0 + yi), 6, top + yi * ch + 10);
      row.forEach((c, mi) => {
        g.fillStyle = !c ? "#e2e8f0" : c.total < heatMax * 0.015 ? "#e8edf3" : heatColor(Math.pow(c.total / heatMax, 0.62));
        g.fillRect(left + mi * cw, top + yi * ch, cw - 1, ch - 1);
      });
    });
    g.fillStyle = "#64748b";
    g.fillText(`Scale: 0 → ≥ ${fmtInt(Math.round(heatMax))} hotspots / month (same for every region). Grey = no data.`, 8, top + rows * ch + 18);
    const a = document.createElement("a");
    a.href = cv.toDataURL("image/png");
    a.download = `vigil_${selectionName.replace(/[^a-z0-9]/gi, "_")}_calendar_${mode}.png`;
    a.click();
  };

  /* ── Calendar (year × month heatmap), shared by the panel and the split view ── */
  const renderCalendar = (large: boolean) => (
    <div className={"hd-heat" + (large ? " lg" : "")} onMouseLeave={() => setTip(null)}>
      <div />
      {MONTHS.map((m) => <div key={m} className="hd-heat-col">{m[0]}</div>)}
      {vals.map((row, yi) => (
        <React.Fragment key={yi}>
          <div className="hd-heat-row">{large || yi % 2 === 0 ? Y0 + yi : ""}</div>
          {row.map((c, m) => {
            const bg = !c ? undefined : c.total < heatMax * 0.015 ? "#e8edf3" : heatColor(Math.pow(c.total / heatMax, 0.62));
            const k = (Y0 + yi) * 12 + m;
            const inRange = k >= selRange.from.y * 12 + selRange.from.m && k <= selRange.to.y * 12 + selRange.to.m;
            const sel = selection ? inRange && selRange.from.y * 12 + selRange.from.m === selRange.to.y * 12 + selRange.to.m : date.y === Y0 + yi && date.m === m;
            return (
              <div
                key={m}
                className={"hd-cell" + (c ? "" : " empty") + (sel ? " sel" : "") + (selection && !inRange ? " out" : "")}
                style={{ background: bg }}
                onMouseMove={(e) => setTip({ x: e.clientX, y: e.clientY, yi, m })}
                onClick={(e) => {
                  if (!c) return;
                  if (!selection) { setDate({ y: Y0 + yi, m }); return; }
                  // With a selection the calendar edits the study period: click = that month, shift+click = extend.
                  const cur = { y: Y0 + yi, m };
                  if (e.shiftKey) {
                    const a = selRange.from, lo = k < a.y * 12 + a.m;
                    setSelRange(lo ? { from: cur, to: selRange.to } : { from: selRange.from, to: cur });
                  } else setSelRange({ from: cur, to: cur });
                }}
                aria-label={c ? `${MONTHS[m]} ${Y0 + yi}: ${fmtInt(c.total)} ${unit(metric)}` : `${MONTHS[m]} ${Y0 + yi}: no data`}
              />
            );
          })}
        </React.Fragment>
      ))}
      <div className="hd-heat-legend">
        <span>0</span><i />
        <span>{covered ? `≥ ${fmtInt(Math.round(heatMax))} hotspots / month · same scale for every region` : "No data.json coverage for this area"}</span>
      </div>
    </div>
  );

  const bb = region.bbox;
  const sgn = (v: number) => (v >= 0 ? "+" : "−");
  void bb; void sgn;

  /* ── Country search ── */
  const searchMatches = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [] as typeof COUNTRIES;
    return COUNTRIES.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 8);
  }, [searchQuery]);

  const selectCountry = useCallback((c: { name: string; bbox: [number, number, number, number] }) => {
    const ring = rectRing(c.bbox);
    applySelection(regionFromRing(ring), ring, c.name, false);
    setSearchOpen(false);
    setSearchQuery("");
  }, [applySelection]);

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  useEffect(() => {
    if (!searchOpen) return;
    const handler = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setSearchOpen(false);
        setSearchQuery("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [searchOpen]);

  return (
    <div className="hd-root">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div ref={containerRef} className="hd-map" />

      {/* Toolbar */}
      <div className="hd-toolbar">
        <span className="hd-word">Vigil</span>

        {/* Country search */}
        <div className="hd-search" ref={searchRef}>
          {!searchOpen ? (
            <button className="hd-search-toggle" onClick={() => setSearchOpen(true)} aria-label="Search country">
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <circle cx="6" cy="6" r="4.5" />
                <line x1="9.5" y1="9.5" x2="13" y2="13" />
              </svg>
            </button>
          ) : (
            <>
              <div className="hd-search-inner">
                <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                  <circle cx="6" cy="6" r="4.5" /><line x1="9.5" y1="9.5" x2="13" y2="13" />
                </svg>
                <input
                  ref={searchInputRef}
                  className="hd-search-input"
                  placeholder="Search country…"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Escape") { setSearchOpen(false); setSearchQuery(""); } }}
                />
                {searchQuery && (
                  <button className="hd-search-clear" onClick={() => setSearchQuery("")} aria-label="Clear">×</button>
                )}
              </div>
              {searchMatches.length > 0 && (
                <div className="hd-search-dropdown">
                  {searchMatches.map((c) => (
                    <button key={c.name} className="hd-search-result" onClick={() => selectCountry(c)}>
                      {c.name}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <div className="hd-group">
          <button className={"hd-btn" + (tool === "box" ? " on" : "")} onClick={() => pickTool("box")}>Box</button>
          <button className={"hd-btn" + (tool === "poly" ? " on" : "")} onClick={() => pickTool("poly")}>Polygon</button>
          {tool === "poly" && polyN >= 3 && <button className="hd-btn accent" onClick={finishPoly}>Finish</button>}
          {selection && <button className="hd-btn" onClick={clearSelection}>Clear</button>}
          <button className="hd-btn" onClick={() => setFlat(!flat)} aria-pressed={flat} title={flat ? "Switch to 3D globe" : "Switch to 2D map"}>{flat ? "3D" : "2D"}</button>
        </div>
      </div>

      {tool !== "none" && (
        <div className="hd-hintbar">
          {tool === "box" ? "Drag on the map" : polyN < 3 ? `Click to add vertices (${polyN})` : "Click first vertex, double-click, or Enter to close"}
          <span>Esc to cancel</span>
        </div>
      )}

      {/* Date + legend */}
      <div className="hd-datechip">
        <div className="hd-date-row">
          {selection ? (
            <>
              <b className="hd-mono">
                {`${selRange.from.y}-${String(selRange.from.m + 1).padStart(2, "0")} → ${selRange.to.y}-${String(selRange.to.m + 1).padStart(2, "0")}`}
              </b>
              <span className="hd-mono">
                {fmtInt(pointTotal)} {mode === "raw" ? "hotspots (raw)" : "harmonized hotspots"} · {fmtInt(hotspots.features.length)} cells
              </span>
            </>
          ) : (
            <>
              <button onClick={() => stepDate(-1)} aria-label="Previous month">‹</button>
              <b className="hd-mono">{date.y}-{String(date.m + 1).padStart(2, "0")}</b>
              <button onClick={() => stepDate(1)} aria-label="Next month">›</button>
              <span className="hd-mono">{fmtInt(pointTotal)} {mode === "raw" ? "hotspots (raw)" : "harmonized hotspots"}</span>
              {(date.y !== LATEST.y || date.m !== LATEST.m) && <button className="hd-link" onClick={() => setDate(LATEST)}>Latest</button>}
            </>
          )}
        </div>
        {coverageNote && <div className="hd-nodata">{coverageNote}</div>}
        <div className="hd-frp-legend">
          <span>Hotspots / {CELL_DEG}° cell</span>
          {[["#fbbf24", "<5"], ["#f97316", "5–20"], ["#ea580c", "20–100"], ["#dc2626", "≥100"]].map(([c, t]) => (
            <span key={t}><i style={{ background: c }} />{t}</span>
          ))}
        </div>
      </div>

      {/* Fire stripes: one stripe per year, top right of the globe */}
      {selection && covered && (
        <div className="hd-stripes-card">
          <div className="hd-stripes" role="img" aria-label={`Fire stripes ${Y0}–${Y1} for ${selectionName}: one stripe per year, blue = fewer hotspots, red = more hotspots than the average year`}>
            {stripes.map((c, yi) => (
              <i
                key={yi}
                className={c ? "" : "empty"}
                style={{ background: c ?? undefined }}
                title={`${Y0 + yi}: ${annual[yi].value === null ? "no data" : `${fmtInt(annual[yi].value!)} ${unit(metric)}${annual[yi].est ? " (estimated, partial year)" : ""}`}`}
              />
            ))}
          </div>
          <div className="hd-stripes-axis"><span>{Y0}</span><span>hotspots / year</span><span>{Y1}</span></div>
        </div>
      )}

      {/* Left panel: Region card */}
      {selection && (
        <aside ref={leftDrag.ref} style={leftDrag.style} className={"hd-panel-left" + (panelLeftOpen ? "" : " collapsed") + (leftDrag.dragging ? " dragging" : "")} aria-label="Region settings">
          <div className="hd-panel-head" {...leftDrag.handle}>
            <span className="hd-mono hd-name">{selectionName}</span>
            <button className="hd-icon" onClick={() => setPanelLeftOpen(!panelLeftOpen)} aria-label={panelLeftOpen ? "Collapse region panel" : "Expand region panel"} aria-expanded={panelLeftOpen}>
              <svg width="12" height="12" viewBox="0 0 14 14"><path d={panelLeftOpen ? "M2 5l5 5 5-5" : "M2 9l5-5 5 5"} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" /></svg>
            </button>
          </div>
          {panelLeftOpen && (
            <div className="hd-panel-body">
              <RegionCard
                selection={selection}
                name={selectionName}
                onRename={setSelectionName}
                range={selRange}
                onRangeChange={setSelRange}
                onApplyBbox={handleApplyBbox}
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
              <Seg<Variant> label="Data series" value={mode} onChange={setMode} options={[{ v: "raw", t: "Raw (one sensor per era)" }, { v: "harm", t: "Harmonized (MODIS-eq.)" }]} />

              {med && (
                <div className="hd-median" aria-live="polite">
                  <div className="hd-median-head">
                    <b className="hd-mono">{MONTHS[med.m]} {med.y}</b> vs median {BASE_Y0}–{BASE_Y1}
                    <span className="hd-median-cls" style={{ background: CLASS_COLORS[med.cls], color: med.cls === 0 || med.cls === 4 ? "#fff" : "#0f172a" }}>
                      {CLASSES5[med.cls]}
                    </span>
                  </div>
                  <div className="hd-median-row hd-mono">
                    {fmtInt(med.value)} hotspots · median {fmtInt(med.median)}
                    {med.pctMedian !== null ? ` · ${Math.round(med.pctMedian)} % of median` : ""}
                  </div>
                  <div className="hd-median-row hd-mono dim">
                    rank {med.rank} / {med.nYears} · usual range (P10–P90) {fmtInt(med.p10)}–{fmtInt(med.p90)} · harmonized series
                  </div>
                </div>
              )}

              {renderCalendar(false)}
              <button className="hd-rc-apply" onClick={downloadCalendarPng} aria-label="Download the calendar as a PNG image">Download PNG</button>

              <div className="hd-chart-wrap">
                <svg viewBox={`0 0 ${W} ${H}`} className="hd-chart" role="img" aria-label="Annual series, raw versus harmonized">
                  {ticks.map((t) => (
                    <g key={t}>
                      <line x1={ml} x2={W - mr} y1={yAt(t)} y2={yAt(t)} stroke="#e2e8f0" />
                      <text x={ml - 6} y={yAt(t) + 3.5} textAnchor="end" className="hd-axis">{fmtCompact(t)}</text>
                    </g>
                  ))}
                  {[2000, 2005, 2010, 2015, 2020, 2025].map((y) => <text key={y} x={xAt(y - Y0)} y={H - 3} textAnchor="middle" className="hd-axis">{y}</text>)}
                  <line x1={xAt(2012 - Y0)} x2={xAt(2012 - Y0)} y1={mt} y2={mt + ph} stroke="#dc2626" strokeDasharray="3 3" opacity={0.6} />
                  <text x={xAt(2012 - Y0) - 4} y={mt + 8} textAnchor="end" className="hd-annot">2012</text>
                  <path d={pathOf(rawLine)} fill="none" stroke="#dc2626" strokeWidth={mode === "raw" ? 2.4 : 1.4} strokeDasharray="5 3" opacity={mode === "raw" ? 1 : 0.4} strokeLinejoin="round" />
                  <path d={pathOf(harmLine)} fill="none" stroke="#ea580c" strokeWidth={mode === "harm" ? 2.4 : 1.4} opacity={mode === "harm" ? 1 : 0.45} strokeLinejoin="round" />
                  {/* partial years (data start / current year) are extrapolated: hollow markers, never plain points */}
                  {annual.map((p, i) => (p.est && p.value !== null
                    ? <circle key={`est${i}`} cx={xAt(i)} cy={yAt(p.value)} r={3} fill="#fff" stroke="#0f172a" strokeWidth={1.2}><title>{`${Y0 + i}: partial year, annual total estimated`}</title></circle>
                    : null))}
                  {hoverYear !== null && (
                    <g>
                      <line x1={xAt(hoverYear)} x2={xAt(hoverYear)} y1={mt} y2={mt + ph} stroke="#0f172a" opacity={0.25} />
                      {rawLine[hoverYear] != null && <circle cx={xAt(hoverYear)} cy={yAt(rawLine[hoverYear]!)} r={3.5} fill="#dc2626" stroke="#fff" strokeWidth={1.2} />}
                      {harmLine[hoverYear] != null && <circle cx={xAt(hoverYear)} cy={yAt(harmLine[hoverYear]!)} r={3.5} fill="#ea580c" stroke="#fff" strokeWidth={1.2} />}
                    </g>
                  )}
                  <rect x={ml} y={mt} width={pw} height={ph} fill="transparent" onMouseMove={onChartMove} onMouseLeave={() => setHoverYear(null)} />
                </svg>
                <div className="hd-chart-legend">
                  <span><svg width="22" height="6"><line x1="0" y1="3" x2="22" y2="3" stroke="#dc2626" strokeWidth="2.4" strokeDasharray="4 3" /></svg>Raw</span>
                  <span><svg width="22" height="6"><line x1="0" y1="3" x2="22" y2="3" stroke="#ea580c" strokeWidth="2.4" /></svg>Harmonized</span>
                  <span><svg width="10" height="10"><circle cx="5" cy="5" r="3" fill="#fff" stroke="#0f172a" strokeWidth="1.2" /></svg>partial year (est.)</span>
                  {hoverYear !== null && (
                    <span className="hd-mono hd-hover-read">
                      {Y0 + hoverYear}: {rawLine[hoverYear] != null ? fmtCompact(rawLine[hoverYear]!) : "—"} / {harmLine[hoverYear] != null ? fmtCompact(harmLine[hoverYear]!) : "—"} {unit(metric)}
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
            <span className="hd-mono hd-name">{region.name}</span>
            <Seg<Variant> label="Data series" value={mode} onChange={setMode} options={[{ v: "raw", t: "Raw (one sensor per era)" }, { v: "harm", t: "Harmonized (MODIS-eq.)" }]} />
            <button className="hd-icon hd-split-close" onClick={() => setSplit(false)} aria-label="Exit deep dive (Esc)" title="Back (Esc)">
              <CollapseIcon />
            </button>
          </div>
          <div className="hd-split-body">
            <section className="hd-split-pane" aria-label="Calendar">
              <div className="hd-sec-head"><span className="hd-sec-title">Calendar</span></div>
              <div className="hd-split-cal">{renderCalendar(true)}</div>
            </section>
          </div>
        </div>
      )}

      {/* Heatmap tooltip */}
      {tip && selection && (panelOpen || split) && (
        <div className="hd-tip" style={{ left: Math.max(8, tip.x - 250), top: Math.max(8, tip.y - 12), transform: "translateY(-100%)" }}>
          <div className="hd-tip-title">{Y0 + tip.yi}-{String(tip.m + 1).padStart(2, "0")}</div>
          {tipCell && tipStats ? (
            <>
              <div className="hd-tip-r"><span>{mode === "harm" ? "Harmonized hotspots" : "Hotspots (raw)"}</span><b>{fmtInt(tipStats.count.total)}</b></div>
              <div className="hd-tip-r"><span>Source</span><b>{provenance(Y0 + tip.yi, tip.m, mode)}</b></div>
              <div className="hd-tip-r dim"><span>MODIS Aqua detected</span><b>{fmtInt(tipStats.count.modis)}</b></div>
              <div className="hd-tip-r dim"><span>VIIRS detected</span><b>{tipCell.hasV ? fmtInt(tipStats.count.viirs) : "—"}</b></div>
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

.hd-datechip{position:absolute;left:12px;bottom:28px;z-index:5;background:rgba(255,255,255,.78);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);border-radius:8px;padding:7px 10px;box-shadow:0 2px 12px rgba(15,23,42,.12);display:flex;flex-direction:column;gap:6px}
.hd-date-row{display:flex;align-items:center;gap:8px}
.hd-date-row button{border:0;background:rgba(15,23,42,.06);width:22px;height:22px;border-radius:6px;line-height:1;font-size:15px;padding:0}
.hd-date-row button:hover{background:var(--bg2)}
.hd-date-row .hd-link{width:auto;border:0;background:none;color:var(--or);font-weight:600;font-size:12px;padding:0 2px;height:auto}
.hd-nodata{margin-top:4px;color:#b45309;font-size:11px;max-width:340px}
.hd-frp-legend{display:flex;gap:10px;color:var(--mut);font-size:11px;align-items:center}
.hd-frp-legend span{display:inline-flex;align-items:center;gap:4px}
.hd-frp-legend i{width:9px;height:9px;border-radius:50%}

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
.hd-search-inner{display:flex;align-items:center;gap:6px;padding:3px 6px 3px 10px}
.hd-search-input{border:0;background:transparent;outline:none;font:inherit;font-size:12px;color:var(--tx);width:155px}
.hd-search-input::placeholder{color:var(--mut)}
.hd-search-clear{border:0;background:transparent;padding:1px 5px;border-radius:5px;color:var(--mut);font-size:14px;line-height:1;cursor:pointer}
.hd-search-clear:hover{color:var(--tx)}
.hd-search-dropdown{position:absolute;top:calc(100% + 4px);left:0;min-width:100%;background:rgba(255,255,255,.96);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);border-radius:8px;box-shadow:0 6px 24px rgba(15,23,42,.16);overflow:hidden;z-index:20}
.hd-search-result{display:block;width:100%;border:0;background:transparent;text-align:left;padding:7px 12px;font-size:12px;color:var(--tx);cursor:pointer;white-space:nowrap}
.hd-search-result:hover{background:rgba(15,23,42,.06)}

.hd-heat{display:grid;grid-template-columns:26px repeat(12,minmax(0,1fr));gap:1px;user-select:none}
.hd-heat-col{font-size:9px;color:var(--mut);text-align:center;line-height:1.2}
.hd-heat-row{font-size:9px;color:var(--mut);display:flex;align-items:center;font-variant-numeric:tabular-nums;line-height:1;font-family:ui-monospace,Menlo,monospace}
.hd-cell{height:8px;border-radius:1px;cursor:pointer}
.hd-cell.empty{background:repeating-linear-gradient(45deg,#f1f5f9 0 2px,#e2e8f0 2px 3px);cursor:default}
.hd-stripes-card{position:absolute;top:62px;right:56px;z-index:5;width:240px;padding:6px;display:flex;flex-direction:column;gap:3px;
  background:rgba(255,255,255,.78);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);border-radius:8px;box-shadow:0 2px 12px rgba(15,23,42,.12)}
.hd-stripes{display:flex;height:96px;border-radius:5px;overflow:hidden}
.hd-stripes i{flex:1;min-width:0}
.hd-stripes i.empty{background:repeating-linear-gradient(45deg,#e2e8f0 0 2px,#f8fafc 2px 4px)}
.hd-stripes-axis{display:flex;justify-content:space-between;font-size:9.5px;color:var(--mut)}
.hd-heat-legend{grid-column:1 / -1;display:flex;align-items:center;gap:6px;margin-top:4px;font-size:9.5px;color:var(--mut)}
.hd-heat-legend i{flex:0 0 46px;height:6px;border-radius:2px;background:linear-gradient(90deg,#e8edf3,rgb(254,243,199) 4%,rgb(252,211,77) 25%,rgb(251,146,60) 50%,rgb(234,88,12) 72%,rgb(220,38,38) 88%,rgb(127,29,29))}
.hd-cell.out{opacity:.35}
.hd-cell.sel{outline:1.5px solid var(--tx);outline-offset:0;position:relative;z-index:1}
.hd-cell:hover{outline:1px solid var(--tx);outline-offset:0;position:relative;z-index:1}

.hd-chart-wrap{position:relative}
.hd-chart{width:100%;height:auto;display:block}
.hd-median{margin:0 14px;padding:8px 10px;border:1px solid var(--bd);border-radius:7px;background:rgba(255,255,255,.6);display:flex;flex-direction:column;gap:3px;font-size:12px}
.hd-median-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.hd-median-cls{margin-left:auto;padding:1px 7px;border-radius:999px;font-size:11px;font-weight:650;border:1px solid rgba(15,23,42,.15)}
.hd-median-row{font-size:11.5px}
.hd-median-row.dim{color:var(--mut);font-size:10.5px}
.hd-panel-body>.hd-rc-apply{margin:0 14px;align-self:flex-end}
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
.hd-rc-titlerow{display:flex;align-items:center;gap:8px;min-height:26px}
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
  .hd-datechip{display:none}
  .hd-toolbar{right:50px}
  .hd-stripes-card{width:150px;right:50px}
  .hd-stripes{height:56px}
}
@media (prefers-reduced-motion:reduce){.hd-root *{transition:none!important}}
`;
