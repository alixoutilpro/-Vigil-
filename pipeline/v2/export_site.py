"""Static files for the web app (no server): H3 res-5 world map, per-country series, uncertainty, Greece points.

Run after `mondial agreger`, `mondial agreger --tables hex,jourfrp`, `mondial calibrer`, `mondial calibrer-frp`
and `nettoyage --region grece`:
    python -m pipeline.v2.export_site                    # writes <sortie>/site/ (outside Git), prints sizes
    python -m pipeline.v2.export_site --site public/data # writes into the repo, served by Vercel at /data/...

Layout (all little-endian, gzip-compressed binary; decode in JS with DataView):
  h3_5/mois/YYYY-MM.bin.gz        map of one month. Records of 16 bytes, sorted by h3:
                                  uint64 h3 | float32 hotspots (MODIS-Aqua equivalent) | float32 frp_MW (Aqua equivalent)
  h3_5/tuiles/<parent>.bin.gz     every month of the hexagons inside one H3 res-1 parent (zone statistics without
                                  downloading all months). Records of 18 bytes, sorted by (h3, month):
                                  uint64 h3 | uint16 month index (0 = 2002-01) | float32 hotspots | float32 frp_MW
  pays.json                       monthly series per country (hotspots and FRP, 80/95 % bands, reliability)
  incertitude.json                conformal quantile tables (to compute the band of ANY zone total in the browser)
  points_grece/YYYY.csv.gz        every Greek detection, one CSV per year (E9), with the reason when not counted
  index.json                      months, provenance, colour breaks, units, file list and sizes
Values of a hexagon = sum over the countries it overlaps, each harmonized with its own country k (counts and FRP).
"""
import argparse
import glob
import gzip
import json
import os
from datetime import datetime

import duckdb
import numpy as np
import pandas as pd

from . import parametres as P
from .harmonisation import BASCULE

MOIS0 = pd.Timestamp("2002-01-01")
PARENT_RES = 1
ENR_MOIS = np.dtype([("h3", "<u8"), ("hotspots", "<f4"), ("frp", "<f4")])
ENR_TUILE = np.dtype([("h3", "<u8"), ("mois", "<u2"), ("hotspots", "<f4"), ("frp", "<f4")])


def _enregistrer_facteurs(con, K, rho, cle):
    """Register k (country, sub-region, global) and rho lookup tables in DuckDB under suffix `cle`."""
    con.register(f"k_{cle}", K[["pays", "daynight", "mois", "k"]])
    con.register(f"ks_{cle}", K.groupby(["sous_region", "daynight", "mois"])["k_sous_region"].first().reset_index())
    kg = (K.groupby("daynight")["Aqua"].sum() / K.groupby("daynight")["SNPP"].sum()).rename("kg").reset_index()
    con.register(f"kg_{cle}", kg)
    con.register(f"rho_{cle}", rho[["daynight", "mois", "rho"]])


def harmoniser_hex(con, chemin_hex, Kc, rho_c, Kf, rho_f):
    """Hex x month x country harmonized hotspots and FRP, computed in DuckDB (the world table does not fit pandas).
    Same switch rule as the 0.25 deg map of `calibrer`: Aqua before the switch date (converted S-NPP on Aqua outage
    days), then S-NPP, NOAA-20 on days
    without S-NPP; k = country, else sub-region, else global day/night ratio (never silently 0)."""
    con.register("sr", Kc.drop_duplicates("pays")[["pays", "sous_region"]])
    _enregistrer_facteurs(con, Kc, rho_c, "c")
    _enregistrer_facteurs(con, Kf, rho_f, "f")
    fac = lambda c: f"""CASE h.satellite WHEN 'Aqua' THEN 1.0
                 WHEN 'SNPP' THEN coalesce(k_{c}.k, ks_{c}.k_sous_region, kg_{c}.kg)
                 ELSE coalesce(k_{c}.k, ks_{c}.k_sous_region, kg_{c}.kg) * coalesce(rho_{c}.rho, 1.0) END"""
    jointures = "".join(f"""
            LEFT JOIN k_{c} ON k_{c}.pays = h.pays AND k_{c}.daynight = h.daynight AND k_{c}.mois = h.mois
            LEFT JOIN ks_{c} ON ks_{c}.sous_region = sr.sous_region AND ks_{c}.daynight = h.daynight AND ks_{c}.mois = h.mois
            LEFT JOIN kg_{c} ON kg_{c}.daynight = h.daynight
            LEFT JOIN rho_{c} ON rho_{c}.daynight = h.daynight AND rho_{c}.mois = h.mois""" for c in ["c", "f"])
    cols = {r[0] for r in con.sql(f"DESCRIBE SELECT * FROM read_parquet('{chemin_hex}', union_by_name=true)").fetchall()}
    sans_aqua = "coalesce(jour_sans_aqua, false)" if "jour_sans_aqua" in cols else "false"   # tables written before the Aqua-outage fix
    con.execute(f"""CREATE OR REPLACE TABLE hp AS
        SELECT h.h3, h.annee, h.mois, h.pays,
               sum(u * ({fac('c')}) * h.n_vegetation) AS hotspots, sum(u * ({fac('f')}) * h.frp_vegetation) AS frp
        FROM (SELECT *, CASE
                WHEN make_date(annee, mois, 1) < DATE '{BASCULE.date()}' THEN
                     ((satellite = 'Aqua' AND NOT {sans_aqua}) OR (satellite = 'SNPP' AND {sans_aqua}))::INT
                WHEN satellite = 'SNPP' THEN (NOT jour_sans_snpp)::INT
                WHEN satellite = 'NOAA20' THEN jour_sans_snpp::INT ELSE 0 END AS u
              FROM read_parquet('{chemin_hex}', union_by_name=true) WHERE satellite IN ('Aqua','SNPP','NOAA20') AND annee >= 2002) h
        LEFT JOIN sr ON sr.pays = h.pays {jointures}
        GROUP BY ALL""")


def ecrire_gz(chemin, tableau):
    os.makedirs(os.path.dirname(chemin), exist_ok=True)
    with open(chemin, "wb") as f:   # mtime=0: identical bytes when the content is unchanged (no Git churn)
        f.write(gzip.compress(tableau.tobytes(), compresslevel=9, mtime=0))


def exporter_h3(dossier, site, memoire="3GB"):
    con = duckdb.connect()
    con.execute(f"SET memory_limit='{memoire}'")
    con.execute(f"SET temp_directory='{os.path.join(dossier, 'tmp_duckdb')}'")
    harmoniser_hex(con, os.path.join(dossier, "hex", "*.parquet").replace("\\", "/"),
                   pd.read_csv(os.path.join(dossier, "k_pays.csv")), pd.read_csv(os.path.join(dossier, "rho_noaa20.csv")),
                   pd.read_csv(os.path.join(dossier, "k_frp_pays.csv")), pd.read_csv(os.path.join(dossier, "rho_frp_noaa20.csv")))
    par_pays = con.sql("SELECT pays, annee, mois, sum(hotspots) AS hotspots FROM hp GROUP BY ALL").df().set_index(["pays", "annee", "mois"])["hotspots"]
    M = con.sql("""SELECT h3, annee, mois, sum(hotspots)::FLOAT AS hotspots, sum(frp)::FLOAT AS frp FROM hp
                   GROUP BY ALL HAVING sum(hotspots) > 0 OR sum(frp) > 0""").df()
    con.close()
    M["mi"] = ((M["annee"] - 2002) * 12 + M["mois"] - 1).astype("uint16")
    tailles = {"mois": 0, "tuiles": 0}
    for (a, m), g in M.groupby(["annee", "mois"]):
        g = g.sort_values("h3")
        t = np.zeros(len(g), ENR_MOIS)
        t["h3"], t["hotspots"], t["frp"] = g["h3"].to_numpy("uint64"), g["hotspots"], g["frp"]
        ch = os.path.join(site, "h3_5", "mois", f"{a}-{m:02d}.bin.gz")
        ecrire_gz(ch, t)
        tailles["mois"] += os.path.getsize(ch)
    import h3
    uniques = np.unique(M["h3"].to_numpy("uint64"))
    parents = {int(c): h3.cell_to_parent(h3.int_to_str(int(c)), PARENT_RES) for c in uniques}
    M["parent"] = M["h3"].map(lambda c: parents[int(c)])
    tuiles = []
    for p, g in M.groupby("parent"):
        g = g.sort_values(["h3", "mi"])
        t = np.zeros(len(g), ENR_TUILE)
        t["h3"], t["mois"], t["hotspots"], t["frp"] = g["h3"].to_numpy("uint64"), g["mi"], g["hotspots"], g["frp"]
        ch = os.path.join(site, "h3_5", "tuiles", f"{p}.bin.gz")
        ecrire_gz(ch, t)
        tailles["tuiles"] += os.path.getsize(ch)
        tuiles.append(p)
    # colour breaks: quantiles of non-zero monthly hexagon values (log scale advised)
    v, f = M.loc[M["hotspots"] > 0, "hotspots"], M.loc[M["frp"] > 0, "frp"]
    qs = [0.5, 0.75, 0.9, 0.95, 0.99]
    seuils = {"hotspots": {str(q): float(v.quantile(q)) for q in qs}, "frp_MW": {str(q): float(f.quantile(q)) for q in qs}}
    return M, par_pays, tailles, tuiles, seuils


def exporter_pays(dossier, site):
    sc = pd.read_csv(os.path.join(dossier, "serie_mensuelle_pays.csv"))
    sf = pd.read_csv(os.path.join(dossier, "serie_frp_mensuelle_pays.csv"))
    d = sc.merge(sf[["pays", "annee", "mois", "frp_MW", "bas_80", "haut_80", "bas_95", "haut_95", "fiabilite_frp"]]
                 .rename(columns={"bas_80": "frp_bas_80", "haut_80": "frp_haut_80", "bas_95": "frp_bas_95", "haut_95": "frp_haut_95"}),
                 on=["pays", "annee", "mois"], how="left")
    out = {}
    r = lambda x: [None if pd.isna(v) else round(float(v), 2) for v in x]
    txt = lambda v: None if pd.isna(v) else str(v)   # countries without calibration (e.g. Monaco): null, never NaN
    for p, g in d.sort_values(["pays", "annee", "mois"]).groupby("pays"):
        out[p] = {"sous_region": txt(g["sous_region"].iloc[0]), "fiabilite": txt(g["fiabilite"].iloc[0]),
                  "fiabilite_frp": txt(g["fiabilite_frp"].iloc[0]) if "fiabilite_frp" in g else None,
                  "premier_mois": f"{int(g['annee'].iloc[0])}-{int(g['mois'].iloc[0]):02d}",
                  "hotspots": r(g["valeur"]), "bas_80": r(g["bas_80"]), "haut_80": r(g["haut_80"]),
                  "bas_95": r(g["bas_95"]), "haut_95": r(g["haut_95"]),
                  "frp_MW": r(g["frp_MW"]), "frp_bas_80": r(g["frp_bas_80"]), "frp_haut_80": r(g["frp_haut_80"]),
                  "couverture_jours": r(g["couverture_jours"])}
    ch = os.path.join(site, "pays.json")
    with open(ch, "w", encoding="utf-8") as fo:
        json.dump(out, fo, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    return sc, os.path.getsize(ch)


def exporter_incertitude(dossier, site):
    rc = json.load(open(os.path.join(dossier, "rapport_mondial.json"), encoding="utf-8"))
    rf = json.load(open(os.path.join(dossier, "rapport_frp.json"), encoding="utf-8"))
    from .harmonisation import CLASSES, NOMS_CLASSES
    inc = {"espace": "log(1+x) : borne = exp(log(1+x) + q) - 1, plancher 0 ; seulement pour les mois >= bascule",
           "valide_a_l_echelle": "pays x mois (non valide sous l'echelle du pays : a signaler a l'ecran)",
           "hotspots": {"classes_bornes": [float(c) for c in CLASSES[1:-1]], "noms": NOMS_CLASSES,
                        "quantiles": rc["incertitude"]["quantiles"], "couverture_observee": rc["incertitude"]["couverture_observee"]},
           "frp_MW": {"classes_bornes": rf["incertitude"]["classes_MW"], "quantiles": rf["incertitude"]["quantiles"],
                      "couverture_observee": rf["incertitude"]["couverture_observee"]}}
    sp = os.path.join(dossier, "incertitude_sous_pays.json")      # etudes/validation_sous_pays.py
    if os.path.exists(sp):
        s = json.load(open(sp, encoding="utf-8"))
        inc["hotspots_sous_pays"] = {"usage": "zones dessinees / mode H3 (sous l'echelle du pays)", "valide_pour": s["valide_pour"],
                                     "classes_bornes": s["classes_bornes"], "noms": s["noms"], "quantiles": s["quantiles"],
                                     "couverture_observee": s["couverture"]}
    ch = os.path.join(site, "incertitude.json")
    with open(ch, "w", encoding="utf-8") as f:
        json.dump(inc, f, ensure_ascii=False, indent=1, allow_nan=False)
    return rc, rf


def exporter_points_grece(sortie, site):
    src = os.path.join(sortie, "grece", "hotspots_propres.parquet")
    if not os.path.exists(src):
        return 0, 0
    cols = ["latitude", "longitude", "acq_date", "acq_time", "satellite", "instrument", "daynight", "confidence_brut",
            "frp", "type", "categorie", "compte_calendrier", "origine", "version"]
    pts = pd.read_parquet(src, columns=cols + ["pays"])
    pts = pts[pts["pays"] == "Greece"].drop(columns="pays").rename(columns={"confidence_brut": "confidence"})
    pts["acq_date"] = pd.to_datetime(pts["acq_date"])
    total = 0
    for a, g in pts.groupby(pts["acq_date"].dt.year):
        ch = os.path.join(site, "points_grece", f"{a}.csv.gz")
        os.makedirs(os.path.dirname(ch), exist_ok=True)
        g.assign(acq_date=g["acq_date"].dt.strftime("%Y-%m-%d")).sort_values(["acq_date", "acq_time"]).to_csv(
            ch, index=False, compression={"method": "gzip", "compresslevel": 9, "mtime": 0})
        total += os.path.getsize(ch)
    return len(pts), total


def main(argv=None):
    ap = argparse.ArgumentParser(description="Vigil v2 - fichiers statiques du site")
    ap.add_argument("--sortie", default=P.DOSSIER_SORTIE)
    ap.add_argument("--site", default=None, help="destination folder (e.g. public/data, served by Vercel as /data)")
    a = ap.parse_args(argv)
    dossier, site = os.path.join(a.sortie, "monde"), a.site or os.path.join(a.sortie, "site")
    os.makedirs(site, exist_ok=True)
    M, par_pays, tailles, tuiles, seuils = exporter_h3(dossier, site)
    sc, t_pays = exporter_pays(dossier, site)
    rc, rf = exporter_incertitude(dossier, site)
    n_pts, t_pts = exporter_points_grece(a.sortie, site)

    # consistency: hexagons summed per country = country map of `calibrer` (same rows, same k)
    carte = pd.read_parquet(os.path.join(dossier, "carte_cellules_mois.parquet")).groupby(["pays", "annee", "mois"])["valeur"].sum()
    c = pd.concat([par_pays.rename("hex"), carte.rename("carte")], axis=1).fillna(0)
    c = c[c.index.get_level_values("pays") != "inconnu"]      # the 0.25 deg map drops unknown-country rows
    ecart = float((c["hex"] - c["carte"]).abs().sum() / max(c["carte"].sum(), 1))
    # closure: detections without a country (2026 form rows only) must stay a negligible share (audit 15/11)
    pi = par_pays.groupby(level=["pays", "annee"]).sum()
    inconnu = {"hotspots_sans_pays_par_annee": {int(y): round(float(v), 1) for (p, y), v in pi.items() if p == "inconnu"},
               "part_2026_pct": round(100 * float(pi.get(("inconnu", 2026), 0.0)) / max(float(pi.xs(2026, level="annee").sum()), 1), 4)}
    ap26 = os.path.join(dossier, "attribution_pays_2026.json")
    if os.path.exists(ap26):
        inconnu["attribution_2026"] = json.load(open(ap26, encoding="utf-8"))

    mois = sorted({f"{x}-{y:02d}" for x, y in zip(M["annee"], M["mois"])})
    index = {"genere_le": datetime.now().isoformat(timespec="seconds"), "methode": "VIGIL-K1 (comptes) + VIGIL-K1-FRP",
             "unites": {"hotspots": "detections de feux actifs, equivalent MODIS Aqua", "frp_MW": "puissance radiative, MW, equivalent Aqua"},
             "h3_resolution": 5, "tuile_parent_resolution": PARENT_RES, "mois_index_0": "2002-01",
             "bascule_viirs": str(BASCULE.date()), "provenance": {"avant_bascule": "modis_observed", "apres": "viirs_converted"},
             "mois": mois, "tuiles": sorted(tuiles), "seuils_couleur_quantiles": seuils,
             "validation": {"hotspots": rc["validation_mondiale"], "frp": rf["validation_mondiale"]},
             "controle_hex_vs_carte_pays_ecart_relatif": ecart, "controle_pays_inconnu": inconnu,
             "tailles_octets": {"h3_mois": tailles["mois"], "h3_tuiles": tailles["tuiles"], "pays_json": t_pays, "points_grece": t_pts},
             "points_grece": n_pts}
    with open(os.path.join(site, "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=1, default=str, allow_nan=False)
    mo = 1e6
    print(f"H3 5 : {len(mois)} mois -> {tailles['mois'] / mo:.1f} Mo ; {len(tuiles)} tuiles -> {tailles['tuiles'] / mo:.1f} Mo")
    print(f"pays.json : {t_pays / mo:.1f} Mo ; points Grece : {n_pts:,} points -> {t_pts / mo:.1f} Mo")
    print(f"Controle hexagones vs carte pays : ecart relatif {ecart:.2e} (attendu ~0)")
    print(f"Controle pays inconnu : {inconnu['part_2026_pct']} % des hotspots harmonises 2026 (attendu ~0)")
    print(f"Fichiers ecrits dans {site}")


if __name__ == "__main__":
    main()
