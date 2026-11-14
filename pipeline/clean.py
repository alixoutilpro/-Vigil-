"""Pillar 3: cleaning rules."""
from __future__ import annotations
import pandas as pd
from . import config as C


def map_confidence(df: pd.DataFrame, sensor: str) -> pd.DataFrame:
    df = df.copy()
    df["confidence_raw"] = df["confidence"]
    if sensor == "modis":
        v = pd.to_numeric(df["confidence"], errors="coerce")
        df["confidence"] = pd.cut(
            v, bins=[-1, 29, 79, 100], labels=["low", "nominal", "high"]
        ).astype("object")
    else:  # viirs: letters l/n/h (or words) -- verify_on_saturday
        df["confidence"] = (
            df["confidence"].astype("string").str.strip().str.lower().map(C.VIIRS_CONF_MAP)
        )
    return df


def clean(
    df: pd.DataFrame,
    sensor: str,
    *,
    polygon=None,                 # shapely geometry (lon, lat) or None = no area filter
    keep_confidence=C.KEEP_CONFIDENCE,
    include_night: bool = True,
    include_static: bool = False,
    restrict_satellite: bool = True,
) -> pd.DataFrame:
    df = df.dropna(subset=["latitude", "longitude", "acq_date"])
    df = df.drop_duplicates()
    df = map_confidence(df, sensor)
    df = df[df["confidence"].isin(keep_confidence)]

    if "type" in df.columns and not include_static:
        df = df[df["type"] == 0]
    if not include_night and "daynight" in df.columns:
        df = df[df["daynight"] == "D"]
    if restrict_satellite and "satellite" in df.columns:
        df = df[df["satellite"].astype(str).isin(C.KEEP_SATELLITES[sensor])]

    if polygon is not None and len(df):
        from shapely import contains_xy
        df = df[contains_xy(polygon, df["longitude"].to_numpy(), df["latitude"].to_numpy())]
    return df.reset_index(drop=True)
