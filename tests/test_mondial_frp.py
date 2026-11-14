"""FRP calibration (pipeline/v2/mondial_frp.py) on synthetic data with a KNOWN Aqua/VIIRS FRP ratio."""
import argparse
import json
import os

import numpy as np
import pandas as pd

from pipeline.v2.mondial_frp import calibrer_frp

K_VRAI = {"Alpha": 0.30, "Beta": 0.50, "Gamma": 0.40}          # true Aqua/S-NPP FRP ratio, by country
SOUS_REGION = {"Alpha": "Sud", "Beta": "Sud", "Gamma": "Nord"}


def _jeu(dossier):
    rng = np.random.default_rng(0)
    jours = pd.date_range("2012-02-01", "2021-12-31", freq="D")
    lignes = []
    for pays, k in K_VRAI.items():
        for d in jours:
            saison = 1 + np.cos(2 * np.pi * (d.month - 8) / 12)
            for dn, f in [("D", 1.0), ("N", 0.3)]:
                nv = rng.poisson(20 * saison * f)
                frp_v = float(rng.gamma(2.0, 5.0, nv).sum()) if nv else 0.0
                na = rng.binomial(nv, 0.25) if nv else 0
                frp_a = frp_v * k * float(np.exp(rng.normal(0, 0.1)))
                lignes.append((pays, d, "SNPP", dn, nv, frp_v, 0))
                lignes.append((pays, d, "Aqua", dn, na, frp_a, 0))
                if d >= pd.Timestamp("2018-04-01"):
                    lignes.append((pays, d, "NOAA20", dn, nv, frp_v * 1.02, 0))
    J = pd.DataFrame(lignes, columns=["pays", "acq_date", "satellite", "daynight", "n_vegetation", "frp_vegetation", "n_frp_manquante"])
    os.makedirs(os.path.join(dossier, "monde", "jourfrp"), exist_ok=True)
    J.to_parquet(os.path.join(dossier, "monde", "jourfrp", "synthetique.parquet"), index=False)
    kc = pd.DataFrame([(p, dn, m, SOUS_REGION[p], 0.25) for p in K_VRAI for dn in "DN" for m in range(1, 13)],
                      columns=["pays", "daynight", "mois", "sous_region", "k"])
    kc.to_csv(os.path.join(dossier, "monde", "k_pays.csv"), index=False)


def test_frp_k_is_recovered_and_outputs_are_sane(tmp_path):
    _jeu(str(tmp_path))
    calibrer_frp(argparse.Namespace(sortie=str(tmp_path)))
    d = os.path.join(str(tmp_path), "monde")
    K = pd.read_csv(os.path.join(d, "k_frp_pays.csv"))
    for pays, k in K_VRAI.items():
        assert abs(K.loc[K["pays"] == pays, "k"].median() / k - 1) < 0.05, pays
    r = json.load(open(os.path.join(d, "rapport_frp.json"), encoding="utf-8"))
    v = r["validation_mondiale"]
    # per-country FRP ratios differ (0.3 to 0.5): a single global ratio must be clearly worse
    assert v["vigil_k1_frp"]["rmse_MW"] < v["naif_A_ratio_global"]["rmse_MW"]
    assert abs(v["vigil_k1_frp"]["biais_pct"]) < 2
    assert 0.70 <= r["incertitude"]["couverture_observee"]["0.8"] <= 0.90
    s = pd.read_csv(os.path.join(d, "serie_frp_mensuelle_pays.csv"))
    assert (s["frp_MW"] >= 0).all() and (s["bas_80"] <= s["frp_MW"] + 1e-6).all() and (s["haut_80"] >= s["frp_MW"] - 1e-6).all()
    assert set(s["source"]) == {"modis_observed", "viirs_converted"}
    rho = pd.read_csv(os.path.join(d, "rho_frp_noaa20.csv"))
    assert len(rho) == 24 and rho["rho"].notna().all()                 # never a silent 0/0
    assert np.allclose(rho["rho"], 1 / 1.02, rtol=1e-6)                 # February (no fire) uses the fallback
    assert rho.loc[rho["mois"] == 2, "rho_repli"].all() and not rho.loc[rho["mois"] != 2, "rho_repli"].any()
