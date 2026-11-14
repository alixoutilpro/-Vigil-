"""Tests of the v2 pipeline rules (synthetic data, no FIRMS file needed)."""
from datetime import date

import numpy as np
import pandas as pd
import pytest
from shapely.geometry import box

from pipeline.v2 import harmonisation as H
from pipeline.v2 import nettoyage as N


def brut(**kw):
    ligne = {c: None for c in N.COLONNES}
    ligne.update({"latitude": "38.0", "longitude": "23.0", "acq_date": "2020-07-01", "acq_time": "1130",
                  "satellite": "Aqua", "instrument": "MODIS", "confidence": "50", "version": "6.03",
                  "frp": "10", "daynight": "D", "type": "0", "brightness": "320", "bright_t31": "290",
                  "scan": "1.0", "track": "1.0", "filename": r"C:\x\modis\2020\modis_2020_Greece.csv"})
    ligne.update(kw)
    return pd.DataFrame([ligne])


def test_formulaire_viirs_colonnes_modis_et_code_snpp():
    df = N.normaliser(brut(satellite="SNPP", instrument="SNPP", confidence="n", acq_time="0010",
                           filename=r"C:\x\2026-formulaire\DL_FIRE_SV-C2_846272\fire_nrt_SV-C2_846272.csv", type=None))
    r = df.iloc[0]
    assert (r["satellite"], r["instrument"], r["origine"]) == ("SNPP", "VIIRS", "nrt")
    assert r["bright_4um"] == 320.0 and r["acq_time"] == "0010"
    assert pd.isna(r["type"])


def test_codes_satellites_annuels():
    df = N.normaliser(pd.concat([brut(satellite="N"), brut(satellite="N20"), brut(satellite="Terra")]))
    assert df["satellite"].tolist() == ["SNPP", "NOAA20", "Terra"]


def test_validation_motifs():
    df = N.normaliser(pd.concat([
        brut(satellite="XYZ"),                                   # unknown satellite
        brut(latitude="95"),                                     # bad coordinates
        brut(acq_time="2460"),                                   # bad time
        brut(satellite="N", confidence="l", daynight="N"),       # VIIRS night 'low' outside SAA
        brut(satellite="N", acq_date="2011-12-31"),              # before S-NPP lifetime
        brut()]))                                                # valid
    r = N.valider(df, date(2026, 11, 14)).tolist()
    assert r[:5] == ["satellite_inconnu", "coordonnees_invalides", "heure_invalide",
                     "viirs_nuit_low_anormal", "hors_vie_satellite"]
    assert pd.isna(r[5])                                          # valid row = no exclusion reason


def test_confiance_seuils():
    df = N.normaliser(pd.concat([brut(confidence="29"), brut(confidence="30"), brut(confidence="80"),
                                 brut(satellite="N", confidence="n"), brut(satellite="N", confidence="l")]))
    assert N.classer_confiance(df).tolist() == ["low", "nominal", "high", "nominal", "low"]


def test_assigner_pays_tolerance_cotiere():
    geoms = {"A": box(20, 35, 21, 36)}
    lat = np.array([35.5, 35.5, 35.5])
    lon = np.array([20.5, 21.01, 21.5])      # inside, ~0.9 km outside, ~45 km outside
    pays, cotier = N.assigner_pays(lat, lon, geoms, 2.0)
    assert pays.tolist() == ["A", "A", None]
    assert cotier.tolist() == [False, True, False]


def test_doublons_exacts_et_quasi():
    df = N.normaliser(pd.concat([brut(), brut(), brut(latitude="38.0009"), brut(latitude="38.02")]))
    ok = pd.Series(True, index=df.index)
    df.index = range(len(df))
    assert N.doublons_exacts(df, ok.set_axis(df.index)).tolist() == [False, True, False, False]
    q = N.quasi_doublons(df.iloc[[0, 2, 3]])          # 0.1 km apart (< 0.5 km) then 2.2 km apart
    assert q.tolist() == [False, True, False]


def test_controle_croise_satellite_non_lance_n_est_pas_discordant():
    jours = pd.to_datetime(["2017-07-01", "2019-07-01"])
    agg = pd.DataFrame({"acq_date": np.repeat(jours, 3), "daynight": "D",
                        "satellite": ["Aqua", "SNPP", "NOAA20"] * 2, "n_vegetation": [50, 250, 0, 50, 250, 240]})
    cc = N.controle_croise(agg)
    assert np.isnan(cc.loc[0, "z_NOAA20_Aqua"])                  # NOAA-20 not yet in FIRMS in 2017
    assert not cc["discordant"].any()


def test_k_bayes_formule_et_bornes():
    t = pd.DataFrame({"pays": ["G"] * 24, "daynight": ["D"] * 12 + ["N"] * 12, "mois": list(range(1, 13)) * 2,
                      "Aqua": [20] * 12 + [2] * 12, "SNPP": [100] * 12 + [50] * 12}).set_index(["pays", "daynight", "mois"])
    kc, kp = H.estimer_k(t)
    assert np.allclose(kc.loc[kc["daynight"] == "D", "k"], 0.2)     # A/V = prior = 0.2 -> k = 0.2
    assert np.allclose(kc.loc[kc["daynight"] == "N", "k"], 0.04)
    q = {c: {"q_bas": -0.7, "q_haut": 0.35} for c in H.NOMS_CLASSES}
    lo, hi = H.intervalle(np.array([0.0, 3.0, 100.0]), q)
    assert (lo >= 0).all() and (lo <= np.array([0.0, 3.0, 100.0])).all() and (hi >= np.array([0.0, 3.0, 100.0])).all()


if __name__ == "__main__":
    pytest.main([__file__, "-q"])
