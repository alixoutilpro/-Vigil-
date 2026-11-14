"""Regenerate data/data.json: SIMULATED weekly fire-days with realistic climatology.

This is NOT FIRMS data. The raw FIRMS files are not in the repo (data/raw is empty, the real
pipeline reads them from a private folder). This script writes a file that follows the frozen
pillar 6 contract (pipeline/config.py OUTPUT_COLUMNS) for the same 25 cells as before, with:
  - the real fire season of each site (peak week, width, off-season floor),
  - year-to-year variability and the documented bad years (e.g. Portugal 2017, Greece 2021,
    Australia 2019-20, Borneo 2015, Amazon 2019-20, California 2018/2020),
  - bursty weeks (fires persist from one week to the next),
  - VIIRS (375 m) detecting more fire-days than MODIS (1 km), more so on small agricultural fires,
  - the harmonization of pipeline/harmonize.py (k through the origin per land cover class,
    10th/90th percentile residual band), applied where MODIS is missing.

Run from the repo root:  python3 data/generer_data.py
Deterministic (fixed seed). Pure standard library.
"""
from __future__ import annotations

import datetime as dt
import json
import math
import os
import random

SEED = 20261114
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "data.json")

FIRST = (2003, 1)        # first ISO week written (MODIS Terra+Aqua era)
LAST = (2026, 43)        # last ISO week written (end of Oct 2026)
VIIRS_START = (2012, 4)  # S-NPP in FIRMS from 20 Jan 2012
MODIS_OUTAGE_P = 0.02    # weeks where MODIS has no usable data (VIIRS converted instead)

# Detection ratio VIIRS/MODIS in fire-days: 375 m pixels catch many more small fires.
VIIRS_RATIO = {"forest": 1.35, "shrub_grass": 1.5, "cropland": 2.0, "other": 1.4}

# name, lat, lon, land cover, peak ISO week, season sigma (weeks), off-season floor,
# latent activity at the peak, bad years: (year, from_week, to_week, multiplier)
SITES = [
    ("Araucania, Chile", -38.65, -72.45, "shrub_grass", 6, 5.0, 0.01, 1.6,
     [(2017, 1, 10, 3.2), (2023, 4, 12, 2.6), (2024, 4, 10, 1.8)]),
    ("Victoria, Australia", -36.65, 144.75, "forest", 4, 5.0, 0.01, 1.1,
     [(2006, 50, 53, 2.2), (2007, 1, 8, 2.4), (2009, 4, 9, 3.4), (2013, 1, 6, 1.8), (2019, 50, 53, 2.8), (2020, 1, 8, 3.6)]),
    ("Buenos Aires, Argentina", -34.75, -58.05, "cropland", 34, 5.0, 0.04, 0.55,
     [(2008, 28, 40, 1.7), (2020, 28, 40, 1.5)]),
    ("Parana delta, Argentina", -33.15, -60.45, "forest", 35, 6.0, 0.03, 1.1,
     [(2008, 14, 40, 2.2), (2020, 22, 42, 3.0), (2022, 14, 34, 2.0)]),
    ("Blue Mountains, Australia", -33.15, 150.55, "other", 46, 6.0, 0.015, 0.9,
     [(2006, 46, 53, 1.8), (2013, 41, 46, 2.6), (2019, 42, 53, 3.4), (2020, 1, 6, 3.2)]),
    ("Northern Territory, Australia", -19.75, 129.65, "forest", 33, 7.0, 0.015, 2.7,
     [(2011, 28, 44, 1.4), (2012, 30, 46, 1.4), (2019, 30, 46, 1.3)]),
    ("Mato Grosso, Brazil", -15.85, -55.95, "forest", 37, 4.5, 0.02, 3.3,
     [(2005, 30, 42, 1.3), (2007, 30, 42, 1.5), (2010, 30, 42, 1.6), (2019, 30, 42, 1.3), (2020, 30, 42, 1.4), (2024, 28, 42, 1.7)]),
    ("Zambia", -12.55, 28.05, "forest", 33, 6.5, 0.02, 3.4, []),
    ("Rondonia, Brazil", -9.85, -63.25, "cropland", 36, 4.0, 0.02, 3.0,
     [(2005, 30, 42, 1.7), (2007, 30, 42, 1.2), (2010, 30, 42, 1.8), (2019, 30, 42, 1.3), (2024, 28, 42, 1.8)]),
    ("Kenya rift", -1.05, 35.35, "cropland", 6, 6.0, 0.10, 0.45,
     [(2009, 1, 14, 1.8), (2017, 1, 14, 1.6), (2022, 1, 14, 1.5)]),
    ("Borneo, Indonesia", 0.85, 114.25, "other", 37, 3.5, 0.015, 1.5,
     [(2006, 33, 44, 3.4), (2009, 33, 44, 1.8), (2015, 33, 46, 4.2), (2019, 33, 44, 2.6), (2023, 35, 46, 2.4)]),
    ("Cote d'Ivoire", 5.35, -5.15, "shrub_grass", 5, 5.0, 0.01, 3.4, []),
    ("Central African Republic / Chad", 8.15, 19.65, "forest", 52, 6.0, 0.01, 3.9, []),
    ("Burkina Faso", 11.95, -1.65, "cropland", 51, 5.0, 0.01, 3.1, []),
    ("Northern Laos / Thailand", 20.75, 101.05, "forest", 11, 3.5, 0.01, 3.2,
     [(2007, 8, 16, 1.4), (2015, 8, 16, 1.3), (2019, 8, 17, 1.5), (2023, 8, 16, 1.4)]),
    ("Arizona / Sonora", 31.45, -109.95, "other", 24, 4.0, 0.02, 0.5,
     [(2011, 20, 28, 2.8), (2012, 22, 28, 1.8), (2020, 22, 30, 1.9)]),
    ("Southern California", 33.95, -117.55, "other", 41, 8.0, 0.04, 0.55,
     [(2003, 41, 45, 4.2), (2007, 41, 45, 3.6), (2008, 44, 48, 2.4), (2016, 31, 38, 2.0),
      (2017, 49, 53, 3.0), (2018, 44, 48, 2.2), (2020, 34, 40, 2.8)]),
    ("Tunisia", 36.85, 9.95, "cropland", 30, 3.5, 0.02, 0.6,
     [(2017, 26, 34, 1.6), (2021, 26, 34, 1.7), (2022, 26, 34, 1.8), (2023, 27, 34, 2.4)]),
    ("Attica / Peloponnese, Greece", 37.85, 23.65, "cropland", 31, 3.0, 0.015, 0.7,
     [(2007, 33, 36, 4.0), (2012, 28, 35, 1.8), (2018, 28, 31, 2.8), (2021, 30, 34, 4.0), (2023, 28, 32, 3.0)]),
    ("Alentejo, Portugal", 38.35, -8.35, "forest", 32, 4.0, 0.01, 0.85,
     [(2003, 30, 36, 3.2), (2005, 28, 36, 3.0), (2012, 28, 36, 1.9), (2017, 27, 43, 2.8), (2022, 27, 35, 2.3)]),
    ("Sacramento Valley, USA", 38.65, -121.55, "other", 31, 6.0, 0.03, 0.8,
     [(2008, 24, 30, 2.5), (2018, 28, 34, 2.6), (2020, 33, 40, 3.2), (2021, 28, 40, 2.6)]),
    ("Calabria, Italy", 38.85, 15.95, "forest", 31, 3.5, 0.01, 0.8,
     [(2007, 28, 34, 3.0), (2012, 28, 34, 1.8), (2017, 30, 36, 2.6), (2021, 30, 34, 3.4), (2023, 28, 32, 2.0)]),
    ("Castilla, Spain", 40.65, -3.85, "shrub_grass", 31, 3.5, 0.02, 0.9,
     [(2012, 27, 35, 2.6), (2015, 27, 35, 1.7), (2022, 27, 33, 3.0)]),
    ("Yellowstone, USA", 43.95, -110.45, "forest", 33, 3.5, 0.005, 0.5,
     [(2003, 30, 36, 1.6), (2006, 30, 38, 1.8), (2012, 30, 38, 2.6), (2016, 32, 40, 3.4), (2021, 30, 38, 2.2)]),
    ("Okanagan, Canada", 49.85, -119.95, "shrub_grass", 32, 3.5, 0.005, 0.55,
     [(2003, 31, 36, 3.6), (2009, 29, 34, 1.8), (2015, 29, 36, 2.2), (2017, 28, 36, 2.8),
      (2018, 30, 37, 3.0), (2021, 26, 36, 3.2), (2023, 31, 38, 3.2)]),
]


def cell_id(lat: float, lon: float) -> str:
    return f"{math.floor(lat * 10 + 1e-9)}_{math.floor(lon * 10 + 1e-9)}"


def iso_weeks(first, last):
    d = dt.date.fromisocalendar(first[0], first[1], 1)
    end = dt.date.fromisocalendar(last[0], last[1], 1)
    while d <= end:
        y, w, _ = d.isocalendar()
        yield y, w
        d += dt.timedelta(days=7)


def season(week: int, peak: float, sigma: float, floor: float) -> float:
    d = abs(week - peak)
    d = min(d, 52 - d)
    return floor + (1 - floor) * math.exp(-0.5 * (d / sigma) ** 2)


def binom(rng: random.Random, n: int, p: float) -> int:
    return sum(rng.random() < p for _ in range(n))


def percentile(xs: list[float], q: float) -> float:
    xs = sorted(xs)
    if not xs:
        return 0.0
    pos = (len(xs) - 1) * q / 100
    lo, hi = math.floor(pos), math.ceil(pos)
    return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo)


def simulate(rng: random.Random) -> list[dict]:
    rows: list[dict] = []
    for _name, lat, lon, lc, peak, sigma, floor, lam, bad in SITES:
        cid = cell_id(lat, lon)
        # Persistent latent activity (AR(1) in log space) + a yearly severity factor.
        year_factor = {y: math.exp(rng.gauss(0, 0.30)) for y in range(FIRST[0], LAST[0] + 1)}
        z = 0.0
        ratio = VIIRS_RATIO[lc] * math.exp(rng.gauss(0, 0.05))
        cell_rows: list[dict] = []
        for y, w in iso_weeks(FIRST, LAST):
            z = 0.62 * z + math.sqrt(1 - 0.62 ** 2) * rng.gauss(0, 0.55)
            mult = 1.0
            for by, w0, w1, m in bad:
                if by == y and w0 <= w <= w1:
                    mult = max(mult, m)
            a = lam * season(w, peak, sigma, floor) * year_factor[y] * mult * math.exp(z)
            has_v = (y, w) >= VIIRS_START
            modis = binom(rng, 7, min(1 - math.exp(-a / 3.2), 0.985))
            viirs = binom(rng, 7, min(1 - math.exp(-a * ratio / 3.2), 0.99)) if has_v else None
            modis_out = has_v and rng.random() < MODIS_OUTAGE_P
            cell_rows.append({
                "cell_id": cid, "lat": lat, "lon": lon, "iso_year": y, "iso_week": w,
                "modis_fire_days": None if modis_out else modis, "viirs_fire_days": viirs,
                "land_cover_class": lc,
            })
        # Keep the weeks with a detection, plus the first and last week so the observed period is
        # explicit (a missing row means "no fire-day"; a boundary row of 0 fixes the coverage).
        keep = [r for r in cell_rows if (r["modis_fire_days"] or 0) > 0 or (r["viirs_fire_days"] or 0) > 0]
        for edge in (cell_rows[0], cell_rows[-1]):
            if edge not in keep:
                keep.append(edge)
        rows.extend(keep)
    return rows


def harmonize(rows: list[dict]):
    """Same estimator as pipeline/harmonize.py: k through the origin per land cover, 10/90 residuals."""

    def pairs_of(sub):
        return [(r["viirs_fire_days"], r["modis_fire_days"]) for r in sub
                if r["modis_fire_days"] is not None and r["viirs_fire_days"] is not None
                and (r["modis_fire_days"] > 0 or r["viirs_fire_days"] > 0)]

    def fit(pairs):
        vv = sum(v * v for v, _ in pairs)
        if not pairs or vv == 0:
            return {"k": 1.0, "lo": 0.0, "hi": 0.0}
        k = sum(v * m for v, m in pairs) / vv
        res = [m - k * v for v, m in pairs]
        return {"k": k, "lo": percentile(res, 10), "hi": percentile(res, 90)}

    pooled = fit(pairs_of(rows))
    params = {}
    for lc in VIIRS_RATIO:
        pr = pairs_of([r for r in rows if r["land_cover_class"] == lc])
        params[lc] = fit(pr) if len(pr) >= 30 else pooled

    out = []
    for r in rows:
        p = params[r["land_cover_class"]]
        has_m, has_v = r["modis_fire_days"] is not None, r["viirs_fire_days"] is not None
        conv = p["k"] * (r["viirs_fire_days"] or 0)
        est = float(r["modis_fire_days"]) if has_m else conv
        low = float(r["modis_fire_days"]) if has_m else conv + p["lo"]
        high = float(r["modis_fire_days"]) if has_m else conv + p["hi"]
        est = min(max(est, 0.0), 7.0)
        low = min(min(max(low, 0.0), 7.0), est)
        high = max(min(max(high, 0.0), 7.0), est)
        out.append({
            "cell_id": r["cell_id"], "lat": r["lat"], "lon": r["lon"],
            "iso_year": r["iso_year"], "iso_week": r["iso_week"],
            "modis_fire_days": r["modis_fire_days"], "viirs_fire_days": r["viirs_fire_days"],
            "harmonized_fire_days": round(est, 2), "harmonized_low": round(low, 2),
            "harmonized_high": round(high, 2),
            "land_cover_class": r["land_cover_class"],
            "source": "both" if has_m and has_v else "modis_only" if has_m else "viirs_converted",
        })
    out.sort(key=lambda r: (r["cell_id"], r["iso_year"], r["iso_week"]))
    return out, params


def main() -> None:
    rng = random.Random(SEED)
    out, params = harmonize(simulate(rng))
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"), allow_nan=False)
    print(f"{len(out)} rows, {len({r['cell_id'] for r in out})} cells -> {OUT}")
    print("k per land cover:", {k: round(v["k"], 3) for k, v in params.items()})


if __name__ == "__main__":
    main()
