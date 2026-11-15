"""Static site export (pipeline/v2/export_site.py): hexagon harmonization rule and binary file format."""
import gzip

import duckdb
import h3
import numpy as np
import pandas as pd
import pytest

from pipeline.v2.export_site import ENR_MOIS, ENR_TUILE, ecrire_gz, harmoniser_hex

HEX = h3.str_to_int(h3.latlng_to_cell(38.1, 23.8, 5))


def _k(k):
    return pd.DataFrame([("Greece", dn, m, "Southern Europe", 0.2, 0.2, 100, 500) for dn in "DN" for m in range(1, 13)],
                        columns=["pays", "daynight", "mois", "sous_region", "k_sous_region", "k", "Aqua", "SNPP"]).assign(k=k)


def _rho(r):
    return pd.DataFrame([(dn, m, r) for dn in "DN" for m in range(1, 13)], columns=["daynight", "mois", "rho"])


def test_switch_rule_k_and_frp(tmp_path):
    lignes = [  # pays, h3, annee, mois, satellite, daynight, jour_sans_snpp, n_vegetation, frp_vegetation
        ("Greece", HEX, 2015, 8, "Aqua", "D", False, 10, 100.0),     # before switch: Aqua as observed
        ("Greece", HEX, 2015, 8, "SNPP", "D", False, 50, 300.0),     # before switch: VIIRS not used
        ("Greece", HEX, 2023, 8, "SNPP", "D", False, 50, 300.0),     # after: k x S-NPP
        ("Greece", HEX, 2023, 8, "SNPP", "D", True, 7, 70.0),        # S-NPP on a day flagged without S-NPP: ignored
        ("Greece", HEX, 2023, 8, "NOAA20", "D", True, 20, 200.0),    # NOAA-20 fills days without S-NPP: k x rho
        ("Greece", HEX, 2023, 8, "NOAA20", "D", False, 40, 400.0),   # NOAA-20 when S-NPP exists: ignored
        ("Greece", HEX, 2023, 8, "Aqua", "D", False, 9, 90.0),       # Aqua after switch: ignored (orbit drift)
        ("Nowhere", HEX, 2023, 9, "SNPP", "D", False, 10, 10.0),     # unknown country: global day ratio, not 0
    ]
    H = pd.DataFrame(lignes, columns=["pays", "h3", "annee", "mois", "satellite", "daynight", "jour_sans_snpp",
                                      "n_vegetation", "frp_vegetation"])
    H["h3"] = H["h3"].astype("uint64")
    p = str(tmp_path / "hex.parquet").replace("\\", "/")
    H.to_parquet(p, index=False)
    con = duckdb.connect()
    harmoniser_hex(con, p, _k(0.2), _rho(1.1), _k(0.5), _rho(0.9))
    r = con.sql("SELECT * FROM hp").df().set_index(["pays", "annee", "mois"])
    assert r.loc[("Greece", 2015, 8), "hotspots"] == pytest.approx(10)
    assert r.loc[("Greece", 2015, 8), "frp"] == pytest.approx(100)
    assert r.loc[("Greece", 2023, 8), "hotspots"] == pytest.approx(0.2 * 50 + 0.2 * 1.1 * 20)
    assert r.loc[("Greece", 2023, 8), "frp"] == pytest.approx(0.5 * 300 + 0.5 * 0.9 * 200)
    assert r.loc[("Nowhere", 2023, 9), "hotspots"] == pytest.approx(100 / 500 * 10)   # global D ratio = 0.2


def test_binary_records_round_trip(tmp_path):
    t = np.zeros(2, ENR_MOIS)
    t["h3"], t["hotspots"], t["frp"] = [HEX, HEX + 1], [1.5, 2.5], [10.0, 20.0]
    ecrire_gz(str(tmp_path / "m.bin.gz"), t)
    b = np.frombuffer(gzip.open(tmp_path / "m.bin.gz").read(), ENR_MOIS)
    assert ENR_MOIS.itemsize == 16 and ENR_TUILE.itemsize == 18
    assert int(b["h3"][0]) == HEX and b["hotspots"][1] == pytest.approx(2.5) and b["frp"][1] == pytest.approx(20.0)


def test_aqua_outage_days_use_converted_snpp_before_the_switch(tmp_path):
    """Before the switch, a day flagged 'without Aqua' takes k x S-NPP instead of the (partial) Aqua count."""
    lignes = [("Greece", HEX, 2020, 8, "Aqua", "D", False, False, 10, 100.0),    # normal days: Aqua as observed
              ("Greece", HEX, 2020, 8, "Aqua", "D", False, True, 1, 5.0),        # outage days: partial Aqua, ignored
              ("Greece", HEX, 2020, 8, "SNPP", "D", False, False, 50, 300.0),    # normal days: VIIRS not used
              ("Greece", HEX, 2020, 8, "SNPP", "D", False, True, 40, 200.0)]     # outage days: k x S-NPP
    H = pd.DataFrame(lignes, columns=["pays", "h3", "annee", "mois", "satellite", "daynight", "jour_sans_snpp", "jour_sans_aqua",
                                      "n_vegetation", "frp_vegetation"]).astype({"h3": "uint64"})
    ch = str(tmp_path / "hex.parquet")
    H.to_parquet(ch)
    con = duckdb.connect()
    harmoniser_hex(con, ch, _k(0.2), _rho(1.0), _k(0.5), _rho(1.0))
    r = con.sql("SELECT sum(hotspots) h, sum(frp) f FROM hp").fetchall()[0]
    assert r[0] == pytest.approx(10 + 0.2 * 40) and r[1] == pytest.approx(100 + 0.5 * 200)
