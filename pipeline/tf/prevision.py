"""Forecasting models of Trends & Forecasts (docs/methode_tf.md §5-7). One model per horizon h = 1..5 years.

Protocol, fixed before looking at the test years:
  split by TARGET year, never shuffled   train <= 2017 | validation 2018-2020 | test 2021-2025
  regression target   annual harmonized hotspots of the cell (counts), two complementary models:
                      - "expected count" (Poisson loss): unbiased totals, criterion = mean Poisson deviance (as VIGIL-K1);
                      - "log" (squared error on log(1 + y)): typical value of a skewed variable, criterion = RMSE and R2
                        on log(1 + y), R2 of anomalies (departure from the long-run mean of the cell)
  classification      "high-activity year" (density >= 1 detection / 1,000 km2 / month). Main criterion: Brier score;
                      also ROC-AUC, PR-AUC, log-loss, confusion matrix at p >= 0.5 (sensitivity, specificity, ...)
  references to beat  climatology (mean of the past years), persistence (last year), mean of the last 3 years
  candidates          linear regression (ridge) on log(1 + y), Poisson regression, logistic regression, k-nearest
                      neighbours, gradient-boosted trees (HistGradientBoosting); hyper-parameters chosen on validation
  intervals           split-conformal on log(1 + y), by class of predicted magnitude (Mondrian), learnt on validation
                      years, coverage checked on the test years
  production          the retained specification refitted on every available year, origin 2025 -> 2026..2030
"""
import time

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
from sklearn.impute import SimpleImputer
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression, PoissonRegressor, Ridge
from sklearn.metrics import average_precision_score, brier_score_loss, log_loss, roc_auc_score
from sklearn.neighbors import KNeighborsClassifier, KNeighborsRegressor
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from . import parametres as P
from .vecteurs import FAMILLES, TOUTES

O_MIN = 2007                 # first origin: at least 5 years of fire memory (2003-2007)
CLASSES_PRED = [-np.inf, 1.0, 10.0, 100.0, np.inf]       # classes of predicted annual hotspots (Mondrian conformal)
NOMS_CLASSES = ["<1", "1-10", "10-100", ">100"]
NIVEAUX = [0.80, 0.95]
N_COMPARAISON = 120_000      # rows of the common validation sample on which every candidate is compared
N_KNN = 100_000              # training rows of the nearest-neighbour models (cost grows with rows x rows)
HGB = dict(learning_rate=0.08, max_iter=600, max_leaf_nodes=63, min_samples_leaf=40, l2_regularization=1.0,
           early_stopping=True, n_iter_no_change=20, random_state=0)


# ------------------------------------------------------------------ metrics
def deviance_poisson(y, mu):
    y, mu = np.asarray(y, "f8"), np.maximum(np.asarray(mu, "f8"), 1e-9)
    return float(2 * np.mean(np.where(y > 0, y * np.log(np.where(y > 0, y, 1) / mu), 0) - (y - mu)))


def metriques_reg(y, mu, clim=None):
    """y, mu: observed and predicted annual counts. clim: climatology of the cell (to score anomalies)."""
    y, mu = np.asarray(y, "f8"), np.maximum(np.asarray(mu, "f8"), 0)
    ly, lm = np.log1p(y), np.log1p(mu)
    out = {"n": int(len(y)), "deviance_poisson": deviance_poisson(y, mu),
           "rmse_log": float(np.sqrt(np.mean((ly - lm) ** 2))), "mae_log": float(np.mean(np.abs(ly - lm))),
           "r2_log": float(1 - np.mean((ly - lm) ** 2) / ly.var()), "rmse_sur_ecart_type_log": float(np.sqrt(np.mean((ly - lm) ** 2)) / ly.std()),
           "rmse": float(np.sqrt(np.mean((y - mu) ** 2))), "mae": float(np.mean(np.abs(y - mu))), "r2": float(1 - np.mean((y - mu) ** 2) / y.var()),
           "biais_total_pct": float(100 * (mu.sum() - y.sum()) / y.sum())}
    if clim is not None:
        a, b = ly - np.log1p(clim), lm - np.log1p(clim)
        out["r2_anomalies_log"] = float(1 - np.mean((a - b) ** 2) / np.mean((a - a.mean()) ** 2))
    return out


def metriques_clf(z, p, seuil=0.5):
    z, p = np.asarray(z, int), np.clip(np.asarray(p, "f8"), 1e-6, 1 - 1e-6)
    pred = p >= seuil
    vp, fp = int((pred & (z == 1)).sum()), int((pred & (z == 0)).sum())
    fn, vn = int((~pred & (z == 1)).sum()), int((~pred & (z == 0)).sum())
    base = z.mean()
    div = lambda a, b: float(a / b) if b else float("nan")
    sens, spec, prec = div(vp, vp + fn), div(vn, vn + fp), div(vp, vp + fp)
    return {"n": int(len(z)), "prevalence": float(base), "brier": float(brier_score_loss(z, p)),
            "brier_reference_prevalence": float(base * (1 - base)), "log_loss": float(log_loss(z, p, labels=[0, 1])),
            "roc_auc": float(roc_auc_score(z, p)) if 0 < base < 1 else float("nan"),
            "pr_auc": float(average_precision_score(z, p)) if base > 0 else float("nan"),
            "seuil": seuil, "vp": vp, "fp": fp, "fn": fn, "vn": vn, "exactitude": div(vp + vn, len(z)),
            "exactitude_classe_majoritaire": float(max(base, 1 - base)), "sensibilite": sens, "specificite": spec, "precision": prec,
            "f1": div(2 * vp, 2 * vp + fp + fn), "exactitude_equilibree": float(np.nanmean([sens, spec]))}


def fiabilite(z, p, n=10):
    """Reliability table: mean predicted probability vs observed frequency in n equal-width bins."""
    z, p = np.asarray(z, int), np.asarray(p, "f8")
    b = np.minimum((p * n).astype(int), n - 1)
    return [{"de": i / n, "a": (i + 1) / n, "n": int((b == i).sum()), "p_moyenne": float(p[b == i].mean()), "frequence": float(z[b == i].mean())}
            for i in range(n) if (b == i).any()]


# ------------------------------------------------------------------ models
def _lin(modele):
    return make_pipeline(SimpleImputer(strategy="median"), StandardScaler(), modele)


def references(X):
    """Naive forecasts of the annual count, all computed from the feature vector (years <= origin)."""
    return {"climatologie": np.expm1(X["f_mall"].to_numpy("f8")), "persistance": np.expm1(X["f_l0"].to_numpy("f8")),
            "moyenne_3_ans": np.expm1(X["f_m3"].to_numpy("f8"))}


def ajuster_hgb_reg(Xa, ya, Xv=None, yv=None, colonnes=TOUTES, n_iter=None):
    par = dict(HGB)
    if n_iter:
        par.update(max_iter=int(n_iter), early_stopping=False)
    m = HistGradientBoostingRegressor(loss="poisson", **par)
    if n_iter or Xv is None:
        return m.fit(Xa[colonnes], ya)
    return m.fit(Xa[colonnes], ya, X_val=Xv[colonnes], y_val=yv)


def ajuster_hgb_log(Xa, ya, Xv=None, yv=None, colonnes=TOUTES, n_iter=None):
    """Boosted trees minimizing the squared error on log(1 + y)."""
    par = dict(HGB)
    if n_iter:
        par.update(max_iter=int(n_iter), early_stopping=False)
    m = HistGradientBoostingRegressor(loss="squared_error", **par)
    if n_iter or Xv is None:
        return m.fit(Xa[colonnes], np.log1p(ya))
    return m.fit(Xa[colonnes], np.log1p(ya), X_val=Xv[colonnes], y_val=np.log1p(yv))


def ajuster_hgb_clf(Xa, za, Xv=None, zv=None, colonnes=TOUTES, n_iter=None):
    par = dict(HGB)
    if n_iter:
        par.update(max_iter=int(n_iter), early_stopping=False)
    m = HistGradientBoostingClassifier(**par)
    if n_iter or Xv is None:
        return m.fit(Xa[colonnes], za)
    return m.fit(Xa[colonnes], za, X_val=Xv[colonnes], y_val=zv)


def quantiles_conformes(y, mu):
    """Mondrian split-conformal quantiles of r = log(1+y) - log(1+mu), per class of predicted magnitude."""
    r = np.log1p(y) - np.log1p(mu)
    cl = pd.cut(mu, CLASSES_PRED, labels=NOMS_CLASSES)
    return {str(niv): {c: {"q_bas": float(np.quantile(r[cl == c], (1 - niv) / 2)), "q_haut": float(np.quantile(r[cl == c], 1 - (1 - niv) / 2)), "n": int((cl == c).sum())}
                       for c in NOMS_CLASSES if (cl == c).sum() >= 30} for niv in NIVEAUX}


def bornes(mu, q, niveau):
    """Interval [low, high] of annual counts around mu from the conformal table q (floored at 0)."""
    mu = np.asarray(mu, "f8")
    cl = np.asarray(pd.cut(mu, CLASSES_PRED, labels=NOMS_CLASSES).astype(object))
    t = q[str(niveau)]
    dispo = [c for c in NOMS_CLASSES if c in t]
    cl = np.where(np.isin(cl, dispo), cl, dispo[-1])
    qb = np.array([t[c]["q_bas"] for c in cl]); qh = np.array([t[c]["q_haut"] for c in cl])
    return np.maximum(np.expm1(np.log1p(mu) + qb), 0), np.maximum(np.expm1(np.log1p(mu) + qh), 0)


def couverture(y, mu, q):
    out = {}
    cl = np.asarray(pd.cut(mu, CLASSES_PRED, labels=NOMS_CLASSES).astype(object))
    for niv in NIVEAUX:
        lo, hi = bornes(mu, q, niv)
        ok = (y >= lo - 1e-9) & (y <= hi + 1e-9)
        out[str(niv)] = {"globale": float(ok.mean()), "par_classe": {c: float(ok[cl == c].mean()) for c in NOMS_CLASSES if (cl == c).any()},
                         "largeur_relative_mediane": float(np.median((hi - lo) / np.maximum(mu, 1)))}
    return out


# ------------------------------------------------------------------ one horizon
def evaluer_horizon(H, h, journal=print, complet=True):
    """Train, select, test and refit for one horizon. Returns (report dict, production objects)."""
    t0 = time.time()
    o_train = list(range(O_MIN, P.AN_TRAIN_MAX - h + 1))
    o_valid = [y - h for y in range(P.AN_VALID[0], P.AN_VALID[1] + 1)]
    o_test = [y - h for y in range(P.AN_TEST[0], P.AN_TEST[1] + 1)]
    Xa, ya, za, _ = H.jeu(h, o_train)
    Xv, yv, zv, kv = H.jeu(h, o_valid)
    Xt, yt, zt, kt = H.jeu(h, o_test)
    rng = np.random.default_rng(100 + h)
    iv = rng.choice(len(Xv), min(N_COMPARAISON, len(Xv)), replace=False)
    Xc, yc, zc = Xv.iloc[iv], yv[iv], zv[iv]
    rapport = {"horizon": h, "origines": {"apprentissage": [o_train[0], o_train[-1]], "validation": [o_valid[0], o_valid[-1]], "test": [o_test[0], o_test[-1]]},
               "lignes": {"apprentissage": int(len(Xa)), "validation": int(len(Xv)), "test": int(len(Xt)), "echantillon_comparaison": int(len(Xc))}}
    journal(f"h={h}: {len(Xa):,} lignes d'apprentissage, {len(Xv):,} de validation, {len(Xt):,} de test ({time.time() - t0:.0f} s)")

    # ---- regression: candidates on the common validation sample
    comp = {}
    clim_c = references(Xc)["climatologie"]
    for nom, mu in references(Xc).items():
        comp[nom] = metriques_reg(yc, mu, clim_c)
    reg = ajuster_hgb_reg(Xa, ya, Xv, yv)
    n_reg = int(reg.n_iter_)
    hp = {k: HGB[k] for k in ("learning_rate", "max_leaf_nodes", "min_samples_leaf", "l2_regularization")}
    comp["gradient_boosting_poisson"] = {**metriques_reg(yc, reg.predict(Xc[TOUTES]), clim_c), "objectif": "poisson", "hyperparametres": {"arbres": n_reg, **hp}}
    regl = ajuster_hgb_log(Xa, ya, Xv, yv)
    n_log = int(regl.n_iter_)
    comp["gradient_boosting_log"] = {**metriques_reg(yc, np.expm1(regl.predict(Xc[TOUTES])), clim_c), "objectif": "log", "hyperparametres": {"arbres": n_log, **hp}}
    ia = rng.choice(len(Xa), min(N_KNN, len(Xa)), replace=False)
    if complet:
        best = None
        for alpha in (1e-4, 1e-2, 1.0):
            m = _lin(PoissonRegressor(alpha=alpha, max_iter=300)).fit(Xa.iloc[ia][TOUTES], ya[ia])
            r = metriques_reg(yc, m.predict(Xc[TOUTES]), clim_c)
            if best is None or r["deviance_poisson"] < best["deviance_poisson"]:
                best = {**r, "hyperparametres": {"alpha": alpha, "lignes_apprentissage": int(len(ia))}}
        comp["regression_poisson"] = {**best, "objectif": "poisson"}
        alpha_poisson = best["hyperparametres"]["alpha"]
        best = None
        for alpha in (0.1, 10.0, 1000.0):
            m = _lin(Ridge(alpha=alpha)).fit(Xa[TOUTES], np.log1p(ya))
            r = metriques_reg(yc, np.expm1(m.predict(Xc[TOUTES])), clim_c)
            if best is None or r["rmse_log"] < best["rmse_log"]:
                best = {**r, "hyperparametres": {"alpha": alpha}}
        comp["regression_lineaire"] = {**best, "objectif": "log"}
        alpha_ridge = best["hyperparametres"]["alpha"]
        best, courbe_k = None, []
        Xs = _lin(None)[:-1].fit(Xa.iloc[ia][TOUTES])
        A_, C_ = Xs.transform(Xa.iloc[ia][TOUTES]), Xs.transform(Xc[TOUTES])
        for k in (5, 15, 40, 100):
            m = KNeighborsRegressor(n_neighbors=k, n_jobs=-1).fit(A_, np.log1p(ya[ia]))
            r = metriques_reg(yc, np.expm1(m.predict(C_)), clim_c)
            courbe_k.append({"k": k, "deviance_poisson": r["deviance_poisson"], "rmse_log": r["rmse_log"]})
            if best is None or r["rmse_log"] < best["rmse_log"]:
                best = {**r, "hyperparametres": {"k": k, "lignes_apprentissage": int(len(ia))}}
        comp["k_plus_proches_voisins"] = {**best, "objectif": "log", "courbe_k": courbe_k}
    rapport["regression_validation"] = comp
    # learning curve of the boosted trees (over- / under-fitting): validation deviance after each 20 trees
    courbe = []
    for it, mu in enumerate(reg.staged_predict(Xc[TOUTES]), 1):
        if it % 20 == 0 or it == n_reg:
            courbe.append({"arbres": it, "deviance_validation": deviance_poisson(yc, mu)})
    ja = rng.choice(len(Xa), min(N_COMPARAISON, len(Xa)), replace=False)
    for c, (it, mu) in zip(courbe, [(i, m) for i, m in enumerate(reg.staged_predict(Xa.iloc[ja][TOUTES]), 1) if i % 20 == 0 or i == n_reg]):
        c["deviance_apprentissage"] = deviance_poisson(ya[ja], mu)
    rapport["courbe_apprentissage"] = courbe
    journal(f"h={h}: regression comparee ({time.time() - t0:.0f} s) " + ", ".join(f"{k} dev {v['deviance_poisson']:.2f} R2log {v['r2_log']:.3f}" for k, v in comp.items()))

    # ---- conformal quantiles on the validation years (model that never saw them), then refit on train + validation
    mu_v = reg.predict(Xv[TOUTES])
    q = quantiles_conformes(yv, mu_v)
    Xav, yav, zav = pd.concat([Xa, Xv], ignore_index=True), np.concatenate([ya, yv]), np.concatenate([za, zv])
    reg2 = ajuster_hgb_reg(Xav, yav, n_iter=n_reg)
    mu_t = reg2.predict(Xt[TOUTES])
    ml_t = np.expm1(ajuster_hgb_log(Xav, yav, n_iter=n_log).predict(Xt[TOUTES]))
    ref_t = references(Xt)
    en_jeu = (Xt["f_freq"].to_numpy() > 0) & (Xt["f_freq"].to_numpy() < 1)
    actif = Xt["f_mall"].to_numpy() > 0
    rapport["regression_test"] = {
        "gradient_boosting_poisson": metriques_reg(yt, mu_t, ref_t["climatologie"]),
        "gradient_boosting_log": metriques_reg(yt, ml_t, ref_t["climatologie"]),
        **{nom: metriques_reg(yt, mu, ref_t["climatologie"]) for nom, mu in ref_t.items()},
        "gradient_boosting_poisson_cellules_avec_historique": metriques_reg(yt[actif], mu_t[actif], ref_t["climatologie"][actif]),
        "gradient_boosting_log_cellules_avec_historique": metriques_reg(yt[actif], ml_t[actif], ref_t["climatologie"][actif]),
        "climatologie_cellules_avec_historique": metriques_reg(yt[actif], ref_t["climatologie"][actif], ref_t["climatologie"][actif]),
        "par_annee": {int(a): metriques_reg(yt[kt["cible"].to_numpy() == a], mu_t[kt["cible"].to_numpy() == a]) for a in sorted(kt["cible"].unique())}}
    if complet:      # the simple models too, refitted on train + validation with the hyper-parameter chosen on validation
        iav = rng.choice(len(Xav), min(N_KNN, len(Xav)), replace=False)
        lin = _lin(Ridge(alpha=alpha_ridge)).fit(Xav[TOUTES], np.log1p(yav))
        rapport["regression_test"]["regression_lineaire"] = metriques_reg(yt, np.expm1(lin.predict(Xt[TOUTES])), ref_t["climatologie"])
        glm = _lin(PoissonRegressor(alpha=alpha_poisson, max_iter=300)).fit(Xav.iloc[iav][TOUTES], yav[iav])
        rapport["regression_test"]["regression_poisson"] = metriques_reg(yt, glm.predict(Xt[TOUTES]), ref_t["climatologie"])
        coef = pd.Series(lin[-1].coef_, index=TOUTES)
        rapport["coefficients_standardises_regression_lineaire"] = {k: float(v) for k, v in coef.reindex(coef.abs().sort_values(ascending=False).index).items()}
    for nom in ("climatologie", "persistance", "moyenne_3_ans"):
        rt = rapport["regression_test"]
        rt[f"skill_deviance_vs_{nom}"] = float(1 - rt["gradient_boosting_poisson"]["deviance_poisson"] / rt[nom]["deviance_poisson"])
        rt[f"skill_mse_log_vs_{nom}"] = float(1 - (rt["gradient_boosting_log"]["rmse_log"] / rt[nom]["rmse_log"]) ** 2)
    rapport["intervalles"] = {"quantiles": q, "couverture_test": couverture(yt, mu_t, q), "classes": NOMS_CLASSES, "bornes_classes": CLASSES_PRED[1:-1]}

    # ---- zone totals: residuals of sums over H3 parents (res 2 and res 1) on validation -> quantiles, coverage on test
    import h3
    par = {r: np.array([h3.str_to_int(h3.cell_to_parent(h3.int_to_str(int(c)), r)) for c in H.cellules], np.uint64) for r in (3, 2, 1)}

    def sommes(k, y, mu):
        d = pd.DataFrame({"cible": k["cible"].to_numpy(), "y": y, "mu": mu, **{f"p{r}": par[r][k["i"].to_numpy()] for r in par}})
        s = pd.concat([d.groupby([f"p{r}", "cible"])[["y", "mu"]].sum().assign(niveau=r) for r in par])
        return s[s["mu"] >= 1]
    sv, st_ = sommes(kv, yv, mu_v), sommes(kt, yt, mu_t)
    qz = quantiles_conformes(sv["y"].to_numpy(), sv["mu"].to_numpy())
    rapport["intervalles_zone"] = {"quantiles": qz, "apprises_sur": "sommes par parent H3 res 3, 2 et 1 (validation)", "classes": NOMS_CLASSES, "bornes_classes": CLASSES_PRED[1:-1],
                                   "couverture_test": {str(r): couverture(g["y"].to_numpy(), g["mu"].to_numpy(), qz) for r, g in st_.groupby("niveau")},
                                   "metriques_test": {str(r): metriques_reg(g["y"].to_numpy(), g["mu"].to_numpy()) for r, g in st_.groupby("niveau")}}

    # ---- classification
    compc = {}
    for nom, p in {"frequence_historique": Xc["f_freq"].to_numpy("f8"), "frequence_5_ans": Xc["f_freq5"].to_numpy("f8"),
                   "persistance": (np.expm1(Xc["f_l0"].to_numpy("f8")) / H.aire[kv["i"].to_numpy()[iv]] * 1000 / 12 >= P.SEUIL_DENSITE).astype("f8")}.items():
        compc[nom] = metriques_clf(zc, p)
    clf = ajuster_hgb_clf(Xa, za, Xv, zv)
    n_clf = int(clf.n_iter_)
    compc["gradient_boosting"] = {**metriques_clf(zc, clf.predict_proba(Xc[TOUTES])[:, 1]), "hyperparametres": {"arbres": n_clf}}
    if complet:
        best = None
        for C_reg in (0.01, 0.1, 1.0):
            m = _lin(LogisticRegression(C=C_reg, max_iter=400)).fit(Xa.iloc[ia][TOUTES], za[ia])
            r = metriques_clf(zc, m.predict_proba(Xc[TOUTES])[:, 1])
            if best is None or r["brier"] < best["brier"]:
                best = {**r, "hyperparametres": {"C": C_reg, "lignes_apprentissage": int(len(ia))}}
        compc["regression_logistique"] = best
        c_logit = best["hyperparametres"]["C"]
        best = None
        for k in (15, 40, 100):
            m = KNeighborsClassifier(n_neighbors=k, n_jobs=-1).fit(A_, za[ia])
            r = metriques_clf(zc, m.predict_proba(C_)[:, 1])
            if best is None or r["brier"] < best["brier"]:
                best = {**r, "hyperparametres": {"k": k, "lignes_apprentissage": int(len(ia))}}
        compc["k_plus_proches_voisins"] = best
    rapport["classification_validation"] = compc
    # isotonic calibration learnt on the validation years (probabilities of the model that never saw them)
    iso = IsotonicRegression(y_min=0, y_max=1, out_of_bounds="clip").fit(clf.predict_proba(Xv[TOUTES])[:, 1], zv)
    clf2 = ajuster_hgb_clf(Xav, zav, n_iter=n_clf)
    p_brut = clf2.predict_proba(Xt[TOUTES])[:, 1]
    p_t = iso.predict(p_brut)
    pers_t = (np.expm1(Xt["f_l0"].to_numpy("f8")) / H.aire[kt["i"].to_numpy()] * 1000 / 12 >= P.SEUIL_DENSITE).astype("f8")
    rapport["classification_test"] = {
        "gradient_boosting": metriques_clf(zt, p_t), "gradient_boosting_non_calibre": metriques_clf(zt, p_brut),
        "frequence_historique": metriques_clf(zt, Xt["f_freq"].to_numpy("f8")), "persistance": metriques_clf(zt, pers_t),
        "gradient_boosting_cellules_en_jeu": metriques_clf(zt[en_jeu], p_t[en_jeu]),
        "frequence_historique_cellules_en_jeu": metriques_clf(zt[en_jeu], Xt["f_freq"].to_numpy("f8")[en_jeu]),
        "persistance_cellules_en_jeu": metriques_clf(zt[en_jeu], pers_t[en_jeu]),
        "fiabilite": fiabilite(zt, p_t), "fiabilite_cellules_en_jeu": fiabilite(zt[en_jeu], p_t[en_jeu]),
        "par_annee": {int(a): metriques_clf(zt[kt["cible"].to_numpy() == a], p_t[kt["cible"].to_numpy() == a]) for a in sorted(kt["cible"].unique())}}
    b = rapport["classification_test"]
    if complet:
        logit = _lin(LogisticRegression(C=c_logit, max_iter=400)).fit(Xav.iloc[iav][TOUTES], zav[iav])
        b["regression_logistique"] = metriques_clf(zt, logit.predict_proba(Xt[TOUTES])[:, 1])
        b["regression_logistique_cellules_en_jeu"] = metriques_clf(zt[en_jeu], logit.predict_proba(Xt[TOUTES])[:, 1][en_jeu])
        coef = pd.Series(logit[-1].coef_[0], index=TOUTES)
        rapport["coefficients_standardises_regression_logistique"] = {k: float(v) for k, v in coef.reindex(coef.abs().sort_values(ascending=False).index).items()}
    b["skill_brier_vs_frequence_historique"] = float(1 - b["gradient_boosting"]["brier"] / b["frequence_historique"]["brier"])
    b["skill_brier_vs_frequence_historique_cellules_en_jeu"] = float(1 - b["gradient_boosting_cellules_en_jeu"]["brier"] / b["frequence_historique_cellules_en_jeu"]["brier"])
    # ROC curve points (test) for the dashboard
    o = np.argsort(-p_t)
    tp, fp = np.cumsum(zt[o]), np.cumsum(1 - zt[o])
    pas = np.unique(np.linspace(0, len(o) - 1, 60).astype(int))
    b["roc"] = [{"tfp": float(fp[i] / max(fp[-1], 1)), "tvp": float(tp[i] / max(tp[-1], 1))} for i in pas]
    journal(f"h={h}: test regression deviance {rapport['regression_test']['gradient_boosting_poisson']['deviance_poisson']:.2f} (climatologie {rapport['regression_test']['climatologie']['deviance_poisson']:.2f}), "
            f"R2 log {rapport['regression_test']['gradient_boosting_log']['r2_log']:.3f} (climatologie {rapport['regression_test']['climatologie']['r2_log']:.3f}) ; classification AUC {b['gradient_boosting']['roc_auc']:.3f}, Brier {b['gradient_boosting']['brier']:.4f} "
            f"(freq. hist. {b['frequence_historique']['brier']:.4f}) ; couverture 80 % {rapport['intervalles']['couverture_test']['0.8']['globale']:.3f} ({time.time() - t0:.0f} s)")

    # ---- production: same specification on every available target year, origin = last complete year
    o_tous = list(range(O_MIN, P.AN1 - h + 1))
    Xp, yp, zp, _ = H.jeu(h, o_tous)
    regp = ajuster_hgb_reg(Xp, yp, n_iter=int(round(n_reg * 1.1)))
    clfp = ajuster_hgb_clf(Xp, zp, n_iter=int(round(n_clf * 1.1)))
    # production intervals: out-of-sample residuals of validation AND test years pooled
    q_prod = quantiles_conformes(np.concatenate([yv, yt]), np.concatenate([mu_v, mu_t]))
    s2 = pd.concat([sv, st_])
    qz_prod = quantiles_conformes(s2["y"].to_numpy(), s2["mu"].to_numpy())
    Xo = H.vecteurs(P.AN1)
    mu_o = regp.predict(Xo[TOUTES])
    lo, hi = bornes(mu_o, q_prod, 0.8)
    prod = {"annee": P.AN1 + h, "mu": mu_o, "bas80": lo, "haut80": hi, "proba": iso.predict(clfp.predict_proba(Xo[TOUTES])[:, 1]),
            "q": q_prod, "qz": qz_prod}
    rapport["production"] = {"origine": P.AN1, "annee_prevue": P.AN1 + h, "lignes_apprentissage": int(len(Xp)), "quantiles_cellule": q_prod, "quantiles_zone": qz_prod,
                             "total_prevu": float(mu_o.sum()), "cellules_proba_sup_50": int((prod["proba"] >= 0.5).sum())}
    extras = {"reg2": reg2, "clf2": clf2, "Xt": Xt, "yt": yt, "zt": zt, "Xa": Xa, "ya": ya, "Xv": Xv, "yv": yv, "n_reg": n_reg, "iso": iso}
    return rapport, prod, extras


def importance_permutation(modele, X, y, graine=0, n=60_000, repetitions=3):
    """Increase of the mean Poisson deviance when a feature (or a whole family) is shuffled, on test rows."""
    rng = np.random.default_rng(graine)
    i = rng.choice(len(X), min(n, len(X)), replace=False)
    Xs, ys = X.iloc[i][TOUTES].reset_index(drop=True), y[i]
    base = deviance_poisson(ys, modele.predict(Xs))

    def perte(cols):
        d = []
        for _ in range(repetitions):
            Xp = Xs.copy()
            o = rng.permutation(len(Xs))
            Xp[cols] = Xs[cols].to_numpy()[o]
            d.append(deviance_poisson(ys, modele.predict(Xp)) - base)
        return float(np.mean(d))
    par_var = {c: perte([c]) for c in TOUTES}
    par_fam = {f: perte(cols) for f, cols in FAMILLES.items()}
    return {"deviance_de_base": base, "par_variable": par_var, "par_famille": par_fam, "lignes": int(len(Xs)), "repetitions": repetitions}


def ablation(Xa, ya, Xv, yv, n_iter, graine=0, n=400_000):
    """Validation deviance of the boosted trees trained on nested feature sets: what does each family add?"""
    rng = np.random.default_rng(graine)
    i = rng.choice(len(Xa), min(n, len(Xa)), replace=False)
    jeux = {"memoire": FAMILLES["memoire"], "memoire + voisins": FAMILLES["memoire"] + FAMILLES["voisins"],
            "memoire + voisins + climat": FAMILLES["memoire"] + FAMILLES["voisins"] + FAMILLES["climat"],
            "toutes (+ sol, relief, latitude)": TOUTES,
            "environnement seul (climat, sol, relief, latitude)": FAMILLES["climat"] + FAMILLES["sol"] + FAMILLES["lieu"]}
    clim = references(Xv)["climatologie"]
    out = {}
    for nom, cols in jeux.items():
        m = ajuster_hgb_reg(Xa.iloc[i], ya[i], colonnes=cols, n_iter=n_iter)
        out[nom] = {**{k: v for k, v in metriques_reg(yv, m.predict(Xv[cols]), clim).items() if k in ("deviance_poisson", "r2_log", "rmse_log", "r2_anomalies_log", "biais_total_pct")},
                    "n_variables": len(cols)}
    return out
