"""Pillar 4: 0.1 deg grid, daily fire_day, ISO-week aggregation."""
from __future__ import annotations
import numpy as np
import pandas as pd
from . import config as C


def add_cells(df: pd.DataFrame, cell_deg: float = C.CELL_DEG) -> pd.DataFrame:
    df = df.copy()
    df["ilat"] = np.floor(df["latitude"] / cell_deg).astype("int64")
    df["ilon"] = np.floor(df["longitude"] / cell_deg).astype("int64")
    return df


def cell_id(ilat, ilon):
    return pd.Series(ilat).astype(str) + "_" + pd.Series(ilon).astype(str)


def cell_centre(ilat, ilon, cell_deg: float = C.CELL_DEG):
    return (np.round((ilat + 0.5) * cell_deg, 6), np.round((ilon + 0.5) * cell_deg, 6))


def weekly_fire_days(df: pd.DataFrame, cell_deg: float = C.CELL_DEG) -> pd.DataFrame:
    """Per (cell, ISO year, ISO week): number of UTC dates with >=1 valid hotspot (0-7),
    plus hotspot_count and frp_sum as secondary metrics."""
    cols = ["ilat", "ilon", "iso_year", "iso_week", "fire_days", "hotspot_count", "frp_sum"]
    if df.empty:
        return pd.DataFrame(columns=cols)
    df = add_cells(df, cell_deg)
    daily = (
        df.groupby(["ilat", "ilon", "acq_date"])
        .agg(hotspot_count=("acq_date", "size"),
             frp_sum=("frp", "sum") if "frp" in df else ("acq_date", "size"))
        .reset_index()
    )
    iso = daily["acq_date"].dt.isocalendar()
    daily["iso_year"] = iso["year"].astype("int64")
    daily["iso_week"] = iso["week"].astype("int64")
    daily["fire_days"] = 1
    return (
        daily.groupby(["ilat", "ilon", "iso_year", "iso_week"])[
            ["fire_days", "hotspot_count", "frp_sum"]].sum().reset_index()
    )
