"""Etude de la conversion VIIRS -> equivalent Aqua-MODIS (le facteur k).

Reproductible : lit les sorties de pipeline.v2.nettoyage et ecrit tous les tableaux dans
<entree>/etude_k/. Usage :
    .\\.venv\\Scripts\\python.exe -m etudes.etude_k --entree C:\\Hackathon-NASA\\Donnees-propres\\grece

Protocole fixe AVANT de regarder les resultats :
- cible : nombre MENSUEL de hotspots Aqua (unite du calendrier), jour + nuit ;
- unites d'ajustement : mois x strate (jour/nuit, ...) x region ;
- juge : validation croisee "une annee laissee de cote" (LOYO) sur 2012-2021 ;
- references a battre : climatologie (mediane Aqua du meme mois, annees d'entrainement) et k = 1 ;
- calibration sur les jours ou les DEUX satellites observent (hors pannes listees, hors jours
  discordants), variante sans ce filtre en test de sensibilite.
"""
import argparse
import os

import numpy as np
import pandas as pd

from pipeline.v2 import parametres as P

ANNEES_CALIB = list(range(2012, 2022))
ETE = {6, 7, 8, 9}


# ------------------------------------------------------------------ data
def charger(entree, colonne="n_vegetation"):
    agg = pd.read_parquet(os.path.join(entree, "agregat_h3_jour.parquet"))
    cc = pd.read_csv(os.path.join(entree, "controle_croise_jours.csv"), parse_dates=["acq_date"])
    jsd = pd.read_csv(os.path.join(entree, "jours_sans_donnees.csv"), parse_dates=["date"])
    agg = agg.assign(n=agg[colonne] if colonne in agg else agg["n_vegetation"] + agg["n_industriel"])
    return agg, cc, jsd


def jours_observes(sat, jsd, debut, fin):
    jours = pd.date_range(debut, fin, freq="D")
    d0, d1 = P.DEBUT_DONNEES_FIRMS[sat], P.VIE_SATELLITES[sat][1]
    ok = (jours >= pd.Timestamp(d0)) & (jours <= pd.Timestamp(d1 or fin))
    panne = set(jsd.loc[jsd["satellite"] == sat, "date"])
    return set(jours[ok & ~jours.isin(panne)])


def mensuel(agg, sats, jours_communs, cle_region):
    """Monthly totals per region x day/night, restricted to the given set of days."""
    a = agg[agg["satellite"].isin(sats) & agg["acq_date"].isin(jours_communs)]
    a = a.assign(region=cle_region(a), annee=a["acq_date"].dt.year, mois=a["acq_date"].dt.month)
    t = a.groupby(["region", "annee", "mois", "daynight", "satellite"])["n"].sum().unstack("satellite", fill_value=0)
    for s in sats:
        if s not in t.columns:
            t[s] = 0
    idx = pd.MultiIndex.from_product([sorted(a["region"].unique()), sorted(a["annee"].unique()), range(1, 13), ["D", "N"]],
                                     names=["region", "annee", "mois", "daynight"])
    return t.reindex(idx, fill_value=0).reset_index()


# ------------------------------------------------------------------ estimators (y = Aqua, x = VIIRS)
def ratio_totaux(y, x):
    return {"k": y.sum() / x.sum() if x.sum() > 0 else np.nan}


def moyenne_ratios(y, x):
    m = x > 0
    return {"k": np.mean(y[m] / x[m]) if m.any() else np.nan}


def mediane_ratios(y, x):
    m = x > 0
    return {"k": np.median(y[m] / x[m]) if m.any() else np.nan}


def mco_origine(y, x):
    return {"k": (x * y).sum() / (x * x).sum() if (x * x).sum() > 0 else np.nan}


def rma_origine(y, x):
    return {"k": np.sqrt((y * y).sum() / (x * x).sum()) if (x * x).sum() > 0 else np.nan}


def poisson_puissance(y, x, iterations=50):
    """Poisson GLM log E[y] = a + b log x (x > 0), IRLS. b = 1 <=> proportional model."""
    m = x > 0
    X = np.column_stack([np.ones(m.sum()), np.log(x[m])])
    yy = y[m].astype(float)
    beta = np.array([np.log(max(yy.sum(), 1) / x[m].sum()), 1.0])
    for _ in range(iterations):
        eta = X @ beta
        mu = np.exp(eta)
        z = eta + (yy - mu) / mu
        W = mu
        nb = np.linalg.solve(X.T @ (W[:, None] * X), X.T @ (W * z))
        if np.max(np.abs(nb - beta)) < 1e-10:
            beta = nb
            break
        beta = nb
    mu = np.exp(X @ beta)
    phi = np.sum((yy - mu) ** 2 / mu) / max(len(yy) - 2, 1)
    cov = phi * np.linalg.inv(X.T @ (mu[:, None] * X))
    return {"a": beta[0], "b": beta[1], "se_b": np.sqrt(cov[1, 1]), "phi": phi}


def predire(params, x, methode):
    if methode == "poisson_puissance":
        return np.where(x > 0, np.exp(params["a"]) * np.power(np.maximum(x, 1e-12), params["b"]), 0.0)
    if methode == "quantile_mapping":
        qx, qy, ktail = params["qx"], params["qy"], params["ktail"]
        return np.where(x <= qx[-1], np.interp(x, qx, qy), qy[-1] + ktail * (x - qx[-1]))
    return params["k"] * x


def quantile_mapping(y, x):
    q = np.linspace(0, 1, 101)
    qx, qy = np.quantile(x, q), np.quantile(y, q)
    qx, i = np.unique(qx, return_index=True)
    return {"qx": qx, "qy": qy[i], "ktail": y.sum() / x.sum() if x.sum() else np.nan}


ESTIMATEURS = {"ratio_totaux": ratio_totaux, "moyenne_ratios": moyenne_ratios, "mediane_ratios": mediane_ratios,
               "mco_origine": mco_origine, "rma_origine": rma_origine, "poisson_puissance": poisson_puissance,
               "quantile_mapping": quantile_mapping}

STRATES = {
    "aucune": lambda d: pd.Series("tout", index=d.index),
    "jour_nuit": lambda d: d["daynight"],
    "jour_nuit_saison": lambda d: d["daynight"] + "_" + np.where(d["mois"].isin(ETE), "ete", "hors_ete"),
    "jour_nuit_mois": lambda d: d["daynight"] + "_" + d["mois"].astype(str),
}


# ------------------------------------------------------------------ cross-validation
def ajuster(train, methode, strate, vcol):
    s = STRATES[strate](train)
    return {k: ESTIMATEURS[methode](g["Aqua"].to_numpy(float), g[vcol].to_numpy(float)) for k, g in train.groupby(s)}


def appliquer(modele, test, methode, strate, vcol, repli=None):
    s = STRATES[strate](test)
    pred = np.zeros(len(test))
    for k, idx in test.groupby(s).groups.items():
        p = modele.get(k) or repli
        pos = test.index.get_indexer(idx)
        pred[pos] = predire(p, test.loc[idx, vcol].to_numpy(float), methode)
    return pred


def loyo(m, methode, strate, vcol, annees=ANNEES_CALIB, region_fit=None):
    """Leave-one-year-out predictions of monthly Aqua (unit rows) for the given years."""
    out = []
    for t in annees:
        tr = m[m["annee"].isin(annees) & (m["annee"] != t)]
        if region_fit is not None:
            tr = tr[tr["region"].isin(region_fit)]
        te = m[m["annee"] == t].copy()
        mod = ajuster(tr, methode, strate, vcol)
        te["pred"] = appliquer(mod, te, methode, strate, vcol)
        out.append(te)
    return pd.concat(out)


def metriques(df, obs="Aqua", pred="pred"):
    """Metrics on region x month totals (day + night summed)."""
    g = df.groupby(["region", "annee", "mois"])[[obs, pred]].sum()
    o, p = g[obs].to_numpy(float), g[pred].to_numpy(float)
    rmse = np.sqrt(np.mean((p - o) ** 2))
    sd = o.std()
    rmse_log = np.sqrt(np.mean((np.log1p(p) - np.log1p(o)) ** 2))
    dev = 2 * np.sum(np.where(o > 0, o * np.log(np.where(o > 0, o, 1) / np.maximum(p, 1e-9)), 0) - (o - p)) / len(o)
    return {"n_mois": len(o), "RMSE": rmse, "ecart_type_obs": sd, "R2": 1 - (rmse / sd) ** 2 if sd > 0 else np.nan,
            "RMSE_log": rmse_log, "MAE": np.mean(np.abs(p - o)), "biais_pct": 100 * (p.sum() - o.sum()) / o.sum(),
            "deviance_poisson": dev}


def climatologie_loyo(m, annees=ANNEES_CALIB):
    out = []
    for t in annees:
        tr = m[m["annee"].isin(annees) & (m["annee"] != t)]
        med = tr.groupby(["region", "mois", "daynight"])["Aqua"].median()
        te = m[m["annee"] == t].copy()
        te["pred"] = med.reindex(pd.MultiIndex.from_frame(te[["region", "mois", "daynight"]])).to_numpy()
        out.append(te)
    return pd.concat(out)


def mann_kendall(x):
    x = np.asarray(x, float)
    n = len(x)
    s = sum(np.sign(x[j] - x[i]) for i in range(n - 1) for j in range(i + 1, n))
    var = n * (n - 1) * (2 * n + 5) / 18
    z = (s - np.sign(s)) / np.sqrt(var) if s != 0 else 0.0
    from math import erf, sqrt
    p = 2 * (1 - 0.5 * (1 + erf(abs(z) / sqrt(2))))
    pentes = [(x[j] - x[i]) / (j - i) for i in range(n - 1) for j in range(i + 1, n)]
    return {"S": s, "z": z, "p": p, "pente_sen": float(np.median(pentes))}


# ------------------------------------------------------------------ main
def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--entree", default=os.path.join(P.DOSSIER_SORTIE, "grece"))
    a = ap.parse_args(argv)
    sortie = os.path.join(a.entree, "etude_k")
    os.makedirs(sortie, exist_ok=True)
    agg, cc, jsd = charger(a.entree)
    fin = agg["acq_date"].max()
    discord = set(cc.loc[cc["discordant"], "acq_date"])
    obs = {s: jours_observes(s, jsd, "2000-11-01", fin) for s in ["Terra", "Aqua", "SNPP", "NOAA20"]}
    commun_sa = (obs["Aqua"] & obs["SNPP"]) - discord
    region_zone = lambda d: pd.Series("zone", index=d.index)  # noqa: E731
    region_pays = lambda d: d["pays"]  # noqa: E731
    R = {}

    # ---- 1. estimators x stratification, zone + Greece, LOYO 2012-2021 (SNPP -> Aqua)
    mz = mensuel(agg, ["Aqua", "SNPP"], commun_sa, region_zone)
    mp = mensuel(agg, ["Aqua", "SNPP"], commun_sa, region_pays)
    lignes = []
    for strate in STRATES:
        for meth in ESTIMATEURS:
            if meth == "quantile_mapping" and strate == "jour_nuit_mois":
                continue
            pz = loyo(mz, meth, strate, "SNPP")
            pg = loyo(mp, meth, strate, "SNPP", region_fit=None)
            lignes.append({"strate": strate, "methode": meth, "niveau": "zone", **metriques(pz)})
            lignes.append({"strate": strate, "methode": meth, "niveau": "pays (5)", **metriques(pg)})
            lignes.append({"strate": strate, "methode": meth, "niveau": "Grece", **metriques(pg[pg["region"] == "Greece"])})
    for nom, df in [("climatologie (prevision constante)", climatologie_loyo(mp)), ("k = 1 (aucune harmonisation)", mp.assign(pred=mp["SNPP"]))]:
        df = df[df["annee"].isin(ANNEES_CALIB)]
        lignes.append({"strate": "-", "methode": nom, "niveau": "pays (5)", **metriques(df)})
        lignes.append({"strate": "-", "methode": nom, "niveau": "Grece", **metriques(df[df["region"] == "Greece"])})
    t1 = pd.DataFrame(lignes)
    t1.to_csv(os.path.join(sortie, "1_estimateurs_strates.csv"), index=False)
    R["t1"] = t1

    # ---- 2. proportionality test (power law exponent b), per day/night, zone
    lignes = []
    for dn in ["D", "N"]:
        g = mz[(mz["daynight"] == dn) & mz["annee"].isin(ANNEES_CALIB)]
        r = poisson_puissance(g["Aqua"].to_numpy(float), g["SNPP"].to_numpy(float))
        lignes.append({"daynight": dn, "b": r["b"], "IC95_b": (r["b"] - 1.96 * r["se_b"], r["b"] + 1.96 * r["se_b"]),
                       "phi_surdispersion": r["phi"], "k_ratio_totaux": ratio_totaux(g["Aqua"].to_numpy(float), g["SNPP"].to_numpy(float))["k"]})
    pd.DataFrame(lignes).to_csv(os.path.join(sortie, "2_proportionnalite.csv"), index=False)
    R["t2"] = pd.DataFrame(lignes)

    # ---- 3. pooled vs per-country k, predicting Greece (LOYO)
    lignes = []
    for nom, fit in [("k commun 5 pays", None), ("k Grece seule", ["Greece"])]:
        pr = loyo(mp, "ratio_totaux", "jour_nuit", "SNPP", region_fit=fit)
        lignes.append({"calibration": nom, **metriques(pr[pr["region"] == "Greece"])})
    # empirical-Bayes partial pooling (gamma-Poisson conjugate): per country and day/night,
    # k_c = (A_c + alpha) / (V_c + alpha / k_pool); alpha = 0 -> own k, alpha -> inf -> pooled k.
    # alpha chosen by LOYO on the 5 countries (all predicted months), then reported for Greece.
    for alpha in [0, 10, 30, 100, 300, 1000, 3000, 1e9]:
        out = []
        for t in ANNEES_CALIB:
            tr = mp[mp["annee"].isin(ANNEES_CALIB) & (mp["annee"] != t)]
            te = mp[mp["annee"] == t].copy()
            tot = tr.groupby("daynight")[["Aqua", "SNPP"]].sum()
            kpool = tot["Aqua"] / tot["SNPP"]
            par = tr.groupby(["region", "daynight"])[["Aqua", "SNPP"]].sum()
            kc = {(r, dn): (row["Aqua"] + alpha) / (row["SNPP"] + alpha / kpool[dn]) for (r, dn), row in par.iterrows()}
            te["pred"] = [kc[(r, dn)] * v for r, dn, v in zip(te["region"], te["daynight"], te["SNPP"])]
            out.append(te)
        pr = pd.concat(out)
        lignes.append({"calibration": f"bayes gamma-Poisson alpha={alpha:g}", **metriques(pr), "niveau": "pays (5)"})
        lignes.append({"calibration": f"bayes gamma-Poisson alpha={alpha:g}", **metriques(pr[pr["region"] == "Greece"]), "niveau": "Grece"})
    yr = mp[mp["annee"].isin(ANNEES_CALIB)].groupby(["region", "daynight"])[["Aqua", "SNPP"]].sum()
    yr["k"] = yr["Aqua"] / yr["SNPP"]
    pd.DataFrame(lignes).to_csv(os.path.join(sortie, "3_regional.csv"), index=False)
    yr.reset_index().to_csv(os.path.join(sortie, "3_k_par_pays.csv"), index=False)
    R["t3"], R["t3b"] = pd.DataFrame(lignes), yr

    # ---- 4. temporal drift: yearly k (day / night) 2012-2025 + Mann-Kendall + block bootstrap CI
    mall = mensuel(agg, ["Aqua", "SNPP", "NOAA20"], (obs["Aqua"] & obs["SNPP"]) - discord, region_zone)
    rng = np.random.default_rng(0)
    lignes = []
    for dn in ["D", "N"]:
        for an, g in mall[mall["daynight"] == dn].groupby("annee"):
            if an < 2012:
                continue
            k = g["Aqua"].sum() / g["SNPP"].sum()
            boots = [g.iloc[rng.integers(0, len(g), len(g))] for _ in range(2000)]
            kb = [b["Aqua"].sum() / b["SNPP"].sum() for b in boots if b["SNPP"].sum() > 0]
            lignes.append({"daynight": dn, "annee": an, "k": k, "IC95_bas": np.quantile(kb, .025), "IC95_haut": np.quantile(kb, .975)})
    t4 = pd.DataFrame(lignes)
    t4.to_csv(os.path.join(sortie, "4_k_annuel.csv"), index=False)
    mk = {dn: mann_kendall(t4[t4["daynight"] == dn].sort_values("annee")["k"]) for dn in ["D", "N"]}
    mk10 = {dn: mann_kendall(t4[(t4["daynight"] == dn) & t4["annee"].between(2012, 2021)].sort_values("annee")["k"]) for dn in ["D", "N"]}
    R["t4"], R["mk"], R["mk10"] = t4, mk, mk10
    # forward validation of the window
    lignes = []
    for fen_nom, fen in [("2012-2021", range(2012, 2022)), ("2012-2025", range(2012, 2026)), ("2018-2025", range(2018, 2026))]:
        tr = mall[mall["annee"].isin(fen)]
        mod = ajuster(tr, "ratio_totaux", "jour_nuit", "SNPP")
        for per_nom, per in [("2022-2025", range(2022, 2026))]:
            te = mall[mall["annee"].isin(per)].copy()
            te["pred"] = appliquer(mod, te, "ratio_totaux", "jour_nuit", "SNPP")
            lignes.append({"fenetre": fen_nom, "evalue_sur": per_nom, "dans_fenetre": any(y in fen for y in per), **metriques(te)})
    pd.DataFrame(lignes).to_csv(os.path.join(sortie, "4b_fenetre.csv"), index=False)
    R["t4b"] = pd.DataFrame(lignes)

    # ---- 5. NOAA-20: direct vs chained vs mean of SNPP and N20 (LOYO 2018-2021, then 2022-2025 check)
    c3 = (obs["Aqua"] & obs["SNPP"] & obs["NOAA20"]) - discord
    m3 = mensuel(agg, ["Aqua", "SNPP", "NOAA20"], c3, region_zone)
    ans = list(range(2018, 2022))
    lignes = []
    for t in ans:
        tr, te = m3[m3["annee"].isin(ans) & (m3["annee"] != t)], m3[m3["annee"] == t].copy()
        kS = ajuster(tr, "ratio_totaux", "jour_nuit", "SNPP")
        kN = ajuster(tr, "ratio_totaux", "jour_nuit", "NOAA20")
        # chain: N20 -> SNPP on all overlap years except t, then SNPP -> Aqua
        trc = m3[(m3["annee"] != t)]
        rNS = {dn: g["SNPP"].sum() / g["NOAA20"].sum() for dn, g in trc.groupby("daynight")}
        te["pS"] = appliquer(kS, te, "ratio_totaux", "jour_nuit", "SNPP")
        te["pN"] = appliquer(kN, te, "ratio_totaux", "jour_nuit", "NOAA20")
        te["pC"] = te.apply(lambda r: kS[r["daynight"]]["k"] * rNS[r["daynight"]] * r["NOAA20"], axis=1)
        te["pM"] = (te["pS"] + te["pN"]) / 2
        lignes.append(te)
    t5 = pd.concat(lignes)
    R["t5"] = pd.DataFrame([{"variante": n, **metriques(t5, pred=c)} for n, c in
                            [("S-NPP seul", "pS"), ("NOAA-20 direct", "pN"), ("NOAA-20 chaine via S-NPP", "pC"), ("moyenne S-NPP + NOAA-20", "pM")]])
    R["t5"].to_csv(os.path.join(sortie, "5_noaa20.csv"), index=False)

    # ---- 6. Terra vs Aqua ratio over time (decision G9)
    cta = (obs["Aqua"] & obs["Terra"])
    mta = mensuel(agg, ["Aqua", "Terra"], cta, region_zone)
    t6 = mta.groupby(["daynight", "annee"])[["Aqua", "Terra"]].sum().reset_index()
    t6["Terra_sur_Aqua"] = t6["Terra"] / t6["Aqua"]
    t6.to_csv(os.path.join(sortie, "6_terra_aqua.csv"), index=False)
    R["t6"] = t6
    R["mk_terra"] = {dn: mann_kendall(t6[(t6["daynight"] == dn) & t6["annee"].between(2003, 2025)].sort_values("annee")["Terra_sur_Aqua"]) for dn in ["D", "N"]}

    # ---- 7. sensitivity: calibration-day filter, cleaning variants
    lignes = []
    tous = obs["Aqua"] & obs["SNPP"]
    for nom, jours, col in [("jours communs, hors discordants (protocole)", commun_sa, "n_vegetation"),
                            ("jours communs, discordants inclus", tous, "n_vegetation"),
                            ("tous les jours (aucun appariement)", set(pd.date_range("2000-01-01", fin)), "n_vegetation"),
                            ("quasi-doublons conserves", commun_sa, "n_vegetation_brut"),
                            ("sources industrielles incluses", commun_sa, "n_vegetation+ind")]:
        ag = agg.assign(n=agg["n_vegetation"] + agg["n_industriel"]) if col == "n_vegetation+ind" else agg.assign(n=agg[col])
        mm = mensuel(ag, ["Aqua", "SNPP"], jours, region_pays)
        pr = loyo(mm, "ratio_totaux", "jour_nuit", "SNPP")
        kk = mm[mm["annee"].isin(ANNEES_CALIB)].groupby("daynight")[["Aqua", "SNPP"]].sum()
        lignes.append({"variante": nom, "k_jour": kk.loc["D", "Aqua"] / kk.loc["D", "SNPP"],
                       "k_nuit": kk.loc["N", "Aqua"] / kk.loc["N", "SNPP"], **metriques(pr[pr["region"] == "Greece"])})
    R["t7"] = pd.DataFrame(lignes)
    R["t7"].to_csv(os.path.join(sortie, "7_sensibilite.csv"), index=False)

    # ---- 8. uncertainty: split-conformal interval on log scale, coverage by nested LOYO
    base = loyo(mp, "ratio_totaux", "jour_nuit", "SNPP")
    g = base.groupby(["region", "annee", "mois"])[["Aqua", "pred"]].sum().reset_index()
    g["r"] = np.log1p(g["Aqua"]) - np.log1p(g["pred"])
    lignes = []
    for niveau in [0.8, 0.9]:
        a_ = (1 - niveau) / 2
        couv = []
        for t in ANNEES_CALIB:
            res = g.loc[g["annee"] != t, "r"]
            ql, qh = np.quantile(res, a_), np.quantile(res, 1 - a_)
            te = g[g["annee"] == t]
            lo = np.maximum(np.expm1(np.log1p(te["pred"]) + ql), 0)
            hi = np.expm1(np.log1p(te["pred"]) + qh)
            couv.append(((te["Aqua"] >= lo) & (te["Aqua"] <= hi)).to_numpy())
        lignes.append({"niveau_nominal": niveau, "couverture_observee": np.concatenate(couv).mean(),
                       "q_bas_log": np.quantile(g["r"], a_), "q_haut_log": np.quantile(g["r"], 1 - a_)})
    R["t8"] = pd.DataFrame(lignes)
    R["t8"].to_csv(os.path.join(sortie, "8_incertitude.csv"), index=False)

    # ---- 9. homogeneity: yearly bias of the converted VIIRS vs observed Aqua (LOYO), Greece and 5 countries
    t9 = []
    for nom, sel in [("Grece", base["region"] == "Greece"), ("pays (5)", base["region"].notna())]:
        y = base[sel].groupby("annee")[["Aqua", "pred"]].sum()
        y["biais_pct"] = 100 * (y["pred"] - y["Aqua"]) / y["Aqua"]
        t9.append(y.assign(niveau=nom).reset_index())
    R["t9"] = pd.concat(t9)
    R["t9"].to_csv(os.path.join(sortie, "9_homogeneite_annuelle.csv"), index=False)
    R["mk_biais"] = {n: mann_kendall(g.sort_values("annee")["biais_pct"]) for n, g in R["t9"].groupby("niveau")}

    # ---- 10. change point of the daytime k (Aqua orbit drift): Pettitt test, yearly and monthly
    def pettitt(x):
        x = np.asarray(x, float)
        n = len(x)
        U = [sum(np.sign(x[j] - x[i]) for i in range(t + 1) for j in range(t + 1, n)) for t in range(n - 1)]
        t = int(np.argmax(np.abs(U)))
        K = abs(U[t])
        return {"rupture_apres_indice": t, "K": K, "p": min(1.0, 2 * np.exp(-6 * K ** 2 / (n ** 3 + n ** 2)))}
    kd = t4[(t4["daynight"] == "D") & t4["annee"].between(2012, 2025)].sort_values("annee")
    pt = pettitt(kd["k"].to_numpy())
    pt["annee_rupture"] = int(kd["annee"].iloc[pt["rupture_apres_indice"] + 1])
    km = mall[(mall["daynight"] == "D") & (mall["annee"] >= 2012) & (mall["annee"] <= 2025)].copy()
    km = km.groupby(["annee", "mois"])[["Aqua", "SNPP"]].sum()
    km = km[km["SNPP"] >= 200]
    ptm = pettitt((km["Aqua"] / km["SNPP"]).to_numpy())
    ptm["mois_rupture"] = str(km.index[ptm["rupture_apres_indice"] + 1])
    R["pettitt_annuel"], R["pettitt_mensuel"] = pt, ptm

    # ---- 11. final candidates on the stable window (LOYO), country level
    def candidats(m, annees, alpha_grid=(0, 3, 10, 30, 100, 300, 1e9)):
        res = {}
        for t in annees:
            tr = m[m["annee"].isin(annees) & (m["annee"] != t)]
            te = m[m["annee"] == t].copy()
            pool_dm = tr.groupby(["daynight", "mois"])[["Aqua", "SNPP"]].sum()
            kdm = pool_dm["Aqua"] / pool_dm["SNPP"]
            pool_d = tr.groupby("daynight")[["Aqua", "SNPP"]].sum()
            kd_ = pool_d["Aqua"] / pool_d["SNPP"]
            cd = tr.groupby(["region", "daynight"])[["Aqua", "SNPP"]].sum()
            kcd = cd["Aqua"] / cd["SNPP"]
            cdm = tr.groupby(["region", "daynight", "mois"])[["Aqua", "SNPP"]].sum()
            idx = list(zip(te["region"], te["daynight"], te["mois"]))
            kA = np.array([kdm[(d, mo)] for _, d, mo in idx])
            kB = np.array([kcd[(r, d)] * kdm[(d, mo)] / kd_[d] for r, d, mo in idx])
            res.setdefault("A: k(jour/nuit x mois) commun", []).append(te.assign(pred=kA * te["SNPP"]))
            res.setdefault("B: k(pays x jour/nuit) x saisonnalite commune", []).append(te.assign(pred=kB * te["SNPP"]))
            for al in alpha_grid:
                kC = []
                for (r, d, mo), prior in zip(idx, kB):
                    A_, V_ = cdm.loc[(r, d, mo)] if (r, d, mo) in cdm.index else (0.0, 0.0)
                    kC.append((A_ + al) / (V_ + al / prior) if (V_ + al / prior) > 0 else prior)
                res.setdefault(f"C: bayes vers B, alpha={al:g}", []).append(te.assign(pred=np.array(kC) * te["SNPP"]))
        return {k: pd.concat(v) for k, v in res.items()}

    lignes = []
    for fen_nom, fen in [("2012-2020", list(range(2012, 2021))), ("2012-2021", ANNEES_CALIB)]:
        for nom, pr in candidats(mp, fen).items():
            for niv, sel in [("pays (5)", pr["region"].notna()), ("Grece", pr["region"] == "Greece")]:
                lignes.append({"fenetre": fen_nom, "candidat": nom, "niveau": niv, **metriques(pr[sel])})
    t11 = pd.DataFrame(lignes)
    t11.to_csv(os.path.join(sortie, "11_candidats_finaux.csv"), index=False)
    R["t11"] = t11

    # ---- 12. conformal intervals: global vs by magnitude (Mondrian), final candidate B, window 2012-2020
    pr = candidats(mp, list(range(2012, 2021)), alpha_grid=())["B: k(pays x jour/nuit) x saisonnalite commune"]
    g = pr.groupby(["region", "annee", "mois"])[["Aqua", "pred"]].sum().reset_index()
    g["r"] = np.log1p(g["Aqua"]) - np.log1p(g["pred"])
    g["classe"] = pd.cut(g["pred"], [-1, 5, 30, 150, np.inf], labels=["<5", "5-30", "30-150", ">150"])
    lignes = []
    for mode in ["global", "par_classe"]:
        for t in sorted(g["annee"].unique()):
            cal, te = g[g["annee"] != t], g[g["annee"] == t]
            for cl, tc in te.groupby("classe", observed=True):
                ref = cal["r"] if mode == "global" else cal.loc[cal["classe"] == cl, "r"]
                ql, qh = np.quantile(ref, 0.1), np.quantile(ref, 0.9)
                lo = np.maximum(np.expm1(np.log1p(tc["pred"]) + ql), 0)
                hi = np.expm1(np.log1p(tc["pred"]) + qh)
                lignes += [{"mode": mode, "classe": cl, "couvert": c} for c in ((tc["Aqua"] >= lo) & (tc["Aqua"] <= hi))]
    t12 = pd.DataFrame(lignes).groupby(["mode", "classe"], observed=True)["couvert"].agg(["mean", "size"]).reset_index()
    t12.to_csv(os.path.join(sortie, "12_couverture_par_classe.csv"), index=False)
    R["t12"] = t12

    pd.set_option("display.width", 220)
    t1 = R.pop("t1")
    for niv in ["Grece", "pays (5)", "zone"]:
        print(f"\n######## t1 - niveau {niv} (tri par RMSE_log)")
        print(t1[t1["niveau"] == niv].sort_values("RMSE_log").drop(columns="niveau").round(4).to_string(index=False))
    for k_, v_ in R.items():
        print(f"\n######## {k_}")
        print(v_.round(4).to_string() if isinstance(v_, pd.DataFrame) else v_)


if __name__ == "__main__":
    main()
