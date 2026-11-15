"use client";

import React, { useEffect, useRef } from "react";
import type { Map as MLMap } from "maplibre-gl";

/**
 * Decorative orbits (TERRA, NOAA-20, NOAA-21, SNPP) drawn over the 3D globe while no region is selected.
 *
 * - Pure SVG + native SMIL animation (animateMotion): no React re-render per frame, no WebGL work.
 * - The SVG is authored in a fixed space where the Earth is a circle of radius 100 at the origin;
 *   on every camera move a single CSS transform maps that space onto the globe's on-screen disc.
 * - "Behind the Earth" is faked with a mask: the far half of each orbit (and the satellite while it
 *   travels it) is hidden wherever it overlaps the globe disc.
 * - pointer-events: none everywhere, so the map keeps every mouse/touch interaction.
 */

const GLOBE_R = 100; // radius of the Earth in SVG units
const VIEW = 320; // half-size of the SVG canvas in SVG units
const FADE_MS = 500;

interface Orbit { id: string; label: string; rx: number; ry: number; tilt: number; dur: number; begin: number }

const ORBITS: Orbit[] = [
  { id: "terra",  label: "TERRA",   rx: 145, ry: 24, tilt: -14, dur: 34, begin:   0 },
  { id: "noaa20", label: "NOAA-20", rx: 170, ry: 38, tilt:   6, dur: 50, begin: -11 },
  { id: "snpp",   label: "SNPP",    rx: 158, ry: 46, tilt: -28, dur: 58, begin:  -5 },
  { id: "noaa21", label: "NOAA-21", rx: 182, ry: 30, tilt:  22, dur: 42, begin: -18 },
];

/* Ellipse as two arcs from the left end: first the near (lower) half, then the far (upper) half.
   Both arcs have the same length, so with paced motion t = 0.5 is exactly the right end. */
const fullPath = (rx: number, ry: number) => `M ${-rx} 0 A ${rx} ${ry} 0 0 0 ${rx} 0 A ${rx} ${ry} 0 0 0 ${-rx} 0`;
const nearPath = (rx: number, ry: number) => `M ${-rx} 0 A ${rx} ${ry} 0 0 0 ${rx} 0`;
const farPath = (rx: number, ry: number) => `M ${rx} 0 A ${rx} ${ry} 0 0 0 ${-rx} 0`;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export default function OrbitOverlay(props: {
  mapRef: React.MutableRefObject<MLMap | null>;
  ready: boolean;
  /** false as soon as a region is selected or the 2D plan is shown */
  visible: boolean;
  /** delay before fading back in (e.g. while the plan wraps back into a globe) */
  enterDelayMs?: number;
}) {
  const { mapRef, ready, visible, enterDelayMs = 0 } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const posRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const visibleRef = useRef(visible);
  const camVisibleRef = useRef(false);
  const pauseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* Run the SMIL clock only while something is on screen (and never with reduced motion). */
  const syncClock = (immediate = false) => {
    const svg = svgRef.current;
    if (!svg) return;
    if (pauseTimer.current) { clearTimeout(pauseTimer.current); pauseTimer.current = null; }
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const run = visibleRef.current && camVisibleRef.current && !reduce;
    if (run) { svg.unpauseAnimations(); return; }
    if (reduce) { svg.setCurrentTime(6); svg.pauseAnimations(); return; }
    // Let the fade-out finish before freezing the satellites.
    if (immediate) svg.pauseAnimations();
    else pauseTimer.current = setTimeout(() => svg.pauseAnimations(), FADE_MS);
  };

  useEffect(() => {
    visibleRef.current = visible;
    syncClock();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  useEffect(() => () => { if (pauseTimer.current) clearTimeout(pauseTimer.current); }, []);

  /* Follow the camera: place the SVG origin on the globe centre and scale GLOBE_R to its pixel radius. */
  useEffect(() => {
    const m = mapRef.current;
    if (!m || !ready) return;

    const apply = () => {
      const root = rootRef.current, pos = posRef.current;
      if (!root || !pos) return;
      const canvas = m.getCanvas();
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (!w || !h) return;

      // Same maths as MapLibre's vertical-perspective transform: the camera sits cameraToCenterDistance
      // pixels from the centre point on the surface, the sphere centre is one globe radius behind it.
      const tr = (m as unknown as { transform?: { worldSize?: number; cameraToCenterDistance?: number } }).transform;
      const worldSize = tr?.worldSize ?? 512 * Math.pow(2, m.getZoom());
      const lat = (m.getCenter().lat * Math.PI) / 180;
      const R = worldSize / (2 * Math.PI) / Math.cos(lat);
      const d = tr?.cameraToCenterDistance ?? (0.5 * h) / Math.tan((36.87 / 2) * (Math.PI / 180));
      const pitch = (m.getPitch() * Math.PI) / 180;
      const zc = d + R * Math.cos(pitch);
      const yc = R * Math.sin(pitch);
      const D2 = zc * zc + yc * yc;
      const r = D2 > R * R ? (d * R) / Math.sqrt(D2 - R * R) : Infinity; // silhouette radius in px
      const cx = w / 2;
      const cy = h / 2 + (d * yc) / zc;

      // Fade the orbits out when the globe fills the screen, shrinks to a dot, or the view is strongly tilted.
      const big = Math.max(w, h);
      const zoomFade = clamp01((0.75 * big - r) / (0.25 * big));
      const smallFade = clamp01((r - 60) / 60); // globe too small for readable satellites
      const pitchFade = clamp01((60 - m.getPitch()) / 20);
      const fade = Number.isFinite(r) ? Math.min(zoomFade, smallFade, pitchFade) : 0;

      pos.style.transform = `translate3d(${cx.toFixed(1)}px,${cy.toFixed(1)}px,0) scale(${(r / GLOBE_R).toFixed(4)})`;
      pos.style.opacity = fade.toFixed(3);
      root.style.transformOrigin = `${cx.toFixed(1)}px ${cy.toFixed(1)}px`;

      const camVisible = fade > 0;
      if (camVisible !== camVisibleRef.current) {
        camVisibleRef.current = camVisible;
        pos.style.visibility = camVisible ? "visible" : "hidden";
        syncClock(!camVisible);
      }
    };

    let rafId = 0;
    const applyThrottled = () => {
      if (!visibleRef.current) return;
      if (rafId) return;
      rafId = requestAnimationFrame(() => { rafId = 0; apply(); });
    };
    apply();
    m.on("move", applyThrottled);
    m.on("resize", apply);
    return () => { m.off("move", applyThrottled); m.off("resize", apply); if (rafId) cancelAnimationFrame(rafId); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapRef, ready]);

  return (
    <div
      ref={rootRef}
      className={"vo-root" + (visible ? "" : " vo-out")}
      style={visible && enterDelayMs ? ({ "--vo-delay": `${enterDelayMs}ms` } as React.CSSProperties) : undefined}
      aria-hidden="true"
    >
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div ref={posRef} className="vo-pos" style={{ visibility: "hidden", opacity: 0 }}>
        <svg
          ref={svgRef}
          className="vo-svg"
          width={VIEW * 2}
          height={VIEW * 2}
          viewBox={`${-VIEW} ${-VIEW} ${VIEW * 2} ${VIEW * 2}`}
          focusable="false"
        >
          <Defs />
          {ORBITS.map((o) => (
            <g key={o.id} transform={`rotate(${o.tilt})`}>
              <Satellite orbit={o} copy="far" />
              <Satellite orbit={o} copy="near" />
            </g>
          ))}
        </svg>
      </div>
    </div>
  );
}

/* One satellite is drawn twice on the same clock: the "near" copy is shown on the front half of the
   orbit, the "far" copy (masked by the Earth) on the back half. They swap at the ellipse ends, which
   lie outside the globe disc, so the hand-over is invisible. */
function Satellite({ orbit: o, copy }: { orbit: Orbit; copy: "near" | "far" }) {
  const timing = { dur: `${o.dur}s`, begin: `${o.begin}s`, repeatCount: "indefinite" } as const;
  const spline = "0.45 0 0.55 1;0.45 0 0.55 1;0.45 0 0.55 1;0.45 0 0.55 1";
  return (
    <g mask={copy === "far" ? "url(#vo-occlude)" : undefined}>
      <g opacity={copy === "near" ? 1 : 0}>
        <animate attributeName="opacity" values={copy === "near" ? "1;0" : "0;1"} keyTimes="0;0.5" calcMode="discrete" {...timing} />
        <g>
          <animateMotion path={fullPath(o.rx, o.ry)} rotate="auto" calcMode="paced" {...timing} />
          {/* Depth cue: nearest at t=.25 (bottom), farthest at t=.75 (top). */}
          <g>
            <animateTransform attributeName="transform" type="scale" values="0.9;1.06;0.9;0.74;0.9" keyTimes="0;0.25;0.5;0.75;1" calcMode="spline" keySplines={spline} {...timing} />
            <animate attributeName="opacity" values="0.95;1;0.95;0.7;0.95" keyTimes="0;0.25;0.5;0.75;1" calcMode="spline" keySplines={spline} {...timing} />
            <g>
              <animateTransform attributeName="transform" type="rotate" values="0;22;0;-22;0" keyTimes="0;0.25;0.5;0.75;1" calcMode="spline" keySplines={spline} dur="13s" begin={`${o.begin}s`} repeatCount="indefinite" />
              <use href="#vo-sat" />
            </g>
          </g>
        </g>
        {/* Label: same motion without rotate, counter-rotated against the orbit tilt so it reads level. */}
        <g>
          <animateMotion path={fullPath(o.rx, o.ry)} calcMode="paced" {...timing} />
          <g transform={`rotate(${-o.tilt})`}>
            <text className="vo-label" y={-11} textAnchor="middle">{o.label}</text>
          </g>
        </g>
      </g>
    </g>
  );
}

/* Satellite artwork (black), sensor pointing to local -y (towards the Earth once rotate="auto" is applied).
   Thin grey detail lines keep the structure readable. */
function SatIcon() {
  const ink = "#0a0a0a", line = "#6b7280";
  const panel = (x0: number) => (
    <>
      <rect x={x0} y={-6} width={10} height={12} rx={0.8} fill={ink} stroke={line} strokeWidth={0.45} />
      {[1, 2, 3].map((i) => <line key={`v${i}`} x1={x0 + i * 2.5} y1={-6} x2={x0 + i * 2.5} y2={6} stroke={line} strokeOpacity={0.7} strokeWidth={0.3} />)}
      <line x1={x0} y1={0} x2={x0 + 10} y2={0} stroke={line} strokeOpacity={0.8} strokeWidth={0.35} />
    </>
  );
  return (
    <g id="vo-sat" transform="scale(0.36)">
      {/* struts */}
      <line x1={-14} y1={0.6} x2={-8.6} y2={0.6} stroke={ink} strokeWidth={1} />
      <line x1={8.6} y1={0.6} x2={14} y2={0.6} stroke={ink} strokeWidth={1} />
      {/* solar panels */}
      <g transform="translate(0 0.6)">
        {panel(-24.5)}
        {panel(14.5)}
      </g>
      {/* hexagonal bus */}
      <path d="M-5.5 -7 H5.5 L8.6 -3.2 V5.2 L5.5 9 H-5.5 L-8.6 5.2 V-3.2 Z" fill={ink} stroke={line} strokeWidth={0.5} />
      <path d="M-3 -7 V9 M3 -7 V9" stroke={line} strokeOpacity={0.6} strokeWidth={0.4} />
      <rect x={-8.6} y={1.3} width={17.2} height={1.8} fill="#262626" />
      {/* optical instrument facing the Earth */}
      <path d="M-4.2 -7 L-3 -11 H3 L4.2 -7 Z" fill={ink} stroke={line} strokeWidth={0.4} />
      <ellipse cx={0} cy={-11.2} rx={2.9} ry={1.25} fill="#1f1f1f" stroke={line} strokeWidth={0.4} />
      {/* antenna (zenith) */}
      <line x1={0} y1={9} x2={0} y2={12.5} stroke={ink} strokeWidth={0.7} />
      <path d="M-2.4 13.6 Q0 11.6 2.4 13.6" fill="none" stroke={ink} strokeWidth={0.8} strokeLinecap="round" />
    </g>
  );
}

function Defs() {
  return (
    <defs>
      {/* white = visible, black = hidden behind the Earth; soft edge at the limb */}
      <radialGradient id="vo-occlude-grad" cx="0" cy="0" r={GLOBE_R * 1.04} gradientUnits="userSpaceOnUse">
        <stop offset="0.955" stopColor="#000" />
        <stop offset="1" stopColor="#fff" />
      </radialGradient>
      <mask id="vo-occlude" maskUnits="userSpaceOnUse" x={-VIEW} y={-VIEW} width={VIEW * 2} height={VIEW * 2}>
        <rect x={-VIEW} y={-VIEW} width={VIEW * 2} height={VIEW * 2} fill="url(#vo-occlude-grad)" />
      </mask>
      <SatIcon />
    </defs>
  );
}

const CSS = `
.vo-root{position:absolute;inset:0;z-index:1;pointer-events:none;overflow:hidden;
  opacity:1;transform:scale(1);visibility:visible;
  transition:opacity ${FADE_MS}ms ease var(--vo-delay,0ms),transform ${FADE_MS}ms ease var(--vo-delay,0ms),visibility 0s linear var(--vo-delay,0ms)}
.vo-root.vo-out{opacity:0;transform:scale(1.05);visibility:hidden;
  transition:opacity ${FADE_MS}ms ease,transform ${FADE_MS}ms ease,visibility 0s linear ${FADE_MS}ms}
.vo-root *{pointer-events:none}
.vo-pos{position:absolute;left:0;top:0;width:0;height:0;transform-origin:0 0}
.vo-svg{position:absolute;left:${-VIEW}px;top:${-VIEW}px;overflow:visible}
.vo-orbit{fill:none;stroke:#000;stroke-linecap:round;stroke-width:1.1;stroke-dasharray:1.5 5;vector-effect:non-scaling-stroke}
.vo-orbit-near{stroke-opacity:.6}
.vo-orbit-far{stroke-opacity:.35}
.vo-label{font:700 4.6px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em;fill:#000;
  stroke:rgba(255,255,255,.85);stroke-width:1.2px;stroke-linejoin:round;paint-order:stroke}
`;
