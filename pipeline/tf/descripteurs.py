"""Fire-regime descriptors and trend statistics of every cell, from the harmonized monthly table (pipeline/tf/table.py)."""
import numpy as np
import pandas as pd
from scipy import stats

from . import parametres as P


def matrices(F, C, an0=P.AN0, an1=P.AN1):
    """Annual matrix (cells x years) and mean monthly profile (cells x 12) of hotspots; annual FRP matrix."""
    cel = C["cellule"].to_numpy("uint64")
    f = F[(F["an"] >= an0) & (F["an"] <= an1)]
    A = f.groupby(["cellule", "an"])["hotspots"].sum().unstack(fill_value=0.0).reindex(index=cel, columns=range(an0, an1 + 1), fill_value=0.0)
    R = f.groupby(["cellule", "an"])["frp"].sum().unstack(fill_value=0.0).reindex(index=cel, columns=range(an0, an1 + 1), fill_value=0.0)
    M = f.groupby(["cellule", "mois"])["hotspots"].sum().unstack(fill_value=0.0).reindex(index=cel, columns=range(1, 13), fill_value=0.0) / (an1 - an0 + 1)
    return A, R, M


def saison(M, lat):
    """Circular statistics of the mean monthly profile. Months of the southern hemisphere are shifted by 6 so that
    'month 7' is mid-summer in both hemispheres (regimes become comparable across the equator).
    Returns angle-based centre (1-12, solar-aligned), concentration R in [0, 1] (1 = one single month) and
    season length = number of months holding >= 10 % of the annual total (Giglio et al. 2006)."""
    p = M.to_numpy("f8")
    tot = p.sum(axis=1, keepdims=True)
    w = np.divide(p, tot, out=np.zeros_like(p), where=tot > 0)
    mois = np.arange(1, 13)[None, :] + np.where(np.asarray(lat)[:, None] < 0, 6, 0)
    ang = 2 * np.pi * (mois - 0.5) / 12
    c, s = (w * np.cos(ang)).sum(axis=1), (w * np.sin(ang)).sum(axis=1)
    centre = (np.degrees(np.arctan2(s, c)) % 360) / 30 + 0.5
    return pd.DataFrame({"saison_cos": c, "saison_sin": s, "saison_R": np.hypot(c, s), "saison_centre": centre,
                         "saison_longueur": (w >= 0.10).sum(axis=1).astype(float),
                         "mois_pic": M.to_numpy().argmax(axis=1) + 1}, index=M.index)


def mann_kendall(Y):
    """Vectorised Mann-Kendall test on the rows of Y (cells x years), ties corrected. Returns S, z, two-sided p."""
    Y = np.asarray(Y, "f8")
    n = Y.shape[1]
    S = np.zeros(Y.shape[0])
    for i in range(n - 1):
        S += np.sign(Y[:, i + 1:] - Y[:, [i]]).sum(axis=1)
    var = np.full(Y.shape[0], n * (n - 1) * (2 * n + 5) / 18.0)
    Ys = np.sort(Y, axis=1)
    # tie groups: runs of equal values in the sorted rows
    run = np.ones(Y.shape[0])
    corr = np.zeros(Y.shape[0])
    for j in range(1, n + 1):
        same = (Ys[:, j] == Ys[:, j - 1]) if j < n else np.zeros(Y.shape[0], bool)
        fin = ~same
        corr += np.where(fin & (run > 1), run * (run - 1) * (2 * run + 5), 0.0)
        run = np.where(same, run + 1, 1.0)
    var = (n * (n - 1) * (2 * n + 5) - corr) / 18.0
    z = np.where(var > 0, (S - np.sign(S)) / np.sqrt(np.maximum(var, 1e-12)), 0.0)
    return S, z, 2 * stats.norm.sf(np.abs(z))


def sen(Y, annees):
    """Theil-Sen slope (median of pairwise slopes) of the rows of Y against the years."""
    Y = np.asarray(Y, "f8")
    t = np.asarray(annees, "f8")
    i, j = np.triu_indices(len(t), 1)
    return np.median((Y[:, j] - Y[:, i]) / (t[j] - t[i]), axis=1)


def benjamini_hochberg(p):
    """Adjusted p-values (q) controlling the false discovery rate; NaN stay NaN."""
    p = np.asarray(p, "f8")
    q = np.full_like(p, np.nan)
    ok = ~np.isnan(p)
    x = p[ok]
    o = np.argsort(x)
    r = x[o] * len(x) / np.arange(1, len(x) + 1)
    r = np.minimum.accumulate(r[::-1])[::-1]
    out = np.empty_like(x)
    out[o] = np.minimum(r, 1.0)
    q[ok] = out
    return q


def descripteurs(F, C):
    A, R, M = matrices(F, C)
    d = pd.DataFrame(index=A.index)
    aire = C.set_index("cellule")["aire_km2"].reindex(A.index).to_numpy("f8")
    lat = C.set_index("cellule")["lat"].reindex(A.index).to_numpy("f8")
    d["moy_an"] = A.mean(axis=1)
    d["mediane_an"] = A.median(axis=1)
    d["densite"] = d["moy_an"] / aire * 1000 / 12          # detections / 1,000 km2 / month, annual mean
    d["cv_an"] = A.std(axis=1, ddof=1) / d["moy_an"].replace(0, np.nan)
    d["part_annees_actives"] = (A >= 1).mean(axis=1)
    d["part_annees_fortes"] = ((A.to_numpy() / aire[:, None] * 1000 / 12) >= P.SEUIL_DENSITE).mean(axis=1)
    d["frp_par_detection"] = R.sum(axis=1) / A.sum(axis=1).replace(0, np.nan)
    d = d.join(saison(M, lat))
    return d, A, R, M
