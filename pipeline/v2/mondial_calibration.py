"""VIGIL-K1 global calibration (works on the small tables written by `mondial agreger`).

Hierarchy (gamma-Poisson empirical Bayes, never mixing hemispheres):
    k_s[d,m], k_s[d]   pooled totals of the UN sub-region s (Natural Earth SUBREGION)
    k_c[d]   = (A_cd + ALPHA) / (V_cd + ALPHA / k_s[d])                 country level, shrunk to its sub-region
    k0[c,d,m]= k_c[d] * k_s[d,m] / k_s[d]                               country level x sub-regional seasonality
    k[c,d,m] = (A_cdm + ALPHA) / (V_cdm + ALPHA / k0[c,d,m])            final factor
Credible interval of k (95 %), corrected for over-dispersion phi (clustered detections):
    k_true / k ~ Gamma(shape = A_cdm / phi + ALPHA, rate = shape)  ->  k * [q05, q95]
    gamma quantiles by the Wilson-Hilferty (1931) approximation (shape >= ALPHA = 10: error < 0.1 %).
Prediction interval of a monthly total: split-conformal, per magnitude class (Mondrian), as for Greece.
"""
import glob
import json
import os
from datetime import datetime

import numpy as np
import pandas as pd
import shapely
from shapely.geometry import shape

from . import parametres as P
from .harmonisation import ALPHA, BASCULE, CLASSES, DEBUT_CALIB, FIN_CALIB, NOMS_CLASSES

NIVEAUX = [0.80, 0.95]

Z95 = 1.959963984540054   # two-sided 95 %
ALPHAS_TESTES = [3, 10, 30, 100]


def gamma_relatif(forme, z):
    """Quantile of Gamma(forme, rate=forme) (mean 1), Wilson-Hilferty approximation."""
    forme = np.asarray(forme, float)
    return np.maximum(1 - 1 / (9 * forme) + z * np.sqrt(1 / (9 * forme)), 0) ** 3


# ------------------------------------------------------------------ inputs
def charger(dossier):
    J = pd.concat([pd.read_parquet(p) for p in glob.glob(os.path.join(dossier, "jour", "*.parquet"))], ignore_index=True)
    C = pd.concat([pd.read_parquet(p) for p in glob.glob(os.path.join(dossier, "cellule", "*.parquet"))], ignore_index=True)
    J["acq_date"] = pd.to_datetime(J["acq_date"])
    J = J[J["satellite"].notna() & J["acq_date"].notna()]
    return J, C


def jours_observes(sat, jsd, fin):
    jours = pd.date_range(P.DEBUT_DONNEES_FIRMS[sat], fin, freq="D")
    f = P.VIE_SATELLITES[sat][1]
    if f is not None:
        jours = jours[jours <= pd.Timestamp(f)]
    return jours[~jours.isin(pd.to_datetime(jsd.loc[jsd["satellite"] == sat, "date"]))]


def sous_regions(C, frontieres):
    """Country -> Natural Earth sub-region, from the detection-weighted centroid of each FIRMS country."""
    with open(frontieres, encoding="utf-8") as f:
        gj = json.load(f)
    geoms = [shape(ft["geometry"]) for ft in gj["features"]]
    sub = [ft["properties"]["SUBREGION"] for ft in gj["features"]]
    arbre = shapely.STRtree(geoms)
    w = C.assign(w=C["n_vegetation"] + C["n_industriel"] + 1)
    cent = w.groupby("pays").apply(lambda g: pd.Series({"lat": np.average(g["lat_c"], weights=g["w"]),
                                                       "lon": np.average(g["lon_c"], weights=g["w"])}), include_groups=False)
    pts = shapely.points(cent["lon"].to_numpy(), cent["lat"].to_numpy())
    idx = arbre.nearest(pts)
    cent["sous_region"] = [sub[i] for i in idx]
    # a centroid can fall at sea or in a neighbour: keep the most frequent sub-region of the cells instead
    cel = w[["pays", "lat_c", "lon_c", "w"]].drop_duplicates(["pays", "lat_c", "lon_c"])
    ic = arbre.nearest(shapely.points(cel["lon_c"].to_numpy(), cel["lat_c"].to_numpy()))
    cel["sr"] = [sub[i] for i in ic]
    maj = cel.groupby(["pays", "sr"])["w"].sum().reset_index().sort_values("w").drop_duplicates("pays", keep="last")
    cent["sous_region"] = pd.Series(cent.index.map(maj.set_index("pays")["sr"]), index=cent.index).fillna(cent["sous_region"])
    return cent


def discordants(J, obs, seuil_z=3.5, min_total=20, min_jours=30, debut=DEBUT_CALIB, fin=FIN_CALIB):
    """Per country, daytime days where log((SNPP+1)/(Aqua+1)) is a robust outlier (|z| > 3.5).
    Median and MAD are computed on the calibration window only: the reference distribution is the regime being
    calibrated (Aqua drifts after 2020-11), and k never changes when data outside the window change (audit 15/11)."""
    d = (J[J["daynight"] == "D"].pivot_table(index=["pays", "acq_date"], columns="satellite",
                                               values="n_vegetation", aggfunc="sum", fill_value=0))
    d = d.reset_index()
    d = d[d["acq_date"].isin(obs["Aqua"]) & d["acq_date"].isin(obs["SNPP"])
          & (d["acq_date"] >= pd.Timestamp(debut)) & (d["acq_date"] <= pd.Timestamp(fin))]
    d = d[(d.get("Aqua", 0) + d.get("SNPP", 0)) >= min_total].copy()
    d["lr"] = np.log((d["SNPP"] + 1) / (d["Aqua"] + 1))
    st = d.groupby("pays")["lr"].agg(med="median", n="size")
    d = d.join(st, on="pays")
    d["mad"] = d.groupby("pays")["lr"].transform(lambda s: 1.4826 * (s - s.median()).abs().median())
    d["z"] = (d["lr"] - d["med"]) / d["mad"].replace(0, np.nan)
    return d.loc[(d["n"] >= min_jours) & (d["z"].abs() > seuil_z), ["pays", "acq_date"]]


# ------------------------------------------------------------------ model
def estimer(T, sr, alpha=ALPHA):
    """T: totals per (pays, daynight, mois) with Aqua (A) and SNPP (V). Returns k table."""
    if "pays" not in T.columns:
        T = T.reset_index()
    T = T.join(sr["sous_region"], on="pays")
    T = T[T["sous_region"].notna()]   # countries without any vegetation detection: no information on k
    g = T.groupby(["daynight"])[["Aqua", "SNPP"]].sum()
    k_g = g["Aqua"] / g["SNPP"]
    gm = T.groupby(["daynight", "mois"])[["Aqua", "SNPP"]].sum()
    k_gm = gm["Aqua"] / gm["SNPP"]
    s = T.groupby(["sous_region", "daynight"])[["Aqua", "SNPP"]].sum()
    sm = T.groupby(["sous_region", "daynight", "mois"])[["Aqua", "SNPP"]].sum()
    c = T.groupby(["pays", "daynight"])[["Aqua", "SNPP"]].sum()
    out = T.copy()
    # sub-region factors shrunk to the global ones (a sub-region can be data-poor too)
    key_s = list(zip(out["sous_region"], out["daynight"]))
    key_sm = list(zip(out["sous_region"], out["daynight"], out["mois"]))
    key_gm = list(zip(out["daynight"], out["mois"]))
    ks = np.array([(s.loc[k, "Aqua"] + alpha) / (s.loc[k, "SNPP"] + alpha / k_g[k[1]]) for k in key_s])
    ksm = np.array([(sm.loc[k, "Aqua"] + alpha) / (sm.loc[k, "SNPP"] + alpha / k_gm[(k[1], k[2])]) for k in key_sm])
    kc = np.array([(c.loc[(p, d), "Aqua"] + alpha) / (c.loc[(p, d), "SNPP"] + alpha / k_)
                   for p, d, k_ in zip(out["pays"], out["daynight"], ks)])
    out["k_sous_region"] = ksm
    out["k0"] = kc * ksm / ks
    out["k"] = (out["Aqua"] + alpha) / (out["SNPP"] + alpha / out["k0"])
    return out


def surdispersion(U):
    """Pearson over-dispersion of monthly country units under the fitted model."""
    m = U[U["pred"] > 0]
    return float(np.sum((m["Aqua"] - m["pred"]) ** 2 / m["pred"]) / max(len(m) - 1, 1))


def table_calibration(J, jours, disc):
    j = J[J["acq_date"].isin(jours) & J["satellite"].isin(["Aqua", "SNPP"])].copy()
    if len(disc):
        cle = pd.MultiIndex.from_frame(disc)
        j = j[~pd.MultiIndex.from_frame(j[["pays", "acq_date"]]).isin(cle)]
    j["annee"], j["mois"] = j["acq_date"].dt.year, j["acq_date"].dt.month
    t = j.groupby(["pays", "annee", "daynight", "mois", "satellite"])["n_vegetation"].sum().unstack("satellite", fill_value=0)
    for s in ["Aqua", "SNPP"]:
        if s not in t.columns:
            t[s] = 0
    return t.reset_index()


def loyo(U, sr, annees, alpha):
    """Leave-one-year-out predictions of monthly Aqua per country (day + night summed)."""
    res = []
    for t in annees:
        tr = U[U["annee"] != t].groupby(["pays", "daynight", "mois"])[["Aqua", "SNPP"]].sum()
        e = estimer(tr, sr, alpha)
        k = e.set_index(["pays", "daynight", "mois"])["k"]
        ksr = e.groupby(["sous_region", "daynight", "mois"])["k_sous_region"].first()
        te = U[U["annee"] == t].join(sr["sous_region"], on="pays")
        kv = te.set_index(["pays", "daynight", "mois"]).index.map(k).to_numpy(float)
        kr = te.set_index(["sous_region", "daynight", "mois"]).index.map(ksr).to_numpy(float)
        te["pred"] = np.where(np.isnan(kv), np.nan_to_num(kr), kv) * te["SNPP"]   # unseen country -> sub-region
        res.append(te)
    return pd.concat(res)


def metriques(o, p):
    o, p = np.asarray(o, float), np.asarray(p, float)
    dev = 2 * np.sum(np.where(o > 0, o * np.log(np.where(o > 0, o, 1) / np.maximum(p, 1e-9)), 0) - (o - p)) / max(len(o), 1)
    return {"n_mois": len(o), "aqua_total": float(o.sum()), "r2": float(1 - np.mean((p - o) ** 2) / o.var()) if o.var() > 0 else np.nan,
            "biais_pct": float(100 * (p.sum() - o.sum()) / o.sum()) if o.sum() > 0 else np.nan, "deviance_poisson": float(dev)}


def pettitt(x):
    x = np.asarray(x, float)
    n = len(x)
    r = np.argsort(np.argsort(x)) + 1
    U = np.array([2 * r[:t + 1].sum() - (t + 1) * (n + 1) for t in range(n - 1)])
    t = int(np.argmax(np.abs(U)))
    K = abs(U[t])
    return t, float(K), float(min(1.0, 2 * np.exp(-6 * K ** 2 / (n ** 3 + n ** 2))))


# ------------------------------------------------------------------ main
def calibrer(a):
    dossier = os.path.join(a.sortie, "monde")
    J, C = charger(dossier)
    jsd = pd.read_csv(os.path.join(os.path.dirname(__file__), P.FICHIER_JOURS_SANS_DONNEES))
    fin = J["acq_date"].max()
    obs = {s: jours_observes(s, jsd, fin) for s in ["Aqua", "SNPP", "NOAA20"]}
    sr = sous_regions(C, a.frontieres)
    disc = discordants(J, obs)
    jc = obs["Aqua"].intersection(obs["SNPP"])
    jc = jc[(jc >= DEBUT_CALIB) & (jc <= FIN_CALIB)]
    U = table_calibration(J, jc, disc)
    U = U[U["pays"] != "inconnu"]
    annees = sorted(U["annee"].unique())
    rapport = {"methode": "VIGIL-K1 mondial", "genere_le": datetime.now().isoformat(timespec="seconds"),
               "jours_calibration": int(len(jc)), "jours_discordants_exclus": int(len(disc)), "pays": int(U["pays"].nunique())}

    # 1. Aqua orbit-drift change point, global daytime ratio (monthly)
    g = J[(J["daynight"] == "D") & J["acq_date"].isin(obs["Aqua"].intersection(obs["SNPP"]))]
    g = g[g["acq_date"] >= "2012-02-01"].assign(m=lambda x: x["acq_date"].dt.to_period("M"))
    r = g.pivot_table(index="m", columns="satellite", values="n_vegetation", aggfunc="sum")
    r = (r["Aqua"] / r["SNPP"]).dropna()
    t, K, p = pettitt(r.to_numpy())
    rapport["rupture_pettitt_mondiale"] = {"premier_mois_nouveau_regime": str(r.index[t + 1]), "K": K, "p": p}

    # 2. alpha by leave-one-year-out (all countries), one-standard-error-like rule (<= 0.5 % from best)
    dev = {}
    for al in ALPHAS_TESTES:
        pr = loyo(U, sr, annees, al).groupby(["pays", "annee", "mois"])[["Aqua", "pred"]].sum()
        dev[al] = metriques(pr["Aqua"], pr["pred"])["deviance_poisson"]
    best = min(dev.values())
    alpha = max(al for al, v in dev.items() if v <= 1.005 * best)
    rapport["alpha"] = {"teste": dev, "retenu": alpha}

    # 3. final LOYO with chosen alpha: per-country quality, over-dispersion, conformal quantiles
    pr = loyo(U, sr, annees, alpha)
    phi = surdispersion(pr.assign(pred=pr["pred"]))
    m = pr.groupby(["pays", "annee", "mois"])[["Aqua", "pred"]].sum().reset_index()
    m["resid"] = np.log1p(m["Aqua"]) - np.log1p(m["pred"])
    m["classe"] = pd.cut(m["pred"], CLASSES, labels=NOMS_CLASSES)
    q = {niv: {cl: {"q_bas": float(np.quantile(x["resid"], (1 - niv) / 2)), "q_haut": float(np.quantile(x["resid"], 1 - (1 - niv) / 2)), "n": int(len(x))}
               for cl, x in m.groupby("classe", observed=True)} for niv in NIVEAUX}
    # empirical coverage of each level (nested: quantiles learnt without the tested year)
    couv = {}
    for niv in NIVEAUX:
        ok = []
        for t in annees:
            cal, te = m[m["annee"] != t], m[m["annee"] == t]
            for cl, x in te.groupby("classe", observed=True):
                ref = cal.loc[cal["classe"] == cl, "resid"]
                ok.append(((x["resid"] >= np.quantile(ref, (1 - niv) / 2)) & (x["resid"] <= np.quantile(ref, 1 - (1 - niv) / 2))).to_numpy())
        couv[str(niv)] = float(np.concatenate(ok).mean())
    val = pd.DataFrame([{"pays": c, **metriques(x["Aqua"], x["pred"])} for c, x in m.groupby("pays")])
    val = val.join(sr["sous_region"], on="pays")
    val["fiabilite"] = np.select([(val["aqua_total"] >= 500) & (val["r2"] >= 0.8) & (val["biais_pct"].abs() <= 10),
                                  (val["aqua_total"] >= 100) & (val["r2"] >= 0.5)],
                                 ["elevee", "moyenne"], default="faible")
    val.to_csv(os.path.join(dossier, "validation_pays.csv"), index=False)
    rapport["validation_mondiale"] = metriques(m["Aqua"], m["pred"])
    rapport["surdispersion_phi"] = phi
    rapport["fiabilite_pays"] = val["fiabilite"].value_counts().to_dict()
    rapport["incertitude"] = {"methode": "split-conformal Mondrian, log(1+x)", "quantiles": q, "couverture_observee": couv}

    # 4. final k on all calibration years + 90 % credible interval (over-dispersion corrected)
    K_ = estimer(U.groupby(["pays", "daynight", "mois"])[["Aqua", "SNPP"]].sum(), sr, alpha).reset_index(drop=True)
    forme = K_["Aqua"] / phi + alpha
    K_["k_bas_95"] = K_["k"] * gamma_relatif(forme, -Z95)
    K_["k_haut_95"] = K_["k"] * gamma_relatif(forme, Z95)
    K_.to_csv(os.path.join(dossier, "k_pays.csv"), index=False)

    # 5. NOAA-20 chained to S-NPP (global day/night x month)
    jn = obs["SNPP"].intersection(obs["NOAA20"])
    n = J[J["acq_date"].isin(jn) & J["satellite"].isin(["SNPP", "NOAA20"])]
    n = n.assign(mois=n["acq_date"].dt.month).groupby(["daynight", "mois", "satellite"])["n_vegetation"].sum().unstack()
    rho = (n["SNPP"] / n["NOAA20"]).rename("rho").reset_index()
    rho.to_csv(os.path.join(dossier, "rho_noaa20.csv"), index=False)

    # 6. country monthly series (daily switch rule) and global cell map (monthly)
    kk = K_.set_index(["pays", "daynight", "mois"])["k"]
    ks_pool = K_.groupby(["sous_region", "daynight", "mois"])["k_sous_region"].first()
    w = J[J["satellite"].isin(["Aqua", "SNPP", "NOAA20"])].copy()
    w["mois"], w["annee"] = w["acq_date"].dt.month, w["acq_date"].dt.year
    w = w.join(sr["sous_region"], on="pays")
    kv = w.set_index(["pays", "daynight", "mois"]).index.map(kk).to_numpy(float)
    kp = w.set_index(["sous_region", "daynight", "mois"]).index.map(ks_pool).to_numpy(float)
    w["k"] = np.where(np.isnan(kv), kp, kv)
    w = w.merge(rho, on=["daynight", "mois"], how="left")
    av = w["acq_date"] < BASCULE
    o = {s: w["acq_date"].isin(obs[s]).to_numpy() for s in obs}
    sat = w["satellite"].to_numpy()
    # before the switch: Aqua as observed; on Aqua outage days, converted S-NPP when it observes (never a hole when a sensor saw the fire)
    use = np.select([av & (sat == "Aqua") & o["Aqua"], av & (sat == "SNPP") & o["SNPP"] & ~o["Aqua"], ~av & (sat == "SNPP") & o["SNPP"],
                     ~av & (sat == "NOAA20") & o["NOAA20"] & ~o["SNPP"]], [1.0, 1.0, 1.0, 1.0], 0.0)
    fac = np.select([sat == "Aqua", sat == "SNPP", sat == "NOAA20"], [1.0, w["k"], w["k"] * w["rho"]], 0.0)
    w["valeur"] = use * fac * w["n_vegetation"]
    serie = w[w["annee"] >= 2002].groupby(["pays", "annee", "mois"])["valeur"].sum()
    mois_tous = pd.period_range(P.DEBUT_DONNEES_FIRMS["Aqua"], fin, freq="M")
    grille = pd.MultiIndex.from_tuples([(c, p.year, p.month) for c in sorted(set(serie.index.get_level_values(0)) - {"inconnu"})
                                        for p in mois_tous], names=["pays", "annee", "mois"])
    serie = serie.reindex(grille, fill_value=0.0).reset_index()          # no detection = observed 0
    # share of the days of each month with data; the last month runs to its last calendar day (a partial month is < 1)
    jours = pd.date_range(P.DEBUT_DONNEES_FIRMS["Aqua"], pd.Timestamp(fin) + pd.offsets.MonthEnd(0), freq="D")
    ok = np.where(jours < BASCULE, jours.isin(obs["Aqua"]) | jours.isin(obs["SNPP"]), jours.isin(obs["SNPP"]) | jours.isin(obs["NOAA20"])) & (jours <= fin)
    cov = pd.Series(ok, index=jours).groupby([jours.year, jours.month]).mean().rename("couverture_jours")
    cov.index.names = ["annee", "mois"]
    serie = serie.join(cov, on=["annee", "mois"])
    conv = pd.to_datetime(dict(year=serie["annee"], month=serie["mois"], day=1)) >= BASCULE
    cl = pd.cut(serie["valeur"], CLASSES, labels=NOMS_CLASSES)
    for niv in NIVEAUX:
        qb = cl.map(lambda c: q[niv][c]["q_bas"]).astype(float)
        qh = cl.map(lambda c: q[niv][c]["q_haut"]).astype(float)
        tag = int(round(niv * 100))
        serie[f"bas_{tag}"] = np.where(conv, np.maximum(np.expm1(np.log1p(serie["valeur"]) + qb), 0), serie["valeur"])
        serie[f"haut_{tag}"] = np.where(conv, np.expm1(np.log1p(serie["valeur"]) + qh), serie["valeur"])
    serie["source"] = np.where(conv, "viirs_converted", "modis_observed")
    serie = serie.join(sr["sous_region"], on="pays").join(val.set_index("pays")["fiabilite"], on="pays")
    serie.to_csv(os.path.join(dossier, "serie_mensuelle_pays.csv"), index=False)

    Cc = C[C["satellite"].isin(["Aqua", "SNPP", "NOAA20"]) & (C["annee"] >= 2002)].join(sr["sous_region"], on="pays")
    kv = Cc.set_index(["pays", "daynight", "mois"]).index.map(kk).to_numpy(float)
    kp = Cc.set_index(["sous_region", "daynight", "mois"]).index.map(ks_pool).to_numpy(float)
    Cc["k"] = np.where(np.isnan(kv), kp, kv)
    Cc = Cc.merge(rho, on=["daynight", "mois"], how="left")
    avc = pd.to_datetime(dict(year=Cc["annee"], month=Cc["mois"], day=1)) < BASCULE
    s = Cc["satellite"]
    sans_aqua = (Cc["jour_sans_aqua"].fillna(False).astype(bool) if "jour_sans_aqua" in Cc else pd.Series(False, index=Cc.index)).to_numpy()
    use = np.select([avc & (s == "Aqua") & ~sans_aqua, avc & (s == "SNPP") & sans_aqua, ~avc & (s == "SNPP") & ~Cc["jour_sans_snpp"],
                     ~avc & (s == "NOAA20") & Cc["jour_sans_snpp"]], [1.0, 1.0, 1.0, 1.0], 0.0)
    fac = np.select([s == "Aqua", s == "SNPP", s == "NOAA20"], [1.0, Cc["k"], Cc["k"] * Cc["rho"]], 0.0)
    Cc["valeur"] = use * fac * Cc["n_vegetation"]
    carte = Cc.groupby(["lat_c", "lon_c", "pays", "annee", "mois"])["valeur"].sum().reset_index()
    carte = carte[carte["valeur"] > 0]
    carte.to_parquet(os.path.join(dossier, "carte_cellules_mois.parquet"), index=False)

    rapport["fichiers"] = ["k_pays.csv", "validation_pays.csv", "rho_noaa20.csv", "serie_mensuelle_pays.csv", "carte_cellules_mois.parquet"]
    with open(os.path.join(dossier, "rapport_mondial.json"), "w", encoding="utf-8") as f:
        json.dump(rapport, f, ensure_ascii=False, indent=2, default=str)
    print(json.dumps({k: v for k, v in rapport.items() if k != "incertitude"}, ensure_ascii=False, indent=2, default=str))
    print(f"Fichiers ecrits dans {dossier}")
