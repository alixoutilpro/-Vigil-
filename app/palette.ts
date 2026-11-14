/**
 * Colour palettes of the whole interface: "standard" and "daltonien" (colour-vision deficiency).
 * The colour-blind palette avoids any hue pair confused by protan / deutan / tritan viewers:
 *  - sequential scales (map hexagons, calendar) = viridis, reversed (light yellow = low → dark violet = high);
 *  - diverging "vs normal" classes = PuOr (purple ↔ orange) instead of red ↔ blue;
 *  - categorical marks = Okabe–Ito (blue, orange, vermillion, bluish green).
 * The choice is global (one toggle, remembered in localStorage) and also exposed as CSS variables on <html>
 * (data-cvd="1"), so plain CSS follows it through var(--or), var(--cr)…
 */
import { useSyncExternalStore } from "react";

export interface Palette {
  /** 12 fixed map classes, low → high. */
  hex: string[];
  /** Continuous calendar ramp: [t, rgb]. */
  heat: [number, [number, number, number]][];
  /** 9-step diverging scale, low (below normal) → high. */
  div: string[];
  /** Text colour readable on div[c]. */
  divText: (c: number) => string;
  /** Badge colours of the 5 "vs normal" classes. */
  classes: Record<string, string>;
  modis: string;
  viirs: string;
  /** Main accent (series line, buttons). */
  accent: string;
  accentDark: string;
  /** Alerts, sensor switch, selection outline. */
  alert: string;
  ok: string;
}

const STANDARD: Palette = {
  hex: ["#ffffd4", "#fff3a8", "#ffe680", "#ffd45c", "#ffbd45", "#fea03a", "#fd8132", "#f5602a", "#e44022", "#c9261b", "#a11416", "#6e0a10"],
  heat: [[0, [254, 243, 199]], [0.25, [252, 211, 77]], [0.5, [251, 146, 60]], [0.72, [234, 88, 12]], [0.88, [220, 38, 38]], [1, [127, 29, 29]]],
  div: ["#2166ac", "#4393c3", "#92c5de", "#d1e5f0", "#f7f7f7", "#fddbc7", "#f4a582", "#d6604d", "#b2182b"],
  divText: (c) => (c <= 1 || c >= 7 ? "#ffffff" : "#0f172a"),
  classes: { "much below normal": "#2166ac", "below normal": "#92c5de", "near normal": "#f7f7f7", "above normal": "#f4a582", "much above normal": "#b2182b" },
  modis: "#22d3ee",
  viirs: "#fde047",
  accent: "#ea580c",
  accentDark: "#c2410c",
  alert: "#dc2626",
  ok: "#16a34a",
};

const DALTONIEN: Palette = {
  hex: ["#fde725", "#bddf26", "#81d34d", "#4ec36b", "#2ab07f", "#1f9e89", "#23898e", "#2b748e", "#345e8d", "#404387", "#482374", "#440154"],
  heat: [[0, [253, 231, 37]], [0.2, [122, 209, 81]], [0.4, [34, 168, 132]], [0.6, [42, 120, 142]], [0.8, [65, 68, 135]], [1, [68, 1, 84]]],
  div: ["#2d004b", "#542788", "#8073ac", "#d8daeb", "#f7f7f7", "#fee0b6", "#e08214", "#b35806", "#7f3b08"],
  divText: (c) => (c <= 1 || c >= 7 ? "#ffffff" : "#0f172a"),
  classes: { "much below normal": "#2d004b", "below normal": "#8073ac", "near normal": "#f7f7f7", "above normal": "#e08214", "much above normal": "#7f3b08" },
  modis: "#56b4e9",
  viirs: "#e69f00",
  accent: "#0072b2",
  accentDark: "#005a8c",
  alert: "#d55e00",
  ok: "#009e73",
};

const KEY = "vigil.daltonien";
let cvd = false;
let loaded = false;
const listeners = new Set<() => void>();

function apply() {
  if (typeof document !== "undefined") {
    if (cvd) document.documentElement.dataset.cvd = "1";
    else delete document.documentElement.dataset.cvd;
  }
}
/** Reads the remembered choice. Called once from an effect (after hydration, so server and client first renders match). */
export function initDaltonien() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try { cvd = window.localStorage.getItem(KEY) === "1"; } catch { /* storage blocked */ }
  apply();
  if (cvd) listeners.forEach((l) => l());
}

export function isDaltonien(): boolean { return cvd; }
export function setDaltonien(on: boolean) {
  cvd = on;
  loaded = true;
  try { window.localStorage.setItem(KEY, on ? "1" : "0"); } catch { /* storage blocked */ }
  apply();
  listeners.forEach((l) => l());
}
/** Current palette, for non-React code (MapLibre expressions, canvas export). */
export function palette(): Palette { return isDaltonien() ? DALTONIEN : STANDARD; }

function subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }
/** React hook: re-renders on toggle. Server render = standard palette. */
export function useDaltonien(): boolean {
  return useSyncExternalStore(subscribe, isDaltonien, () => false);
}
export function usePalette(): Palette { return useDaltonien() ? DALTONIEN : STANDARD; }

/** CSS gradient of the calendar ramp, prefixed by the "zero" colour. */
export function heatGradient(p: Palette): string {
  return `linear-gradient(90deg,#e8edf3,${p.heat.map(([t, c]) => `rgb(${c.join(",")}) ${t === 0 ? 4 : Math.round(t * 100)}%`).join(",")})`;
}

/** CSS variables of both palettes (the colour-blind set wins when <html data-cvd="1">). */
const vars = (p: Palette) => `--or:${p.accent};--or-dk:${p.accentDark};--cr:${p.alert};--gr:${p.ok};--heat-grad:${heatGradient(p)};--heat-mid:rgb(${p.heat[2][1].join(",")})`;
export const PALETTE_CSS = `:root{${vars(STANDARD)}}\n:root[data-cvd="1"]{${vars(DALTONIEN)}}`;
