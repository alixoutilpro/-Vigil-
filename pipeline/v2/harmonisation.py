"""Phase 3 - Harmonization VIIRS -> Aqua-MODIS equivalent (method decided by etudes/etude_k.py).

Usage (from the repo root, after pipeline.v2.nettoyage):
    .\\.venv\\Scripts\\python.exe -m pipeline.v2.harmonisation --region grece

Method "VIGIL-K1" (see Hackathon-contexte/sous-bassements scientifiques/3 Audit de k.md):
- reference: Aqua MODIS in its stable orbit. Calibration window 2012-02-01 -> 2020-10-31
  (Pettitt change point of the daytime ratio in 2020-11 = Aqua orbit drift).
- calibration days: Aqua AND S-NPP observing, outage days and discordant days excluded.
- conversion factor per country c, day/night d, calendar month m (gamma-Poisson empirical Bayes):
      k0[c,d,m] = k[c,d] * k[d,m] / k[d]                      (country level x pooled seasonality)
      k[c,d,m]  = (A[c,d,m] + ALPHA) / (V[c,d,m] + ALPHA / k0[c,d,m])
  where A, V = Aqua and S-NPP totals on calibration days, ALPHA = 10 (chosen by cross-validation).
  Areas outside calibrated countries use the pooled k[d,m].
- NOAA-20 is chained to S-NPP: rho[d,m] = sum SNPP / sum NOAA20 on common days, then k * rho.
- published series: Aqua observed before 2020-11-01; afterwards S-NPP converted (NOAA-20 converted
  when S-NPP does not observe: outages, and after 2026-11-02). A valid observation is never replaced
  by a model estimate.
- uncertainty: split-conformal 80 % interval on log(1+x) residuals of leave-one-year-out predictions,
  computed per magnitude class (Mondrian), applied to monthly totals; lower bound >= 0 by construction.
"""
import argparse
import json
import os
from datetime import date, datetime

import numpy as np
import pandas as pd

from . import parametres as P

METHODE = "VIGIL-K1"
DEBUT_CALIB, FIN_CALIB = pd.Timestamp("2012-02-01"), pd.Timestamp("2020-10-31")
BASCULE = pd.Timestamp("2020-11-01")
ALPHA = 10.0
NIVEAU = 0.80
CLASSES = [-1, 5, 30, 150, np.inf]
NOMS_CLASSES = ["<5", "5-30", "30-150", ">150"]
SATS = ["Aqua", "SNPP", "NOAA20"]


def jours_observes(sat, jsd, fin):
    jours = pd.date_range(P.DEBUT_DONNEES_FIRMS[sat], fin, freq="D")
    f = P.VIE_SATELLITES[sat][1]
    if f is not None:
        jours = jours[jours <= pd.Timestamp(f)]
    panne = set(jsd.loc[jsd["satellite"] == sat, "date"])
    return pd.DatetimeIndex([j for j in jours if j not in panne])


def totaux(agg, jours, sats, cles):
    a = agg[agg["satellite"].isin(sats) & agg["acq_date"].isin(jours)]
    a = a.assign(mois=a["acq_date"].dt.month, annee=a["acq_date"].dt.year)
    t = a.groupby(cles + ["satellite"])["n_vegetation"].sum().unstack("satellite", fill_value=0)
    for s in sats:
        if s not in t.columns:
            t[s] = 0
    return t


def estimer_k(t_cdm):
    """t_cdm: totals indexed by (pays, daynight, mois) with columns Aqua, SNPP. Returns k tables."""
    t = t_cdm.reset_index()
    kd = t.groupby("daynight")[["Aqua", "SNPP"]].sum()
    kd = kd["Aqua"] / kd["SNPP"]
    kdm = t.groupby(["daynight", "mois"])[["Aqua", "SNPP"]].sum()
    kdm = kdm["Aqua"] / kdm["SNPP"]
    kcd = t.groupby(["pays", "daynight"])[["Aqua", "SNPP"]].sum()
    kcd = kcd["Aqua"] / kcd["SNPP"]
    lignes = []
    for c in sorted(t["pays"].unique()):
        for d in ["D", "N"]:
            for m in range(1, 13):
                sel = t[(t["pays"] == c) & (t["daynight"] == d) & (t["mois"] == m)]
                A, V = float(sel["Aqua"].sum()), float(sel["SNPP"].sum())
                k0 = kcd.get((c, d), kd[d]) * kdm[(d, m)] / kd[d]
                lignes.append({"pays": c, "daynight": d, "mois": m, "A_calib": A, "V_calib": V,
                               "k_pays_dn": kcd.get((c, d), np.nan), "k_commun_dn_mois": kdm[(d, m)],
                               "k_prior": k0, "k": (A + ALPHA) / (V + ALPHA / k0)})
    kc = pd.DataFrame(lignes)
    kp = kdm.rename("k").reset_index()
    return kc, kp


def appliquer_k(df, kc, kp):
    """df with columns pays, daynight, mois -> k (country table, pooled fallback)."""
    k = df.merge(kc[["pays", "daynight", "mois", "k"]], on=["pays", "daynight", "mois"], how="left")["k"]
    k_pool = df.merge(kp, on=["daynight", "mois"], how="left")["k"]
    return k.fillna(k_pool).to_numpy()


def conformal(agg, jours_calib):
    """Leave-one-year-out residuals of monthly country totals -> Mondrian quantiles per class."""
    t = totaux(agg, jours_calib, ["Aqua", "SNPP"], ["pays", "annee", "daynight", "mois"]).reset_index()
    res = []
    for an in sorted(t["annee"].unique()):
        tr = t[t["annee"] != an].groupby(["pays", "daynight", "mois"])[["Aqua", "SNPP"]].sum()
        kc, kp = estimer_k(tr)
        te = t[t["annee"] == an].copy()
        te["pred"] = appliquer_k(te, kc, kp) * te["SNPP"]
        res.append(te)
    r = pd.concat(res).groupby(["pays", "annee", "mois"])[["Aqua", "pred"]].sum().reset_index()
    r["resid"] = np.log1p(r["Aqua"]) - np.log1p(r["pred"])
    r["classe"] = pd.cut(r["pred"], CLASSES, labels=NOMS_CLASSES)
    a = (1 - NIVEAU) / 2
    q = {cl: {"q_bas": float(np.quantile(g["resid"], a)), "q_haut": float(np.quantile(g["resid"], 1 - a)), "n": int(len(g))}
         for cl, g in r.groupby("classe", observed=True)}
    o, p = r["Aqua"].to_numpy(float), r["pred"].to_numpy(float)
    valid = {"schema": "leave_one_year_out", "n_mois": int(len(r)),
             "rmse": float(np.sqrt(np.mean((p - o) ** 2))), "ecart_type_reference": float(o.std()),
             "r2": float(1 - np.mean((p - o) ** 2) / o.var()), "biais_pct": float(100 * (p.sum() - o.sum()) / o.sum()),
             "deviance_poisson": float(2 * np.sum(np.where(o > 0, o * np.log(np.where(o > 0, o, 1) / np.maximum(p, 1e-9)), 0) - (o - p)) / len(o))}
    return q, valid


def intervalle(valeur, quantiles):
    cl = pd.cut(pd.Series(valeur), CLASSES, labels=NOMS_CLASSES)
    qb = cl.map(lambda c: quantiles[c]["q_bas"]).astype(float).to_numpy()
    qh = cl.map(lambda c: quantiles[c]["q_haut"]).astype(float).to_numpy()
    lo = np.maximum(np.expm1(np.log1p(valeur) + qb), 0.0)
    hi = np.expm1(np.log1p(valeur) + qh)
    return lo, hi


def main(argv=None):
    ap = argparse.ArgumentParser(description="Vigil v2 - harmonisation VIIRS -> equivalent Aqua")
    ap.add_argument("--region", default="grece", choices=sorted(P.REGIONS))
    ap.add_argument("--sortie", default=P.DOSSIER_SORTIE)
    a = ap.parse_args(argv)
    dossier = os.path.join(a.sortie, a.region)
    agg = pd.read_parquet(os.path.join(dossier, "agregat_h3_jour.parquet"))
    cc = pd.read_csv(os.path.join(dossier, "controle_croise_jours.csv"), parse_dates=["acq_date"])
    jsd = pd.read_csv(os.path.join(dossier, "jours_sans_donnees.csv"), parse_dates=["date"])
    fin = agg["acq_date"].max()
    obs = {s: jours_observes(s, jsd, fin) for s in SATS}
    discord = pd.DatetimeIndex(cc.loc[cc["discordant"], "acq_date"])

    # 1. calibration Aqua <- S-NPP
    jc = obs["Aqua"].intersection(obs["SNPP"]).difference(discord)
    jc = jc[(jc >= DEBUT_CALIB) & (jc <= FIN_CALIB)]
    kc, kp = estimer_k(totaux(agg, jc, ["Aqua", "SNPP"], ["pays", "daynight", "mois"]))
    # 2. chain NOAA-20 -> S-NPP
    jn = obs["SNPP"].intersection(obs["NOAA20"])
    tn = totaux(agg, jn, ["SNPP", "NOAA20"], ["daynight", "mois"])
    rho = (tn["SNPP"] / tn["NOAA20"]).rename("rho").reset_index()
    # 3. uncertainty
    quantiles, validation = conformal(agg, jc)

    # 4. apply at cell x day level
    w = agg.pivot_table(index=["h3_6", "acq_date", "daynight", "pays"], columns="satellite",
                        values="n_vegetation", aggfunc="sum", fill_value=0).reset_index()
    for s in ["Terra"] + SATS:
        if s not in w.columns:
            w[s] = 0
    w["mois"] = w["acq_date"].dt.month
    w["k"] = appliquer_k(w, kc, kp)
    w = w.merge(rho, on=["daynight", "mois"], how="left")
    jour_obs = {s: w["acq_date"].isin(obs[s]).to_numpy() for s in SATS}
    w["aqua_eq_snpp"] = np.where(jour_obs["SNPP"], w["k"] * w["SNPP"], np.nan)
    w["aqua_eq_noaa20"] = np.where(jour_obs["NOAA20"], w["k"] * w["rho"] * w["NOAA20"], np.nan)
    avant = (w["acq_date"] < BASCULE).to_numpy()
    w["valeur"] = np.select(
        [avant & jour_obs["Aqua"], ~avant & jour_obs["SNPP"], ~avant & jour_obs["NOAA20"]],
        [w["Aqua"], w["aqua_eq_snpp"], w["aqua_eq_noaa20"]], default=np.nan)
    w["source"] = np.select(
        [avant & jour_obs["Aqua"], ~avant & jour_obs["SNPP"], ~avant & jour_obs["NOAA20"]],
        ["modis_observed", "viirs_converted_snpp", "viirs_converted_noaa20"], default="none")
    cols = ["h3_6", "acq_date", "daynight", "pays", "Terra", "Aqua", "SNPP", "NOAA20",
            "k", "rho", "aqua_eq_snpp", "aqua_eq_noaa20", "valeur", "source"]
    w[cols].to_parquet(os.path.join(dossier, "harmonise_h3_jour.parquet"), index=False)

    # 5. monthly series per country (+ whole zone), with coverage and interval
    jours = pd.date_range(pd.Timestamp(P.DEBUT_DONNEES_FIRMS["Aqua"]), fin, freq="D")
    src_jour = pd.Series(np.select([jours < BASCULE, jours.isin(obs["SNPP"]), jours.isin(obs["NOAA20"])],
                                   ["Aqua", "SNPP", "NOAA20"], default="none"), index=jours)
    src_jour[(jours < BASCULE) & ~jours.isin(obs["Aqua"])] = "none"
    cov = (src_jour != "none").groupby([jours.year, jours.month]).mean()
    cov.index.names = ["annee", "mois"]
    w["annee"], w["mois"] = w["acq_date"].dt.year, w["acq_date"].dt.month
    lignes = []
    for zone, sel in [(c, w["pays"] == c) for c in sorted(w["pays"].unique())] + [("zone", w["pays"].notna())]:
        m = w[sel & w["annee"].ge(2002)].groupby(["annee", "mois"])["valeur"].sum(min_count=1)
        m = m.reindex(cov.index)
        conv = (pd.to_datetime(dict(year=m.index.get_level_values(0), month=m.index.get_level_values(1), day=1)) >= BASCULE).to_numpy()
        val = m.fillna(0).to_numpy(float)
        lo, hi = intervalle(val, quantiles)
        lo, hi = np.where(conv, lo, val), np.where(conv, hi, val)
        lignes.append(pd.DataFrame({"zone": zone, "annee": m.index.get_level_values(0), "mois": m.index.get_level_values(1),
                                    "hotspots_aqua_eq": np.where(cov.to_numpy() > 0, val, np.nan),
                                    "bas_80": np.where(cov.to_numpy() > 0, lo, np.nan),
                                    "haut_80": np.where(cov.to_numpy() > 0, hi, np.nan),
                                    "source": np.where(conv, "viirs_converted", "modis_observed"),
                                    "couverture_jours": cov.to_numpy()}))
    serie = pd.concat(lignes)
    serie.to_csv(os.path.join(dossier, "serie_mensuelle_harmonisee.csv"), index=False)

    params = {
        "methode": METHODE, "genere_le": datetime.now().isoformat(timespec="seconds"),
        "reference": "Aqua MODIS (orbite stable)",
        "fenetre_calibration": [str(DEBUT_CALIB.date()), str(FIN_CALIB.date())],
        "bascule_source": str(BASCULE.date()), "alpha_bayes": ALPHA, "jours_calibration": int(len(jc)),
        "k_pays": kc.round(6).to_dict(orient="records"), "k_commun": kp.round(6).to_dict(orient="records"),
        "rho_noaa20_vers_snpp": rho.round(6).to_dict(orient="records"),
        "incertitude": {"methode": "split-conformal Mondrian (classes de taille), log(1+x)", "niveau": NIVEAU,
                        "quantiles": quantiles},
        "validation": validation,
    }
    with open(os.path.join(dossier, "parametres_harmonisation.json"), "w", encoding="utf-8") as f:
        json.dump(params, f, ensure_ascii=False, indent=2)

    g = serie[serie["zone"] == "Greece"]
    print(f"Methode {METHODE} | {len(jc)} jours de calibration | validation LOYO : R2 = {validation['r2']:.3f}, "
          f"biais = {validation['biais_pct']:+.2f} %, deviance = {validation['deviance_poisson']:.2f}")
    print("k (Grece, jour) par mois :", kc[(kc["pays"] == "Greece") & (kc["daynight"] == "D")]["k"].round(3).tolist())
    print("Grece, total annuel en equivalent Aqua :")
    print(g.groupby("annee")["hotspots_aqua_eq"].sum().round(0).astype(int).to_string())
    print(f"Fichiers ecrits dans {dossier} : harmonise_h3_jour.parquet, serie_mensuelle_harmonisee.csv, parametres_harmonisation.json")


if __name__ == "__main__":
    main()
