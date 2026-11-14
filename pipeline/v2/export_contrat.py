"""Export data/data.json for the web app, in the EXISTING contract the frontend already reads.

Usage (from the repo root, after `mondial agreger` and `mondial calibrer`):
    python -m pipeline.v2.export_contrat                      # Greece, through 2026-10
    python -m pipeline.v2.export_contrat --pays Greece --fin 2026-10 --sortie data/data.json

One row per 0.25 deg cell x month with at least one detection (any sensor). Field names are the frozen
contract (pipeline/config.py OUTPUT_COLUMNS, app/Vigil.tsx ContractRow); their CONTENT in v2 is:
    modis_fire_days       Aqua MODIS hotspot COUNT of the month (vegetation, nominal+high confidence)
    viirs_fire_days       VIIRS hotspot COUNT (S-NPP; NOAA-20 on days without S-NPP), null before 2012-02
    harmonized_fire_days  VIGIL-K1 hotspot count, MODIS-Aqua equivalent (= Aqua before 2020-11,
                          converted VIIRS after) -- same value as carte_cellules_mois.parquet
    harmonized_low/high   80 % split-conformal band (country-month quantiles by size class; NOT
                          validated at cell scale); equal to the value when Aqua is observed
    iso_year/iso_week     ISO week containing the 15th of the month (its Thursday is in that month,
                          so the app's isoWeekMonth() maps it back to the right month)
    land_cover_class      "other" (no land-cover source is connected)
    source                modis_only (< 2012-02) | both (2012-02 .. 2020-10) | viirs_converted (>= 2020-11)
Only complete months are exported (--fin), so a partial current month never looks like an anomaly.
"""
import argparse
import json
import os
from datetime import date

import duckdb
import numpy as np
import pandas as pd

from . import parametres as P
from .harmonisation import BASCULE, CLASSES, NOMS_CLASSES

DEBUT_VIIRS = pd.Timestamp("2012-02-01")
NIVEAU = "0.8"


def semaine_iso(annee, mois):
    """ISO (year, week) of the 15th of the month."""
    y, w, _ = date(int(annee), int(mois), 15).isocalendar()
    return y, w


def source(annee, mois):
    d = pd.Timestamp(int(annee), int(mois), 1)
    return "modis_only" if d < DEBUT_VIIRS else ("both" if d < BASCULE else "viirs_converted")


def bornes(valeur, convertie, quantiles):
    """80 % band in log(1+x) space by size class; no band when Aqua is observed."""
    v = np.asarray(valeur, float)
    cl = pd.cut(v, CLASSES, labels=NOMS_CLASSES).astype(str)
    qb = np.array([quantiles[c]["q_bas"] for c in cl])
    qh = np.array([quantiles[c]["q_haut"] for c in cl])
    bas = np.where(convertie, np.maximum(np.expm1(np.log1p(v) + qb), 0), v)
    haut = np.where(convertie, np.expm1(np.log1p(v) + qh), v)
    return bas, haut


def construire(dossier, pays, fin):
    fa, fm = (int(x) for x in fin.split("-"))
    filtre = f"pays = '{pays}' AND (annee < {fa} OR (annee = {fa} AND mois <= {fm}))"
    cel = os.path.join(dossier, "cellule", "*.parquet").replace("\\", "/")
    carte = os.path.join(dossier, "carte_cellules_mois.parquet").replace("\\", "/")
    con = duckdb.connect()
    brut = con.sql(f"""
        SELECT lat_c, lon_c, annee, mois,
               sum(CASE WHEN satellite = 'Aqua' THEN n_vegetation ELSE 0 END) AS modis,
               sum(CASE WHEN (satellite = 'SNPP' AND NOT jour_sans_snpp)
                          OR (satellite = 'NOAA20' AND jour_sans_snpp) THEN n_vegetation ELSE 0 END) AS viirs
        FROM read_parquet('{cel}')
        WHERE {filtre} AND annee >= 2002
        GROUP BY ALL""").df()
    harm = con.sql(f"SELECT lat_c, lon_c, annee, mois, sum(valeur) AS harm FROM read_parquet('{carte}') "
                   f"WHERE {filtre} GROUP BY ALL").df()
    d = brut.merge(harm, on=["lat_c", "lon_c", "annee", "mois"], how="outer").fillna({"modis": 0, "viirs": 0, "harm": 0.0})
    d = d[(d["modis"] > 0) | (d["viirs"] > 0) | (d["harm"] > 0)].sort_values(["lat_c", "lon_c", "annee", "mois"])
    return d.reset_index(drop=True)


def en_contrat(d, quantiles):
    debut_mois = pd.to_datetime(dict(year=d["annee"], month=d["mois"], day=1))
    convertie = (debut_mois >= BASCULE).to_numpy()
    bas, haut = bornes(d["harm"], convertie, quantiles)
    iso = [semaine_iso(a, m) for a, m in zip(d["annee"], d["mois"])]
    lignes = []
    for i, r in enumerate(d.itertuples(index=False)):
        avant_viirs = debut_mois.iloc[i] < DEBUT_VIIRS
        lignes.append({
            "cell_id": f"{round(r.lat_c * 100)}_{round(r.lon_c * 100)}",
            "lat": round(float(r.lat_c), 3), "lon": round(float(r.lon_c), 3),
            "iso_year": iso[i][0], "iso_week": iso[i][1],
            "modis_fire_days": int(r.modis),
            "viirs_fire_days": None if avant_viirs else int(r.viirs),
            "harmonized_fire_days": round(float(r.harm), 2),
            "harmonized_low": round(float(bas[i]), 2), "harmonized_high": round(float(haut[i]), 2),
            "land_cover_class": "other",
            "source": source(r.annee, r.mois),
        })
    return lignes


def main(argv=None):
    ap = argparse.ArgumentParser(description="Vigil v2 - export of data/data.json (frontend contract)")
    ap.add_argument("--pays", default="Greece")
    ap.add_argument("--fin", default="2026-10", help="last complete month exported, YYYY-MM")
    ap.add_argument("--sortie", default=os.path.join("data", "data.json"))
    ap.add_argument("--dossier", default=os.path.join(P.DOSSIER_SORTIE, "monde"))
    a = ap.parse_args(argv)
    with open(os.path.join(a.dossier, "rapport_mondial.json"), encoding="utf-8") as f:
        quantiles = json.load(f)["incertitude"]["quantiles"][NIVEAU]
    d = construire(a.dossier, a.pays, a.fin)
    lignes = en_contrat(d, quantiles)
    with open(a.sortie, "w", encoding="utf-8") as f:
        json.dump(lignes, f, separators=(",", ":"))
    print(f"{len(lignes)} lignes, {d[['lat_c', 'lon_c']].drop_duplicates().shape[0]} cases, "
          f"{d['annee'].min()}-{d['annee'].max()} -> {a.sortie} ({os.path.getsize(a.sortie) / 1e6:.2f} Mo)")


if __name__ == "__main__":
    main()
