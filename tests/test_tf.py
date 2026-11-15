"""Trends & Forecasts pipeline (pipeline/tf): statistics, no look-ahead in the feature vectors, intervals, file format."""
import gzip
import json

import h3
import numpy as np
import pandas as pd
import pytest
from scipy import stats

from pipeline.tf import parametres as P
from pipeline.tf import prevision as V
from pipeline.tf.climat import moyenne_par_cellule
from pipeline.tf.descripteurs import benjamini_hochberg, mann_kendall, saison, sen
from pipeline.tf.executer import TYPES, ecrire_colonnes
from pipeline.tf.regimes import adjacence, tendances
from pipeline.tf.table import table_mensuelle
from pipeline.tf.vecteurs import TOUTES, Historique

CENTRE = h3.latlng_to_cell(38.1, 23.8, 4)
CELLULES = np.array(sorted(h3.str_to_int(c) for c in h3.grid_disk(CENTRE, 2)), np.uint64)


def test_mann_kendall_sen_and_fdr():
    rng = np.random.default_rng(0)
    t = np.arange(2003, 2026)
    Y = np.vstack([10 + 2.0 * (t - 2003) + rng.normal(0, 1, 23), rng.normal(50, 5, 23), np.full(23, 7.0)])
    S, z, p = mann_kendall(Y)
    assert p[0] < 1e-6 and p[1] > 0.05 and p[2] == 1.0            # trend, noise, constant series (all ties)
    ref = stats.kendalltau(t, Y[1])
    assert S[1] == pytest.approx(ref.statistic * 23 * 22 / 2)      # same S as scipy (no ties)
    assert sen(Y, t)[0] == pytest.approx(stats.theilslopes(Y[0], t)[0])
    q = benjamini_hochberg(np.array([0.001, 0.02, 0.03, 0.8, np.nan]))
    assert q[0] == pytest.approx(0.004) and q[1] == pytest.approx(0.04) and q[2] == pytest.approx(0.04) and np.isnan(q[4])
    assert (q[:4] >= np.array([0.001, 0.02, 0.03, 0.8])).all()     # adjusted p-values never decrease


def test_season_is_aligned_between_hemispheres():
    M = pd.DataFrame(np.zeros((2, 12)), columns=range(1, 13))
    M.loc[0, 8] = 100.0          # northern cell burning in August
    M.loc[1, 2] = 100.0          # southern cell burning in February: the same solar season
    s = saison(M, np.array([40.0, -30.0]))
    assert s["saison_cos"].iloc[0] == pytest.approx(s["saison_cos"].iloc[1])
    assert s["saison_R"].iloc[0] == pytest.approx(1.0) and s["saison_longueur"].iloc[0] == 1


def test_res5_hexagons_sum_into_their_res4_parent():
    enfants = list(h3.cell_to_children(CENTRE, 5))
    M = pd.DataFrame({"h3": [h3.str_to_int(c) for c in enfants], "an": 2020, "mois": 8, "hotspots": 1.5, "frp": 10.0})
    F = table_mensuelle(M)
    assert len(F) == 1 and F["cellule"].iloc[0] == h3.str_to_int(CENTRE)
    assert F["hotspots"].iloc[0] == pytest.approx(1.5 * len(enfants))


def test_climate_mean_ignores_missing_pixels():
    v = np.ma.masked_invalid(np.array([[[1.0, 2.0], [np.nan, 4.0]]] * 12))
    d = moyenne_par_cellule(v, np.array([[1, 1], [2, 2]], np.uint64))
    assert d["m01"].tolist() == [1.5, 4.0]


def _historique(tmp_path, graine=0):
    rng = np.random.default_rng(graine)
    lignes = [(c, an, m, float(rng.poisson(3)), float(rng.poisson(60))) for c in CELLULES for an in range(P.AN0, P.AN1 + 1) for m in (7, 8)]
    F = pd.DataFrame(lignes, columns=["cellule", "an", "mois", "hotspots", "frp"])
    C = pd.DataFrame({"cellule": CELLULES, "lat": [h3.cell_to_latlng(h3.int_to_str(int(c)))[0] for c in CELLULES],
                      "lon": [h3.cell_to_latlng(h3.int_to_str(int(c)))[1] for c in CELLULES], "aire_km2": 1700.0})
    return F, C, Historique(F, C, str(tmp_path))


def test_feature_vectors_never_use_the_future(tmp_path):
    F, C, H = _historique(tmp_path)
    X = H.vecteurs(2015)
    F2 = F.copy()
    F2.loc[F2["an"] > 2015, "hotspots"] *= 50          # change everything after the origin year
    X2 = Historique(F2, C, str(tmp_path)).vecteurs(2015)
    fire = [c for c in TOUTES if c[0] in "fv"]
    pd.testing.assert_frame_equal(X[fire], X2[fire])
    Xj, y, z, cle = H.jeu(3, [2015])
    assert (cle["cible"] == 2018).all() and y[0] == pytest.approx(H.A[0, 2018 - P.AN0])
    assert X["v_m3"].iloc[0] == pytest.approx((H.W1 @ X["f_m3"].to_numpy())[0])


def test_pooled_trend_uses_cell_and_neighbours():
    annees = np.arange(P.AN0, P.AN1 + 1)
    A = pd.DataFrame(np.full((len(CELLULES), len(annees)), 2.0), index=CELLULES, columns=annees)   # 2 a year: below the 3-a-year floor
    A.iloc[:, :] += 0.2 * (annees - P.AN0)[None, :]                                                 # a rise shared by every cell
    d = pd.DataFrame({"moy_an": A.mean(axis=1)})
    W = adjacence(CELLULES)
    seul, _ = tendances(A.clip(upper=2.9), d.assign(moy_an=2.0))
    lisse, r = tendances(A, d, W)
    i = list(CELLULES).index(h3.str_to_int(CENTRE))
    assert seul["tendance"].iloc[i] == -128                       # alone: too few detections to be tested
    assert lisse["tendance"].iloc[i] == 1 and lisse["sen_pct_an"].iloc[i] > 0
    assert W[i].sum() == 6 and r["serie"].startswith("cellule + 6")


def test_conformal_band_covers_what_it_claims():
    rng = np.random.default_rng(1)
    mu = rng.gamma(1.0, 40.0, 40000)
    y = rng.poisson(mu * rng.lognormal(0, 0.5, len(mu)))          # over-dispersed counts around mu
    q = V.quantiles_conformes(y[:20000], mu[:20000])
    c = V.couverture(y[20000:], mu[20000:], q)
    assert abs(c["0.8"]["globale"] - 0.80) < 0.02 and abs(c["0.95"]["globale"] - 0.95) < 0.015
    lo, hi = V.bornes(mu, q, 0.8)
    assert (lo >= 0).all() and (hi >= lo).all()


def test_classification_metrics_on_a_known_table():
    z = np.array([1] * 40 + [0] * 60)
    p = np.array([0.9] * 30 + [0.1] * 10 + [0.8] * 6 + [0.2] * 54)     # TP 30, FN 10, FP 6, TN 54
    m = V.metriques_clf(z, p)
    assert (m["vp"], m["fn"], m["fp"], m["vn"]) == (30, 10, 6, 54)
    assert m["sensibilite"] == pytest.approx(0.75) and m["specificite"] == pytest.approx(0.9)
    assert m["precision"] == pytest.approx(30 / 36) and m["exactitude"] == pytest.approx(0.84)
    assert m["exactitude_classe_majoritaire"] == pytest.approx(0.6)
    assert V.deviance_poisson([3, 0, 5], [3, 0, 5]) == pytest.approx(0, abs=1e-6)
    r = V.metriques_reg(np.array([0.0, 10.0, 100.0]), np.array([0.0, 10.0, 100.0]))
    assert r["r2_log"] == pytest.approx(1) and r["biais_total_pct"] == pytest.approx(0)


def test_columnar_file_round_trip(tmp_path):
    ch = str(tmp_path / "tf" / "cellules.bin.gz")
    col = {"h3": ("u64", CELLULES[:3]), "regime": ("u8", [0, 1, 4]), "tendance": ("i8", [-128, -1, 1]), "mu1": ("f32", [0.5, np.nan, 1e6])}
    ecrire_colonnes(ch, col, {"format": "VTF1", "pays": ["Greece"]})
    b = gzip.open(ch).read()
    assert b[:4] == b"VTF1"
    lt = int(np.frombuffer(b[4:8], "<u4")[0])
    assert (8 + lt) % 8 == 0
    tete = json.loads(b[8:8 + lt])
    assert tete["n"] == 3 and tete["pays"] == ["Greece"]
    for c in tete["colonnes"]:
        assert c["decalage"] % 8 == 0
        v = np.frombuffer(b, TYPES[c["type"]], count=3, offset=8 + lt + c["decalage"])
        np.testing.assert_array_equal(v, np.asarray(col[c["nom"]][1]).astype(TYPES[c["type"]]))


def test_hubs_bursts_episodes_and_split():
    """A wildfire burst is linked in space-time into one episode; regular yearly burning never bursts; big groups are split."""
    from pipeline.tf.hubs import RATIO, TAILLE_MAX, V_MIN, decouper, episodes, medianes_mois
    a, b = (h3.str_to_int(c) for c in list(h3.grid_disk(h3.latlng_to_cell(38.1, 23.8, 5), 1))[:2])
    loin = h3.str_to_int(h3.latlng_to_cell(10.0, 20.0, 5))
    lignes = [(loin, an, 3, 40.0, 400.0) for an in range(2003, 2026)]                      # a field burnt every March
    lignes += [(a, 2021, 8, 60.0, 9000.0), (b, 2021, 8, 30.0, 4000.0), (b, 2021, 9, 20.0, 2000.0), (a, 2012, 8, 15.0, 900.0)]
    M = pd.DataFrame(lignes, columns=["h3", "an", "mois", "hotspots", "frp"])
    M["h3"] = M["h3"].astype("uint64")
    M["mi"] = (M["an"] - 2002) * 12 + M["mois"] - 1
    med = medianes_mois(M, {m: 23 for m in range(1, 13)})
    assert med.loc[(loin, 3)] == 40.0 and med.loc[(a, 8)] == 0.0
    M = M.join(med, on=["h3", "mois"])
    B = M[(M["hotspots"] >= V_MIN) & (M["hotspots"] >= RATIO * (M["med"] + 1))]
    assert loin not in set(B["h3"]) and len(B) == 4                                         # regular burning is not a burst
    B = episodes(B)
    e21 = B[B["an"] == 2021]["episode"]
    assert e21.nunique() == 1 and B["episode"].nunique() == 2                               # Aug-Sep 2021, a and b: one episode; 2012: another
    gros = pd.Series(np.arange(1.0, 62.0), index=np.array([h3.str_to_int(c) for c in h3.grid_disk(h3.latlng_to_cell(38.1, 23.8, 5), 4)], np.uint64))
    hub = decouper(gros)
    assert hub.groupby(hub).size().max() <= TAILLE_MAX and gros.idxmax() in hub.index      # local hubs, the strongest hexagon kept


def test_hubs_latitude_weight_and_fixed_sites(tmp_path):
    """Same counts weigh less at high latitude (more overpasses); the published exclusion list is readable and holds known volcanoes."""
    from pipeline.tf.hubs import LAT_REF, poids_latitude
    from pipeline.tf.sites_fixes import charger
    eq, ref, nord = (h3.str_to_int(h3.latlng_to_cell(la, 20.0, 5)) for la in (0.0, LAT_REF, 60.0))
    w = poids_latitude([eq, ref, nord])
    assert w[ref] == pytest.approx(1.0, abs=0.01) and w[eq] > 1.25 and w[nord] == pytest.approx(0.5 / np.cos(np.radians(LAT_REF)), abs=0.02)
    exclus, t = charger()
    assert t is not None and set(t["raison"]) == {"volcan", "firms_statique"}
    for la, lo in ((19.41, -155.28), (-1.52, 29.25), (-21.24, 55.71)):          # Kilauea, Nyiragongo, Piton de la Fournaise
        assert h3.str_to_int(h3.latlng_to_cell(la, lo, 5)) in exclus
    assert h3.str_to_int(h3.latlng_to_cell(41.004, 25.998, 5)) not in exclus    # Evros 2023: a real wildfire stays
