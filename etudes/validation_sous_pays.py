"""Does VIGIL-K1 still work on zones SMALLER than a country? (the app lets users draw any zone)

For each calibration year t (leave-one-year-out), country k tables are re-estimated WITHOUT year t
(same model, alpha = 30 as chosen by the world calibration), then applied to the S-NPP counts of square
blocks of B degrees inside each country, and compared with the Aqua counts actually observed there.
Scales: country, 2 deg (~220 km), 1 deg (~110 km), 0.5 deg (~55 km).
Metrics per scale (block x month units): RMSE / standard deviation, R2, R2 of anomalies (deviation from the
block's monthly normal of the other years), skill against a single global k, median relative error on
months with >= 50 Aqua detections, total bias.
Limitation: block counts include every day of the month (the country calibration uses only days observed by
both satellites and not discordant): slightly pessimistic for small blocks.

Run (repo root):  python -m etudes.validation_sous_pays      -> <sortie>/monde/validation_sous_pays.csv
"""
import glob
import os

import duckdb
import numpy as np
import pandas as pd

from pipeline.v2 import parametres as P
from pipeline.v2.harmonisation import DEBUT_CALIB, FIN_CALIB
from pipeline.v2.mondial_calibration import discordants, estimer, jours_observes, table_calibration

ALPHA = 30
ECHELLES = [2.0, 1.0, 0.5]


def blocs(dossier, taille):
    cel = os.path.join(dossier, "cellule", "*_20[12][0-9].parquet").replace("\\", "/")
    con = duckdb.connect()
    con.execute("SET memory_limit='2GB'")
    return con.sql(f"""
        SELECT pays, floor(lat_c / {taille}) AS bi, floor(lon_c / {taille}) AS bj, annee, mois, daynight,
               sum(n_vegetation) FILTER (satellite = 'Aqua') AS Aqua,
               sum(n_vegetation) FILTER (satellite = 'SNPP' AND NOT jour_sans_snpp) AS SNPP
        FROM read_parquet('{cel}')
        WHERE satellite IN ('Aqua', 'SNPP') AND make_date(annee, mois, 1) BETWEEN DATE '{DEBUT_CALIB.date()}' AND DATE '{FIN_CALIB.date()}'
        GROUP BY ALL""").df().fillna({"Aqua": 0, "SNPP": 0})


def metriques(d):
    """d: one row per unit x year x month with Aqua (observed), pred, predA (global k)."""
    d = d.copy()
    d["clim"] = np.nan
    for t in d["annee"].unique():                       # normal of the unit-month from the OTHER years
        c = d[d["annee"] != t].groupby(["unite", "mois"])["Aqua"].mean()
        idx = d["annee"] == t
        d.loc[idx, "clim"] = d.loc[idx].set_index(["unite", "mois"]).index.map(c).to_numpy(float)
    d["clim"] = d["clim"].fillna(0)
    o, an_o = d["Aqua"].to_numpy(float), (d["Aqua"] - d["clim"]).to_numpy(float)
    res = {"n_unites": d["unite"].nunique(), "n_unite_mois": len(d)}
    for nom, col in [("k1", "pred"), ("k_global", "predA")]:
        p = d[col].to_numpy(float)
        res[f"rmse_sur_ecart_type_{nom}"] = float(np.sqrt(np.mean((p - o) ** 2)) / o.std())
        res[f"r2_{nom}"] = float(1 - np.mean((p - o) ** 2) / o.var())
        res[f"r2_anomalies_{nom}"] = float(1 - np.mean(((p - d["clim"]) - an_o) ** 2) / an_o.var())
    big = o >= 50
    res["erreur_relative_mediane_pct_mois_50plus"] = float(100 * np.median(np.abs(d["pred"].to_numpy()[big] - o[big]) / o[big]))
    res["biais_pct"] = float(100 * (d["pred"].sum() - o.sum()) / o.sum())
    res["skill_vs_k_global"] = 1 - (res["rmse_sur_ecart_type_k1"] / res["rmse_sur_ecart_type_k_global"]) ** 2
    return res


def bandes_sous_pays(dossier, P_, annees, niveaux=(0.8, 0.95)):
    """Split-conformal bands for SUB-COUNTRY zones, learnt on the LOYO residuals of the 2 / 1 / 0.5 deg blocks
    (pooled), by size class as for countries. Coverage checked per scale with quantiles learnt without the tested
    year. Also reports the coverage the COUNTRY quantiles would give on these blocks (expected too narrow)."""
    import json
    from pipeline.v2.harmonisation import CLASSES, NOMS_CLASSES
    d = P_[P_["pred"] > 0].copy()
    d["resid"] = np.log1p(d["Aqua"]) - np.log1p(d["pred"])
    d["classe"] = pd.cut(d["pred"], CLASSES, labels=NOMS_CLASSES).astype(str)
    q = {str(n): {c: {"q_bas": float(np.quantile(x["resid"], (1 - n) / 2)), "q_haut": float(np.quantile(x["resid"], 1 - (1 - n) / 2)),
                      "n": int(len(x))} for c, x in d.groupby("classe")} for n in niveaux}
    q_pays = json.load(open(os.path.join(dossier, "rapport_mondial.json"), encoding="utf-8"))["incertitude"]["quantiles"]
    couverture = {}
    for n in niveaux:
        lo, hi = (1 - n) / 2, 1 - (1 - n) / 2
        for e, de in d.groupby("echelle"):
            ok = []
            for t in annees:
                cal, te = d[d["annee"] != t], de[de["annee"] == t]
                bq = cal.groupby("classe")["resid"].quantile([lo, hi]).unstack()
                b = te.join(bq, on="classe")
                ok.append(((b["resid"] >= b[lo]) & (b["resid"] <= b[hi])).to_numpy())
            qp = de["classe"].map(lambda c: q_pays[str(n)][c]["q_bas"]), de["classe"].map(lambda c: q_pays[str(n)][c]["q_haut"])
            couverture[f"{n}|{e} deg"] = {"bandes_sous_pays": float(np.concatenate(ok).mean()),
                                          "bandes_pays_appliquees_ici": float(((de["resid"] >= qp[0]) & (de["resid"] <= qp[1])).mean())}
    out = {"methode": "split-conformal Mondrian, log(1+x), residus LOYO de blocs 2/1/0,5 deg a l'interieur des pays",
           "valide_pour": "zones sous l'echelle du pays (~55 a ~220 km) ; non teste pour un hexagone isole (~16 km)",
           "classes_bornes": [float(c) for c in CLASSES[1:-1]], "noms": NOMS_CLASSES, "quantiles": q, "couverture": couverture}
    with open(os.path.join(dossier, "incertitude_sous_pays.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    for k, v in couverture.items():
        print(f"couverture {k:<14} bandes sous-pays {v['bandes_sous_pays']:.3f} | bandes pays appliquees ici {v['bandes_pays_appliquees_ici']:.3f}")
    for n in niveaux:
        print(f"quantiles {n} :", {c: (round(v['q_bas'], 3), round(v['q_haut'], 3)) for c, v in q[str(n)].items()})


def main():
    dossier = os.path.join(P.DOSSIER_SORTIE, "monde")
    J = pd.concat([pd.read_parquet(p) for p in glob.glob(os.path.join(dossier, "jour", "*.parquet"))], ignore_index=True)
    J["acq_date"] = pd.to_datetime(J["acq_date"])
    J = J[J["satellite"].notna() & J["acq_date"].notna()]
    jsd = pd.read_csv(os.path.join(os.path.dirname(P.__file__), P.FICHIER_JOURS_SANS_DONNEES))
    obs = {s: jours_observes(s, jsd, J["acq_date"].max()) for s in ["Aqua", "SNPP"]}
    jc = obs["Aqua"].intersection(obs["SNPP"])
    jc = jc[(jc >= DEBUT_CALIB) & (jc <= FIN_CALIB)]
    U = table_calibration(J, jc, discordants(J, obs))
    U = U[U["pays"] != "inconnu"]
    del J
    sr = pd.read_csv(os.path.join(dossier, "k_pays.csv")).drop_duplicates("pays").set_index("pays")[["sous_region"]]
    annees = sorted(U["annee"].unique())
    k_loyo, kg_loyo = {}, {}
    for t in annees:                                    # country k WITHOUT year t
        tr = U[U["annee"] != t].groupby(["pays", "daynight", "mois"])[["Aqua", "SNPP"]].sum()
        e = estimer(tr, sr, ALPHA)
        k_loyo[t] = e.set_index(["pays", "daynight", "mois"])["k"]
        g = tr.groupby("daynight").sum()
        kg_loyo[t] = g["Aqua"] / g["SNPP"]

    def predire(B):
        parts = []
        for t in annees:
            b = B[B["annee"] == t].copy()
            k = b.set_index(["pays", "daynight", "mois"]).index.map(k_loyo[t]).to_numpy(float)
            b = b[~np.isnan(k)].assign(k=k[~np.isnan(k)])
            b["pred"], b["predA"] = b["k"] * b["SNPP"], b["daynight"].map(kg_loyo[t]) * b["SNPP"]
            parts.append(b)
        return pd.concat(parts).groupby(["unite", "annee", "mois"])[["Aqua", "pred", "predA"]].sum().reset_index()

    lignes, preds = [], []
    pays = U.rename(columns={"pays": "unite"}).assign(pays=lambda x: x["unite"])
    lignes.append({"echelle": "pays", **metriques(predire(pays))})
    for taille in ECHELLES:
        B = blocs(dossier, taille)
        B["unite"] = B["pays"] + "|" + B["bi"].astype(int).astype(str) + "|" + B["bj"].astype(int).astype(str)
        p = predire(B)
        preds.append(p.assign(echelle=f"{taille:g}"))
        lignes.append({"echelle": f"{taille:g} deg (~{round(111 * taille)} km)", **metriques(p)})
        g = predire(B[B["pays"] == "Greece"])
        lignes.append({"echelle": f"Grece, {taille:g} deg", **metriques(g)})
    r = pd.DataFrame(lignes)
    r.to_csv(os.path.join(dossier, "validation_sous_pays.csv"), index=False)
    bandes_sous_pays(dossier, pd.concat(preds, ignore_index=True), annees)
    pd.set_option("display.width", 250)
    print(r[["echelle", "n_unites", "rmse_sur_ecart_type_k1", "r2_anomalies_k1", "r2_anomalies_k_global",
             "skill_vs_k_global", "erreur_relative_mediane_pct_mois_50plus", "biais_pct"]].round(3).to_string(index=False))


if __name__ == "__main__":
    main()
