"""Raw calendars: same day-by-day satellite rule as the harmonized series, only the conversion differs."""
import pandas as pd

from pipeline.v2.export_calendrier_brut import series_brutes


def _J(lignes):
    J = pd.DataFrame(lignes, columns=["acq_date", "satellite", "n_vegetation"])
    J["acq_date"] = pd.to_datetime(J["acq_date"])
    return J


def test_regle_satellites_et_bascules():
    J = _J([
        ("2011-12-05", "Aqua", 4), ("2011-12-05", "Terra", 9),          # Terra never enters a series
        ("2012-03-01", "Aqua", 2), ("2012-03-01", "SNPP", 12),
        ("2020-11-02", "Aqua", 3), ("2020-11-02", "SNPP", 20), ("2020-11-02", "NOAA20", 25),  # S-NPP observed: NOAA-20 ignored
        ("2020-11-03", "NOAA20", 7),                                      # S-NPP gap day: NOAA-20 used
        ("2020-11-04", "Aqua", 5),                                        # Aqua day outside Aqua-observed days: ignored
    ])
    jours = pd.date_range("2011-12-01", "2020-11-30", freq="D")
    obs = {"Aqua": jours[jours != "2020-11-04"], "SNPP": jours[jours != "2020-11-03"], "NOAA20": jours}
    mois = pd.period_range("2011-12", "2020-11", freq="M")
    m = series_brutes(J, "n_vegetation", obs, mois)
    p = lambda s: pd.Period(s, "M")
    # naive splice: Aqua before 2012-02, VIIRS after
    assert m.loc[p("2011-12"), "naif_2012"] == 4
    assert m.loc[p("2012-03"), "naif_2012"] == 12
    # switch 2020-11: Aqua before, VIIRS (S-NPP, NOAA-20 on S-NPP gap days) after
    assert m.loc[p("2012-03"), "brut_2020"] == 2
    assert m.loc[p("2020-11"), "brut_2020"] == 20 + 7
    # per-satellite raw totals keep every row
    assert m.loc[p("2020-11"), "Aqua"] == 8 and m.loc[p("2011-12"), "Terra"] == 9
    # months without any detection are observed zeros
    assert m.loc[p("2015-06"), "brut_2020"] == 0
