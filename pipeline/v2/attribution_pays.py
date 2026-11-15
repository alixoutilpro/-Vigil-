"""Country of a detection that comes without one (FIRMS 'World' form files, 2026).

Rule (chosen by etudes/attribution_pays_2026.py, validated on 2021 and 2025 where FIRMS gives the country):
  1. Point-in-polygon on Natural Earth admin-0 (pinned v5.1.2), on the 0.01 deg cell centre of the point (~1 km).
     Each polygon PART (a multipolygon is split: mainland, islands, overseas territories) is mapped to the FIRMS
     country name that holds the majority of the historical FIRMS detections inside it (data-driven name mapping,
     so Natural Earth and FIRMS naming never have to agree). A point outside every polygon but closer than
     TOLERANCE_COTE_KM to one takes the nearest part (coastline generalisation).
  2. Otherwise (at sea, or a part with no history): country of the same 0.25 deg cell in the FIRMS yearly files,
     else the majority country of the H3 res-3 parent of that cell centre (~12,400 km2).
  3. Otherwise 'inconnu' (counted and reported, never silently dropped).
"""
import json

import numpy as np
import pandas as pd
import shapely
from shapely.geometry import shape

PAS = 0.01            # degrees, attribution grid (~1.1 km): border error < ~0.7 km
KM_PAR_DEGRE = 111.2
CELLULE = 0.25        # degrees, grid of the 'cellule' tables (fallback 2)
H3_SECOURS = 3


def charger_parties(chemin):
    """Natural Earth admin-0 split into polygon parts -> (geoms array, ADMIN name of each part, STRtree)."""
    with open(chemin, encoding="utf-8") as f:
        gj = json.load(f)
    geoms, admin = [], []
    for ft in gj["features"]:
        g = shape(ft["geometry"])
        for p in getattr(g, "geoms", [g]):
            geoms.append(p)
            admin.append(ft["properties"]["ADMIN"])
    geoms = np.array(geoms, dtype=object)
    shapely.prepare(geoms)
    return geoms, np.array(admin, dtype=object), shapely.STRtree(geoms)


TUILE = 0.25          # degrees, speed-up: a tile lying entirely inside one part gives that part to all its points


def localiser(lat, lon, parties, tolerance_km):
    """Index of the polygon part containing each point (else nearest part within tolerance, else -1), and a coastal flag.
    Exact result; for speed, points of a TUILE x TUILE tile that lies entirely within one part get it without a test."""
    geoms, _, arbre = parties
    lat, lon = np.asarray(lat, float), np.asarray(lon, float)
    idx = np.full(len(lat), -1, dtype=np.int64)
    ti, tj = np.floor(lat / TUILE).astype(np.int64), np.floor(lon / TUILE).astype(np.int64)
    tuiles, inv = np.unique(np.stack([ti, tj], 1), axis=0, return_inverse=True)
    boites = shapely.box(tuiles[:, 1] * TUILE, tuiles[:, 0] * TUILE, (tuiles[:, 1] + 1) * TUILE, (tuiles[:, 0] + 1) * TUILE)
    i_b, i_g = arbre.query(boites, predicate="within")
    part_tuile = np.full(len(tuiles), -1, dtype=np.int64)
    part_tuile[i_b] = i_g
    idx[:] = part_tuile[inv.ravel()]
    a_tester = np.flatnonzero(idx < 0)
    pts = shapely.points(lon[a_tester], lat[a_tester])
    i_pt, i_geom = arbre.query(pts, predicate="intersects")
    i_pt = a_tester[i_pt]
    pts = shapely.points(lon, lat)
    # a point exactly on a shared border hits two parts: keep the first one (deterministic, tree order)
    premier = np.unique(i_pt, return_index=True)[1]
    idx[i_pt[premier]] = i_geom[premier]
    reste = np.flatnonzero(idx < 0)
    cotier = np.zeros(len(pts), dtype=bool)
    if len(reste) and tolerance_km > 0:
        j_pt, j_geom = arbre.query_nearest(pts[reste], max_distance=tolerance_km / KM_PAR_DEGRE)
        premier = np.unique(j_pt, return_index=True)[1]
        idx[reste[j_pt[premier]]] = j_geom[premier]
        cotier[reste[j_pt[premier]]] = True
    return idx, cotier


def apprendre_correspondance(lat, lon, pays, poids, parties, tolerance_km):
    """Part index -> FIRMS country (weighted majority of historical detections); parts without history take the
    majority of their Natural Earth country (ADMIN). Returns (Series part -> pays, quality table)."""
    _, admin, _ = parties
    idx, _ = localiser(lat, lon, parties, tolerance_km)
    d = pd.DataFrame({"part": idx, "pays": pays, "w": poids})
    d = d[d["part"] >= 0]
    d["admin"] = admin[d["part"].to_numpy()]
    par_part = d.groupby(["part", "pays"])["w"].sum().reset_index()
    tot = par_part.groupby("part")["w"].transform("sum")
    par_part["part_majoritaire"] = par_part["w"] / tot
    maj = par_part.sort_values("w").drop_duplicates("part", keep="last").set_index("part")
    corr = maj["pays"]
    par_admin = d.groupby(["admin", "pays"])["w"].sum().reset_index().sort_values("w").drop_duplicates("admin", keep="last")
    adm = par_admin.set_index("admin")["pays"]
    sans = np.setdiff1d(np.arange(len(admin)), corr.index.to_numpy())
    corr = pd.concat([corr, pd.Series(adm.reindex(admin[sans]).to_numpy(), index=sans)]).dropna()
    qualite = maj[["pays", "w", "part_majoritaire"]].assign(admin=admin[maj.index.to_numpy()])
    return corr.sort_index(), qualite


def attribuer_polygone(lat, lon, parties, corr, tolerance_km):
    """FIRMS country from the polygon rule (None where it does not apply) and the level used."""
    idx, cotier = localiser(lat, lon, parties, tolerance_km)
    pays = pd.Series(idx).map(corr).to_numpy(dtype=object)
    pays[idx < 0] = None
    niveau = np.where(pd.isna(pays), "", np.where(cotier, "polygone_cotier", "polygone"))
    return pays, niveau


def sql_secours(ref_sql, table_points, lat="lat_c", lon="lon_c"):
    """SQL adding pays_secours to `table_points` (columns lat, lon = 0.25 deg cell centres): cell history, then the
    H3 res-3 parent majority. `ref_sql` = relation (pays, lat_c, lon_c, n) of historical FIRMS detections.
    Needs the DuckDB 'h3' extension loaded."""
    return f"""WITH ref AS ({ref_sql}),
        rc AS (SELECT lat_c, lon_c, arg_max(pays, n) pays FROM (SELECT lat_c, lon_c, pays, sum(n) n FROM ref GROUP BY ALL) GROUP BY ALL),
        rh AS (SELECT p, arg_max(pays, n) pays FROM
               (SELECT h3_latlng_to_cell(lat_c, lon_c, {H3_SECOURS}) p, pays, sum(n) n FROM ref GROUP BY ALL) GROUP BY ALL)
        SELECT t.*, rc.pays AS pays_cellule, rh.pays AS pays_h3 FROM {table_points} t
        LEFT JOIN rc ON rc.lat_c = t.{lat} AND rc.lon_c = t.{lon}
        LEFT JOIN rh ON rh.p = h3_latlng_to_cell(t.{lat}, t.{lon}, {H3_SECOURS})"""


def centre_cellule(x, pas):
    return np.floor(np.asarray(x, float) / pas) * pas + pas / 2


def attribuer(con, lat, lon, parties, corr, ref_sql, tolerance_km):
    """Full rule for arrays of points (lat, lon): returns (pays, niveau) arrays.
    niveau in {polygone, polygone_cotier, cellule_0.25, h3_res3, inconnu}."""
    pays, niveau = attribuer_polygone(lat, lon, parties, corr, tolerance_km)
    reste = np.flatnonzero(pd.isna(pays))
    if len(reste):
        t = pd.DataFrame({"k": reste, "lat_c": centre_cellule(np.asarray(lat)[reste], CELLULE),
                          "lon_c": centre_cellule(np.asarray(lon)[reste], CELLULE)})
        con.register("pts_secours", t)
        s = con.sql(sql_secours(ref_sql, "pts_secours")).df().set_index("k").loc[reste]
        con.unregister("pts_secours")
        p2 = np.where(s["pays_cellule"].notna(), s["pays_cellule"], np.where(s["pays_h3"].notna(), s["pays_h3"], "inconnu"))
        n2 = np.where(s["pays_cellule"].notna(), "cellule_0.25", np.where(s["pays_h3"].notna(), "h3_res3", "inconnu"))
        pays[reste], niveau[reste] = p2, n2
    return pays.astype(object), niveau
