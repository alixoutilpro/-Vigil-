"""Harmonized fire history per H3 res-4 cell, from the site files of the Analytics view (public/data, contract v2).

    python -m pipeline.tf.table

Reads h3_5/mois/YYYY-MM.bin.gz (H3 res-5 x month, harmonized hotspots and FRP), sums the res-5 hexagons into their
res-4 parent (exact: H3 is hierarchical by index) and writes in <cache>:
    feux_mois.parquet     cell x year x month (only months with fire)
    cellules.parquet      every analysed cell: land cells (centre in a Natural Earth country) and cells with fire;
                          centre, area, country
Nothing else is used: the Trends & Forecasts view rests on exactly the same harmonized data as the Analytics view.
"""
import argparse
import gzip
import json
import os
import sys

import numpy as np
import pandas as pd

from . import parametres as P

ENR_MOIS = np.dtype([("h3", "<u8"), ("hotspots", "<f4"), ("frp", "<f4")])


def lire_mois(site):
    """All month files -> DataFrame h3 (res 5, uint64), an, mois, hotspots, frp."""
    index = json.load(open(os.path.join(site, "index.json"), encoding="utf-8"))
    blocs = []
    for m in index["mois"]:
        a = np.frombuffer(gzip.open(os.path.join(site, "h3_5", "mois", m + ".bin.gz")).read(), ENR_MOIS)
        blocs.append(pd.DataFrame({"h3": a["h3"], "an": np.int16(int(m[:4])), "mois": np.int8(int(m[5:])),
                                   "hotspots": a["hotspots"].astype("f8"), "frp": a["frp"].astype("f8")}))
    return pd.concat(blocs, ignore_index=True), index


def parents(h3_ints, res=P.RES):
    """Parent cell (uint64) of every distinct res-5 hexagon."""
    import h3
    u = np.unique(h3_ints)
    return pd.Series([h3.str_to_int(h3.cell_to_parent(h3.int_to_str(int(c)), res)) for c in u], index=u, dtype="uint64")


def table_mensuelle(M, res=P.RES):
    p = parents(M["h3"].to_numpy(), res)
    M = M.assign(cellule=M["h3"].map(p).astype("uint64"))
    return M.groupby(["cellule", "an", "mois"], as_index=False)[["hotspots", "frp"]].sum()


def cellules_terre(frontieres, res=P.RES):
    """Every H3 cell whose centre lies in a Natural Earth country polygon (Antarctica left out) -> (cells, country names)."""
    import h3
    import shapely
    from shapely.geometry import shape
    gj = json.load(open(frontieres, encoding="utf-8"))
    ft = [f for f in gj["features"] if f["properties"].get("ADMIN") != "Antarctica"]
    geoms = [shape(f["geometry"]) for f in ft]
    noms = np.array([f["properties"].get("ADMIN") or f["properties"].get("NAME") for f in ft], object)
    arbre = shapely.STRtree(geoms)
    tous = np.array([h3.str_to_int(c) for r0 in h3.get_res0_cells() for c in h3.cell_to_children(r0, res)], np.uint64)
    ll = np.array([h3.cell_to_latlng(h3.int_to_str(int(c))) for c in tous])
    pts = shapely.points(ll[:, 1], ll[:, 0])
    ip, ig = arbre.query(pts, predicate="within")
    pays = pd.Series(noms[ig], index=tous[ip])
    pays = pays[~pays.index.duplicated()]
    return pays.index.to_numpy("uint64"), pays, (arbre, geoms, noms)


def table_cellules(cellules_feu, frontieres):
    """Universe of the study: land cells and cells with fire. Centre (lat, lon), area (km2), country (Natural Earth)."""
    import h3
    import shapely
    terre, pays, (arbre, geoms, noms) = cellules_terre(frontieres)
    tous = np.unique(np.concatenate([np.asarray(cellules_feu, "uint64"), terre]))
    lat, lon, aire = [], [], []
    for c in tous:
        s = h3.int_to_str(int(c))
        la, lo = h3.cell_to_latlng(s)
        lat.append(la); lon.append(lo); aire.append(h3.cell_area(s, unit="km^2"))
    d = pd.DataFrame({"cellule": tous, "lat": np.array(lat, "f4"), "lon": np.array(lon, "f4"), "aire_km2": np.array(aire, "f4")})
    d["terre"] = d["cellule"].isin(set(terre.tolist()))
    d["feu"] = d["cellule"].isin(set(np.asarray(cellules_feu, "uint64").tolist()))
    d["pays"] = d["cellule"].map(pays)
    # fire cells whose centre is at sea (coast, islands): nearest country polygon
    m = d["pays"].isna()
    if m.any():
        d.loc[m, "pays"] = noms[arbre.nearest(shapely.points(d.loc[m, "lon"].to_numpy("f8"), d.loc[m, "lat"].to_numpy("f8")))]
    return d


def annuel(F, cellules, an0=P.AN0, an1=P.AN1):
    """Dense matrix cells x complete years of annual harmonized hotspots (0 = observed without fire)."""
    a = F[(F["an"] >= an0) & (F["an"] <= an1)].groupby(["cellule", "an"])["hotspots"].sum().unstack(fill_value=0.0)
    return a.reindex(index=cellules, columns=range(an0, an1 + 1), fill_value=0.0)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Vigil T&F - historique des feux par cellule H3 res 4")
    ap.add_argument("--site", default=P.SITE)
    ap.add_argument("--cache", default=P.CACHE)
    ap.add_argument("--frontieres", default=P.FRONTIERES)
    a = ap.parse_args(argv)
    os.makedirs(a.cache, exist_ok=True)
    M, index = lire_mois(a.site)
    F = table_mensuelle(M)
    C = table_cellules(F["cellule"].unique(), a.frontieres)
    F.to_parquet(os.path.join(a.cache, "feux_mois.parquet"), index=False)
    C.to_parquet(os.path.join(a.cache, "cellules.parquet"), index=False)
    ecart = abs(F["hotspots"].sum() - M["hotspots"].sum()) / M["hotspots"].sum()
    meta = {"site_genere_le": index["genere_le"], "methode": index["methode"], "mois": [index["mois"][0], index["mois"][-1]],
            "hexagones_res5": int(M["h3"].nunique()), "cellules": int(len(C)), "cellules_avec_feu": int(C["feu"].sum()),
            "cellules_terre": int(C["terre"].sum()), "controle_somme_res4_vs_res5_ecart_relatif": float(ecart)}
    json.dump(meta, open(os.path.join(a.cache, "table_meta.json"), "w", encoding="utf-8"), indent=1)
    print(json.dumps(meta, indent=1))


if __name__ == "__main__":
    sys.exit(main())
