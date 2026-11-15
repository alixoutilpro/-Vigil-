"""Feature vectors of the forecasting models: one row per (cell, origin year o), built ONLY with data of years <= o.

Families (docs/methode_tf.md §4):
    memoire   fire memory of the cell (harmonized series): recent levels, long-run mean, variability, slope,
              frequency of high-activity years, intensity (FRP per detection), seasonality
    voisins   the same memory averaged over the neighbouring cells (H3 rings 1 and 2): fire is spatially contagious
    climat    TerraClimate normals (5 sampled years 2002-2018): vapour pressure deficit, precipitation, soil moisture,
              climatic water deficit, maximum temperature, actual evapotranspiration, wind, aridity index
    sol       ESA WorldCover 2021 class shares (fuel type) ; relief = mean elevation and ruggedness
    lieu      absolute latitude
Targets for the horizon h: annual harmonized hotspots of year o + h, and "high-activity year" (density >= threshold).
"""
import glob
import os

import numpy as np
import pandas as pd
from scipy import sparse

from . import parametres as P

FAMILLES = {
    "memoire": ["f_l0", "f_l1", "f_l2", "f_m3", "f_m5", "f_m10", "f_mall", "f_sd", "f_pente", "f_max", "f_freq", "f_freq5", "f_frp",
                "f_saison_cos", "f_saison_sin", "f_saison_long"],
    "voisins": ["v_m3", "v2_m3", "v_freq"],
    "climat": ["c_vpd_moy", "c_vpd_max", "c_ppt", "c_ppt_cv", "c_soil_moy", "c_soil_min", "c_def", "c_tmax", "c_aet", "c_ws", "c_aridite"],
    "sol": ["lc_arbres", "lc_arbustes", "lc_herbacees", "lc_cultures", "lc_bati", "lc_nu", "lc_neige", "lc_eau", "lc_zones_humides",
            "lc_mangroves", "lc_mousses", "alt_moy", "alt_sd"],
    "lieu": ["lat_abs"],
}
LIBELLES = {
    "f_l0": "Fire activity, last year (log)", "f_l1": "Fire activity, 2 years ago (log)", "f_l2": "Fire activity, 3 years ago (log)",
    "f_m3": "Mean activity, last 3 years (log)", "f_m5": "Mean activity, last 5 years (log)", "f_m10": "Mean activity, last 10 years (log)",
    "f_mall": "Long-run mean activity since 2003 (log)", "f_sd": "Year-to-year variability (10 years)", "f_pente": "Recent slope of activity (10 years)",
    "f_max": "Highest year on record (log)", "f_freq": "Share of high-activity years since 2003", "f_freq5": "Share of high-activity years, last 5",
    "f_frp": "Fire intensity: FRP per detection (log)", "f_saison_cos": "Season timing (cos)", "f_saison_sin": "Season timing (sin)",
    "f_saison_long": "Fire-season length (months)",
    "v_m3": "Neighbours' mean activity, ring 1 (~42 km)", "v2_m3": "Neighbours' mean activity, ring 2 (~85 km)", "v_freq": "Neighbours' share of high-activity years",
    "c_vpd_moy": "Vapour pressure deficit, annual mean", "c_vpd_max": "Vapour pressure deficit, driest month", "c_ppt": "Annual precipitation",
    "c_ppt_cv": "Precipitation seasonality", "c_soil_moy": "Soil moisture, annual mean", "c_soil_min": "Soil moisture, driest month",
    "c_def": "Climatic water deficit, annual", "c_tmax": "Max temperature, warmest month", "c_aet": "Actual evapotranspiration (productivity)",
    "c_ws": "Wind speed, annual mean", "c_aridite": "Aridity index (P / PET)",
    "lc_arbres": "Tree cover share", "lc_arbustes": "Shrubland share", "lc_herbacees": "Grassland share", "lc_cultures": "Cropland share",
    "lc_bati": "Built-up share", "lc_nu": "Bare / sparse vegetation share", "lc_neige": "Snow and ice share", "lc_eau": "Permanent water share",
    "lc_zones_humides": "Herbaceous wetland share", "lc_mangroves": "Mangrove share", "lc_mousses": "Moss and lichen share",
    "alt_moy": "Mean elevation", "alt_sd": "Ruggedness (SD of elevation)", "lat_abs": "Absolute latitude",
}
NOMS_FAMILLES = {"memoire": "Fire memory of the cell", "voisins": "Neighbouring cells", "climat": "Climate (TerraClimate)",
                 "sol": "Land cover and relief", "lieu": "Latitude"}
TOUTES = [v for f in FAMILLES.values() for v in f]


def voisinage(cellules):
    """Row-normalized sparse matrices of the H3 ring-1 and ring-2 neighbours present in the study (self excluded)."""
    import h3
    pos = {int(c): i for i, c in enumerate(cellules)}
    out = []
    for k in (1, 2):
        li, co = [], []
        for i, c in enumerate(cellules):
            s = h3.int_to_str(int(c))
            for v in h3.grid_ring(s, k):
                j = pos.get(h3.str_to_int(v))
                if j is not None:
                    li.append(i); co.append(j)
        W = sparse.csr_matrix((np.ones(len(li)), (li, co)), shape=(len(cellules), len(cellules)))
        n = np.asarray(W.sum(axis=1)).ravel()
        out.append(sparse.diags(1 / np.maximum(n, 1)) @ W)
    return out


def climat_normales(cache, cellules):
    """Climate normals per cell: mean over the sampled years of the monthly TerraClimate fields (see pipeline/tf/climat.py)."""
    dossier = os.path.join(cache, "terraclimate")
    mois = [f"m{m:02d}" for m in range(1, 13)]
    moy, annees = {}, {}
    for v in ["vpd", "ppt", "soil", "def", "tmax", "aet", "ws"]:
        fs = sorted(glob.glob(os.path.join(dossier, f"{v}_[0-9][0-9][0-9][0-9].parquet")))
        if not fs:
            continue
        annees[v] = [int(os.path.basename(f)[-12:-8]) for f in fs]
        x = [pd.read_parquet(f).set_index("h3").reindex(cellules)[mois].to_numpy("f8") for f in fs]
        moy[v] = np.nanmean(np.stack(x), axis=0)          # cells x 12, mean of the sampled years
    c = pd.DataFrame(index=cellules)
    if "vpd" in moy:
        c["c_vpd_moy"], c["c_vpd_max"] = moy["vpd"].mean(axis=1), moy["vpd"].max(axis=1)
    if "ppt" in moy:
        c["c_ppt"] = moy["ppt"].sum(axis=1)
        c["c_ppt_cv"] = moy["ppt"].std(axis=1) / np.maximum(moy["ppt"].mean(axis=1), 1e-6)
    if "soil" in moy:
        c["c_soil_moy"], c["c_soil_min"] = moy["soil"].mean(axis=1), moy["soil"].min(axis=1)
    if "def" in moy:
        c["c_def"] = moy["def"].sum(axis=1)
    if "tmax" in moy:
        c["c_tmax"] = moy["tmax"].max(axis=1)
    if "aet" in moy:
        c["c_aet"] = moy["aet"].sum(axis=1)
    if "ws" in moy:
        c["c_ws"] = moy["ws"].mean(axis=1)
    if {"ppt", "aet", "def"} <= set(moy):
        pet = moy["aet"].sum(axis=1) + moy["def"].sum(axis=1)      # PET = AET + climatic water deficit
        c["c_aridite"] = moy["ppt"].sum(axis=1) / np.maximum(pet, 1e-6)
    return c.astype("f4"), annees


class Historique:
    """Arrays shared by every origin year: annual counts, FRP, monthly counts, neighbours, static covariates."""

    def __init__(self, F, C, cache=P.CACHE):
        self.C = C.reset_index(drop=True)
        self.cellules = self.C["cellule"].to_numpy("uint64")
        self.annees = np.arange(P.AN0, P.AN1 + 1)
        n, ny = len(self.cellules), len(self.annees)
        pos = pd.Series(np.arange(n), index=self.cellules)
        f = F[(F["an"] >= P.AN0) & (F["an"] <= P.AN1)]
        i, y, m = pos.reindex(f["cellule"]).to_numpy(), (f["an"] - P.AN0).to_numpy(), (f["mois"] - 1).to_numpy()
        self.M = np.zeros((n, ny, 12), "f4")
        np.add.at(self.M, (i, y, m), f["hotspots"].to_numpy("f4"))
        self.A = self.M.sum(axis=2).astype("f8")
        self.R = np.zeros((n, ny))
        np.add.at(self.R, (i, y), f["frp"].to_numpy("f8"))
        self.aire = self.C["aire_km2"].to_numpy("f8")
        self.lat = self.C["lat"].to_numpy("f8")
        self.dens = self.A / self.aire[:, None] * 1000 / 12
        self.fort = self.dens >= P.SEUIL_DENSITE
        self.L = np.log1p(self.A)
        self.W1, self.W2 = voisinage(self.cellules)
        self.clim, self.clim_annees = climat_normales(cache, self.cellules)
        st = os.path.join(cache, "statique.parquet")
        self.stat = (pd.read_parquet(st).set_index("h3").reindex(self.cellules) if os.path.exists(st) else pd.DataFrame(index=self.cellules))

    def vecteurs(self, o):
        """Feature table of origin year o (data of years <= o only)."""
        j = int(o - P.AN0)
        L, X = self.L[:, :j + 1], pd.DataFrame(index=self.cellules)
        der = lambda k: L[:, max(0, j + 1 - k):]
        X["f_l0"], X["f_l1"], X["f_l2"] = L[:, j], L[:, j - 1], L[:, j - 2]
        X["f_m3"], X["f_m5"], X["f_m10"], X["f_mall"] = der(3).mean(axis=1), der(5).mean(axis=1), der(10).mean(axis=1), L.mean(axis=1)
        d10 = der(10)
        X["f_sd"] = d10.std(axis=1)
        t = np.arange(d10.shape[1]) - (d10.shape[1] - 1) / 2
        X["f_pente"] = (d10 * t).sum(axis=1) / (t ** 2).sum()
        X["f_max"] = L.max(axis=1)
        fort = self.fort[:, :j + 1]
        X["f_freq"], X["f_freq5"] = fort.mean(axis=1), fort[:, max(0, j - 4):].mean(axis=1)
        a5, r5 = self.A[:, max(0, j - 4):j + 1].sum(axis=1), self.R[:, max(0, j - 4):j + 1].sum(axis=1)
        X["f_frp"] = np.log1p(np.divide(r5, a5, out=np.zeros_like(r5), where=a5 > 0))
        prof = self.M[:, :j + 1].sum(axis=1).astype("f8")
        tot = prof.sum(axis=1, keepdims=True)
        w = np.divide(prof, tot, out=np.zeros_like(prof), where=tot > 0)
        ang = 2 * np.pi * (np.arange(1, 13)[None, :] + np.where(self.lat[:, None] < 0, 6, 0) - 0.5) / 12
        X["f_saison_cos"], X["f_saison_sin"] = (w * np.cos(ang)).sum(axis=1), (w * np.sin(ang)).sum(axis=1)
        X["f_saison_long"] = (w >= 0.10).sum(axis=1)
        X["v_m3"], X["v2_m3"] = self.W1 @ X["f_m3"].to_numpy(), self.W2 @ X["f_m3"].to_numpy()
        X["v_freq"] = self.W1 @ X["f_freq"].to_numpy()
        for c in FAMILLES["climat"]:
            X[c] = self.clim[c].to_numpy() if c in self.clim else np.nan
        for c in FAMILLES["sol"]:
            X[c] = self.stat[c].to_numpy("f8") if c in self.stat else np.nan
        X["lat_abs"] = np.abs(self.lat)
        return X[TOUTES].astype("f4")

    def jeu(self, h, origines):
        """Stacked rows for the origins: features X, target counts y, high-activity flag z, plus keys (cell index, origin, target year)."""
        Xs, ys, zs, cle = [], [], [], []
        for o in origines:
            Xs.append(self.vecteurs(o))
            t = int(o + h - P.AN0)
            ys.append(self.A[:, t]); zs.append(self.fort[:, t])
            cle.append(pd.DataFrame({"i": np.arange(len(self.cellules)), "origine": o, "cible": o + h}))
        return pd.concat(Xs, ignore_index=True), np.concatenate(ys), np.concatenate(zs).astype(int), pd.concat(cle, ignore_index=True)
