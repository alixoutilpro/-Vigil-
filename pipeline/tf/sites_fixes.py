"""Hexagons whose thermal anomalies are not vegetation fires: fixed sites and active volcanoes.

    python -m pipeline.tf.sites_fixes --volcans <csv Smithsonian GVP>      # writes pipeline/tf/sites_fixes_h3.csv

Why (data-quality audit of 15 Nov 2026): the harmonized files keep the detections FIRMS labels 'type 0' (presumed
vegetation fire). FIRMS does not label lava flows nor part of the gas flares, so Kilauea, Nyiragongo or Hassi Messaoud
came out as "wildfire hubs". Two independent sources are used, and the reason is kept for every excluded hexagon:
  firms_statique  the hexagon is DOMINATED by sites that FIRMS itself labels as static (type 1 volcano, 2 other static
                  land source, 3 offshore) in the 2023-2025 archive: at least N_MIN labelled detections and at least
                  PART_MIN of all its detections, VIIRS (375 m: the sensor that sees flares best). A refinery in a
                  forested hexagon does not reach PART_MIN: real wildfire country is kept.
  volcan          the hexagon holds, or touches (H3 ring 1, ~17 km), a Holocene volcano of the Smithsonian Global
                  Volcanism Program whose last eruption is AN_ERUPTION_MIN or later: lava is hot, not burning vegetation.
The list is used by pipeline/tf/hubs.py only (Vigil Trends). The Analytics maps still show these detections: removing
them there needs a new aggregation of the raw FIRMS files (README, limit 6).
"""
import argparse
import glob
import os
import sys

import numpy as np
import pandas as pd

from . import parametres as P

N_MIN = 30              # FIRMS-labelled static detections (2023-2025, VIIRS) in the hexagon
PART_MIN = 0.5          # ... and share of all the detections of the hexagon
AN_ERUPTION_MIN = 1990  # volcanoes active in the satellite era
CELLULE = 0.02          # degrees, grid of the 'statique' tables (pipeline/v2/mondial.py)
SORTIE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sites_fixes_h3.csv")


def hex_statiques(dossier_statique):
    import h3
    d = pd.concat([pd.read_parquet(f) for f in glob.glob(os.path.join(dossier_statique, "*.parquet"))])
    d = d[d["instrument"] == "VIIRS"].groupby(["ilat", "ilon"])[["n", "n_statique"]].sum().reset_index()
    d["h3"] = [h3.latlng_to_cell((a + 0.5) * CELLULE, (b + 0.5) * CELLULE, 5) for a, b in zip(d["ilat"], d["ilon"])]
    g = d.groupby("h3")[["n", "n_statique"]].sum()
    g["part"] = g["n_statique"] / g["n"]
    g = g[(g["n_statique"] >= N_MIN) & (g["part"] >= PART_MIN)]
    return pd.DataFrame({"h3": g.index, "raison": "firms_statique", "nom": "", "detail": [f"{int(n)} static of {int(t)} detections" for n, t in zip(g["n_statique"], g["n"])]})


def hex_volcans(csv):
    import h3
    v = pd.read_csv(csv)
    v = v[pd.to_numeric(v["Last_Eruption_Year"], errors="coerce") >= AN_ERUPTION_MIN]
    lignes = []
    for _, r in v.iterrows():
        for c in h3.grid_disk(h3.latlng_to_cell(float(r["Latitude"]), float(r["Longitude"]), 5), 1):
            lignes.append((c, "volcan", r["Volcano_Name"], f"last eruption {int(r['Last_Eruption_Year'])}"))
    return pd.DataFrame(lignes, columns=["h3", "raison", "nom", "detail"]), len(v)


def charger(chemin=SORTIE):
    """Set of excluded hexagons (uint64) and the table, or (empty, None) when the list is absent."""
    if not os.path.exists(chemin):
        return set(), None
    import h3
    t = pd.read_csv(chemin, dtype=str).fillna("")
    return {h3.str_to_int(x) for x in t["h3"]}, t


def main(argv=None):
    ap = argparse.ArgumentParser(description="Vigil Trends - hexagones de sites fixes et de volcans actifs")
    ap.add_argument("--statique", default=os.path.join(os.path.dirname(P.CACHE), "monde", "statique"))
    ap.add_argument("--volcans", required=True, help="CSV of the Smithsonian GVP Holocene volcano list (WFS export)")
    a = ap.parse_args(argv)
    s = hex_statiques(a.statique)
    v, n_volcans = hex_volcans(a.volcans)
    t = pd.concat([v, s]).drop_duplicates("h3", keep="first").sort_values(["raison", "nom", "h3"])
    t.to_csv(SORTIE, index=False, lineterminator="\n")
    print(f"{len(t)} hexagones exclus : {(t['raison'] == 'volcan').sum()} autour de {n_volcans} volcans (eruption >= {AN_ERUPTION_MIN}), "
          f"{(t['raison'] == 'firms_statique').sum()} domines par des sites fixes FIRMS -> {SORTIE}")


if __name__ == "__main__":
    sys.exit(main())
