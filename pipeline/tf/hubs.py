"""Vigil Trends: wildfire hubs found by space-time clustering of the harmonized hexagon-months (public/data).

    python -m pipeline.tf.hubs            # writes public/data/tf/hubs.json

Idea: the same number of detections means two different things. Spread evenly over the same months every year, it is
recurrent burning (mostly agricultural): expected, of little interest here. Packed in a few contiguous hexagons during
one or two months, far above what those hexagons usually show at that time of year, it is a wildfire episode.

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


def main(argv=None):
    ap = argparse.ArgumentParser(description="Vigil Trends - foyers d'incendie (clustering espace-temps)")
    ap.add_argument("--site", default=P.SITE)
    ap.add_argument("--cache", default=P.CACHE)
    a = ap.parse_args(argv)
    import h3
    t0 = time.time()
    M, index = lire_mois(a.site)
    partiel = index.get("mois_partiel", index["mois"][-1] if index["genere_le"][:7] == index["mois"][-1] else None)
    if partiel:
        M = M[~((M["an"] == int(partiel[:4])) & (M["mois"] == int(partiel[5:])))]
    M = M[M["hotspots"] > 0].copy()
    M["mi"] = (M["an"].astype(int) - 2002) * 12 + M["mois"].astype(int) - 1
    n_par_mois = M.drop_duplicates(["an", "mois"]).groupby("mois").size().to_dict()
    med = medianes_mois(M, n_par_mois)
    M = M.join(med, on=["h3", "mois"])
    B = M[(M["hotspots"] >= V_MIN) & (M["hotspots"] >= RATIO * (M["med"] + 1))].copy()
    print(f"[{time.time() - t0:.0f} s] {len(M):,} hexagones-mois avec feu, {len(B):,} sursauts ({100 * B['hotspots'].sum() / M['hotspots'].sum():.1f} % des detections)", flush=True)
    B = episodes(B)
    ep = B.groupby("episode").agg(detections=("hotspots", "sum"), frp=("frp", "sum"), hexagones=("h3", "nunique"), debut=("mi", "min"), fin=("mi", "max"))
    ep = ep[ep["detections"] >= EPISODE_MIN]
    B = B[B["episode"].isin(ep.index)]
    print(f"[{time.time() - t0:.0f} s] {len(ep):,} episodes >= {EPISODE_MIN:.0f} detections ; mediane {ep['hexagones'].median():.0f} hexagones, {(ep['fin'] - ep['debut'] + 1).median():.0f} mois", flush=True)

    C = B[(B["an"] >= P.AN0) & (B["an"] <= P.AN1)]
    E = C.groupby("h3")["hotspots"].sum()
    hub = decouper(E[E >= HEX_MIN])
    C = C.join(hub, on="h3", how="inner")
    annees = np.arange(P.AN0, P.AN1 + 1)
    Y = C.groupby(["hub", "an"])["hotspots"].sum().unstack(fill_value=0.0).reindex(columns=annees, fill_value=0.0)
    Y = Y[Y.sum(axis=1) >= HUB_MIN]
    C = C[C["hub"].isin(Y.index)]
    hub = hub[hub.isin(Y.index)]
    # confidence: bootstrap over years
    rng = np.random.default_rng(0)
    tirages = rng.integers(0, len(annees), size=(N_BOOT, len(annees)))
    y = Y.to_numpy()
    conf = np.mean([(y[:, t].sum(axis=1) >= HUB_MIN) for t in tirages], axis=0)
    # hub table
    aire = pd.Series({h: h3.cell_area(h3.int_to_str(int(h)), unit="km^2") for h in hub.index})
    ll = pd.DataFrame({h: h3.cell_to_latlng(h3.int_to_str(int(h))) for h in hub.index}, index=["lat", "lon"]).T
    g = pd.DataFrame({"hub": hub, "aire": aire, "lat": ll["lat"], "lon": ll["lon"], "expo": E.reindex(hub.index)})
    T = g.groupby("hub").agg(n=("aire", "size"), aire=("aire", "sum"))
    T["lat"] = g.groupby("hub").apply(lambda x: np.average(x["lat"], weights=x["expo"]), include_groups=False)
    T["lon"] = g.groupby("hub").apply(lambda x: np.degrees(np.arctan2(np.average(np.sin(np.radians(x["lon"])), weights=x["expo"]), np.average(np.cos(np.radians(x["lon"])), weights=x["expo"]))), include_groups=False)
    T = T.reindex(Y.index)
    T["detections"] = y.sum(axis=1)
    T["annees_episode"] = (y > 0).sum(axis=1)
    T["frequence"] = T["annees_episode"] / len(annees)
    T["densite"] = T["detections"] / T["aire"] * 1000 / len(annees)
    T["frp_det"] = (C.groupby("hub")["frp"].sum() / C.groupby("hub")["hotspots"].sum()).reindex(Y.index)
    T["confiance"] = conf
    T["composite"] = (rang_pct(T["frequence"]) + rang_pct(T["densite"]) + rang_pct(T["frp_det"])) / 3
    T["score"] = np.clip(np.ceil(100 * rang_pct(T["composite"])), 1, 100).astype(int)
    # usual (non-episodic) burning of the hub cells: share of all detections that is episodic
    tot = M[(M["an"] >= P.AN0) & (M["an"] <= P.AN1)].join(hub, on="h3", how="inner").groupby("hub")["hotspots"].sum()
    T["part_episodique"] = T["detections"] / tot.reindex(Y.index)
    pic = C.groupby(["hub", "episode"]).agg(d=("hotspots", "sum"), mi=("mi", "min")).reset_index().sort_values("d").drop_duplicates("hub", keep="last").set_index("hub")
    dern = C.groupby("hub")["mi"].max()
    cel = pd.read_parquet(os.path.join(a.cache, "cellules.parquet"), columns=["cellule", "pays"]).set_index("cellule")["pays"]
    ym = lambda mi: f"{2002 + int(mi) // 12}-{int(mi) % 12 + 1:02d}"
    hubs = []
    for hid, r in T.sort_values("score", ascending=False).iterrows():
        hs = g.index[g["hub"] == hid]
        parent = h3.str_to_int(h3.cell_to_parent(h3.latlng_to_cell(float(r["lat"]), float(r["lon"]), 5), P.RES))
        hubs.append({"id": int(hid), "lat": round(float(r["lat"]), 3), "lon": round(float(r["lon"]), 3), "pays": cel.get(parent, None) if parent in cel.index else None,
                     "h3": [format(int(h), "x") for h in hs], "aire_km2": round(float(r["aire"])), "score": int(r["score"]), "confiance": round(float(r["confiance"]), 3),
                     "annees_episode": int(r["annees_episode"]), "detections": round(float(r["detections"])), "densite": round(float(r["densite"]), 3),
                     "frp_det": round(float(r["frp_det"]), 1), "part_episodique": round(float(r["part_episodique"]), 3),
                     "pic": {"mois": ym(pic.loc[hid, "mi"]), "detections": round(float(pic.loc[hid, "d"]))}, "dernier": ym(dern.loc[hid]),
                     "serie": [round(float(v), 1) for v in Y.loc[hid].to_numpy()]})
    resume = {"hexagones_mois": int(len(M)), "sursauts": int(len(B)), "episodes": int(len(ep)), "hubs": len(hubs),
              "part_detections_episodiques": float(C["hotspots"].sum() / M[(M["an"] >= P.AN0) & (M["an"] <= P.AN1)]["hotspots"].sum()),
              "confiance_mediane": float(np.median(conf)), "hubs_confiance_90": int((conf >= 0.9).sum()),
              "taille_mediane_hexagones": float(T["n"].median()), "annees_episode_mediane": float(T["annees_episode"].median())}
    out = {"genere_le": datetime.now().isoformat(timespec="seconds"), "site_genere_le": index["genere_le"], "annees": [P.AN0, P.AN1],
           "parametres": {"v_min": V_MIN, "ratio": RATIO, "episode_min": EPISODE_MIN, "hex_min": HEX_MIN, "hub_min": HUB_MIN, "taille_max": TAILLE_MAX, "n_boot": N_BOOT, "h3_resolution": 5},
           "resume": resume, "hubs": hubs}
    ch = os.path.join(a.site, "tf", "hubs.json")
    os.makedirs(os.path.dirname(ch), exist_ok=True)
    with open(ch, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    print(json.dumps(resume, indent=1), f"\n{ch} : {os.path.getsize(ch) / 1e6:.1f} Mo, {time.time() - t0:.0f} s")
    gr = [h for h in hubs if h["pays"] == "Greece"]
    print("Grece :", len(gr), "hubs ;", [(h["lat"], h["lon"], h["score"], h["confiance"], h["annees_episode"], h["pic"]["mois"], h["pic"]["detections"]) for h in gr[:12]])


if __name__ == "__main__":
    sys.exit(main())
