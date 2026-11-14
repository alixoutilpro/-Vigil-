"""Pillars 2 & 5: sensor autodetection and input validation."""
from __future__ import annotations
import os
import pandas as pd
from . import config as C


class ValidationError(ValueError):
    pass


def detect_sensor(columns) -> str:
    cols = set(columns)
    if "bright_ti4" in cols:
        return "viirs"
    if "brightness" in cols:
        return "modis"
    raise ValidationError(C.ERRORS["unknown_sensor"])


def read_firms_csv(path: str, max_mb: float = C.MAX_UPLOAD_MB) -> tuple[pd.DataFrame, str]:
    if os.path.getsize(path) > max_mb * 1024 * 1024:
        raise ValidationError(C.ERRORS["too_large"].format(max_mb=max_mb))
    try:
        df = pd.read_csv(path, dtype={"acq_time": "string"})
    except Exception as e:  # noqa: BLE001
        raise ValidationError(C.ERRORS["not_csv"]) from e
    return validate(df)


def validate(df: pd.DataFrame) -> tuple[pd.DataFrame, str]:
    for col in C.REQUIRED_COLUMNS:
        if col not in df.columns:
            raise ValidationError(C.ERRORS["missing_column"].format(col=col))
    sensor = detect_sensor(df.columns)

    df = df.copy()
    df["acq_date"] = pd.to_datetime(df["acq_date"], errors="coerce")
    start = pd.Timestamp(C.SENSOR_START[sensor])
    bad = df["acq_date"].dropna()
    if ((bad < start) | (bad > pd.Timestamp.today())).any():
        raise ValidationError(C.ERRORS["bad_dates"].format(sensor=sensor, start=start.date()))

    lat, lon = df["latitude"], df["longitude"]
    if ((lat.abs() > 90) | (lon.abs() > 180)).any():
        raise ValidationError(C.ERRORS["bad_coords"])
    return df, sensor
