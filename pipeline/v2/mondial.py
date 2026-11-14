"""VIGIL-K1 at global scale: every country, same method as the Greece study.

Two commands (from the repo root):
    .\\.venv\\Scripts\\python.exe -m pipeline.v2.mondial agreger      # heavy pass, one file group at a time, resumable
    .\\.venv\\Scripts\\python.exe -m pipeline.v2.mondial calibrer     # k per country, validation, series (seconds)

agreger reads the FIRMS yearly country files once (DuckDB, memory-limited) and writes small tables:
    jour/<dir>_<year>.parquet    country x day x satellite x day/night counts   (calibration, daily switch)
    cellule/<dir>_<year>.parquet country x 0.25 deg cell x month x satellite x day/night x "day without S-NPP"
                                 (outage or after 2026-11-02: NOAA-20 replaces S-NPP on those days only)
    statique/<dir>_<year>.parquet 0.02 deg cells with their FIRMS 'type' counts (2023-2025 only, static mask)
The 2026 "World" form files get their country from the historical 0.25 deg cell -> country table and,
for NRT rows (no 'type'), the static-site mask validated on 2025.

Simplifications versus the Greece pipeline (measured there, documented in docs/methode_k.md):
near-duplicates are not removed (effect on k < 1 %); FIRMS country files define the country.
"""
import argparse
import glob
import json
import os
import time

import duckdb
import numpy as np
import pandas as pd
import shapely
from shapely.geometry import shape

from . import parametres as P
from .harmonisation import ALPHA, BASCULE, CLASSES, DEBUT_CALIB, FIN_CALIB, NIVEAU, NOMS_CLASSES

CELLULE = 0.25         # degrees, global map grid
CELLULE_MASQUE = 0.02  # degrees (~2 km), static-site mask grid
SAT_SQL = """CASE upper(trim(satellite))
    WHEN 'TERRA' THEN 'Terra' WHEN 'T' THEN 'Terra' WHEN 'AQUA' THEN 'Aqua' WHEN 'A' THEN 'Aqua'
    WHEN 'N' THEN 'SNPP' WHEN 'SNPP' THEN 'SNPP' WHEN 'N20' THEN 'NOAA20' WHEN '1' THEN 'NOAA20'
    WHEN 'N21' THEN 'NOAA21' ELSE NULL END"""
CONF_OK_SQL = """CASE WHEN sat IN ('Terra','Aqua') THEN TRY_CAST(confidence AS INTEGER) >= 30
    ELSE lower(trim(confidence)) IN ('n','h') END"""


def _liste(fichiers):
    return "[" + ",".join("'" + f.replace("'", "''") + "'" for f in fichiers) + "]"


def _brut(fichiers, pays_sql):
    """Normalized rows (no row dropped silently: invalid rows are kept with valide = false)."""
    return f"""
    WITH b AS (SELECT *, {pays_sql} AS pays FROM read_csv({_liste(fichiers)}, union_by_name=true,
                     all_varchar=true, filename=true, header=true)),
    n AS (SELECT pays, {SAT_SQL} AS sat, TRY_CAST(latitude AS DOUBLE) AS lat, TRY_CAST(longitude AS DOUBLE) AS lon,
                 TRY_CAST(acq_date AS DATE) AS d, upper(trim(daynight)) AS dn, confidence,
                 TRY_CAST("type" AS INTEGER) AS typ, filename FROM b)
    SELECT *, (sat IS NOT NULL AND lat BETWEEN -90 AND 90 AND lon BETWEEN -180 AND 180 AND d IS NOT NULL
               AND dn IN ('D','N')) AS valide, {CONF_OK_SQL} AS conf_ok FROM n"""


def _tables(con, source, sortie, nom, annee, pannes_snpp):
    """From a normalized relation 'source', write the jour / cellule / statique tables."""
    con.execute(f"CREATE OR REPLACE TEMP VIEW r AS {source}")
    con.execute(f"""COPY (SELECT pays, d AS acq_date, sat AS satellite, dn AS daynight,
            count(*) AS n_lignes, count(*) FILTER (NOT valide) AS n_invalides,
            count(*) FILTER (valide AND NOT conf_ok) AS n_confiance_basse,
            count(*) FILTER (valide AND conf_ok AND typ IN (1,3)) AS n_volcan_offshore,
            count(*) FILTER (valide AND conf_ok AND (typ = 2 OR statique_estime)) AS n_industriel,
            count(*) FILTER (valide AND conf_ok AND coalesce(typ, 0) = 0 AND NOT statique_estime) AS n_vegetation
        FROM r GROUP BY ALL) TO '{os.path.join(sortie, 'jour', nom)}' (FORMAT parquet)""")
    con.execute(f"""COPY (SELECT pays, floor(lat / {CELLULE}) * {CELLULE} + {CELLULE / 2} AS lat_c,
            floor(lon / {CELLULE}) * {CELLULE} + {CELLULE / 2} AS lon_c, year(d) AS annee, month(d) AS mois,
            sat AS satellite, dn AS daynight,
            (d > DATE '2026-11-02' OR d IN (SELECT unnest({pannes_snpp}::DATE[]))) AS jour_sans_snpp,
            count(*) FILTER (coalesce(typ, 0) = 0 AND NOT statique_estime) AS n_vegetation,
            count(*) FILTER (typ = 2 OR statique_estime) AS n_industriel
        FROM r WHERE valide AND conf_ok AND coalesce(typ, 0) IN (0, 2) GROUP BY ALL)
        TO '{os.path.join(sortie, 'cellule', nom)}' (FORMAT parquet)""")
    if annee is not None and annee >= 2023:
        con.execute(f"""COPY (SELECT CASE WHEN sat IN ('Terra','Aqua') THEN 'MODIS' ELSE 'VIIRS' END AS instrument,
                year(d) AS annee, floor(lat / {CELLULE_MASQUE})::BIGINT AS ilat, floor(lon / {CELLULE_MASQUE})::BIGINT AS ilon,
                count(*) AS n, count(*) FILTER (typ IN (1,2,3)) AS n_statique
            FROM r WHERE valide AND typ IS NOT NULL GROUP BY ALL)
            TO '{os.path.join(sortie, 'statique', nom)}' (FORMAT parquet)""")


def masque(sortie, annees_apprentissage, dilatation=1):
    """Static-site cells (0.02 deg) from FIRMS 'type', dilated by `dilatation` cells."""
    f = [p for p in glob.glob(os.path.join(sortie, "statique", "*.parquet")) if int(os.path.basename(p)[-12:-8]) in annees_apprentissage]
    s = pd.concat([pd.read_parquet(x) for x in f]).groupby(["ilat", "ilon"])[["n", "n_statique"]].sum()
    s = s[(s["n_statique"] >= P.MASQUE_MIN_DETECTIONS) & (s["n_statique"] / s["n"] >= P.MASQUE_PART_MIN)].reset_index()
    if dilatation:
        d = range(-dilatation, dilatation + 1)
        s = pd.concat([s[["ilat", "ilon"]].assign(ilat=s["ilat"] + a, ilon=s["ilon"] + b) for a in d for b in d])
    return s[["ilat", "ilon"]].drop_duplicates()


def agreger(a):
    sortie = os.path.join(a.sortie, "monde")
    for sd in ["jour", "cellule", "statique"]:
        os.makedirs(os.path.join(sortie, sd), exist_ok=True)
    con = duckdb.connect()
    con.execute(f"SET memory_limit='{a.memoire}'")
    con.execute(f"SET threads={a.threads}")
    con.execute(f"SET temp_directory='{os.path.join(sortie, 'tmp_duckdb')}'")
    jsd = pd.read_csv(os.path.join(os.path.dirname(__file__), P.FICHIER_JOURS_SANS_DONNEES))
    pannes_snpp = "[" + ",".join(f"'{d}'" for d in jsd.loc[jsd["satellite"] == "SNPP", "date"]) + "]"
    pays_sql = r"regexp_extract(filename, '_[0-9]{4}_(.+)\.csv$', 1)"
    t0 = time.time()
    groupes = [(d, int(y)) for d in P.DOSSIERS_ANNUELS for y in sorted(os.listdir(os.path.join(a.brut, d)))
               if y.isdigit() and (a.annees is None or int(y) in a.annees)]
    for i, (d, y) in enumerate(groupes, 1):
        nom = f"{d}_{y}.parquet"
        if os.path.exists(os.path.join(sortie, "cellule", nom)) and os.path.exists(os.path.join(sortie, "jour", nom)):
            print(f"[{i}/{len(groupes)}] {nom} deja fait", flush=True)
            continue
        f = glob.glob(os.path.join(a.brut, d, str(y), "*.csv"))
        src = f"SELECT *, false AS statique_estime FROM ({_brut(f, pays_sql)})"
        _tables(con, src, sortie, nom, y, pannes_snpp)
        print(f"[{i}/{len(groupes)}] {nom} : {len(f)} fichiers, {time.time() - t0:.0f} s", flush=True)

    # 2026 World form files: country from the historical cell table, static mask for NRT rows
    form = []
    for dem in P.DEMANDES_MONDE_2026:
        form += glob.glob(os.path.join(a.brut, "2026-formulaire", dem, "fire_*.csv"))
    if form and (a.annees is None or 2026 in a.annees) and not os.path.exists(os.path.join(sortie, "jour", "formulaire_2026.parquet")):
        cel = pd.concat([pd.read_parquet(p) for p in glob.glob(os.path.join(sortie, "cellule", "*_202[3-5].parquet"))])
        ref = (cel.groupby(["lat_c", "lon_c", "pays"])["n_vegetation"].sum().reset_index()
               .sort_values("n_vegetation").drop_duplicates(["lat_c", "lon_c"], keep="last")[["lat_c", "lon_c", "pays"]])
        con.register("ref_pays", ref)
        con.register("masque", masque(sortie, {2023, 2024, 2025}))
        src = f"""SELECT r.* EXCLUDE (pays), coalesce(ref_pays.pays, 'inconnu') AS pays,
                    (r.typ IS NULL AND m.ilat IS NOT NULL) AS statique_estime
                  FROM ({_brut(form, "'?'")}) r
                  LEFT JOIN ref_pays ON ref_pays.lat_c = floor(r.lat / {CELLULE}) * {CELLULE} + {CELLULE / 2}
                                    AND ref_pays.lon_c = floor(r.lon / {CELLULE}) * {CELLULE} + {CELLULE / 2}
                  LEFT JOIN masque m ON m.ilat = floor(r.lat / {CELLULE_MASQUE})::BIGINT AND m.ilon = floor(r.lon / {CELLULE_MASQUE})::BIGINT"""
        _tables(con, src, sortie, "formulaire_2026.parquet", None, pannes_snpp)
        print(f"formulaire 2026 : {len(form)} fichiers, {time.time() - t0:.0f} s", flush=True)
    con.close()
    print(f"Agregation terminee en {time.time() - t0:.0f} s -> {sortie}")


def main(argv=None):
    ap = argparse.ArgumentParser(description="Vigil v2 - VIGIL-K1 a l'echelle mondiale")
    ap.add_argument("commande", choices=["agreger", "calibrer"])
    ap.add_argument("--brut", default=P.DOSSIER_BRUT)
    ap.add_argument("--sortie", default=P.DOSSIER_SORTIE)
    ap.add_argument("--frontieres", default=P.FICHIER_FRONTIERES)
    ap.add_argument("--memoire", default="3GB")
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--annees", type=lambda s: set(range(int(s.split("-")[0]), int(s.split("-")[-1]) + 1)), default=None)
    a = ap.parse_args(argv)
    if a.commande == "agreger":
        agreger(a)
    else:
        from .mondial_calibration import calibrer
        calibrer(a)


if __name__ == "__main__":
    main()
