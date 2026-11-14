"""Land-cover lookup per cell. Real source (Corine / WorldCover) plugs in here.

Accepts a CSV with columns cell_id,land_cover_class (pre-aggregated to the grid).
Without it everything is 'other' so the pipeline still runs.
"""
from __future__ import annotations
import pandas as pd
from . import config as C


def load_land_cover(path: str | None) -> pd.DataFrame:
    if not path:
        return pd.DataFrame(columns=["cell_id", "land_cover_class"])
    lc = pd.read_csv(path)
    bad = set(lc["land_cover_class"]) - set(C.LAND_COVER_CLASSES)
    if bad:
        raise ValueError(f"Unknown land_cover_class values: {bad}")
    return lc[["cell_id", "land_cover_class"]].drop_duplicates("cell_id")
