"""VIGIL-K1 applied to Fire Radiative Power (FRP, MW): harmonized monthly FRP per country.

Same model as the hotspot counts (mondial_calibration.estimer), on FRP sums instead of counts:
    k_frp[c,d,m] = (A_cdm + a) / (V_cdm + a / k0[c,d,m])     A, V = Aqua and S-NPP FRP sums (MW)
with the same hierarchy (global -> UN sub-region -> country -> month) and calibration days (both satellites
observed, 2012-02 .. 2020-10, discordant days removed). The prior strength a is expressed in "detection
equivalents": a = alpha x mean Aqua FRP per detection (so alpha means the same thing as for counts).
Validated by leave-one-year-out (LOYO) against two naive baselines:
    A) one global FRP ratio per day/night;   B) the COUNT k reused for FRP (is a separate k needed?).
Prediction band of a monthly total: split-conformal in log(1+x), by FRP size class (as for counts).

Command (after `mondial agreger --tables hex,jourfrp` and `mondial calibrer`):
    python -m pipeline.v2.mondial calibrer-frp
Outputs in <sortie>/monde/: k_frp_pays.csv, rho_frp_noaa20.csv, validation_frp_pays.csv,
serie_frp_mensuelle_pays.csv, rapport_frp.json
"""
import glob
import json
import os
from datetime import datetime

import numpy as np
import pandas as pd

from . import parametres as P
from .harmonisation import BASCULE, DEBUT_CALIB, FIN_CALIB
from .mondial_calibration import discordants, estimer, jours_observes, loyo, metriques

ALPHAS_TESTES = [3, 10, 30, 100]
NIVEAUX = [0.80, 0.95]
CLASSES_FRP = [-1, 200, 2_000, 20_000, np.inf]           # MW per month
NOMS_CLASSES_FRP = ["<200", "200-2k", "2k-20k", ">20k"]


def charger_jourfrp(dossier):
    J = pd.concat([pd.read_parquet(p) for p in glob.glob(os.path.join(dossier, "jourfrp", "*.parquet"))], ignore_index=True)
    J["acq_date"] = pd.to_datetime(J["acq_date"])
    return J[J["satellite"].notna() & J["acq_date"].notna()]


def table_frp(J, jours, disc, valeur):
    """Monthly sums of `valeur` (frp_vegetation or n_vegetation) per country x year x day/night x month, Aqua/SNPP."""
    j = J[J["acq_date"].isin(jours) & J["satellite"].isin(["Aqua", "SNPP"])].copy()
    if len(disc):
        j = j[~pd.MultiIndex.from_frame(j[["pays", "acq_date"]]).isin(pd.MultiIndex.from_frame(disc))]
    j["annee"], j["mois"] = j["acq_date"].dt.year, j["acq_date"].dt.month
    t = j.groupby(["pays", "annee", "daynight", "mois", "satellite"])[valeur].sum().unstack("satellite", fill_value=0)
    for s in ["Aqua", "SNPP"]:
        if s not in t.columns:
            t[s] = 0.0
    return t.reset_index()


def loyo_naifs(U, annees, k_comptes):
    """LOYO predictions of the two baselines (A: global ratio per day/night; B: count k reused)."""
    res = []
    for t in annees:
        tr = U[U["annee"] != t].groupby("daynight")[["Aqua", "SNPP"]].sum()
        te = U[U["annee"] == t].copy()
        te["predA"] = te["daynight"].map(tr["Aqua"] / tr["SNPP"]) * te["SNPP"]
        res.append(te)
    r = pd.concat(res)
    kb = r.set_index(["pays", "daynight", "mois"]).index.map(k_comptes).to_numpy(float)
    r["predB"] = np.nan_to_num(kb) * r["SNPP"]
    return r


def evaluer(m, annees):
    """Metrics of monthly country totals (columns Aqua, pred, predA, predB, annee, pays, mois)."""
    clim = {}
    for t in annees:                                       # climatology of the other years (anomaly baseline)
        c = m[m["annee"] != t].groupby(["pays", "mois"])["Aqua"].mean()
        clim[t] = m.loc[m["annee"] == t].set_index(["pays", "mois"]).index.map(c).to_numpy(float)
    m = m.copy()
    m["clim"] = np.nan
    for t in annees:
        m.loc[m["annee"] == t, "clim"] = clim[t]
    m["clim"] = m["clim"].fillna(0)
    o, sd = m["Aqua"].to_numpy(float), m["Aqua"].std()
    an_o = o - m["clim"].to_numpy()
    out = {}
    for nom, col in [("vigil_k1_frp", "pred"), ("naif_A_ratio_global", "predA"), ("naif_B_k_des_comptes", "predB")]:
        p = m[col].to_numpy(float)
        rmse = float(np.sqrt(np.mean((p - o) ** 2)))
        an_p = p - m["clim"].to_numpy()
        big = o >= 1000
        out[nom] = {"rmse_MW": rmse, "rmse_sur_ecart_type": rmse / sd, "r2": float(1 - np.mean((p - o) ** 2) / o.var()),
                    "r2_anomalies": float(1 - np.mean((an_p - an_o) ** 2) / an_o.var()),
                    "biais_pct": float(100 * (p.sum() - o.sum()) / o.sum()),
                    "erreur_relative_mediane_pct_mois_1000MW_plus": float(100 * np.median(np.abs(p[big] - o[big]) / o[big]))}
    ref = out["vigil_k1_frp"]["rmse_MW"]
    for nom in ["naif_A_ratio_global", "naif_B_k_des_comptes"]:
        out[nom]["skill_vigil_vs_ce_naif"] = 1 - (ref / out[nom]["rmse_MW"]) ** 2
    return out


def calibrer_frp(a):
    dossier = os.path.join(a.sortie, "monde")
    J = charger_jourfrp(dossier)
    kc = pd.read_csv(os.path.join(dossier, "k_pays.csv"))            # count calibration (same countries, sub-regions)
    sr = kc.drop_duplicates("pays").set_index("pays")[["sous_region"]]
    k_comptes = kc.set_index(["pays", "daynight", "mois"])["k"]
    jsd = pd.read_csv(os.path.join(os.path.dirname(__file__), P.FICHIER_JOURS_SANS_DONNEES))
    fin = J["acq_date"].max()
    obs = {s: jours_observes(s, jsd, fin) for s in ["Aqua", "SNPP", "NOAA20"]}
    disc = discordants(J, obs)                                         # same discordant days as for counts
    jc = obs["Aqua"].intersection(obs["SNPP"])
    jc = jc[(jc >= DEBUT_CALIB) & (jc <= FIN_CALIB)]
    U = table_frp(J, jc, disc, "frp_vegetation")
    U = U[(U["pays"] != "inconnu") & U["pays"].isin(sr.index)]
    annees = sorted(U["annee"].unique())
    n_aqua = table_frp(J, jc, disc, "n_vegetation")
    frp_par_detection = float(U["Aqua"].sum() / max(n_aqua.loc[n_aqua["pays"].isin(sr.index), "Aqua"].sum(), 1))
    manq = J.groupby("satellite")[["n_frp_manquante", "n_vegetation"]].sum()
    rapport = {"methode": "VIGIL-K1 applique a la FRP (MW)", "genere_le": datetime.now().isoformat(timespec="seconds"),
               "jours_calibration": int(len(jc)), "pays": int(U["pays"].nunique()),
               "frp_moyenne_par_detection_aqua_MW": frp_par_detection,
               "part_frp_manquante": (manq["n_frp_manquante"] / manq["n_vegetation"]).round(6).to_dict()}

    # 1. prior strength by LOYO (same rule as counts: most conservative alpha within 0.5 % of the best deviance)
    dev = {}
    for al in ALPHAS_TESTES:
        pr = loyo(U, sr, annees, al * frp_par_detection).groupby(["pays", "annee", "mois"])[["Aqua", "pred"]].sum()
        dev[al] = metriques(pr["Aqua"], pr["pred"])["deviance_poisson"]
    best = min(dev.values())
    alpha = max(al for al, v in dev.items() if v <= 1.005 * best)
    rapport["alpha"] = {"teste_en_detections_equivalentes": dev, "retenu": alpha, "en_MW": alpha * frp_par_detection}

    # 2. final LOYO + baselines + conformal bands
    pr = loyo(U, sr, annees, alpha * frp_par_detection)
    nv = loyo_naifs(U, annees, k_comptes)
    pr = pr.merge(nv[["pays", "annee", "daynight", "mois", "predA", "predB"]], on=["pays", "annee", "daynight", "mois"], how="left")
    m = pr.groupby(["pays", "annee", "mois"])[["Aqua", "pred", "predA", "predB"]].sum().reset_index()
    rapport["validation_mondiale"] = evaluer(m, annees)
    m["resid"] = np.log1p(m["Aqua"]) - np.log1p(m["pred"])
    m["classe"] = pd.cut(m["pred"], CLASSES_FRP, labels=NOMS_CLASSES_FRP)
    q = {str(niv): {cl: {"q_bas": float(np.quantile(x["resid"], (1 - niv) / 2)),
                         "q_haut": float(np.quantile(x["resid"], 1 - (1 - niv) / 2)), "n": int(len(x))}
                    for cl, x in m.groupby("classe", observed=True)} for niv in NIVEAUX}
    couv = {}
    for niv in NIVEAUX:
        ok = []
        for t in annees:
            cal, te = m[m["annee"] != t], m[m["annee"] == t]
            for cl, x in te.groupby("classe", observed=True):
                ref = cal.loc[cal["classe"] == cl, "resid"]
                ok.append(((x["resid"] >= np.quantile(ref, (1 - niv) / 2)) & (x["resid"] <= np.quantile(ref, 1 - (1 - niv) / 2))).to_numpy())
        couv[str(niv)] = float(np.concatenate(ok).mean())
    rapport["incertitude"] = {"methode": "split-conformal Mondrian, log(1+x), classes de FRP mensuelle (MW)",
                              "classes_MW": CLASSES_FRP[1:-1], "quantiles": q, "couverture_observee": couv}
    val = pd.DataFrame([{"pays": c, **metriques(x["Aqua"], x["pred"])} for c, x in m.groupby("pays")])
    val = val.rename(columns={"aqua_total": "aqua_frp_total_MW"}).join(sr, on="pays")
    val["fiabilite_frp"] = np.select([(val["aqua_frp_total_MW"] >= 50_000) & (val["r2"] >= 0.8) & (val["biais_pct"].abs() <= 10),
                                      (val["aqua_frp_total_MW"] >= 10_000) & (val["r2"] >= 0.5)], ["elevee", "moyenne"], default="faible")
    val.to_csv(os.path.join(dossier, "validation_frp_pays.csv"), index=False)
    rapport["fiabilite_frp_pays"] = val["fiabilite_frp"].value_counts().to_dict()

    # 3. final k on all calibration years
    K = estimer(U.groupby(["pays", "daynight", "mois"])[["Aqua", "SNPP"]].sum(), sr, alpha * frp_par_detection).reset_index(drop=True)
    K.to_csv(os.path.join(dossier, "k_frp_pays.csv"), index=False)

    # 4. NOAA-20 chained to S-NPP for FRP (global day/night x month)
    jn = obs["SNPP"].intersection(obs["NOAA20"])
    n = J[J["acq_date"].isin(jn) & J["satellite"].isin(["SNPP", "NOAA20"])]
    n = n.assign(mois=n["acq_date"].dt.month).groupby(["daynight", "mois", "satellite"])["frp_vegetation"].sum().unstack()
    rho = (n["SNPP"] / n["NOAA20"]).replace([np.inf, -np.inf], np.nan).rename("rho").reset_index()
    # fallback when a day/night x month has no common FRP (0/0): ratio of the day/night totals, else 1
    tot = n.groupby(level="daynight").sum()
    rho_dn = (tot["SNPP"] / tot["NOAA20"]).replace([np.inf, -np.inf], np.nan)
    rho["rho_repli"] = rho["rho"].isna()
    rho["rho"] = rho["rho"].fillna(rho["daynight"].map(rho_dn)).fillna(1.0)
    grille = pd.MultiIndex.from_product([["D", "N"], range(1, 13)], names=["daynight", "mois"]).to_frame(index=False)
    rho = grille.merge(rho, on=["daynight", "mois"], how="left")
    rho["rho_repli"] = rho["rho_repli"].fillna(True).astype(bool)
    rho["rho"] = rho["rho"].fillna(rho["daynight"].map(rho_dn)).fillna(1.0)
    rho.to_csv(os.path.join(dossier, "rho_frp_noaa20.csv"), index=False)
    rapport["rho_frp_noaa20"] = {"min": float(rho["rho"].min()), "max": float(rho["rho"].max()),
                                 "mois_en_repli": int(rho["rho_repli"].sum())}

    # 5. harmonized monthly FRP per country (same daily switch rule as counts)
    serie = serie_frp(J, K, rho, obs, fin, sr, q, val)
    serie.to_csv(os.path.join(dossier, "serie_frp_mensuelle_pays.csv"), index=False)
    rapport["fichiers"] = ["k_frp_pays.csv", "rho_frp_noaa20.csv", "validation_frp_pays.csv", "serie_frp_mensuelle_pays.csv"]
    with open(os.path.join(dossier, "rapport_frp.json"), "w", encoding="utf-8") as f:
        json.dump(rapport, f, ensure_ascii=False, indent=2, default=str)
    print(json.dumps({k: v for k, v in rapport.items() if k != "incertitude"}, ensure_ascii=False, indent=2, default=str))
    print("couverture observee des bandes :", couv)
    print(f"Fichiers ecrits dans {dossier}")


def serie_frp(J, K, rho, obs, fin, sr, q, val):
    kk = K.set_index(["pays", "daynight", "mois"])["k"]
    kp = K.groupby(["sous_region", "daynight", "mois"])["k_sous_region"].first()
    w = J[J["satellite"].isin(["Aqua", "SNPP", "NOAA20"])].copy()
    w["mois"], w["annee"] = w["acq_date"].dt.month, w["acq_date"].dt.year
    w = w.join(sr["sous_region"], on="pays")
    kv = w.set_index(["pays", "daynight", "mois"]).index.map(kk).to_numpy(float)
    ks = w.set_index(["sous_region", "daynight", "mois"]).index.map(kp).to_numpy(float)
    w["k"] = np.where(np.isnan(kv), ks, kv)
    k_dn = (K.groupby("daynight")["Aqua"].sum() / K.groupby("daynight")["SNPP"].sum())
    w["k"] = w["k"].fillna(w["daynight"].map(k_dn))        # country and sub-region unknown: global ratio, never 0
    w = w.merge(rho[["daynight", "mois", "rho"]], on=["daynight", "mois"], how="left")
    av = (w["acq_date"] < BASCULE).to_numpy()
    o = {s: w["acq_date"].isin(obs[s]).to_numpy() for s in obs}
    sat = w["satellite"].to_numpy()
    # before the switch: Aqua as observed; on Aqua outage days, converted S-NPP when it observes (never a hole when a sensor saw the fire)
    use = np.select([av & (sat == "Aqua") & o["Aqua"], av & (sat == "SNPP") & o["SNPP"] & ~o["Aqua"], ~av & (sat == "SNPP") & o["SNPP"],
                     ~av & (sat == "NOAA20") & o["NOAA20"] & ~o["SNPP"]], [1.0, 1.0, 1.0, 1.0], 0.0)
    fac = np.select([sat == "Aqua", sat == "SNPP", sat == "NOAA20"], [1.0, w["k"], w["k"] * w["rho"]], 0.0)
    w["frp_MW"] = use * np.nan_to_num(fac) * w["frp_vegetation"]
    s = w[(w["annee"] >= 2002) & (w["pays"] != "inconnu")].groupby(["pays", "annee", "mois"])["frp_MW"].sum()
    mois_tous = pd.period_range(P.DEBUT_DONNEES_FIRMS["Aqua"], fin, freq="M")
    grille = pd.MultiIndex.from_tuples([(c, p.year, p.month) for c in sorted(set(s.index.get_level_values(0)))
                                        for p in mois_tous], names=["pays", "annee", "mois"])
    s = s.reindex(grille, fill_value=0.0).reset_index()
    conv = (pd.to_datetime(dict(year=s["annee"], month=s["mois"], day=1)) >= BASCULE).to_numpy()
    cl = pd.cut(s["frp_MW"], CLASSES_FRP, labels=NOMS_CLASSES_FRP).astype(str)
    for niv in NIVEAUX:
        qb = cl.map(lambda c: q[str(niv)].get(c, {"q_bas": 0.0})["q_bas"]).astype(float)
        qh = cl.map(lambda c: q[str(niv)].get(c, {"q_haut": 0.0})["q_haut"]).astype(float)
        tag = int(round(niv * 100))
        s[f"bas_{tag}"] = np.where(conv, np.maximum(np.expm1(np.log1p(s["frp_MW"]) + qb), 0), s["frp_MW"])
        s[f"haut_{tag}"] = np.where(conv, np.expm1(np.log1p(s["frp_MW"]) + qh), s["frp_MW"])
    s["source"] = np.where(conv, "viirs_converted", "modis_observed")
    return s.join(val.set_index("pays")["fiabilite_frp"], on="pays")
