"""Static covariates per H3 res-4 cell: land cover (ESA WorldCover 2021 v200) and relief.

    python -m pipeline.tf.statique [--procs 8]

Land cover: Microsoft Planetary Computer data API, mosaic tiles of the `esa-worldcover` collection at zoom 6 (the
lowest zoom the API serves: 2.4 km pixels at the equator, nearest-neighbour samples of the 10 m map). Every second
pixel is used (~70 samples per res-4 cell at the equator, more toward the poles) -> share of each class per cell.
Relief: open "Terrain Tiles" on AWS (Mapzen terrarium encoding; SRTM, GMTED2010, ETOPO1), same tiles and pixels ->
mean elevation and standard deviation of elevation of the land pixels of the cell (ruggedness; water pixels excluded). The Copernicus DEM of the Planetary
Computer is only served from zoom 8 (~20,000 land tiles): too many requests for this study.
Output: <cache>/statique.parquet (h3, n_lc, lc_<class>..., n_alt, alt_moy, alt_sd).
"""
import argparse
import io
import json
import math
import os
import sys
import time
import urllib.request
from multiprocessing import Pool

import numpy as np
import pandas as pd

from . import parametres as P

PC = "https://planetarycomputer.microsoft.com/api/data/v1/mosaic"
TERRAIN = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
Z = 6
PAS = 2
CLASSES = {10: "arbres", 20: "arbustes", 30: "herbacees", 40: "cultures", 50: "bati", 60: "nu", 70: "neige", 80: "eau",
           90: "zones_humides", 95: "mangroves", 100: "mousses"}


def enregistrer_recherche():
    corps = json.dumps({"collections": ["esa-worldcover"], "filter-lang": "cql2-json",
                        "filter": {"op": "=", "args": [{"property": "esa_worldcover:product_version"}, "2.0.0"]}}).encode()
    for essai in range(6):          # the network can fail for a few seconds: retry
        try:
            r = urllib.request.Request(PC + "/register", data=corps, headers={"Content-Type": "application/json"})
            return json.load(urllib.request.urlopen(r, timeout=60))["searchid"]
        except Exception as e:
            err = e
            time.sleep(5 * (essai + 1))
    raise RuntimeError(f"Planetary Computer register: {err}")


def tuile_de(lat, lon, z=Z):
    n = 2 ** z
    x = int((lon + 180) / 360 * n) % n
    y = int((1 - math.asinh(math.tan(math.radians(max(-85.0, min(85.0, lat))))) / math.pi) / 2 * n)
    return x, min(n - 1, max(0, y))


def centres_pixels(x, y, z=Z, pas=PAS):
    """lat, lon of the centres of the sampled pixels of a 256-px Web-Mercator tile."""
    n = 2 ** z * 256
    px = np.arange(pas // 2, 256, pas)
    lon = (x * 256 + px + 0.5) / n * 360 - 180
    lat = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * (y * 256 + px + 0.5) / n))))
    return lat, lon, px


def _telecharger(url, essais=6):
    err = None
    for i in range(essais):
        try:
            return urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "vigil-tf/1.0"}), timeout=90).read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            err = e
        except Exception as e:
            err = e
        time.sleep(3 * (i + 1))
    raise RuntimeError(f"{url}: {err}")


def _une(args):
    x, y, recherche = args
    import h3
    from PIL import Image
    lat, lon, px = centres_pixels(x, y)
    cel = np.array([[h3.str_to_int(h3.latlng_to_cell(float(la), float(lo), P.RES)) for lo in lon] for la in lat], np.uint64).ravel()
    lignes, terre_px = [], None
    try:
        b = _telecharger(f"{PC}/{recherche}/tiles/WebMercatorQuad/{Z}/{x}/{y}@1x.npy?assets=map&collection=esa-worldcover")
        if b is not None:
            a = np.load(io.BytesIO(b))
            lc, ok = a[0][np.ix_(px, px)].ravel(), (a[-1][np.ix_(px, px)].ravel() > 0)
            terre_px = ok & (lc != 80)          # land pixels: the relief statistics ignore the sea floor
            d = pd.DataFrame({"h3": cel[ok], "lc": lc[ok]})
            d = d[d["lc"].isin(list(CLASSES))]
            lignes.append(d.groupby(["h3", "lc"]).size().rename("n").reset_index().assign(type="lc"))
        b = _telecharger(TERRAIN.format(z=Z, x=x, y=y))
        if b is not None:
            im = np.asarray(Image.open(io.BytesIO(b)).convert("RGB"), dtype="f8")[np.ix_(px, px)].reshape(-1, 3)
            alt = im[:, 0] * 256 + im[:, 1] + im[:, 2] / 256 - 32768
            garde = terre_px if terre_px is not None else alt >= 0
            d = pd.DataFrame({"h3": cel[garde], "alt": alt[garde]}).groupby("h3")["alt"].agg(n="size", s="sum", s2=lambda v: float((v ** 2).sum())).reset_index()
            lignes.append(d.assign(type="alt"))
    except Exception as e:
        return x, y, None, str(e)
    return x, y, lignes, ""


def main(argv=None):
    ap = argparse.ArgumentParser(description="Vigil T&F - covariables statiques par cellule H3")
    ap.add_argument("--cache", default=P.CACHE)
    ap.add_argument("--procs", type=int, default=8)
    a = ap.parse_args(argv)
    import h3
    C = pd.read_parquet(os.path.join(a.cache, "cellules.parquet"), columns=["cellule"])   # python -m pipeline.tf.table
    cellules = C["cellule"].to_numpy("uint64")
    terre = set(cellules.tolist())
    tuiles = set()
    for c in cellules:
        if int(c) not in terre:
            continue
        for la, lo in h3.cell_to_boundary(h3.int_to_str(int(c))) + (h3.cell_to_latlng(h3.int_to_str(int(c))),):
            if abs(la) < 85:
                tuiles.add(tuile_de(la, lo))
    recherche = enregistrer_recherche()
    print(f"{len(terre)} cellules terrestres, {len(tuiles)} tuiles z{Z}, recherche {recherche}", flush=True)
    lc, alt, echecs, t0 = [], [], [], time.time()
    with Pool(a.procs) as pool:
        for i, (x, y, lignes, err) in enumerate(pool.imap_unordered(_une, [(x, y, recherche) for x, y in sorted(tuiles)]), 1):
            if lignes is None:
                echecs.append((x, y, err))
            else:
                for d in lignes:
                    (lc if d["type"].iloc[0] == "lc" else alt).append(d) if len(d) else None
            if i % 100 == 0:
                print(f"[{i}/{len(tuiles)}] {time.time() - t0:.0f} s, echecs {len(echecs)}", flush=True)
    L = pd.concat(lc).groupby(["h3", "lc"])["n"].sum().unstack(fill_value=0)
    L.columns = [f"lc_{CLASSES[int(c)]}" for c in L.columns]
    n = L.sum(axis=1)
    L = L.div(n, axis=0).astype("f4").assign(n_lc=n.astype("int32"))
    A = pd.concat(alt).groupby("h3")[["n", "s", "s2"]].sum()
    A["alt_moy"] = (A["s"] / A["n"]).astype("f4")
    A["alt_sd"] = np.sqrt(np.maximum(A["s2"] / A["n"] - (A["s"] / A["n"]) ** 2, 0)).astype("f4")
    out = L.join(A[["alt_moy", "alt_sd"]].assign(n_alt=A["n"].astype("int32")), how="outer").reset_index()
    out.to_parquet(os.path.join(a.cache, "statique.parquet"), index=False)
    print(f"statique.parquet : {len(out)} cellules ; echecs : {len(echecs)} {echecs[:5]} ; {time.time() - t0:.0f} s")


if __name__ == "__main__":
    sys.exit(main())
