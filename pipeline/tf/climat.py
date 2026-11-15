"""TerraClimate (Abatzoglou et al. 2018) -> H3 res-4 cell x month.

    python -m pipeline.tf.climat --source pc --annees 2010,2018,2002,2014,2006      # Planetary Computer mirror (1958-2021)
    python -m pipeline.tf.climat --source thredds                                    # primary server (2000-2025)

One parquet per variable and year in <cache>/terraclimate/ (columns h3, m01..m12 = mean of the sampled 4-km pixels of
the cell). Resumable: existing files are skipped.
- pc: Zarr store of the Microsoft Planetary Computer (`terraclimate` collection, chunks 12 months x 1024 x 1024,
  blosc-lz4), read chunk by chunk over HTTPS with a public SAS token; 1 pixel out of 2 (~8 km, ~25 samples per cell).
  A year of one variable is ~0.3 GB to download, so only the years asked for are read.
- thredds: OPeNDAP server of the Climatology Lab with a regular 0.25-degree subsample (25 MB per variable-year).
  It stopped answering during the study (15 Nov 2026), hence the Planetary Computer route.
"""
import argparse
import os
import sys
import time
from multiprocessing import Pool

import numpy as np
import pandas as pd

from . import parametres as P


def grille_h3(lat, lon, res=P.RES, cache=None):
    """H3 cell (uint64) of every point of the regular grid lat x lon."""
    if cache and os.path.exists(cache):
        return np.load(cache)
    import h3
    out = np.empty((len(lat), len(lon)), np.uint64)
    for i, la in enumerate(lat):
        out[i] = [h3.str_to_int(h3.latlng_to_cell(float(la), float(lo), res)) for lo in lon]
    if cache:
        np.save(cache, out)
    return out


def moyenne_par_cellule(valeurs, cellules):
    """valeurs: masked array (12, nlat, nlon); cellules: (nlat, nlon) uint64 -> DataFrame h3, m01..m12 (NaN = no land sample)."""
    ids, inv = np.unique(cellules.ravel(), return_inverse=True)
    out = {"h3": ids}
    for m in range(valeurs.shape[0]):
        v = np.ma.filled(valeurs[m].astype("f8"), np.nan).ravel()
        ok = ~np.isnan(v)
        s = np.bincount(inv[ok], weights=v[ok], minlength=len(ids))
        n = np.bincount(inv[ok], minlength=len(ids))
        out[f"m{m + 1:02d}"] = np.where(n > 0, s / np.maximum(n, 1), np.nan).astype("f4")
    d = pd.DataFrame(out)
    return d[d.drop(columns="h3").notna().any(axis=1)].reset_index(drop=True)


def _un(args):
    var, an, dossier = args
    ch = os.path.join(dossier, f"{var}_{an}.parquet")
    if os.path.exists(ch):
        return var, an, 0.0, "deja fait"
    import netCDF4
    t0 = time.time()
    for essai in range(8):
        try:
            ds = netCDF4.Dataset(P.TC_URL.format(var=var, an=an))
            v = ds.variables[var]
            lat, lon = ds.variables["lat"][:], ds.variables["lon"][:]
            o = P.TC_PAS // 2
            a = v[:, o::P.TC_PAS, o::P.TC_PAS]      # netCDF4 applies scale_factor / _FillValue
            ds.close()
            break
        except Exception as e:  # network hiccup: retry
            err = e
            time.sleep(5 * (essai + 1))
    else:
        return var, an, time.time() - t0, f"ECHEC {err}"
    cel = grille_h3(lat[o::P.TC_PAS], lon[o::P.TC_PAS], cache=os.path.join(dossier, f"_grille_h3_res{P.RES}_pas{P.TC_PAS}.npy"))
    d = moyenne_par_cellule(a, cel)
    d.to_parquet(ch + ".tmp", index=False)
    os.replace(ch + ".tmp", ch)
    return var, an, time.time() - t0, f"{len(d)} cellules"


PC_ZARR = "https://cpdataeuwest.blob.core.windows.net/cpdata/terraclimate.zarr"
PC_JETON = "https://planetarycomputer.microsoft.com/api/sas/v1/token/terraclimate"
PC_BLOC, PC_PAS, PC_AN0 = 1024, 2, 1958
NOM_PC = {"PDSI": "pdsi"}        # variable names differ between the two servers


def _http(url, essais=8, delai=120):
    import urllib.request
    err = None
    for i in range(essais):
        try:
            return urllib.request.urlopen(url, timeout=delai).read()
        except Exception as e:  # network hiccup: retry
            err = e
            time.sleep(4 * (i + 1))
    raise RuntimeError(f"{url.split('?')[0]}: {err}")


def blocs_pc(cellules, dossier):
    """For each Zarr chunk (iy, ix) that holds study cells: index of the cell of every sampled pixel (-1 = outside)."""
    ch = os.path.join(dossier, f"_blocs_pc_res{P.RES}_pas{PC_PAS}.npz")
    if os.path.exists(ch):
        z = np.load(ch)
        return {tuple(int(v) for v in k.split("_")): z[k] for k in z.files}
    import h3
    pos = {int(c): i for i, c in enumerate(cellules)}
    lat = 90 - (np.arange(4320) + 0.5) / 24
    lon = -180 + (np.arange(8640) + 0.5) / 24
    out = {}
    for iy in range(5):
        for ix in range(9):
            la = lat[iy * PC_BLOC:(iy + 1) * PC_BLOC:PC_PAS]
            lo = lon[ix * PC_BLOC:(ix + 1) * PC_BLOC:PC_PAS]
            idx = np.array([[pos.get(h3.str_to_int(h3.latlng_to_cell(float(a_), float(o_), P.RES)), -1) for o_ in lo] for a_ in la], np.int32)
            if (idx >= 0).any():
                out[(iy, ix)] = idx
    np.savez_compressed(ch, **{f"{k[0]}_{k[1]}": v for k, v in out.items()})
    return out


def lire_pc(var, an, blocs, n_cellules, jeton, fils=8):
    """Sum and count per cell and month of one variable-year, from the Zarr chunks of the Planetary Computer."""
    from concurrent.futures import ThreadPoolExecutor
    from numcodecs import Blosc
    nom, t = NOM_PC.get(var, var), an - PC_AN0
    dtype = "<f8" if var == "ppt" else "<f4"
    s, n = np.zeros((12, n_cellules)), np.zeros((12, n_cellules))

    def un(cle):
        iy, ix = cle
        a = np.frombuffer(Blosc().decode(_http(f"{PC_ZARR}/{nom}/{t}.{iy}.{ix}?{jeton}")), dtype).reshape(12, PC_BLOC, PC_BLOC)
        idx = blocs[cle]
        v = a[:, :idx.shape[0] * PC_PAS:PC_PAS, :idx.shape[1] * PC_PAS:PC_PAS].reshape(12, -1).astype("f8")
        ok = idx.ravel() >= 0
        j = idx.ravel()[ok]
        ss, nn = np.zeros((12, n_cellules)), np.zeros((12, n_cellules))
        for m in range(12):
            x = v[m][ok]
            b = ~np.isnan(x)
            ss[m] = np.bincount(j[b], weights=x[b], minlength=n_cellules)
            nn[m] = np.bincount(j[b], minlength=n_cellules)
        return ss, nn

    with ThreadPoolExecutor(fils) as ex:
        for ss, nn in ex.map(un, sorted(blocs)):
            s += ss
            n += nn
    return s, n


def source_pc(a, dossier):
    import json
    cellules = pd.read_parquet(os.path.join(a.cache, "cellules.parquet"), columns=["cellule"])["cellule"].to_numpy("uint64")
    blocs = blocs_pc(cellules, dossier)
    print(f"{len(cellules)} cellules, {len(blocs)} blocs Zarr utiles sur 45", flush=True)
    t0 = time.time()
    taches = [(v, y) for y in a.annees for v in P.TC_VARS]
    for i, (v, y) in enumerate(taches, 1):
        ch = os.path.join(dossier, f"{v}_{y}.parquet")
        if os.path.exists(ch):
            print(f"[{i}/{len(taches)}] {v} {y}: deja fait", flush=True)
            continue
        jeton = json.loads(_http(PC_JETON))["token"]       # short-lived public token, renewed for each file
        s, n = lire_pc(v, y, blocs, len(cellules), jeton, a.procs)
        d = pd.DataFrame({"h3": cellules, **{f"m{m + 1:02d}": np.where(n[m] > 0, s[m] / np.maximum(n[m], 1), np.nan).astype("f4") for m in range(12)}})
        d = d[d.drop(columns="h3").notna().any(axis=1)]
        d.to_parquet(ch + ".tmp", index=False)
        os.replace(ch + ".tmp", ch)
        print(f"[{i}/{len(taches)}] {v} {y}: {len(d)} cellules, {int(np.median(n[0][n[0] > 0]))} pixels/cellule (mediane), total {time.time() - t0:.0f} s", flush=True)
    print("TerraClimate (Planetary Computer) termine ->", dossier)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Vigil T&F - TerraClimate par cellule H3")
    ap.add_argument("--cache", default=P.CACHE)
    ap.add_argument("--procs", type=int, default=4)
    ap.add_argument("--source", choices=["pc", "thredds"], default="pc")
    ap.add_argument("--annees", type=lambda t: [int(x) for x in t.split(",")], default=P.TC_ANNEES_NORMALE)
    a = ap.parse_args(argv)
    dossier = os.path.join(a.cache, "terraclimate")
    os.makedirs(dossier, exist_ok=True)
    if a.source == "pc":
        return source_pc(a, dossier)
    # the grid -> cell table is computed once, before the workers start
    import netCDF4
    o = P.TC_PAS // 2
    for essai in range(10):          # the network can fail for a few seconds: retry
        try:
            ds = netCDF4.Dataset(P.TC_URL.format(var=P.TC_VARS[0], an=P.TC_AN1))
            lat, lon = ds.variables["lat"][:][o::P.TC_PAS], ds.variables["lon"][:][o::P.TC_PAS]
            ds.close()
            break
        except Exception as e:
            print("connexion TerraClimate :", e, flush=True)
            time.sleep(10)
    else:
        raise SystemExit("TerraClimate inaccessible")
    grille_h3(lat, lon, cache=os.path.join(dossier, f"_grille_h3_res{P.RES}_pas{P.TC_PAS}.npy"))
    taches = [(v, y, dossier) for y in range(P.TC_AN1, P.TC_AN0 - 1, -1) for v in P.TC_VARS]
    t0 = time.time()
    with Pool(a.procs) as pool:
        for i, (v, y, dt, msg) in enumerate(pool.imap_unordered(_un, taches), 1):
            print(f"[{i}/{len(taches)}] {v} {y}: {msg} ({dt:.0f} s, total {time.time() - t0:.0f} s)", flush=True)
    print("TerraClimate termine ->", dossier)


if __name__ == "__main__":
    sys.exit(main())
