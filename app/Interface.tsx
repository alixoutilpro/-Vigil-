"use client";

/**
 * Interface selector, at the very top of the page: "Vigil Analytics" (harmonized calendar, medians, anomalies) and
 * "Vigil Trends" (wildfire hubs found by space-time clustering, exposure score, local trends and fire regimes).
 * Both views are full-screen maps built on the same harmonized data; only one is mounted at a time (one WebGL map).
 * The Analytics view (app/Vigil.tsx) is untouched: it simply starts below the selector bar.
 */
import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import Vigil from "./Vigil";

const Tendances = dynamic(() => import("./Tendances"), { ssr: false });
type Vue = "analytics" | "tf";
const HAUTEUR = 34;

export default function Interface() {
  const [vue, setVue] = useState<Vue>("analytics");
  useEffect(() => { // the choice survives a reload, and a link can open a view directly (#forecasts)
    const h = window.location.hash;
    if (h === "#trends" || h === "#forecasts") setVue("tf");
  }, []);
  const choisir = (v: Vue) => { setVue(v); try { history.replaceState(null, "", v === "tf" ? "#trends" : "#analytics"); } catch { /* noop */ } };
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <nav className="vg-bar" aria-label="Vigil interface">
        <div className="vg-tabs" role="tablist">
          <button role="tab" aria-selected={vue === "analytics"} className={vue === "analytics" ? "on" : ""} onClick={() => choisir("analytics")} title="Harmonized burning calendar, medians and anomalies, 2002 → today">
            <b>Vigil</b> Analytics<small>calendar &amp; anomalies</small>
          </button>
          <button role="tab" aria-selected={vue === "tf"} className={vue === "tf" ? "on" : ""} onClick={() => choisir("tf")} title="Wildfire hubs, exposure score, local trends and fire regimes (space-time clustering)">
            <b>Vigil</b> Trends<small>hubs &amp; exposure</small>
          </button>
        </div>
      </nav>
      {vue === "analytics" ? <Vigil /> : <Tendances />}
    </>
  );
}

const CSS = `
.vg-bar{position:fixed;top:0;left:0;right:0;height:${HAUTEUR}px;z-index:100;display:flex;justify-content:center;align-items:center;
  background:#ffffff;border-bottom:1px solid #e2e8f0;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
.vg-tabs{display:flex;gap:2px;padding:2px;border-radius:9px;background:#f1f5f9}
.vg-tabs button{border:0;background:transparent;border-radius:7px;padding:4px 14px;font:500 12.5px/1.2 inherit;color:#0f172a;cursor:pointer;display:flex;align-items:baseline;gap:5px;white-space:nowrap}
.vg-tabs button b{font-weight:800;letter-spacing:.04em;text-transform:uppercase;font-size:11px}
.vg-tabs button small{font-size:10px;color:#64748b;margin-left:3px}
.vg-tabs button:hover{background:#e2e8f0}
.vg-tabs button.on{background:#0f172a;color:#fff}
.vg-tabs button.on small{color:#cbd5e1}
.vg-tabs button:focus-visible{outline:2px solid #ea580c;outline-offset:2px}
/* both views are full-screen (position:fixed; inset:0): they start below the selector bar */
.hd-root{top:${HAUTEUR}px!important}
@media (max-width:640px){.vg-tabs button small{display:none}.vg-tabs button{padding:4px 9px}}
`;
