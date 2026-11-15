"""Vigil Trends: wildfire hubs found by space-time clustering of the harmonized hexagon-months (public/data).

    python -m pipeline.tf.hubs            # writes public/data/tf/hubs.json

Idea: the same number of detections means two different things. Spread evenly over the same months every year, it is
recurrent burning (mostly agricultural): expected, of little interest here. Packed in a few contiguous hexagons during
one or two months, far above what those hexagons usually show at that time of year, it is a wildfire episode.

Before anything: hexagons of fixed sites and active volcanoes are left out (pipeline/tf/sites_fixes.py), only complete
years are used, and counts are put on a common footing across latitudes for every ABSOLUTE threshold: a polar-orbiting
satellite sees a place about 1 / cos(latitude) times more often than at the equator (swath overlap), so the same fire
yields ~2 times more detections at 60 degrees. Thresholds and the density of the score use detections x cos(latitude)
/ cos(LAT_REF) (counts as they would be seen at LAT_REF); the numbers shown (detections, largest episode, yearly series) stay the real harmonized counts.

Method (every threshold is a named constant below; sensitivity in docs/methode_tf.md):
 1. Burst. A hexagon-month (H3 res 5, ~250 km2) is a burst when its harmonized detections v are both large (v >= V_MIN)
    and unusual for that hexagon AND that calendar month: v >= RATIO x (median of the same month over all years + 1).
    A field burnt every March has a high March median, so it never bursts: the time dimension removes regular burning.
 2. Episode = connected component of bursts in space-time: two bursts are linked when their hexagons are identical or
    neighbours (H3 ring 1) and their months identical or consecutive. Episodes under EPISODE_MIN detections are dropped.
 3. Exposure of a hexagon = detections of its bursts inside kept episodes, 2003-2025 (complete years).
 4. Hub = connected group of exposed hexagons (exposure >= HEX_MIN). A group larger than TAILLE_MAX hexagons is split
    by keeping only its upper half of exposure, again and again: a hub stays local (<= ~80 km across).
 5. Score 1-100 = percentile rank, among all hubs, of the mean of three percentile ranks: how often (share of years
    with an episode), how much (episode detections per 1,000 km2 per year) and how intense (FRP per detection).
 6. Confidence = bootstrap over years: the 23 years are resampled with replacement N_BOOT times; confidence is the
    share of resamples in which the hub still passes the detection rule. A hub resting on one single year gets ~64 %.
"""
import argparse
import json
import os
import sys
import time
from datetime import datetime

import numpy as np
import pandas as pd
from scipy import sparse
from scipy.sparse.csgraph import connected_components

from . import parametres as P
from .table import lire_mois

V_MIN = 10.0          # detections (MODIS-Aqua eq.) of a hexagon-month to be a burst
RATIO = 4.0           # times (median of the same calendar month + 1)
EPISODE_MIN = 50.0    # detections of an episode
HEX_MIN = 20.0        # exposure of a hexagon to enter a hub
HUB_MIN = 100.0       # exposure of a hub
TAILLE_MAX = 19       # hexagons (a ring-2 disk: ~4,800 km2)
N_BOOT = 500
LAT_MAX = 70.0        # the 1 / cos(latitude) law is not used beyond this latitude (weight kept constant)
LAT_REF = 40.0        # thresholds are expressed in detections as seen at this latitude: the one where the method was
                      # checked against documented fires (Greece). The choice moves no ranking, only where the bar sits.


def medianes_mois(M, n_par_mois):
    """Median of each (hexagon, calendar month) over all years, months without fire counted as 0."""
    g = M.groupby(["h3", "mois"])["hotspots"]
    k = g.size()
    n = k.index.get_level_values("mois").map(n_par_mois).to_numpy()
    med = pd.Series(0.0, index=k.index)
    plein = k.to_numpy() > n / 2                      # otherwise more than half of the years are 0: median 0
    if plein.any():
        cles = k.index[plein]
        sous = M.set_index(["h3", "mois"]).loc[M.set_index(["h3", "mois"]).index.isin(cles)]
        def m(x):
            nn = n_par_mois[x.name[1]]
            v = np.sort(np.concatenate([np.zeros(nn - len(x)), x.to_numpy()]))
            return float(np.median(v))
        med.loc[cles] = sous.groupby(level=[0, 1])["hotspots"].apply(m).reindex(cles).to_numpy()
    return med.rename("med")


def voisins_hex(hexs):
    """DataFrame (h3, v): every hexagon with itself and its ring-1 neighbours that are in `hexs`."""
    import h3
    present = set(int(x) for x in hexs)
    a, b = [], []
    for x in present:
        a.append(x); b.append(x)
        for v in h3.grid_ring(h3.int_to_str(x), 1):
            vi = h3.str_to_int(v)
            if vi in present:
                a.append(x); b.append(vi)
    return pd.DataFrame({"h3": np.array(a, np.uint64), "v": np.array(b, np.uint64)})


def composantes(n, i, j):
    g = sparse.coo_matrix((np.ones(len(i), bool), (i, j)), shape=(n, n))
    return connected_components(g, directed=False)[1]


def episodes(B):
    """B: bursts (h3, mi, hotspots, frp). Adds the episode id (space-time connected component)."""
    B = B.reset_index(drop=True)
    B["noeud"] = np.arange(len(B))
    V = voisins_hex(B["h3"].unique())
    x = B[["h3", "mi", "noeud"]].merge(V, on="h3")
    cible = B[["h3", "mi", "noeud"]].rename(columns={"h3": "v", "noeud": "n2"})
    e0 = x.merge(cible, on=["v", "mi"])                                   # same month, same or neighbour hexagon
    e1 = x.assign(mi=x["mi"] + 1).merge(cible, on=["v", "mi"])            # next month
    i = np.concatenate([e0["noeud"].to_numpy(), e1["noeud"].to_numpy()])
    j = np.concatenate([e0["n2"].to_numpy(), e1["n2"].to_numpy()])
    B["episode"] = composantes(len(B), i, j)
    return B.drop(columns="noeud")


def decouper(E, taille_max=TAILLE_MAX):
    """E: Series exposure per hexagon (>= HEX_MIN). Returns Series hub id per hexagon (hexagons dropped by a split are absent)."""
    out, suivant, pile = {}, 0, [E]
    while pile:
        e = pile.pop()
        V = voisins_hex(e.index.to_numpy())
        pos = pd.Series(np.arange(len(e)), index=e.index)
        lab = composantes(len(e), pos.reindex(V["h3"]).to_numpy(), pos.reindex(V["v"]).to_numpy())
        for c in np.unique(lab):
            sous = e[lab == c]
            if len(sous) <= taille_max:
                for h in sous.index:
                    out[h] = suivant
                suivant += 1
            else:
                garde = sous[sous > sous.median()]
                if len(garde) == len(sous) or len(garde) == 0:      # all equal: keep the strongest taille_max
                    garde = sous.sort_values(ascending=False).iloc[:taille_max]
                pile.append(garde)
    return pd.Series(out, name="hub")


def rang_pct(x):
    return pd.Series(x).rank(pct=True).to_numpy()


def poids_latitude(hexs):
    """Weight cos(latitude) / cos(LAT_REF) of each hexagon (latitude clamped at LAT_MAX): detections as they would be
    counted at LAT_REF, where satellites pass 1 / cos(LAT_REF) times more often than at the equator."""
    import h3
    return pd.Series({int(h): float(np.cos(np.radians(min(abs(h3.cell_to_latlng(h3.int_to_str(int(h)))[0]), LAT_MAX))) / np.cos(np.radians(LAT_REF))) for h in hexs})


def detecter(M, an0=P.AN0, an1=P.AN1, normaliser=True):
    """Bursts -> episodes -> hubs on the hexagon-months M (h3, an, mois, hotspots, frp) of the complete years an0..an1.
    Returns a dict: M (with med, w), n_bruts, B (bursts kept in an episode, with hub when in one), ep, hub, Y (weighted), Yb (raw)."""
    M = M[(M["an"] >= an0) & (M["an"] <= an1) & (M["hotspots"] > 0)].copy()
    M["mi"] = (M["an"].astype(int) - 2002) * 12 + M["mois"].astype(int) - 1
    med = medianes_mois(M, {m: an1 - an0 + 1 for m in range(1, 13)})
    M = M.join(med, on=["h3", "mois"])
    M["w"] = M["hotspots"] * (M["h3"].map(poids_latitude(M["h3"].unique())) if normaliser else 1.0)
    B = M[(M["w"] >= V_MIN) & (M["hotspots"] >= RATIO * (M["med"] + 1))].copy()
    n_bruts = len(B)
    B = episodes(B)
    ep = B.groupby("episode").agg(w=("w", "sum"), detections=("hotspots", "sum"), hexagones=("h3", "nunique"), debut=("mi", "min"), fin=("mi", "max"))
    ep = ep[ep["w"] >= EPISODE_MIN]
    B = B[B["episode"].isin(ep.index)]
    E = B.groupby("h3")["w"].sum()
    hub = decouper(E[E >= HEX_MIN])
    C = B.join(hub, on="h3", how="inner")
    annees = np.arange(an0, an1 + 1)
    Y = C.groupby(["hub", "an"])["w"].sum().unstack(fill_value=0.0).reindex(columns=annees, fill_value=0.0)
    Y = Y[Y.sum(axis=1) >= HUB_MIN]
    C = C[C["hub"].isin(Y.index)]
    hub = hub[hub.isin(Y.index)]
    Yb = C.groupby(["hub", "an"])["hotspots"].sum().unstack(fill_value=0.0).reindex(index=Y.index, columns=annees, fill_value=0.0)
    return {"M": M, "n_bruts": n_bruts, "B": B, "C": C, "ep": ep, "hub": hub, "E": E, "Y": Y, "Yb": Yb, "annees": annees}


def main(argv=None):
    ap = argparse.ArgumentParser(description="Vigil Trends - foyers d'incendie (clustering espace-temps)")
    ap.add_argument("--site", default=P.SITE)
    ap.add_argument("--cache", default=P.CACHE)
    ap.add_argument("--sans-latitude", action="store_true", help="sensitivity run: no cos(latitude) weighting of the thresholds")
    ap.add_argument("--sans-exclusion", action="store_true", help="sensitivity run: keep fixed sites and volcanoes")
    ap.add_argument("--sortie", default=None, help="write the result here instead of <site>/tf/hubs.json")
    a = ap.parse_args(argv)
    import h3
    from .sites_fixes import charger
    t0 = time.time()
    M, index = lire_mois(a.site)
    exclus, table_exclus = (set(), None) if a.sans_exclusion else charger()
    complet = (M["an"] >= P.AN0) & (M["an"] <= P.AN1)
    total = float(M.loc[complet, "hotspots"].sum())
    hors = M["h3"].isin(exclus)
    part_exclue = float(M.loc[complet & hors, "hotspots"].sum() / total)
    r = detecter(M[~hors], normaliser=not a.sans_latitude)
    M, B, C, ep, hub, E, Y, Yb, annees = r["M"], r["B"], r["C"], r["ep"], r["hub"], r["E"], r["Y"], r["Yb"], r["annees"]
    print(f"[{time.time() - t0:.0f} s] {len(M):,} hexagones-mois avec feu {P.AN0}-{P.AN1}, {len(exclus)} hexagones exclus ({100 * part_exclue:.2f} % des detections), "
          f"{r['n_bruts']:,} sursauts bruts, {len(B):,} dans {len(ep):,} episodes", flush=True)
    # confidence: bootstrap over years
    rng = np.random.default_rng(0)
    tirages = rng.integers(0, len(annees), size=(N_BOOT, len(annees)))
    y, yb = Y.to_numpy(), Yb.to_numpy()
    conf = np.mean([(y[:, t].sum(axis=1) >= HUB_MIN) for t in tirages], axis=0)
    # hub table
    aire = pd.Series({h: h3.cell_area(h3.int_to_str(int(h)), unit="km^2") for h in hub.index})
    ll = pd.DataFrame({h: h3.cell_to_latlng(h3.int_to_str(int(h))) for h in hub.index}, index=["lat", "lon"]).T
    g = pd.DataFrame({"hub": hub, "aire": aire, "lat": ll["lat"], "lon": ll["lon"], "expo": E.reindex(hub.index)})
    T = g.groupby("hub").agg(n=("aire", "size"), aire=("aire", "sum"))
    T["lat"] = g.groupby("hub").apply(lambda x: np.average(x["lat"], weights=x["expo"]), include_groups=False)
    T["lon"] = g.groupby("hub").apply(lambda x: np.degrees(np.arctan2(np.average(np.sin(np.radians(x["lon"])), weights=x["expo"]), np.average(np.cos(np.radians(x["lon"])), weights=x["expo"]))), include_groups=False)
    T = T.reindex(Y.index)
    T["detections"] = yb.sum(axis=1)                                   # real harmonized counts (shown)
    T["annees_episode"] = (yb > 0).sum(axis=1)
    T["frequence"] = T["annees_episode"] / len(annees)
    T["densite"] = y.sum(axis=1) / T["aire"] * 1000 / len(annees)      # equator-equivalent: comparable across latitudes (score)
    T["frp_det"] = (C.groupby("hub")["frp"].sum() / C.groupby("hub")["hotspots"].sum()).reindex(Y.index)
    T["confiance"] = conf
    T["composite"] = (rang_pct(T["frequence"]) + rang_pct(T["densite"]) + rang_pct(T["frp_det"])) / 3
    T["score"] = np.clip(np.ceil(100 * rang_pct(T["composite"])), 1, 100).astype(int)
    tot = M.join(hub, on="h3", how="inner").groupby("hub")["hotspots"].sum()
    T["part_episodique"] = T["detections"] / tot.reindex(Y.index)
    pic = C.groupby(["hub", "episode"]).agg(d=("hotspots", "sum"), mi=("mi", "min")).reset_index().sort_values("d").drop_duplicates("hub", keep="last").set_index("hub")
    dern = C.groupby("hub")["mi"].max()
    cel = pd.read_parquet(os.path.join(a.cache, "cellules.parquet"), columns=["cellule", "pays"]).set_index("cellule")["pays"]
    ym = lambda mi: f"{2002 + int(mi) // 12}-{int(mi) % 12 + 1:02d}"
    hubs = []
    for hid, r_ in T.sort_values("score", ascending=False).iterrows():
        hs = g.index[g["hub"] == hid]
        parent = h3.str_to_int(h3.cell_to_parent(h3.latlng_to_cell(float(r_["lat"]), float(r_["lon"]), 5), P.RES))
        hubs.append({"id": int(hid), "lat": round(float(r_["lat"]), 3), "lon": round(float(r_["lon"]), 3), "pays": cel.get(parent, None) if parent in cel.index else None,
                     "h3": [format(int(h), "x") for h in hs], "aire_km2": round(float(r_["aire"])), "score": int(r_["score"]), "confiance": round(float(r_["confiance"]), 3),
                     "annees_episode": int(r_["annees_episode"]), "detections": round(float(r_["detections"])), "densite": round(float(r_["densite"]), 3),
                     "frp_det": round(float(r_["frp_det"]), 1), "part_episodique": round(float(r_["part_episodique"]), 3),
                     "pic": {"mois": ym(pic.loc[hid, "mi"]), "detections": round(float(pic.loc[hid, "d"]))}, "dernier": ym(dern.loc[hid]),
                     "serie": [round(float(v), 1) for v in Yb.loc[hid].to_numpy()]})
    lat_abs = T["lat"].abs()
    resume = {"periode": [int(P.AN0), int(P.AN1)], "hexagones_mois": int(len(M)), "sursauts_bruts": int(r["n_bruts"]), "sursauts_en_episode": int(len(B)),
              "sursauts": int(len(B)), "episodes": int(len(ep)), "hubs": len(hubs),
              "hexagones_exclus": int(len(exclus)), "part_detections_exclues": part_exclue,
              "exclus_par_raison": ({} if table_exclus is None else {k: int(v) for k, v in table_exclus["raison"].value_counts().items()}),
              "part_detections_episodiques": float(C["hotspots"].sum() / total),
              "confiance_mediane": float(np.median(conf)), "hubs_confiance_90": int((conf >= 0.9).sum()), "hubs_confiance_95": int((conf >= 0.95).sum()),
              "hubs_par_latitude": {"<30": int((lat_abs < 30).sum()), "30-45": int(((lat_abs >= 30) & (lat_abs < 45)).sum()), ">=45": int((lat_abs >= 45).sum())},
              "taille_mediane_hexagones": float(T["n"].median()), "annees_episode_mediane": float(T["annees_episode"].median())}
    out = {"genere_le": datetime.now().isoformat(timespec="seconds"), "site_genere_le": index["genere_le"], "annees": [P.AN0, P.AN1],
           "parametres": {"v_min": V_MIN, "ratio": RATIO, "episode_min": EPISODE_MIN, "hex_min": HEX_MIN, "hub_min": HUB_MIN, "taille_max": TAILLE_MAX, "n_boot": N_BOOT, "h3_resolution": 5,
                          "normalisation_latitude": not a.sans_latitude, "lat_max": LAT_MAX, "lat_ref": LAT_REF, "exclusion_sites_fixes": not a.sans_exclusion},
           "resume": resume, "hubs": hubs}
    ch = a.sortie or os.path.join(a.site, "tf", "hubs.json")
    os.makedirs(os.path.dirname(ch), exist_ok=True)
    with open(ch, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    print(json.dumps(resume, indent=1), f"\n{ch} : {os.path.getsize(ch) / 1e6:.1f} Mo, {time.time() - t0:.0f} s")
    gr = [h for h in hubs if h["pays"] == "Greece"]
    print("Grece :", len(gr), "hubs ;", [(h["lat"], h["lon"], h["score"], h["confiance"], h["annees_episode"], h["pic"]["mois"], h["pic"]["detections"]) for h in gr[:12]])


if __name__ == "__main__":
    sys.exit(main())
