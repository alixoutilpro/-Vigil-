"""Pillar 6: MODIS-equivalent harmonization with uncertainty.

Method: on cell-weeks where both sensors operated, fit modis ~ k * viirs
(least squares through origin) per land-cover class. Uncertainty band =
empirical 10th/90th percentile of residual ratio (modis - k*viirs) per class.
Where MODIS is observed it is kept as-is (band collapses to the observation).
"""
from __future__ import annotations
import numpy as np
import pandas as pd
from . import config as C
from .grid import cell_id, cell_centre

KEYS = ["ilat", "ilon", "iso_year", "iso_week"]


def calibrate(both: pd.DataFrame) -> dict[str, dict]:
    """both: rows with modis_fire_days & viirs_fire_days both observed."""
    params: dict[str, dict] = {}
    pooled = _fit(both)
    for cls in C.LAND_COVER_CLASSES:
        sub = both[both["land_cover_class"] == cls]
        params[cls] = _fit(sub) if len(sub) >= 30 else pooled
    return params


def _fit(d: pd.DataFrame) -> dict:
    d = d[(d["viirs_fire_days"] > 0) | (d["modis_fire_days"] > 0)]
    v, m = d["viirs_fire_days"].to_numpy(float), d["modis_fire_days"].to_numpy(float)
    if len(d) == 0 or (v @ v) == 0:
        return {"k": 1.0, "lo": 0.0, "hi": 0.0, "n": 0}
    k = float(v @ m / (v @ v))
    res = m - k * v
    return {"k": k, "lo": float(np.percentile(res, 10)), "hi": float(np.percentile(res, 90)), "n": int(len(d))}


def harmonize(modis_w: pd.DataFrame | None, viirs_w: pd.DataFrame | None,
              land_cover: pd.DataFrame | None = None) -> tuple[pd.DataFrame, dict]:
    modis_w = modis_w if modis_w is not None else pd.DataFrame(columns=KEYS + ["fire_days"])
    viirs_w = viirs_w if viirs_w is not None else pd.DataFrame(columns=KEYS + ["fire_days"])
    m_years, v_years = set(modis_w["iso_year"]), set(viirs_w["iso_year"])

    df = modis_w[KEYS + ["fire_days"]].rename(columns={"fire_days": "modis_fire_days"}).merge(
        viirs_w[KEYS + ["fire_days"]].rename(columns={"fire_days": "viirs_fire_days"}),
        on=KEYS, how="outer")
    # Absence of a detection = 0 in years the sensor was loaded; null otherwise.
    for col, years in (("modis_fire_days", m_years), ("viirs_fire_days", v_years)):
        in_period = df["iso_year"].isin(years)
        df[col] = df[col].where(~in_period | df[col].notna(), 0)

    df["cell_id"] = cell_id(df["ilat"], df["ilon"]).values
    df["lat"], df["lon"] = cell_centre(df["ilat"], df["ilon"])
    lc = land_cover if land_cover is not None else pd.DataFrame(columns=["cell_id", "land_cover_class"])
    df = df.merge(lc, on="cell_id", how="left")
    df["land_cover_class"] = df["land_cover_class"].fillna("other")

    both = df.dropna(subset=["modis_fire_days", "viirs_fire_days"])
    params = calibrate(both) if len(both) else {c: {"k": 1.0, "lo": 0.0, "hi": 0.0, "n": 0}
                                                for c in C.LAND_COVER_CLASSES}
    k = df["land_cover_class"].map(lambda c: params[c]["k"])
    lo = df["land_cover_class"].map(lambda c: params[c]["lo"])
    hi = df["land_cover_class"].map(lambda c: params[c]["hi"])

    has_m, has_v = df["modis_fire_days"].notna(), df["viirs_fire_days"].notna()
    conv = (k * df["viirs_fire_days"].fillna(0))
    df["harmonized_fire_days"] = np.where(has_m, df["modis_fire_days"], conv)
    low = np.where(has_m, df["modis_fire_days"], conv + lo)
    high = np.where(has_m, df["modis_fire_days"], conv + hi)
    est = np.clip(df["harmonized_fire_days"], 0, 7)
    df["harmonized_fire_days"] = est
    # band must bracket the estimate
    df["harmonized_low"] = np.minimum(np.clip(low, 0, 7), est)
    df["harmonized_high"] = np.maximum(np.clip(high, 0, 7), est)
    df["source"] = np.select([has_m & has_v, has_m], ["both", "modis_only"], "viirs_converted")

    for c in ("modis_fire_days", "viirs_fire_days"):
        df[c] = df[c].astype("Int64")
    out = df[C.OUTPUT_COLUMNS].sort_values(["cell_id", "iso_year", "iso_week"]).reset_index(drop=True)
    return out, params
