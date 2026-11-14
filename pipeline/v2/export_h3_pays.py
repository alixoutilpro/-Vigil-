"""Country -> H3 res-5 hexagons, so that the map of a country shows the hexagons of THAT country (not its bounding box).

A hexagon belongs to a country when the country's FIRMS file has at least one counted (vegetation) detection of the
satellites used by the harmonized series (Aqua, S-NPP, NOAA-20) in it, any year. Border hexagons can belong to two
countries. Same country assignment as the published country series (monde/hex table, built with it).

Output: <site>/h3_5/pays/<Pays>.bin.gz = sorted uint64 little-endian H3 ids, gzip.
Command: python -m pipeline.v2.export_h3_pays --site public/data
"""
import argparse
import gzip
import os

import duckdb
import numpy as np

from . import parametres as P


def exporter(sortie, site, memoire="3GB"):
    con = duckdb.connect()
    con.execute(f"SET memory_limit='{memoire}'")
    chemin = os.path.join(sortie, "monde", "hex", "*.parquet").replace("\\", "/")
    t = con.execute(f"""SELECT DISTINCT pays, h3 FROM read_parquet('{chemin}')
                        WHERE n_vegetation > 0 AND satellite IN ('Aqua', 'SNPP', 'NOAA20') AND pays <> 'inconnu'
                        ORDER BY pays, h3""").df()
    dossier = os.path.join(site, "h3_5", "pays")
    os.makedirs(dossier, exist_ok=True)
    n = 0
    for pays, g in t.groupby("pays"):
        b = np.sort(g["h3"].to_numpy().astype("<u8")).tobytes()
        with open(os.path.join(dossier, f"{pays}.bin.gz"), "wb") as f:
            f.write(gzip.compress(b, compresslevel=9, mtime=0))   # mtime=0: identical bytes on re-export
        n += 1
    return n, len(t)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Vigil v2 - country -> H3 res-5 hexagons")
    ap.add_argument("--sortie", default=P.DOSSIER_SORTIE)
    ap.add_argument("--site", default="public/data")
    a = ap.parse_args(argv)
    n, k = exporter(a.sortie, a.site)
    print(f"{n} pays, {k} couples pays-hexagone -> {a.site}/h3_5/pays/")


if __name__ == "__main__":
    main()
