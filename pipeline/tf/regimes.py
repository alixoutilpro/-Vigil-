"""Unsupervised part of Trends & Forecasts: fire regimes (k-means on standardized descriptors), trends
(Theil-Sen + Mann-Kendall with false-discovery-rate control) and trajectory shapes (k-means on standardized series).

Rules fixed before looking at the maps (docs/methode_tf.md):
- only cells with a mean of >= MIN_AN harmonized detections per year are clustered or tested (99.3 % of all detections);
  the others are labelled "sporadic": their descriptors are too noisy to be classified;
- every variable is standardized (z-score) before k-means, otherwise the variable with the largest scale decides;
- regimes: k = the elbow of the inertia curve (the smallest k after which one more cluster removes < 10 % of the
  inertia); trajectory shapes: k = the most reproducible partition with >= 3 groups (split-half adjusted Rand index);
  inertia, silhouette, Davies-Bouldin and stability are reported for every k tested.
"""
import numpy as np
import pandas as pd
from sklearn.cluster import KMeans
from sklearn.decomposition import PCA
from sklearn.metrics import adjusted_rand_score, davies_bouldin_score, silhouette_score
from sklearn.preprocessing import StandardScaler

from . import parametres as P
from .descripteurs import benjamini_hochberg, mann_kendall, sen

MIN_AN = 3.0          # mean harmonized detections per year required to describe a regime or test a trend
GAIN_MIN = 0.10       # elbow rule
Q_FDR = 0.10          # false discovery rate of the trend map
N_PARTAGES = 5        # random half-splits used to measure the stability of a partition
VARIABLES_REGIME = ["log_densite", "saison_cos", "saison_sin", "saison_longueur", "log_cv", "log_frp"]


def variables_regime(d):
    return pd.DataFrame({"log_densite": np.log10(d["densite"]), "saison_cos": d["saison_cos"], "saison_sin": d["saison_sin"],
                         "saison_longueur": d["saison_longueur"], "log_cv": np.log(d["cv_an"]),
                         "log_frp": np.log(d["frp_par_detection"].clip(lower=1))}, index=d.index)


def choisir_k(Z, ks=range(2, 11), graine=0, n_sil=12000):
    """k-means for every k: inertia, silhouette (random sample), Davies-Bouldin, split-half stability (mean of
    N_PARTAGES random splits). Elbow rule."""
    rng = np.random.default_rng(graine)
    ech = rng.choice(len(Z), min(n_sil, len(Z)), replace=False)
    moities = [np.array_split(rng.permutation(len(Z)), 2) for _ in range(N_PARTAGES)]
    lignes, modeles = [], {}
    for k in ks:
        km = KMeans(k, n_init=10, random_state=graine).fit(Z)
        # stability: two k-means fitted on two random halves must give the same partition of ALL cells (adjusted Rand index)
        ari = [adjusted_rand_score(KMeans(k, n_init=3, random_state=graine + 1 + j).fit(Z[h1]).predict(Z),
                                   KMeans(k, n_init=3, random_state=graine + 101 + j).fit(Z[h2]).predict(Z)) for j, (h1, h2) in enumerate(moities)]
        lignes.append({"k": k, "inertie": float(km.inertia_), "silhouette": float(silhouette_score(Z[ech], km.labels_[ech])),
                       "davies_bouldin": float(davies_bouldin_score(Z, km.labels_)), "stabilite_ari": float(np.mean(ari)),
                       "stabilite_ari_min": float(np.min(ari)), "plus_petit_groupe": int(np.bincount(km.labels_).min())})
        modeles[k] = km
    t = pd.DataFrame(lignes)
    t["gain_inertie"] = -t["inertie"].pct_change()          # share of inertia removed by going from k-1 to k
    k = int(t["k"].iloc[-1])
    for i in range(len(t) - 1):
        if t["gain_inertie"].iloc[i + 1] < GAIN_MIN:
            k = int(t["k"].iloc[i])
            break
    return k, t, modeles[k]


def regimes(d, graine=0):
    """Fire regimes of the active cells. Returns labels (ordered by decreasing density, 1..k; 0 = sporadic), diagnostics."""
    actif = (d["moy_an"] >= MIN_AN).to_numpy()
    X = variables_regime(d[actif])
    sc = StandardScaler().fit(X)
    Z = sc.transform(X)
    k, diag, km = choisir_k(Z, graine=graine)
    brut = km.labels_
    ordre = pd.Series(d.loc[actif, "densite"].to_numpy()).groupby(brut).median().sort_values(ascending=False).index.to_numpy()
    rang = {int(c): i + 1 for i, c in enumerate(ordre)}
    lab = np.zeros(len(d), np.uint8)
    lab[actif] = [rang[int(c)] for c in brut]
    pca = PCA(2).fit(Z)
    xy = pca.transform(Z)
    g = d[actif].assign(regime=lab[actif])
    profil = g.groupby("regime").agg(n=("densite", "size"), densite=("densite", "median"), cv=("cv_an", "median"),
                                     frp=("frp_par_detection", "median"), saison_R=("saison_R", "median"),
                                     saison_longueur=("saison_longueur", "median"), part_annees_fortes=("part_annees_fortes", "mean"),
                                     hotspots=("moy_an", "sum"))
    ang = np.arctan2(g["saison_sin"], g["saison_cos"])
    profil["saison_centre"] = g.assign(c=np.cos(ang), s=np.sin(ang)).groupby("regime").apply(
        lambda x: float((np.degrees(np.arctan2(x["s"].mean(), x["c"].mean())) % 360) / 30 + 0.5), include_groups=False)
    profil["part_hotspots"] = profil["hotspots"] / d["moy_an"].sum()
    centres_z = pd.DataFrame(km.cluster_centers_, columns=VARIABLES_REGIME).assign(regime=[rang[i] for i in range(k)]).sort_values("regime")
    return lab, {"k": k, "diagnostics": diag, "profil": profil.reset_index(), "centres_z": centres_z, "pca_variance": pca.explained_variance_ratio_.tolist(),
                 "pca_axes": pd.DataFrame(pca.components_, columns=VARIABLES_REGIME), "pca_xy": xy, "actif": actif,
                 "moyennes": dict(zip(VARIABLES_REGIME, sc.mean_.tolist())), "ecarts_types": dict(zip(VARIABLES_REGIME, sc.scale_.tolist()))}


def adjacence(cellules):
    """Binary sparse matrix of the H3 ring-1 neighbours present in the study (self excluded)."""
    import h3
    from scipy import sparse
    pos = {int(c): i for i, c in enumerate(cellules)}
    li, co = [], []
    for i, c in enumerate(cellules):
        for v in h3.grid_ring(h3.int_to_str(int(c)), 1):
            j = pos.get(h3.str_to_int(v))
            if j is not None:
                li.append(i); co.append(j)
    return sparse.csr_matrix((np.ones(len(li)), (li, co)), shape=(len(cellules), len(cellules)))


def tendances(A, d, lissage=None):
    """Theil-Sen slope (% of the mean per year) and Mann-Kendall test of the annual totals, FDR-controlled.
    Class: +1 significant increase, -1 significant decrease, 0 no significant trend, -128 not tested (sporadic).
    lissage: adjacency matrix. When given, the series tested is the SUM of the cell and its ring-1 neighbours
    (a ~125 km neighbourhood): random year-to-year noise of single cells averages out, a shared local trend remains.
    The neighbourhood must hold >= MIN_AN detections per year."""
    annees = np.arange(P.AN0, P.AN1 + 1)
    B = A.to_numpy("f8")
    if lissage is not None:
        B = B + lissage @ B
        actif = B.mean(axis=1) >= MIN_AN
    else:
        actif = (d["moy_an"] >= MIN_AN).to_numpy()
    Y = B[actif]
    _, z, p = mann_kendall(Y)
    pente = sen(Y, annees)
    q = benjamini_hochberg(p)
    n = len(d)
    out = pd.DataFrame({"sen_pct_an": np.full(n, np.nan), "mk_p": np.full(n, np.nan), "mk_q": np.full(n, np.nan), "tendance": np.full(n, -128, np.int8)}, index=d.index)
    out.loc[actif, "sen_pct_an"] = 100 * pente / Y.mean(axis=1)
    out.loc[actif, "mk_p"], out.loc[actif, "mk_q"] = p, q
    out.loc[actif, "tendance"] = np.where(q < Q_FDR, np.sign(pente), 0).astype(np.int8)
    w = Y.mean(axis=1)
    resume = {"cellules_testees": int(actif.sum()), "p_inf_0_05": int((p < 0.05).sum()), "attendu_par_hasard": float(0.05 * actif.sum()),
              "q_fdr": Q_FDR, "hausse_significative": int(((q < Q_FDR) & (pente > 0)).sum()), "baisse_significative": int(((q < Q_FDR) & (pente < 0)).sum()),
              "part_hotspots_hausse": float(w[(q < Q_FDR) & (pente > 0)].sum() / w.sum()), "part_hotspots_baisse": float(w[(q < Q_FDR) & (pente < 0)].sum() / w.sum())}
    resume["serie"] = "cellule + 6 voisines (anneau H3 1)" if lissage is not None else "cellule seule"
    tot = A.sum(axis=0).to_numpy("f8")[None, :]
    _, _, pm = mann_kendall(tot)
    resume["monde"] = {"sen_pct_an": float(100 * sen(tot, annees)[0] / np.median(tot)), "mk_p": float(pm[0]), "annees": [int(P.AN0), int(P.AN1)]}
    return out, resume


def trajectoires(A, d, graine=0):
    """Shapes of the 2003-2025 series: log1p, 3-year moving average, z-score per cell (shape only, not level), k-means.
    Labels 1..k (0 = sporadic), ordered from the most declining to the most rising centre."""
    actif = (d["moy_an"] >= MIN_AN).to_numpy()
    L = np.log1p(A.to_numpy("f8")[actif])
    Lp = np.pad(L, ((0, 0), (1, 1)), mode="edge")
    Ls = (Lp[:, :-2] + Lp[:, 1:-1] + Lp[:, 2:]) / 3
    Z = (Ls - Ls.mean(axis=1, keepdims=True)) / np.maximum(Ls.std(axis=1, keepdims=True), 1e-9)
    _, diag, _ = choisir_k(Z, ks=range(2, 9), graine=graine)
    # Rule for shapes: the inertia curve has no elbow (shapes form a continuum) and 2 groups only say "up or down",
    # which the trend map already gives. So k = the most reproducible partition with at least 3 groups.
    t = diag[diag["k"] >= 3].reset_index(drop=True)
    k = int(t.loc[t["stabilite_ari"].idxmax(), "k"])
    km = KMeans(k, n_init=10, random_state=graine).fit(Z)
    annees = np.arange(P.AN0, P.AN1 + 1)
    pente = np.polyfit(annees, km.cluster_centers_.T, 1)[0]
    rang = {int(c): i + 1 for i, c in enumerate(np.argsort(pente))}
    lab = np.zeros(len(d), np.uint8)
    lab[actif] = [rang[int(c)] for c in km.labels_]
    centres = pd.DataFrame(km.cluster_centers_, columns=annees).assign(trajectoire=[rang[i] for i in range(k)]).sort_values("trajectoire")
    tailles = pd.Series(lab[actif]).value_counts().sort_index()
    return lab, {"k": k, "diagnostics": diag, "centres": centres, "tailles": tailles.to_dict()}
