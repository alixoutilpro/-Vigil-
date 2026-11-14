"""CLI: python -m pipeline.run [--area-geojson f.json] [--land-cover lc.csv]"""
from __future__ import annotations
import argparse, glob, json, os
import pandas as pd
from .schema import read_firms_csv
from .clean import clean
from .grid import weekly_fire_days
from .landcover import load_land_cover
from .harmonize import harmonize


def load_sensor(folder: str, polygon, **kw) -> pd.DataFrame | None:
    parts = []
    for f in sorted(glob.glob(os.path.join(folder, "*.csv"))):
        # Yearly country files can exceed the upload cap; only enforce it for user uploads.
        df, sensor = read_firms_csv(f, max_mb=10_000)
        parts.append(weekly_fire_days(clean(df, sensor, polygon=polygon, **kw)))
    if not parts:
        return None
    w = pd.concat(parts)
    keys = ["ilat", "ilon", "iso_year", "iso_week"]
    # ISO weeks straddle year files -> re-aggregate (max 7 fire days per week)
    out = w.groupby(keys)[["fire_days", "hotspot_count", "frp_sum"]].sum().reset_index()
    out["fire_days"] = out["fire_days"].clip(upper=7)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", default="data/raw")
    ap.add_argument("--out", default="data/processed")
    ap.add_argument("--area-geojson", help="GeoJSON polygon (lon/lat) restricting the area")
    ap.add_argument("--land-cover", help="CSV cell_id,land_cover_class")
    a = ap.parse_args(argv)

    polygon = None
    if a.area_geojson:
        from shapely.geometry import shape
        gj = json.load(open(a.area_geojson))
        gj = gj["features"][0]["geometry"] if gj.get("type") == "FeatureCollection" else gj
        polygon = shape(gj)

    modis = load_sensor(os.path.join(a.raw, "modis"), polygon)
    viirs = load_sensor(os.path.join(a.raw, "viirs-snpp"), polygon)
    if modis is None and viirs is None:
        raise SystemExit(f"No CSV files found under {a.raw}/modis or {a.raw}/viirs-snpp")
    out, params = harmonize(modis, viirs, load_land_cover(a.land_cover))

    os.makedirs(a.out, exist_ok=True)
    out.to_parquet(os.path.join(a.out, "harmonized.parquet"), index=False)
    out.to_json(os.path.join(a.out, "harmonized.json"), orient="records")
    json.dump(params, open(os.path.join(a.out, "calibration.json"), "w"), indent=2)
    print(f"{len(out)} rows -> {a.out}/harmonized.parquet | calibration: {params}")


if __name__ == "__main__":
    main()
