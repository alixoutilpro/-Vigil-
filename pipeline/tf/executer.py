"""Vigil Trends & Forecasts: whole analysis, from the harmonized site files to public/data/tf/.

    python -m pipeline.tf.table        # harmonized fire history per H3 res-4 cell (from public/data)
    python -m pipeline.tf.statique     # land cover (Planetary Computer) and relief
    python -m pipeline.tf.climat       # TerraClimate normals (Planetary Computer)
    python -m pipeline.tf.executer     # regimes, trends, trajectories, forecasts, validation -> public/data/tf/

Files written (contract: docs/methode_tf.md §9):
    tf/cellules.bin.gz   one record per cell, columnar binary (history 2003-2025, regime, trend, forecasts 2026-2030)
    tf/modele.json       model card: protocol, every validation metric, clustering diagnostics, feature importance
"""
import argparse
import gzip
import json
import os
import sys
import time
from datetime import datetime

import numpy as np
import pandas as pd

from . import parametres as P
from . import prevision as V
from .descripteurs import descripteurs
from .regimes import MIN_AN, Q_FDR, VARIABLES_REGIME, adjacence, regimes, tendances, trajectoires
from .vecteurs import FAMILLES, LIBELLES, NOMS_FAMILLES, TOUTES, Historique

TYPES = {"u8": "<u1", "i8": "<i1", "u16": "<u2", "f32": "<f4", "u64": "<u8"}
CLASSES_LC = ["arbres", "arbustes", "herbacees", "cultures", "bati", "nu", "neige", "eau", "zones_humides", "mangroves", "mousses"]
NOMS_LC = {"arbres": "Tree cover", "arbustes": "Shrubland", "herbacees": "Grassland", "cultures": "Cropland", "bati": "Built-up",
           "nu": "Bare / sparse vegetation", "neige": "Snow and ice", "eau": "Permanent water", "zones_humides": "Herbaceous wetland",
           "mangroves": "Mangroves", "mousses": "Moss and lichen"}


def ecrire_colonnes(chemin, colonnes, meta):
    """Columnar binary file: 'VTF1' | uint32 header length | JSON header | columns (each aligned on 8 bytes), gzip."""
    n = len(next(iter(colonnes.values()))[1])
    corps, desc, pos = [], [], 0
    for nom, (typ, v) in colonnes.items():
        b = np.ascontiguousarray(np.asarray(v).astype(TYPES[typ])).tobytes()
        b += b"\0" * (-len(b) % 8)
        desc.append({"nom": nom, "type": typ, "decalage": pos})
        corps.append(b)
        pos += len(b)
    tete = json.dumps({**meta, "n": n, "colonnes": desc}, ensure_ascii=False, allow_nan=False).encode("utf-8")
    tete += b" " * (-(8 + len(tete)) % 8)
    os.makedirs(os.path.dirname(chemin), exist_ok=True)
    with open(chemin, "wb") as f:
        f.write(gzip.compress(b"VTF1" + np.uint32(len(tete)).tobytes() + tete + b"".join(corps), compresslevel=9, mtime=0))
    return os.path.getsize(chemin)


def nom_regime(r):
    """Short English name of a regime from its median profile (rules written before reading the map)."""
    if r["densite"] >= 5 and r["cv"] < 0.5:
        return "Annual savanna-type burning"
    if r["cv"] >= 1.5 and r["frp"] >= 60:
        return "Episodic intense wildfires"
    if r["saison_R"] < 0.6:
        return "Diffuse, weakly seasonal burning"
    return "Regular seasonal burning"


def nom_trajectoire(c, annees):
    """Name of a trajectory shape from its centre (standardized log series): where are the high and the low?"""
    c = np.asarray(c, "f8")
    n = len(c)
    debut, milieu, fin = c[: n // 3].mean(), c[n // 3: 2 * n // 3].mean(), c[2 * n // 3:].mean()
    if fin - debut > 0.8 and milieu < fin:
        return "Rising"
    if debut - fin > 0.8 and milieu < debut:
        return "Declining"
    if milieu > max(debut, fin):
        return "Peak around " + str(int(annees[int(np.argmax(c))]))
    if milieu < min(debut, fin):
        return "Dip around " + str(int(annees[int(np.argmin(c))])) + ", then recovery"
    return "Rising" if fin > debut else "Declining"


def nettoyer(o):
    """JSON-safe copy: numpy types -> Python, NaN/inf -> None."""
    if isinstance(o, dict):
        return {str(k): nettoyer(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [nettoyer(v) for v in o]
    if isinstance(o, pd.DataFrame):
        return nettoyer(o.to_dict("records"))
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (float, np.floating)):
        return float(o) if np.isfinite(o) else None
    if isinstance(o, np.ndarray):
        return nettoyer(o.tolist())
    return o


def main(argv=None):
    ap = argparse.ArgumentParser(description="Vigil T&F - regimes, tendances, previsions, export du site")
    ap.add_argument("--cache", default=P.CACHE)
    ap.add_argument("--site", default=P.SITE)
    ap.add_argument("--rapide", action="store_true", help="skip the linear / nearest-neighbour candidates (tests)")
    ap.add_argument("--previsions", action="store_true", help="also fit the forecasting models (experimental, NOT shown in Vigil Trends: "
                    "on Greek test years they did not beat the historical mean on yearly extremes, see docs/methode_tf.md)")
    a = ap.parse_args(argv)
    t0 = time.time()
    journal = lambda m: print(f"[{time.time() - t0:5.0f} s] {m}", flush=True)
    F = pd.read_parquet(os.path.join(a.cache, "feux_mois.parquet"))
    C = pd.read_parquet(os.path.join(a.cache, "cellules.parquet"))
    meta_table = json.load(open(os.path.join(a.cache, "table_meta.json"), encoding="utf-8"))

    # ---- 1. descriptors, regimes, trends, trajectories (unsupervised)
    d, A, R, M = descripteurs(F, C)
    lab_r, reg = regimes(d)
    tend, res_t = tendances(A, d)
    tend_l, res_l = tendances(A, d, adjacence(A.index.to_numpy("uint64")))      # denoised local trend (cell + neighbours)
    lab_t, traj = trajectoires(A, d)
    journal(f"regimes k={reg['k']}, trajectoires k={traj['k']}, tendances: +{res_t['hausse_significative']} / -{res_t['baisse_significative']} cellules significatives")

    # ---- 2. forecasts
    H = Historique(F, C, a.cache)
    assert (H.cellules == A.index.to_numpy("uint64")).all()
    manquantes = [c for c in TOUTES if not pd.Series(H.vecteurs(P.AN1)[c]).notna().any()]
    if manquantes:
        raise SystemExit(f"Covariables absentes : {manquantes} (lancer pipeline.tf.climat et pipeline.tf.statique)")
    rapports, prods = [], {}
    importance, abl = {}, {}
    for h in (P.HORIZONS if a.previsions else []):
        r, prod, ex = V.evaluer_horizon(H, h, journal, complet=not a.rapide)
        if h in (1, 5):
            importance[str(h)] = V.importance_permutation(ex["reg2"], ex["Xt"], ex["yt"], graine=h)
            journal(f"h={h}: importance par famille {({k: round(v, 2) for k, v in importance[str(h)]['par_famille'].items()})}")
        if h in (1, 3, 5):
            abl[str(h)] = V.ablation(ex["Xa"], ex["ya"], ex["Xv"], ex["yv"], ex["n_reg"], graine=h)
            journal(f"h={h}: ablation " + ", ".join(f"{k}: {v['deviance_poisson']:.2f}" for k, v in abl[str(h)].items()))
        rapports.append(r)
        prods[h] = prod
        del ex

    # parsimony rule: the simplest candidate within 1 % of the best validation criterion, averaged over the horizons
    def ecart_moyen(bloc, critere, noms):
        e = {n: [] for n in noms}
        for r in rapports:
            t = r[bloc]
            meilleur = min(t[n][critere] for n in noms if n in t)
            for n in noms:
                if n in t:
                    e[n].append(t[n][critere] / meilleur - 1)
        return {n: float(np.mean(v)) for n, v in e.items() if v}
    choix = None if not a.previsions else {"regle": "le candidat le plus simple a moins de 1 % du meilleur critere de validation, en moyenne sur les horizons",
             "comptes_deviance_poisson": ecart_moyen("regression_validation", "deviance_poisson", ["regression_poisson", "gradient_boosting_poisson"]),
             "log_rmse": ecart_moyen("regression_validation", "rmse_log", ["regression_lineaire", "k_plus_proches_voisins", "gradient_boosting_log"]),
             "classification_brier": ecart_moyen("classification_validation", "brier", ["regression_logistique", "k_plus_proches_voisins", "gradient_boosting"])}
    ordre_simplicite = ["regression_lineaire", "regression_poisson", "regression_logistique", "k_plus_proches_voisins", "gradient_boosting_log", "gradient_boosting_poisson", "gradient_boosting"]
    for cle in (("comptes_deviance_poisson", "log_rmse", "classification_brier") if choix else ()):
        ok = [n for n in ordre_simplicite if n in choix[cle] and choix[cle][n] <= 0.01]
        choix[cle + "_retenu"] = ok[0] if ok else None
    journal(f"modeles retenus : {choix}")

    # ---- 3. check on the unseen, incomplete year 2026: forecast (h = 1) scaled to the months observed so far
    index = json.load(open(os.path.join(a.site, "index.json"), encoding="utf-8"))
    dernier = index["mois"][-1]
    an_c, mois_c = int(dernier[:4]), int(dernier[5:])
    partiel = index.get("mois_partiel", dernier if index["genere_le"][:7] == dernier else None)
    m_fin = mois_c - 1 if partiel == dernier else mois_c            # last complete month of the current year
    pos = pd.Series(np.arange(len(H.cellules)), index=H.cellules)
    fc = F[(F["an"] == an_c) & (F["mois"] <= m_fin)]
    ytd = np.zeros(len(H.cellules))
    np.add.at(ytd, pos.reindex(fc["cellule"]).to_numpy(), fc["hotspots"].to_numpy("f8"))
    part = H.M[:, :, :m_fin].sum(axis=(1, 2)) / np.maximum(H.M.sum(axis=(1, 2)), 1e-9)       # usual share of Jan..m_fin in the year
    ytd_hist = H.M[:, :, :m_fin].sum(axis=2).astype("f8")                                   # cells x years, same months
    controle_2026 = None
    if a.previsions and an_c == P.AN1 + 1 and m_fin >= 6:
        att = prods[1]["mu"] * part
        clim = np.expm1(H.L.mean(axis=1)) * part
        ok = (att > 0) | (ytd > 0)
        controle_2026 = {"annee": an_c, "mois_observes": f"1-{m_fin}", "observe": float(ytd.sum()), "prevu_a_date": float(att.sum()),
                         "climatologie_a_date": float(clim.sum()), "ecart_pct": float(100 * (att.sum() - ytd.sum()) / ytd.sum()),
                         "cellules": int(ok.sum()), "prevision": V.metriques_reg(ytd[ok], att[ok], clim[ok]), "climatologie": V.metriques_reg(ytd[ok], clim[ok], clim[ok]),
                         "note": "prevision annuelle x part habituelle des mois deja observes (2003-2025) ; annee non vue par le modele"}
        journal(f"controle {an_c} (mois 1-{m_fin}) : observe {ytd.sum():,.0f}, prevu a date {att.sum():,.0f}, deviance {controle_2026['prevision']['deviance_poisson']:.2f} vs climatologie {controle_2026['climatologie']['deviance_poisson']:.2f}")

    # ---- 4. export: cells
    S = H.stat
    lc = S[[f"lc_{c}" for c in CLASSES_LC]].to_numpy("f8") if all(f"lc_{c}" in S for c in CLASSES_LC) else np.full((len(H.cellules), len(CLASSES_LC)), np.nan)
    lc_dom = np.where(np.isnan(lc).all(axis=1), 255, np.nanargmax(np.where(np.isnan(lc), -1, lc), axis=1)).astype(np.uint8)
    pays = sorted(C["pays"].dropna().unique())
    code_pays = C["pays"].map({p: i for i, p in enumerate(pays)}).fillna(65535).to_numpy("uint16")
    horizons = P.HORIZONS if a.previsions else []
    garde = C["feu"].to_numpy()
    if horizons:
        mu = np.stack([prods[h]["mu"] for h in horizons], axis=1)
        pr = np.stack([prods[h]["proba"] for h in horizons], axis=1)
        garde = garde | (mu.max(axis=1) >= 0.5) | (pr.max(axis=1) >= 0.01)
    col = {"h3": ("u64", H.cellules), "lat": ("f32", C["lat"]), "lon": ("f32", C["lon"]), "aire": ("f32", C["aire_km2"]), "pays": ("u16", code_pays),
           "regime": ("u8", lab_r), "trajectoire": ("u8", lab_t), "tendance": ("i8", tend["tendance"]), "sen": ("f32", tend["sen_pct_an"]), "q": ("f32", tend["mk_q"]),
           "tendance_l": ("i8", tend_l["tendance"]), "sen_l": ("f32", tend_l["sen_pct_an"]), "q_l": ("f32", tend_l["mk_q"]),
           "dens": ("f32", d["densite"]), "freq": ("f32", d["part_annees_fortes"]), "frp_det": ("f32", d["frp_par_detection"].fillna(0)),
           "pic": ("u8", d["mois_pic"]), "saison": ("u8", d["saison_longueur"]), "lc": ("u8", lc_dom),
           "vpd": ("f32", H.clim["c_vpd_moy"]), "ppt": ("f32", H.clim["c_ppt"]), "aridite": ("f32", H.clim["c_aridite"]),
           "ytd": ("f32", ytd), "ytd_med": ("f32", np.median(ytd_hist, axis=1))}
    for j, an in enumerate(range(P.AN0, P.AN1 + 1)):
        col[f"a{an}"] = ("f32", H.A[:, j])
    for k, h in enumerate(horizons):
        col[f"mu{h}"] = ("f32", mu[:, k]); col[f"bas{h}"] = ("f32", prods[h]["bas80"]); col[f"haut{h}"] = ("f32", prods[h]["haut80"])
        col[f"p{h}"] = ("u8", np.round(np.clip(pr[:, k], 0, 1) * 200))
    col = {k: (t, np.asarray(v)[garde]) for k, (t, v) in col.items()}
    profil = reg["profil"].copy()
    profil["nom"] = [nom_regime(r) for _, r in profil.iterrows()]
    if profil["nom"].duplicated().any():        # two groups with the same rule-based name: tell them apart by density rank
        profil["nom"] = [f"{n} ({'higher' if i == profil.index[profil['nom'] == n][0] else 'lower'} density)" if (profil["nom"] == n).sum() > 1 else n for i, n in zip(profil.index, profil["nom"])]
    g = pd.DataFrame(lc, columns=CLASSES_LC).assign(regime=lab_r)
    occ = g[g["regime"] > 0].groupby("regime")[CLASSES_LC].mean()
    profil["occupation_du_sol"] = [{NOMS_LC[c]: float(v) for c, v in occ.loc[r].sort_values(ascending=False).head(4).items()} for r in profil["regime"]]
    climr = H.clim.assign(regime=lab_r)
    profil["climat"] = [{"vpd_kPa": float(climr.loc[climr["regime"] == r, "c_vpd_moy"].median()), "pluie_mm": float(climr.loc[climr["regime"] == r, "c_ppt"].median()),
                         "aridite": float(climr.loc[climr["regime"] == r, "c_aridite"].median())} for r in profil["regime"]]
    annees = list(range(P.AN0, P.AN1 + 1))
    centres_t = traj["centres"]
    noms_t = [nom_trajectoire(centres_t.loc[centres_t["trajectoire"] == t, annees].to_numpy()[0], annees) for t in sorted(centres_t["trajectoire"])]
    meta = {"format": "VTF1", "genere_le": datetime.now().isoformat(timespec="seconds"), "h3_resolution": P.RES,
            "annees": [P.AN0, P.AN1], "horizons": horizons, "annees_prevues": [P.AN1 + h for h in horizons],
            "annee_en_cours": {"annee": an_c, "mois_observes": m_fin}, "seuil_densite": P.SEUIL_DENSITE, "pays": pays,
            "occupation_du_sol": [NOMS_LC[c] for c in CLASSES_LC], "regimes": ["Sporadic fire (too few detections to classify)"] + profil.sort_values("regime")["nom"].tolist(),
            "trajectoires": ["Sporadic"] + noms_t, "echelle_p": 200,
            "unites": {"a*, mu*, bas*, haut*, ytd": "harmonized detections per year (MODIS-Aqua equivalent)", "dens": "detections / 1,000 km2 / month, mean 2003-2025",
                       "p*": "probability of a high-activity year x 200", "sen": "% of the cell mean per year", "vpd": "kPa", "ppt": "mm / year"}}
    taille = ecrire_colonnes(os.path.join(a.site, "tf", "cellules.bin.gz"), col, meta)
    journal(f"tf/cellules.bin.gz : {int(garde.sum())} cellules, {len(col)} colonnes, {taille / 1e6:.1f} Mo")

    # ---- 5. export: model card
    rng = np.random.default_rng(0)
    ia = np.flatnonzero(reg["actif"])
    ech = rng.choice(len(ia), min(2500, len(ia)), replace=False)
    carte = {
        "genere_le": meta["genere_le"],
        "donnees": {"source": "public/data (contrat v2), memes fichiers harmonises que la vue Analytics", **meta_table,
                    "cellules_exportees": int(garde.sum()), "annees_completes": [P.AN0, P.AN1],
                    "covariables": {"climat": {"source": "TerraClimate (Abatzoglou et al. 2018), miroir Microsoft Planetary Computer", "annees_normale": H.clim_annees},
                                    "occupation_du_sol": "ESA WorldCover 2021 v200, API de donnees Microsoft Planetary Computer (tuiles zoom 6)",
                                    "relief": "Terrain Tiles AWS / Mapzen (SRTM, GMTED2010, ETOPO1), zoom 6"}},
        "parametres": {"seuil_annee_forte_densite": P.SEUIL_DENSITE, "min_detections_par_an": MIN_AN, "q_fdr": Q_FDR, "origine_min": V.O_MIN,
                       "decoupage": {"apprentissage_cibles_max": P.AN_TRAIN_MAX, "validation": list(P.AN_VALID), "test": list(P.AN_TEST)},
                       "gradient_boosting": {k: v for k, v in V.HGB.items() if k != "random_state"}},
        "variables": {"libelles": LIBELLES, "familles": FAMILLES, "noms_familles": NOMS_FAMILLES, "nombre": len(TOUTES)},
        "regimes": {"k": reg["k"], "variables": VARIABLES_REGIME, "diagnostics": reg["diagnostics"], "profil": profil, "centres_z": reg["centres_z"],
                    "pca": {"variance_expliquee": reg["pca_variance"], "axes": reg["pca_axes"],
                            "points": [[round(float(reg["pca_xy"][i, 0]), 2), round(float(reg["pca_xy"][i, 1]), 2), int(lab_r[ia[i]])] for i in ech]},
                    "cellules_classees": int(reg["actif"].sum()), "cellules_sporadiques": int((~reg["actif"]).sum())},
        "tendances": res_t, "tendances_locales_lissees": res_l,
        "trajectoires": {"k": traj["k"], "diagnostics": traj["diagnostics"], "noms": noms_t, "tailles": traj["tailles"],
                         "centres": [{"trajectoire": int(t), "nom": noms_t[i], "valeurs": [round(float(v), 3) for v in centres_t.loc[centres_t["trajectoire"] == t, annees].to_numpy()[0]]}
                                     for i, t in enumerate(sorted(centres_t["trajectoire"]))], "annees": annees},
        "previsions": {"horizons": rapports, "choix_des_modeles": choix, "controle_annee_en_cours": controle_2026},
        "importance": importance, "ablation": abl,
    }
    ch = os.path.join(a.site, "tf", "modele.json")
    with open(ch, "w", encoding="utf-8") as f:
        json.dump(nettoyer(carte), f, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    journal(f"tf/modele.json : {os.path.getsize(ch) / 1e3:.0f} ko")
    with open(os.path.join(a.cache, "modele_lisible.json"), "w", encoding="utf-8") as f:
        json.dump(nettoyer(carte), f, ensure_ascii=False, indent=1, allow_nan=False)
    journal("termine")


if __name__ == "__main__":
    sys.exit(main())
