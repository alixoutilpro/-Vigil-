"""Which country does a 2026 detection belong to? Study of the attribution rule for the FIRMS 'World' form files.

Problem (audit 15/11): the 2026 form files carry no country. `mondial.py` took the country of the 0.25 deg cell from
the 2023-2025 yearly files. A fire in a cell with no detection in 2023-2025 got 'inconnu' and was dropped from the
country series: in Aug 2026, 79 % of the Russian S-NPP detections and, in Jun-Jul, 56 % of the Canadian ones.

Protocol (fixed before looking at the results):
- Truth: the FIRMS yearly country files, where FIRMS gives the country. Test points = MODIS detections (Terra + Aqua,
  confidence >= 30, type 0) of a test year, on the 0.01 deg grid used by the rule, weighted by their detections.
- Test years: 2025 (the normal case) and 2021 (record Siberian fire year: many newly burnt places, the hard case).
  Every rule only learns from years BEFORE the test year (the name mapping from the 3 previous years, like 2026
  learns from 2023-2025; the cell history from all previous years).
- Rules compared:
    M0  0.25 deg cell -> its country in the 3 previous years (the old rule)
    M2  0.25 deg cell -> its country in all previous years, else majority country of its H3 res-3 parent
    P   Natural Earth polygon part -> FIRMS name (majority mapping), 2 km coastal tolerance, else M2
- Criterion: share of detections attributed to their TRUE country ('inconnu' and a wrong country are both errors),
  globally, for Russia and Canada, and per country (the worst ones: small and enclaved countries).

Run: python -m etudes.attribution_pays_2026
Reads the raw MODIS yearly files of 2018-2025 (~2.7 GB, DuckDB) and Donnees-propres/monde/cellule/*.parquet.
Writes etude_attribution_pays.json, etude_attribution_par_pays.csv next to the tables.
"""
import glob
import json
import os
import sys

import duckdb
import numpy as np
import pandas as pd

from pipeline.v2 import attribution_pays as A
from pipeline.v2 import parametres as P

TESTS = {2021: (2018, 2020), 2025: (2022, 2024)}   # test year -> years used to learn the name mapping
SATS = "('Aqua','SNPP','NOAA20')"


def points_modis(con, annees):
    f = [x for y in annees for x in glob.glob(os.path.join(P.DOSSIER_BRUT, "modis", str(y), "*.csv"))]
    lst = "[" + ",".join("'" + x.replace("\\", "/") + "'" for x in f) + "]"
    return con.sql(f"""SELECT regexp_extract(filename, '_[0-9]{{4}}_(.+)\\.csv$', 1) pays,
            floor(latitude::DOUBLE / {A.PAS})::BIGINT i, floor(longitude::DOUBLE / {A.PAS})::BIGINT j, count(*) n
        FROM read_csv({lst}, union_by_name=true, all_varchar=true, filename=true)
        WHERE TRY_CAST(confidence AS INT) >= 30 AND "type" = '0' GROUP BY ALL""").df()


def ref_cellules(debut, fin):
    f = os.path.join(P.DOSSIER_SORTIE, "monde", "cellule", "*_[0-9][0-9][0-9][0-9].parquet").replace("\\", "/")
    return f"""SELECT pays, lat_c, lon_c, sum(n_vegetation) n FROM read_parquet('{f}')
               WHERE satellite IN {SATS} AND annee BETWEEN {debut} AND {fin} AND n_vegetation > 0 GROUP BY ALL"""


def regle_cellule(con, t, ref_sql, avec_h3):
    """M0 / M2 on the test points t (0.01 deg cells) via their 0.25 deg cell."""
    x = pd.DataFrame({"k": np.arange(len(t)), "lat_c": A.centre_cellule((t["i"] + 0.5) * A.PAS, A.CELLULE),
                      "lon_c": A.centre_cellule((t["j"] + 0.5) * A.PAS, A.CELLULE)})
    con.register("pts", x)
    s = con.sql(A.sql_secours(ref_sql, "pts")).df().sort_values("k")
    con.unregister("pts")
    p = s["pays_cellule"]
    if avec_h3:
        p = p.fillna(s["pays_h3"])
    return p.fillna("inconnu").to_numpy(object)


def scores(t, pred):
    ok, inc = pred == t["pays"].to_numpy(object), pred == "inconnu"
    n = t["n"].to_numpy(float)

    def s(m):
        return {"n": float(n[m].sum()), "correct": 100 * float(n[m & ok].sum() / n[m].sum()),
                "inconnu": 100 * float(n[m & inc].sum() / n[m].sum()), "autre_pays": 100 * float(n[m & ~ok & ~inc].sum() / n[m].sum())}
    out = {"MONDE": s(np.ones(len(t), bool))}
    for z in ("Russian_Federation", "Canada"):
        out[z] = s(t["pays"].to_numpy() == z)
    pc = pd.DataFrame({"pays": t["pays"], "n": n, "ok": n * ok}).groupby("pays")[["n", "ok"]].sum()
    return out, (100 * pc["ok"] / pc["n"]).rename("correct").to_frame().assign(n=pc["n"])


def main(argv=None):
    con = duckdb.connect()
    con.execute("INSTALL h3 FROM community")
    con.execute("LOAD h3")
    parties = A.charger_parties(P.FICHIER_FRONTIERES)
    res, par_pays = {}, []
    for T, (a0, a1) in TESTS.items():
        t = points_modis(con, [T])
        apprend = points_modis(con, range(a0, a1 + 1))
        corr, _ = A.apprendre_correspondance((apprend["i"] + 0.5) * A.PAS, (apprend["j"] + 0.5) * A.PAS,
                                             apprend["pays"].to_numpy(object), apprend["n"].to_numpy(float), parties, P.TOLERANCE_COTE_KM)
        lat, lon = (t["i"] + 0.5) * A.PAS, (t["j"] + 0.5) * A.PAS
        preds = {"M0": regle_cellule(con, t, ref_cellules(T - 3, T - 1), False),
                 "M2": regle_cellule(con, t, ref_cellules(2000, T - 1), True)}
        pays, niveau = A.attribuer(con, lat.to_numpy(), lon.to_numpy(), parties, corr, ref_cellules(2000, T - 1), P.TOLERANCE_COTE_KM)
        preds["P"] = pays
        res[str(T)] = {}
        for r, pr in preds.items():
            res[str(T)][r], pc = scores(t, pr)
            par_pays.append(pc.reset_index().assign(regle=r, annee_test=T))
        w = t["n"].to_numpy(float)
        res[str(T)]["P_niveaux_pct"] = {k: round(100 * float(w[niveau == k].sum() / w.sum()), 3) for k in np.unique(niveau)}
    pc = pd.concat(par_pays)
    dossier = os.path.join(P.DOSSIER_SORTIE, "monde")
    pc.to_csv(os.path.join(dossier, "etude_attribution_par_pays.csv"), index=False)
    for T, r in res.items():
        print(f"\n=== Test year {T}: % of MODIS vegetation detections attributed to their true FIRMS country ===")
        print(f"{'rule':4s} {'zone':20s} {'correct':>8s} {'inconnu':>8s} {'wrong':>8s} {'n':>11s}")
        for regle in ("M0", "M2", "P"):
            for z, v in r[regle].items():
                print(f"{regle:4s} {z:20s} {v['correct']:8.2f} {v['inconnu']:8.2f} {v['autre_pays']:8.2f} {v['n']:11,.0f}")
        print("P, level used (% of detections):", r["P_niveaux_pct"])
        for regle in ("M2", "P"):
            g = pc[(pc["annee_test"] == int(T)) & (pc["regle"] == regle) & (pc["n"] >= 300)].sort_values("correct")
            print(f"{regle}: countries with >= 300 detections: {len(g)} | correct >= 99 %: {(g['correct'] >= 99).sum()}"
                  f" | >= 95 %: {(g['correct'] >= 95).sum()} | worst: "
                  + ", ".join(f"{p} {c:.1f}" for p, c in zip(g["pays"].head(6), g["correct"].head(6))))
    with open(os.path.join(dossier, "etude_attribution_pays.json"), "w", encoding="utf-8") as f:
        json.dump(res, f, ensure_ascii=False, indent=2)
    return res


if __name__ == "__main__":
    main()
    sys.exit(0)
