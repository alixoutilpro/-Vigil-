"""Country attribution of the 2026 form rows (pipeline/v2/attribution_pays.py) on a synthetic world."""
import json

import duckdb
import numpy as np
import pandas as pd
import pytest

from pipeline.v2 import attribution_pays as A


def carre(x0, y0, x1, y1):
    return [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]


@pytest.fixture
def parties(tmp_path):
    gj = {"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {"ADMIN": "Aland"}, "geometry": {"type": "Polygon", "coordinates": carre(0, 0, 1, 1)}},
        # one Natural Earth country with an overseas island: each part gets its own FIRMS name
        {"type": "Feature", "properties": {"ADMIN": "Bland"},
         "geometry": {"type": "MultiPolygon", "coordinates": [carre(1, 0, 2, 1), carre(5, 5, 6, 6)]}},
        # a country with no FIRMS history: its parts take the majority of their ADMIN (none here -> unmapped)
        {"type": "Feature", "properties": {"ADMIN": "Cland"}, "geometry": {"type": "Polygon", "coordinates": carre(20, 20, 21, 21)}},
    ]}
    f = tmp_path / "ne.geojson"
    f.write_text(json.dumps(gj), encoding="utf-8")
    return A.charger_parties(str(f))


@pytest.fixture
def con():
    c = duckdb.connect()
    try:
        c.execute("INSTALL h3 FROM community")
        c.execute("LOAD h3")
    except duckdb.Error:
        pytest.skip("DuckDB h3 extension unavailable")
    return c


def test_correspondance_par_partie(parties):
    lat = np.array([0.5, 0.6, 0.5, 5.5, 5.4])
    lon = np.array([0.5, 0.4, 1.5, 5.5, 5.6])
    pays = np.array(["A_firms", "A_firms", "B_firms", "Ile_firms", "Ile_firms"], dtype=object)
    corr, qualite = A.apprendre_correspondance(lat, lon, pays, np.ones(5), parties, 2.0)
    admin = parties[1]
    assert corr[int(np.flatnonzero(admin == "Aland")[0])] == "A_firms"
    ib = np.flatnonzero(admin == "Bland")
    assert sorted(corr[ib].tolist()) == ["B_firms", "Ile_firms"]          # mainland and island mapped separately
    assert int(np.flatnonzero(admin == "Cland")[0]) not in corr.index      # no history, no invented name
    assert (qualite["part_majoritaire"] == 1).all()


def test_attribuer_tous_les_niveaux(parties, con):
    corr, _ = A.apprendre_correspondance(np.array([0.5, 0.5, 5.5]), np.array([0.5, 1.5, 5.5]),
                                         np.array(["A_firms", "B_firms", "Ile_firms"], dtype=object), np.ones(3), parties, 2.0)
    # history of 0.25 deg cells: one sea cell known as 'Mer_hist', one far region known only at H3 res 3
    ref = pd.DataFrame({"pays": ["Mer_hist", "Loin_hist"], "lat_c": [10.125, -40.125], "lon_c": [10.125, 100.125], "n": [5, 7]})
    con.register("ref", ref)
    lat = np.array([0.5, 0.5, 5.5, -0.01, 10.1, -40.3, -70.0])
    lon = np.array([0.5, 1.5, 5.5, 0.5, 10.1, 100.3, -150.0])
    pays, niveau = A.attribuer(con, lat, lon, parties, corr, "SELECT * FROM ref", 2.0)
    assert list(pays) == ["A_firms", "B_firms", "Ile_firms", "A_firms", "Mer_hist", "Loin_hist", "inconnu"]
    assert list(niveau) == ["polygone", "polygone", "polygone", "polygone_cotier", "cellule_0.25", "h3_res3", "inconnu"]


def test_localiser_rapide_identique_au_test_point_par_point(parties):
    """The 'whole tile inside a part' shortcut must give exactly the point-by-point answer."""
    import shapely
    rng = np.random.default_rng(1)
    lat, lon = rng.uniform(-1, 7, 5000), rng.uniform(-1, 7, 5000)
    idx, _ = A.localiser(lat, lon, parties, 0.0)
    geoms = parties[0]
    attendu = np.full(len(lat), -1)
    for k, g in enumerate(geoms):
        attendu[shapely.contains_xy(g, lon, lat) & (attendu < 0)] = k
    dedans = attendu >= 0
    assert (idx[dedans] == attendu[dedans]).all()
