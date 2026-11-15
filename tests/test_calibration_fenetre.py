"""The calibration must only depend on its window: data after 2020-10 (Aqua drift, 2026 NRT) cannot move k."""
import numpy as np
import pandas as pd

from pipeline.v2.mondial_calibration import discordants


def journal(jours, rapport, rng):
    lignes = []
    for d in jours:
        a = int(rng.integers(40, 60))
        lignes += [{"pays": "X", "acq_date": d, "satellite": "Aqua", "daynight": "D", "n_vegetation": a},
                   {"pays": "X", "acq_date": d, "satellite": "SNPP", "daynight": "D", "n_vegetation": int(a * rapport)}]
    return lignes


def test_jours_discordants_independants_des_donnees_hors_fenetre():
    rng = np.random.default_rng(0)
    calib = pd.date_range("2015-06-01", periods=60)
    J = pd.DataFrame(journal(calib, 4.0, rng))
    J.loc[(J["acq_date"] == calib[10]) & (J["satellite"] == "SNPP"), "n_vegetation"] = 2000   # one clear outlier day
    apres = pd.date_range("2022-06-01", periods=300)
    J2 = pd.concat([J, pd.DataFrame(journal(apres, 12.0, rng))], ignore_index=True)        # another regime, 5x more days
    obs = {s: pd.DatetimeIndex(calib.append(apres)) for s in ["Aqua", "SNPP"]}
    d1, d2 = discordants(J, obs), discordants(J2, obs)
    assert list(d1["acq_date"]) == [calib[10]]
    pd.testing.assert_frame_equal(d1.reset_index(drop=True), d2.reset_index(drop=True))
