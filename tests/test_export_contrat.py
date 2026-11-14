"""Tests of pipeline/v2/export_contrat.py (contract consumed by app/Vigil.tsx)."""
from datetime import date, timedelta

import numpy as np

from pipeline.v2.export_contrat import bornes, semaine_iso, source

Q = {c: {"q_bas": -0.5, "q_haut": 0.4} for c in ["<5", "5-30", "30-150", ">150"]}


def iso_week_month_frontend(iso_year, iso_week):
    """Python copy of isoWeekMonth() in app/Vigil.tsx: month of the Thursday of the ISO week."""
    jan4 = date(iso_year, 1, 4)
    dow = jan4.isoweekday()
    thu = jan4 + timedelta(days=(iso_week - 1) * 7 + (4 - dow))
    return thu.year, thu.month


def test_every_month_maps_back_to_itself_in_the_frontend():
    for annee in range(2002, 2027):
        for mois in range(1, 13):
            assert iso_week_month_frontend(*semaine_iso(annee, mois)) == (annee, mois)


def test_source_boundaries():
    assert source(2012, 1) == "modis_only"
    assert source(2012, 2) == "both"
    assert source(2020, 10) == "both"
    assert source(2020, 11) == "viirs_converted"


def test_band_is_exact_when_aqua_observed_and_never_negative():
    v = np.array([0.0, 3.0, 40.0, 900.0])
    bas, haut = bornes(v, np.array([False] * 4), Q)
    assert np.allclose(bas, v) and np.allclose(haut, v)
    bas, haut = bornes(v, np.array([True] * 4), Q)
    assert (bas >= 0).all() and (bas <= v).all() and (haut >= v).all()
