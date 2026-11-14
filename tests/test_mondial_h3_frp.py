"""Second aggregation pass of pipeline/v2/mondial.py: H3 res-5 map table ('hex') and FRP table ('jourfrp')."""
import argparse
import os

import duckdb
import h3
import pandas as pd
import pytest

from pipeline.v2 import mondial as M

ENTETE_MODIS = "latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_t31,frp,daynight,type"
ENTETE_VIIRS = "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight,type"


def _h3_disponible():
    try:
        con = duckdb.connect()
        con.execute("INSTALL h3 FROM community")
        con.execute("LOAD h3")
        return True
    except Exception:
        return False


pytestmark = pytest.mark.skipif(not _h3_disponible(), reason="DuckDB 'h3' community extension unavailable (offline?)")


def _ecrire(dossier, source, pays, entete, lignes):
    d = os.path.join(dossier, source, "2023")
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, f"{source}_2023_{pays}.csv"), "w", encoding="utf-8") as f:
        f.write(entete + "\n" + "\n".join(lignes) + "\n")


@pytest.fixture
def brut(tmp_path):
    b = str(tmp_path / "brut")
    _ecrire(b, "modis", "Greece", ENTETE_MODIS, [
        "38.10,23.80,330,1,1,2023-08-20,1105,Aqua,MODIS,80,6.2,300,40.5,D,0",    # kept
        "38.11,23.81,330,1,1,2023-08-20,1105,Aqua,MODIS,90,6.2,300,10.0,D,0",    # kept, same hexagon
        "38.10,23.80,330,1,1,2023-08-21,1105,Aqua,MODIS,10,6.2,300,99.0,D,0",    # low confidence -> dropped
        "38.10,23.80,330,1,1,2023-08-22,1105,Aqua,MODIS,80,6.2,300,77.0,D,2",    # industrial -> n_industriel only
        "36.40,25.40,330,1,1,2023-08-22,1105,Aqua,MODIS,80,6.2,300,500.0,D,1",   # volcano -> dropped
    ])
    _ecrire(b, "viirs-snpp", "Greece", ENTETE_VIIRS, [
        "38.10,23.80,330,0.4,0.4,2023-08-20,1150,N,VIIRS,n,2,290,3.5,D,0",
        "38.10,23.80,330,0.4,0.4,2023-08-20,0050,N,VIIRS,h,2,290,6.5,N,0",
        "38.10,23.80,330,0.4,0.4,2023-08-20,1150,N,VIIRS,l,2,290,8.0,D,0",       # low confidence -> dropped
    ])
    _ecrire(b, "viirs-jpss1", "Greece", ENTETE_VIIRS, [
        "38.10,23.80,330,0.4,0.4,2023-08-20,1100,N20,VIIRS,n,2,290,,D,0",        # missing FRP -> counted, FRP 0
    ])
    return b


def _lancer(brut, sortie, tables):
    a = argparse.Namespace(brut=brut, sortie=sortie, memoire="1GB", threads=1, annees={2023}, tables=tables)
    M.agreger(a)
    return os.path.join(sortie, "monde")


def test_second_pass_writes_only_hex_and_frp_tables(brut, tmp_path):
    d = _lancer(brut, str(tmp_path / "out"), M.TABLES_H3_FRP)
    assert sorted(os.listdir(d)) == ["hex", "jourfrp", "tmp_duckdb"] or sorted(os.listdir(d)) == ["hex", "jourfrp"]

    hexa = pd.read_parquet(os.path.join(d, "hex", "modis_2023.parquet"))
    attendu = h3.str_to_int(h3.latlng_to_cell(38.10, 23.80, M.H3_MONDE))
    aqua = hexa[(hexa["h3"] == attendu) & (hexa["satellite"] == "Aqua")]
    assert int(aqua["n_vegetation"].sum()) == 2                      # low-confidence and industrial excluded
    assert aqua["frp_vegetation"].sum() == pytest.approx(50.5)      # 40.5 + 10.0, industrial FRP not included
    assert aqua["frp_max"].max() == pytest.approx(40.5)
    assert int(hexa["n_industriel"].sum()) == 1
    assert int(hexa["n_vegetation"].sum()) == 2                      # volcano row never counted

    snpp = pd.read_parquet(os.path.join(d, "hex", "viirs-snpp_2023.parquet"))
    assert int(snpp["n_vegetation"].sum()) == 2 and snpp["frp_vegetation"].sum() == pytest.approx(10.0)
    assert set(snpp["daynight"]) == {"D", "N"}

    jf = pd.read_parquet(os.path.join(d, "jourfrp", "viirs-jpss1_2023.parquet"))
    assert int(jf["n_vegetation"].sum()) == 1 and jf["frp_vegetation"].sum() == 0
    assert int(jf["n_frp_manquante"].sum()) == 1


def test_hex_counts_equal_cell_counts(brut, tmp_path):
    """The new pass must count exactly what the historical 'cellule' table counts (same filters)."""
    d_hist = _lancer(brut, str(tmp_path / "hist"), M.TABLES_HISTORIQUES)
    d_hex = _lancer(brut, str(tmp_path / "hex"), M.TABLES_H3_FRP)
    assert not os.path.exists(os.path.join(d_hist, "hex"))
    for nom in ["modis_2023.parquet", "viirs-snpp_2023.parquet", "viirs-jpss1_2023.parquet"]:
        c = pd.read_parquet(os.path.join(d_hist, "cellule", nom)).groupby("satellite")[["n_vegetation", "n_industriel"]].sum()
        x = pd.read_parquet(os.path.join(d_hex, "hex", nom)).groupby("satellite")[["n_vegetation", "n_industriel"]].sum()
        pd.testing.assert_frame_equal(c, x, check_dtype=False)
