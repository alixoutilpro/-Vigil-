"""Does the sensor change the hubs? Hexagon-scale check of the harmonization, asked by the data-quality audit (15 Nov 2026).

    python -m etudes.validation_hubs_capteur

VIGIL-K1 is validated for country and ~55-220 km totals. Hubs are found on ~17 km hexagons, where the published series
is MODIS Aqua before Nov 2020 and converted VIIRS after. On 2013-2019 both sensors observe every month: the hub
detection of pipeline/tf/hubs.py is run twice on the same years, once on Aqua as observed, once on S-NPP x k (the
conversion applied after 2020), with the same exclusions and thresholds. If the sensor did not matter the two sets of
hubs would be identical. Output: <cache>/validation_hubs_capteur.json (figures quoted in docs/methode_tf.md).
"""
import json
import os
import sys

import duckdb
import numpy as np
import pandas as pd

from pipeline.tf import parametres as P
from pipeline.tf.hubs import detecter
from pipeline.tf.sites_fixes import charger

AN0, AN1 = 2013, 2019          # complete years inside the calibration window (2012-02 -> 2020-10)


def series(monde):
    hexs = os.path.join(monde, "hex", "*_20[1][3-9].parquet").replace("\\", "/")
    con = duckdb.connect()
    con.register("k", pd.read_csv(os.path.join(monde, "k_pays.csv"))[["pays", "daynight", "mois", "k"]])
    q = f"""SELECT h.h3, h.annee AS an, h.mois, h.satellite,
                   sum(CASE WHEN h.satellite = 'Aqua' THEN h.n_vegetation ELSE k.k * h.n_vegetation END) AS hotspots,
                   sum(h.frp_vegetation) AS frp
            FROM read_parquet('{hexs}') h LEFT JOIN k ON k.pays = h.pays AND k.daynight = h.daynight AND k.mois = h.mois
            WHERE h.satellite IN ('Aqua', 'SNPP') AND h.annee BETWEEN {AN0} AND {AN1} AND (h.satellite = 'Aqua' OR k.k IS NOT NULL)
            GROUP BY ALL HAVING sum(h.n_vegetation) > 0"""
    d = con.sql(q).df()
    d["h3"] = d["h3"].astype("uint64")
    return d[d["satellite"] == "Aqua"].drop(columns="satellite"), d[d["satellite"] == "SNPP"].drop(columns="satellite")


def jaccard(a, b):
    return float(len(a & b) / max(len(a | b), 1))


def main():
    monde = os.path.join(os.path.dirname(P.CACHE), "monde")
    exclus, _ = charger()
    A, V = series(monde)
    out = {"annees": [AN0, AN1], "totaux": {"aqua": float(A["hotspots"].sum()), "snpp_converti": float(V["hotspots"].sum())},
           "hexagones_mois": {"aqua": int(len(A)), "snpp_converti": int(len(V)), "snpp_converti_moins_d_une_detection": float((V["hotspots"] < 1).mean())}}
    r = {n: detecter(M[~M["h3"].isin(exclus)], AN0, AN1) for n, M in (("aqua", A), ("snpp", V))}
    for n in r:
        out[n] = {"sursauts_bruts": int(r[n]["n_bruts"]), "sursauts_en_episode": int(len(r[n]["B"])), "episodes": int(len(r[n]["ep"])),
                  "hubs": int(len(r[n]["Y"])), "hexagones_de_hub": int(len(r[n]["hub"]))}
    ha, hv = set(r["aqua"]["hub"].index), set(r["snpp"]["hub"].index)
    out["jaccard_hexagones_de_hub"] = jaccard(ha, hv)
    ba = set(zip(r["aqua"]["B"]["h3"], r["aqua"]["B"]["mi"])); bv = set(zip(r["snpp"]["B"]["h3"], r["snpp"]["B"]["mi"]))
    out["jaccard_sursauts_en_episode"] = jaccard(ba, bv)
    # hub-level: is a hub of one sensor matched by a hub of the other within one ring (same place, ~17 km tolerance)?
    import h3
    def touche(hubs, autres):
        ok = 0
        for _, cells in hubs.groupby(hubs).groups.items():
            vois = {h3.str_to_int(v) for c in cells for v in h3.grid_disk(h3.int_to_str(int(c)), 1)}
            ok += bool(vois & autres)
        return ok / max(hubs.nunique(), 1)
    out["part_hubs_aqua_retrouves_par_snpp"] = float(touche(r["aqua"]["hub"], hv))
    out["part_hubs_snpp_retrouves_par_aqua"] = float(touche(r["snpp"]["hub"], ha))
    # the same at H3 res 4 (~42 km): does a coarser unit make the sensors agree?
    par = lambda s: {h3.str_to_int(h3.cell_to_parent(h3.int_to_str(int(c)), 4)) for c in s}
    out["jaccard_territoires_res4_avec_hub"] = jaccard(par(ha), par(hv))
    ea, ev = r["aqua"]["E"], r["snpp"]["E"]
    j = pd.concat([ea.rename("a"), ev.rename("v")], axis=1).fillna(0)
    out["correlation_exposition_log"] = float(np.corrcoef(np.log1p(j["a"]), np.log1p(j["v"]))[0, 1])
    ch = os.path.join(P.CACHE, "validation_hubs_capteur.json")
    json.dump(out, open(ch, "w", encoding="utf-8"), indent=1)
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    sys.exit(main())
