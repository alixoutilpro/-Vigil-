"""VIGIL-K1 at global scale: every country, same method as the Greece study.

Commands (from the repo root):
    .\\.venv\\Scripts\\python.exe -m pipeline.v2.mondial agreger      # heavy pass, one file group at a time, resumable
    .\\.venv\\Scripts\\python.exe -m pipeline.v2.mondial agreger --tables hex,jourfrp   # 2nd pass: H3 res 5 + FRP
    .\\.venv\\Scripts\\python.exe -m pipeline.v2.mondial calibrer     # k per country, validation, series (minutes)

agreger reads the FIRMS yearly country files once (DuckDB, memory-limited) and writes small tables:
    jour/<dir>_<year>.parquet    country x day x satellite x day/night counts   (calibration, daily switch)
    cellule/<dir>_<year>.parquet country x 0.25 deg cell x month x satellite x day/night x "day without S-NPP"
                                 (outage or after 2026-11-02: NOAA-20 replaces S-NPP on those days only)
    statique/<dir>_<year>.parquet 0.02 deg cells with their FIRMS 'type' counts (2023-2025 only, static mask)
The 2026 "World" form files carry no country: it is given by pipeline/v2/attribution_pays.py (Natural Earth
polygon part -> FIRMS name learnt on the 2023-2025 MODIS files, else 0.25 deg cell history, else H3 res-3 parent;
rule chosen and validated in etudes/attribution_pays_2026.py). NRT rows (no 'type') get the static-site mask validated on 2025.

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

from . import attribution_pays as A
from . import parametres as P
from .harmonisation import ALPHA, BASCULE, CLASSES, DEBUT_CALIB, FIN_CALIB, NIVEAU, NOMS_CLASSES

CELLULE = 0.25         # degrees, global map grid
CELLULE_MASQUE = 0.02  # degrees (~2 km), static-site mask grid
H3_MONDE = 5           # H3 resolution of the global hexagon map (~253 km2); DuckDB 'h3' community extension
TABLES_HISTORIQUES = frozenset({"jour", "cellule", "statique"})   # written together (default, as before)
TABLES_H3_FRP = frozenset({"hex", "jourfrp"})                     # second pass: H3 map + FRP calibration input
ANNEES_CORRESPONDANCE = [2023, 2024, 2025]   # MODIS yearly files used to map Natural Earth parts -> FIRMS names
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
                 TRY_CAST("type" AS INTEGER) AS typ, TRY_CAST(frp AS DOUBLE) AS frp, filename FROM b)
    SELECT *, (sat IS NOT NULL AND lat BETWEEN -90 AND 90 AND lon BETWEEN -180 AND 180 AND d IS NOT NULL
               AND dn IN ('D','N')) AS valide, {CONF_OK_SQL} AS conf_ok FROM n"""


def _tables(con, source, sortie, nom, annee, pannes_snpp, tables=TABLES_HISTORIQUES):
    """From a normalized relation 'source', write the requested tables (see TABLES_HISTORIQUES / TABLES_H3_FRP)."""
    con.execute(f"CREATE OR REPLACE TEMP VIEW r AS {source}")
    if "hex" in tables:
        # Same filters as 'cellule', on the H3 grid (H3_MONDE) instead of 0.25 deg, plus fire radiative power
        # of the vegetation detections (MW). frp_max keeps the most intense detection of the cell-month.
        con.execute(f"""COPY (SELECT pays, h3_latlng_to_cell(lat, lon, {H3_MONDE}) AS h3, year(d) AS annee, month(d) AS mois,
                sat AS satellite, dn AS daynight,
                (d > DATE '2026-11-02' OR d IN (SELECT unnest({pannes_snpp}::DATE[]))) AS jour_sans_snpp,
                count(*) FILTER (coalesce(typ, 0) = 0 AND NOT statique_estime) AS n_vegetation,
                coalesce(sum(frp) FILTER (coalesce(typ, 0) = 0 AND NOT statique_estime), 0) AS frp_vegetation,
                max(frp) FILTER (coalesce(typ, 0) = 0 AND NOT statique_estime) AS frp_max,
                count(*) FILTER (typ = 2 OR statique_estime) AS n_industriel
            FROM r WHERE valide AND conf_ok AND coalesce(typ, 0) IN (0, 2) GROUP BY ALL)
            TO '{os.path.join(sortie, 'hex', nom)}' (FORMAT parquet)""")
    if "jourfrp" in tables:
        # country x day x satellite x day/night, vegetation counts AND FRP: input of the FRP calibration
        con.execute(f"""COPY (SELECT pays, d AS acq_date, sat AS satellite, dn AS daynight,
                count(*) AS n_vegetation, coalesce(sum(frp), 0) AS frp_vegetation,
                count(*) FILTER (frp IS NULL) AS n_frp_manquante
            FROM r WHERE valide AND conf_ok AND coalesce(typ, 0) = 0 AND NOT statique_estime GROUP BY ALL)
            TO '{os.path.join(sortie, 'jourfrp', nom)}' (FORMAT parquet)""")
    if not tables & TABLES_HISTORIQUES:
        return
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


def table_pays_2026(con, a, form, sortie, pays_sql):
    """0.01 deg cells (i, j) of the 2026 form rows -> FIRMS country, with a written report (no silent 'inconnu')."""
    from .nettoyage import sha256
    if sha256(a.frontieres) != P.SHA256_FRONTIERES:
        raise SystemExit(f"Empreinte inattendue pour {a.frontieres} : retelechargez {P.URL_FRONTIERES}")
    parties = A.charger_parties(a.frontieres)
    f = [x for y in ANNEES_CORRESPONDANCE for x in glob.glob(os.path.join(a.brut, "modis", str(y), "*.csv"))]
    hist = con.sql(f"""SELECT {pays_sql} AS pays, floor(latitude::DOUBLE / {A.PAS})::BIGINT i,
            floor(longitude::DOUBLE / {A.PAS})::BIGINT j, count(*) n
        FROM read_csv({_liste(f)}, union_by_name=true, all_varchar=true, filename=true)
        WHERE TRY_CAST(confidence AS INT) >= 30 AND "type" = '0' GROUP BY ALL""").df()
    corr, qualite = A.apprendre_correspondance((hist["i"] + 0.5) * A.PAS, (hist["j"] + 0.5) * A.PAS, hist["pays"].to_numpy(object),
                                               hist["n"].to_numpy(float), parties, P.TOLERANCE_COTE_KM)
    qualite.to_csv(os.path.join(sortie, "correspondance_ne_firms.csv"), index_label="partie")
    cel = con.sql(f"""SELECT floor(lat / {A.PAS})::BIGINT i, floor(lon / {A.PAS})::BIGINT j, count(*) n
                      FROM ({_brut(form, "'?'")}) WHERE valide GROUP BY ALL""").df()
    ref_cel = os.path.join(sortie, "cellule", "*_[0-9][0-9][0-9][0-9].parquet").replace("\\", "/")
    ref_sql = f"""SELECT pays, lat_c, lon_c, sum(n_vegetation) n FROM read_parquet('{ref_cel}')
                  WHERE satellite IN ('Aqua','SNPP','NOAA20') AND n_vegetation > 0 AND pays <> 'inconnu'
                    AND annee < 2026 GROUP BY ALL"""   # yearly files only: 'formulaire_2026' also matches the glob
    pays, niveau = A.attribuer(con, ((cel["i"] + 0.5) * A.PAS).to_numpy(), ((cel["j"] + 0.5) * A.PAS).to_numpy(),
                               parties, corr, ref_sql, P.TOLERANCE_COTE_KM)
    cel["pays"], cel["niveau"] = pays, niveau
    w = cel.groupby("niveau")["n"].sum()
    rapport = {"regle": "pipeline/v2/attribution_pays.py (validation : etudes/attribution_pays_2026.py)",
               "lignes_valides": int(cel["n"].sum()), "cellules_0.01": int(len(cel)),
               "niveau_pct_lignes": {k: round(100 * float(v) / float(w.sum()), 4) for k, v in w.items()},
               "parties_natural_earth_associees": int(len(corr)), "annees_correspondance": ANNEES_CORRESPONDANCE}
    with open(os.path.join(sortie, "attribution_pays_2026.json"), "w", encoding="utf-8") as fo:
        json.dump(rapport, fo, ensure_ascii=False, indent=2)
    print("attribution des pays 2026 :", rapport["niveau_pct_lignes"], flush=True)
    return cel[["i", "j", "pays"]]


def agreger(a):
    sortie = os.path.join(a.sortie, "monde")
    tables = frozenset(a.tables)
    # files whose presence means "group already done" ('statique' only exists for 2023+, so it is not checked)
    verifiees = sorted(tables - {"statique"} | ({"jour", "cellule"} if tables & TABLES_HISTORIQUES else set()))
    for sd in tables | ({"statique"} if tables & TABLES_HISTORIQUES else set()):
        os.makedirs(os.path.join(sortie, sd), exist_ok=True)
    con = duckdb.connect()
    if "hex" in tables:
        con.execute("INSTALL h3 FROM community")
        con.execute("LOAD h3")
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
        if all(os.path.exists(os.path.join(sortie, t, nom)) for t in verifiees):
            print(f"[{i}/{len(groupes)}] {nom} deja fait", flush=True)
            continue
        f = glob.glob(os.path.join(a.brut, d, str(y), "*.csv"))
        src = f"SELECT *, false AS statique_estime FROM ({_brut(f, pays_sql)})"
        _tables(con, src, sortie, nom, y, pannes_snpp, tables)
        print(f"[{i}/{len(groupes)}] {nom} : {len(f)} fichiers, {time.time() - t0:.0f} s", flush=True)

    # 2026 World form files: country from table_pays_2026 (polygon, then history), static mask for NRT rows
    form = []
    for dem in P.DEMANDES_MONDE_2026:
        form += glob.glob(os.path.join(a.brut, "2026-formulaire", dem, "fire_*.csv"))
    deja = all(os.path.exists(os.path.join(sortie, t, "formulaire_2026.parquet")) for t in verifiees)
    if form and (a.annees is None or 2026 in a.annees) and not deja:
        con.execute("INSTALL h3 FROM community")
        con.execute("LOAD h3")
        con.register("ref_pays", table_pays_2026(con, a, form, sortie, pays_sql))
        con.register("masque", masque(sortie, {2023, 2024, 2025}))
        src = f"""SELECT r.* EXCLUDE (pays), coalesce(ref_pays.pays, 'inconnu') AS pays,
                    (r.typ IS NULL AND m.ilat IS NOT NULL) AS statique_estime
                  FROM ({_brut(form, "'?'")}) r
                  LEFT JOIN ref_pays ON ref_pays.i = floor(r.lat / {A.PAS})::BIGINT AND ref_pays.j = floor(r.lon / {A.PAS})::BIGINT
                  LEFT JOIN masque m ON m.ilat = floor(r.lat / {CELLULE_MASQUE})::BIGINT AND m.ilon = floor(r.lon / {CELLULE_MASQUE})::BIGINT"""
        _tables(con, src, sortie, "formulaire_2026.parquet", None, pannes_snpp, tables)
        print(f"formulaire 2026 : {len(form)} fichiers, {time.time() - t0:.0f} s", flush=True)
    con.close()
    print(f"Agregation terminee en {time.time() - t0:.0f} s -> {sortie}")


def main(argv=None):
    ap = argparse.ArgumentParser(description="Vigil v2 - VIGIL-K1 a l'echelle mondiale")
    ap.add_argument("commande", choices=["agreger", "calibrer", "calibrer-frp"])
    ap.add_argument("--brut", default=P.DOSSIER_BRUT)
    ap.add_argument("--sortie", default=P.DOSSIER_SORTIE)
    ap.add_argument("--frontieres", default=P.FICHIER_FRONTIERES)
    ap.add_argument("--memoire", default="3GB")
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--annees", type=lambda s: set(range(int(s.split("-")[0]), int(s.split("-")[-1]) + 1)), default=None)
    ap.add_argument("--tables", type=lambda s: frozenset(s.split(",")), default=TABLES_HISTORIQUES,
                    help="agreger: jour,cellule,statique (default) or hex,jourfrp (H3 map + FRP, second pass)")
    a = ap.parse_args(argv)
    inconnues = a.tables - TABLES_HISTORIQUES - TABLES_H3_FRP
    if inconnues:
        ap.error(f"tables inconnues : {sorted(inconnues)}")
    if a.commande == "agreger":
        agreger(a)
    elif a.commande == "calibrer-frp":
        from .mondial_frp import calibrer_frp
        calibrer_frp(a)
    else:
        from .mondial_calibration import calibrer
        calibrer(a)


if __name__ == "__main__":
    main()
