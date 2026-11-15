"use client";

/**
 * Vigil Trends dashboard: every hub of the zone with its score and confidence, how hubs are found (the method and
 * its thresholds), and the clustering diagnostics of the context layers (fire regimes, trajectory shapes, trends).
 * Numbers come from public/data/tf/hubs.json and modele.json (pipeline/tf, docs/methode_tf.md).
 * Same visual language as the Analytics dashboard (app/DeepDive.tsx): its stylesheet and definition tooltips.
 */
import React, { useMemo, useState } from "react";
import { CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from "recharts";
import { DD_CSS, Def, fmtLat, fmtLon } from "./tfCommun";
import type { Hub, HubsTF, ModeleTF } from "./tf";
import { libConfiance } from "./tf";
import { CATEG, couleurScore, moisTxt } from "./Tendances";

const n0 = (x: number | null | undefined) => (x === null || x === undefined || !isFinite(x) ? "—" : Math.round(x).toLocaleString("en-US"));
const n2 = (x: number | null | undefined, d = 2) => (x === null || x === undefined || !isFinite(x) ? "—" : x.toFixed(d));
const p0 = (x: number | null | undefined, d = 0) => (x === null || x === undefined || !isFinite(x) ? "—" : `${(100 * x).toFixed(d)} %`);
const fp = (p: number) => (p < 0.001 ? "<0.001" : p.toFixed(3));
const tip: React.CSSProperties = { fontSize: 11, background: "#fff", border: "1px solid #e2e8f0", color: "#0f172a", borderRadius: 6, padding: "6px 9px" };
type Tri = "score" | "confiance" | "annees_episode" | "detections" | "dernier";

export default function TendancesDive({ hubs, liste, modele, titre, onHub }: { hubs: HubsTF; liste: Hub[]; modele: ModeleTF | null; titre: string; onHub: (id: number) => void }) {
  const [tri, setTri] = useState<Tri>("score");
  const P = hubs.parametres, R = hubs.resume, NY = hubs.annees[1] - hubs.annees[0] + 1;
  const lignes = useMemo(() => liste.slice().sort((a, b) => (tri === "dernier" ? b.dernier.localeCompare(a.dernier) : (b[tri] as number) - (a[tri] as number))).slice(0, 300), [liste, tri]);
  const conf90 = liste.filter((h) => h.confiance >= 0.9).length;
  const recents = liste.filter((h) => Number(h.dernier.slice(0, 4)) >= hubs.annees[1] - 4).length;
  const TL = modele?.tendances_locales_lissees ?? modele?.tendances;
  const trajData = modele ? modele.trajectoires.annees.map((y, i) => ({ y, ...Object.fromEntries(modele.trajectoires.centres.map((c) => [`t${c.trajectoire}`, c.valeurs[i]])) })) : [];
  const Th = ({ k, children, d }: { k?: Tri; children: React.ReactNode; d: string }) => (
    <th scope="col" className={k && tri === k ? "td-tri on" : k ? "td-tri" : undefined} onClick={k ? () => setTri(k) : undefined}><Def def={d}>{children}{k && tri === k ? " ▾" : ""}</Def></th>);

  return (
    <div className="dd-root">
      <style dangerouslySetInnerHTML={{ __html: DD_CSS + TD_CSS }} />
      <header className="dd-head"><div>
        <h2 className="dd-title">{titre} <span className="dd-title-sub">· wildfire hubs {hubs.annees[0]}–{hubs.annees[1]} · harmonized detections, MODIS-Aqua equivalent</span></h2>
        <p className="dd-note">Same harmonized data as the Analytics view. A hub is a small group of neighbouring ~17 km hexagons repeatedly hit by <b>bursts</b>: months far above what those hexagons usually show at that time of year. Burning that comes back every year in the same season never qualifies.</p>
      </div></header>

      <div className="dd-kpis">
        <Kpi l={`Hubs · ${titre}`} v={n0(liste.length)} s={`${n0(conf90)} with confidence ≥ 90 % · ${n0(recents)} with an episode since ${hubs.annees[1] - 4}`}
          d="Number of wildfire hubs whose centre lies in the zone (after the confidence filter of the map). Confidence ≥ 90 %: hubs whose detection does not depend on any single year." />
        <Kpi l="Highest exposure" v={liste[0] ? `${liste[0].score} / 100` : "—"} s={liste[0] ? `${fmtLat(liste[0].lat)} ${fmtLon(liste[0].lon)} · ${liste[0].annees_episode} years with an episode · confidence ${p0(liste[0].confiance)}` : "no hub in the zone"}
          d="Exposure score = percentile rank, among all hubs worldwide, of the mean of three percentile ranks: how often (share of years with an episode), how much (episode detections per 1,000 km² per year) and how intense (FRP per detection). 100 = the most exposed hubs on Earth. It ranks places; it is not a probability." />
        <Kpi l="Episodes found · world" v={n0(R.episodes)} s={`${n0(R.sursauts)} bursts among ${n0(R.hexagones_mois)} hexagon-months with fire`}
          d={`An episode is a connected group of bursts: same or neighbouring hexagons, same or consecutive months. Episodes under ${P.episode_min} detections are dropped.`} />
        <Kpi l="Share of detections in episodes" v={p0(R.part_detections_episodiques, 1)} s="the rest is recurrent burning, set aside on purpose"
          d="Share of all harmonized detections 2003–2025 that belongs to an episode of a hub. The large remainder is the regular, seasonal burning (savannas, crop residues) that fills the Analytics map but says little about wildfire exposure." />
        <Kpi l="Confidence · median hub" v={p0(R.confiance_mediane)} s={`${n0(R.hubs_confiance_90)} of ${n0(R.hubs)} hubs at ≥ 90 % · bootstrap, ${P.n_boot} resamples of the years`}
          d={`The ${NY} years are drawn again with replacement ${P.n_boot} times; each time the hub rule is applied to the resampled record. Confidence = share of resamples in which the hub is still found. A hub made by one single exceptional year is found in about 64 % of resamples: real, but not proven recurrent.`} />
        <Kpi l="Size of a hub" v={`${n2(R.taille_mediane_hexagones, 0)} hex`} s={`median · at most ${P.taille_max} hexagons (~80 km across) · median ${n2(R.annees_episode_mediane, 0)} years with an episode`}
          d={`Groups of exposed hexagons larger than ${P.taille_max} are split by keeping only their upper half of exposure, repeatedly: the interest is local.`} />
        {TL && <Kpi l="Local trends · context layer" v={`${n0(TL.hausse_significative)} ↑ · ${n0(TL.baisse_significative)} ↓`} s={`of ${n0(TL.cellules_testees)} territories tested · false discovery rate ≤ ${Math.round(100 * TL.q_fdr)} % · world ${TL.monde.sen_pct_an >= 0 ? "+" : "−"}${Math.abs(TL.monde.sen_pct_an).toFixed(2)} %/yr (p=${fp(TL.monde.mk_p)})`}
          d="Mann–Kendall test of each ~42 km territory pooled with its 6 neighbours, Theil–Sen slope. Testing tens of thousands of territories at p < 0.05 flags 5 % of them by chance: the Benjamini–Hochberg procedure keeps the share of false alarms among flagged territories below 10 %." />}
        {modele && <Kpi l="Fire regimes · trajectories" v={`${modele.regimes.k} · ${modele.trajectoires.k}`} s={`k-means on standardized descriptors · stability (adjusted Rand) ${n2(modele.regimes.diagnostics.find((d) => d.k === modele.regimes.k)?.stabilite_ari)} · ${n2(modele.trajectoires.diagnostics.find((d) => d.k === modele.trajectoires.k)?.stabilite_ari)}`}
          d="Number of groups chosen by a rule fixed in advance (elbow of the inertia curve for regimes, most reproducible partition for trajectory shapes). Stability: two k-means fitted on two random halves of the territories must give the same groups (1 = identical)." />}
      </div>

      <div className="dd-grid">
        <section className="dd-panel dd-full" aria-label="Hubs of the zone">
          <div className="dd-sec-head"><Def def="Click a column title to sort, a row to open the hub on the map. The CSV export holds every hub with its H3 hexagons."><span className="dd-sec-title">Hubs of the zone · {n0(liste.length)}{liste.length > 300 ? " (300 shown)" : ""}</span></Def></div>
          <div className="dd-table-wrap td-scroll"><table className="dd-table td-hubs"><thead><tr>
            <Th k="score" d="Exposure score 1–100 (percentile among all hubs worldwide).">Score</Th>
            <Th d="Centre of the hub, weighted by exposure.">Where</Th>
            <Th d="Country of the hub centre (Natural Earth).">Country</Th>
            <Th k="confiance" d="Bootstrap confidence: share of year-resamples in which the hub is still detected.">Confidence</Th>
            <Th k="annees_episode" d={`Years with at least one episode, out of ${NY}.`}>Years with episode</Th>
            <Th k="detections" d="Harmonized detections of the bursts of the hub, 2003–2025.">Episode detections</Th>
            <Th d="Episode detections per 1,000 km² per year.">Density</Th>
            <Th d="Mean Fire Radiative Power per detection during the bursts (MW).">FRP / det.</Th>
            <Th d="Month and detections of the largest episode.">Largest episode</Th>
            <Th k="dernier" d="Month of the most recent burst.">Last episode</Th>
            <Th d="Hexagons (H3 res 5) and area.">Extent</Th>
            <Th d="Episode detections per year, 2003 → 2025.">Years</Th></tr></thead>
            <tbody>{lignes.map((h) => (
              <tr key={h.id} onClick={() => onHub(h.id)} tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") onHub(h.id); }}>
                <td><span className="td-chip" style={{ background: couleurScore(h.score), color: h.score > 50 ? "#fff" : "#0f172a" }}>{h.score}</span></td>
                <td>{fmtLat(h.lat)} {fmtLon(h.lon)}</td><td style={{ fontFamily: "inherit" }}>{h.pays ?? "—"}</td>
                <td>{p0(h.confiance)} <small>{libConfiance(h.confiance)}</small></td><td>{h.annees_episode}</td><td>{n0(h.detections)}</td><td>{n2(h.densite)}</td><td>{n2(h.frp_det, 0)} MW</td>
                <td>{moisTxt(h.pic.mois)} · {n0(h.pic.detections)}</td><td>{moisTxt(h.dernier)}</td><td>{h.h3.length} · {n0(h.aire_km2)} km²</td>
                <td><span className="td-spark">{h.serie.map((v, k) => <i key={k} style={{ height: `${v > 0 ? Math.max(12, (100 * v) / Math.max(...h.serie)) : 4}%`, background: v > 0 ? couleurScore(h.score) : "#cbd5e1" }} />)}</span></td>
              </tr>))}</tbody></table></div>
        </section>

        <section className="dd-panel dd-full" aria-label="Method">
          <div className="dd-sec-head"><span className="dd-sec-title">How a hub is found · space-time clustering</span></div>
          <ol className="td-steps">
            <li><b>Burst.</b> A hexagon-month is a burst when its detections are large (≥ {P.v_min}) <i>and</i> unusual for that hexagon and that calendar month: ≥ {P.ratio} × (median of the same month over all years + 1). A field burnt every March has a high March median: it never bursts. This is where time separates wildfires from recurrent burning.</li>
            <li><b>Episode.</b> Bursts are linked when their hexagons are identical or neighbours and their months identical or consecutive; each connected group is one episode. Episodes under {P.episode_min} detections are dropped.</li>
            <li><b>Hub.</b> Hexagons with ≥ {P.hex_min} episode detections are grouped with their neighbours; a group larger than {P.taille_max} hexagons is cut down to its most exposed half, repeatedly. Hubs under {P.hub_min} detections are dropped.</li>
            <li><b>Score.</b> Three measures, each turned into a percentile rank among all hubs: share of years with an episode, episode detections per 1,000 km² per year, FRP per detection. The score is the percentile rank of their mean: 1 to 100.</li>
            <li><b>Confidence.</b> Bootstrap over years ({P.n_boot} resamples): the share of resamples in which the hub still passes step 3.</li>
          </ol>
          <p className="dd-note">Limits. A detection is not a fire, and a ~17 km hexagon-month cannot tell one large fire from several close ones. Thresholds are choices, written in <code>pipeline/tf/hubs.py</code>; the list of hubs changes at the margin when they move, the highest scores do not. The score compares hubs with each other: it is an exposure ranking built on 23 years of record, not a forecast. Intense recurrent burning that shifts from its usual month can enter as a burst.</p>
        </section>

        {modele && (
          <>
            <section className="dd-panel dd-full" aria-label="Fire regimes">
              <div className="dd-sec-head"><Def def={`k-means on ${modele.regimes.variables.length} standardized descriptors of ${n0(modele.regimes.cellules_classees)} territories of ~42 km with ≥ ${modele.parametres.min_detections_par_an} detections a year. Land cover and climate were NOT given to the clustering: finding a different vegetation and climate in each group is an external check.`}><span className="dd-sec-title">Context · fire regimes · k-means, k = {modele.regimes.k}</span></Def></div>
              <div className="td-two">
                <div className="dd-table-wrap"><table className="dd-table"><thead><tr><th scope="col">Regime</th><th scope="col">Territories</th><th scope="col">Share of detections</th><th scope="col">Density</th><th scope="col">CV between years</th><th scope="col">FRP / detection</th><th scope="col">Season (months)</th><th scope="col">Main land cover (not used to cluster)</th><th scope="col">VPD · rain</th></tr></thead>
                  <tbody>{modele.regimes.profil.map((r) => <tr key={r.regime}><th scope="row"><i className="td-sw" style={{ background: CATEG[r.regime] }} />{r.nom}</th><td>{n0(r.n)}</td><td>{p0(r.part_hotspots, 1)}</td><td>{n2(r.densite)}</td><td>{n2(r.cv)}</td><td>{n2(r.frp, 0)} MW</td><td>{n2(r.saison_longueur, 0)}</td>
                    <td style={{ textAlign: "left", fontFamily: "inherit" }}>{Object.entries(r.occupation_du_sol).slice(0, 2).map(([k, v]) => `${k} ${Math.round(100 * v)} %`).join(", ")}</td><td>{n2(r.climat.vpd_kPa)} kPa · {n0(r.climat.pluie_mm)} mm</td></tr>)}</tbody></table>
                  <p className="dd-note">Choice of k (rule fixed in advance: smallest k after which one more group removes &lt; 10 % of the inertia): {modele.regimes.diagnostics.slice(0, 6).map((d) => `k=${d.k}: inertia ${n0(d.inertie)}${d.gain_inertie !== null ? ` (−${Math.round(100 * d.gain_inertie)} %)` : ""}, silhouette ${n2(d.silhouette)}, stability ${n2(d.stabilite_ari)}`).join(" · ")}. Silhouettes are low: regimes form a continuum; the groups are a readable summary, not sealed boxes.</p></div>
                <div><div className="dd-mini">Territories on the first 2 principal components ({Math.round(100 * (modele.regimes.pca.variance_expliquee[0] + modele.regimes.pca.variance_expliquee[1]))} % of the variance)</div>
                  <div className="dd-chart"><ResponsiveContainer width="100%" height="100%"><ScatterChart margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke="rgba(15,23,42,.12)" strokeDasharray="2 2" /><XAxis dataKey="x" type="number" tick={{ fontSize: 9, fill: "#000" }} /><YAxis dataKey="y" type="number" tick={{ fontSize: 9, fill: "#000" }} width={28} /><ZAxis range={[10, 10]} />
                    {modele.regimes.profil.map((r) => <Scatter key={r.regime} name={r.nom} data={modele.regimes.pca.points.filter((p) => p[2] === r.regime).map((p) => ({ x: p[0], y: p[1] }))} fill={CATEG[r.regime]} fillOpacity={0.55} isAnimationActive={false} />)}
                  </ScatterChart></ResponsiveContainer></div></div>
              </div>
            </section>
            <section className="dd-panel dd-full" aria-label="Trajectory shapes">
              <div className="dd-sec-head"><Def def="Each curve is the centre of a group of territories whose 2003–2025 series has the same shape (log, 3-year smoothing, standardized per territory so that only the shape counts). Units: standard deviations from the territory's own mean."><span className="dd-sec-title">Context · trajectory shapes · k-means, k = {modele.trajectoires.k}</span></Def></div>
              <div className="dd-chart"><ResponsiveContainer width="100%" height="100%"><ComposedChart data={trajData} margin={{ top: 6, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="rgba(15,23,42,.12)" strokeDasharray="2 2" vertical={false} /><XAxis dataKey="y" tick={{ fontSize: 10, fill: "#000" }} tickLine={false} /><YAxis tick={{ fontSize: 10, fill: "#000" }} width={30} /><ReferenceLine y={0} stroke="#475569" strokeDasharray="4 3" />
                {modele.trajectoires.centres.map((c) => <Line key={c.trajectoire} dataKey={`t${c.trajectoire}`} name={c.nom} stroke={CATEG[c.trajectoire]} strokeWidth={2.2} dot={false} isAnimationActive={false} />)}
                <Tooltip contentStyle={tip} /></ComposedChart></ResponsiveContainer></div>
              <div className="dd-chart-leg">{modele.trajectoires.centres.map((c) => <span key={c.trajectoire}><i className="td-sw" style={{ background: CATEG[c.trajectoire] }} />{c.nom} · {n0(modele.trajectoires.tailles[String(c.trajectoire)])} territories</span>)}</div>
            </section>
          </>
        )}
      </div>
      <p className="dd-foot">NASA FIRMS MODIS &amp; VIIRS active fires, harmonized by VIGIL-K1 (same files as the Analytics view). Hubs computed on {n0(R.hexagones_mois)} hexagon-months, {hubs.annees[0]}–{hubs.annees[1]} (complete years). Generated {hubs.genere_le}.</p>
    </div>
  );
}

function Kpi({ l, v, s, d }: { l: string; v: string; s: string; d: string }) {
  return <div className="dd-kpi"><Def def={d}><span className="dd-kpi-lbl">{l}</span></Def><span className="dd-kpi-val">{v}</span><span className="dd-kpi-sub">{s}</span></div>;
}

const TD_CSS = `
.td-scroll{max-height:420px;overflow:auto}
.td-hubs tbody tr{cursor:pointer}
.td-hubs tbody tr:hover,.td-hubs tbody tr:focus-visible{background:rgba(15,23,42,.06);outline:none}
.td-tri{cursor:pointer}
.td-tri.on{color:var(--or)!important}
.td-chip{display:inline-block;min-width:30px;text-align:center;border-radius:999px;padding:1px 6px;font-weight:700;box-shadow:inset 0 0 0 1px rgba(15,23,42,.15)}
.td-spark{display:inline-flex;align-items:flex-end;gap:1px;height:16px;width:92px}
.td-spark i{flex:1;border-radius:1px 1px 0 0}
.td-steps{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:5px;font-size:12px;line-height:1.45}
.td-two{display:grid;grid-template-columns:minmax(0,1.7fr) minmax(0,1fr);gap:10px}
.td-sw{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}
@media (max-width:1100px){.td-two{grid-template-columns:minmax(0,1fr)}}
`;
