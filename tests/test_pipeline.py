import numpy as np, pandas as pd, pytest
from pipeline import config as C
from pipeline.schema import validate, ValidationError
from pipeline.clean import clean
from pipeline.grid import weekly_fire_days
from pipeline.harmonize import harmonize


def modis_df(rows):
    return pd.DataFrame(rows, columns=["latitude", "longitude", "acq_date", "confidence", "satellite", "type", "frp"]
                        ).assign(brightness=330.0, daynight="D")


def test_sensor_detection_and_errors():
    df = modis_df([[44.5, -0.5, "2019-07-01", 80, "Aqua", 0, 10]])
    assert validate(df)[1] == "modis"
    with pytest.raises(ValidationError, match="Missing column 'confidence'"):
        validate(df.drop(columns="confidence"))
    with pytest.raises(ValidationError, match="Could not detect"):
        validate(df.drop(columns="brightness"))
    with pytest.raises(ValidationError, match="outside the sensor's lifetime"):
        validate(df.assign(acq_date="1999-01-01"))


def test_clean_filters():
    df, s = validate(modis_df([
        [44.5, -0.5, "2019-07-01", 80, "Aqua", 0, 10],   # keep
        [44.5, -0.5, "2019-07-01", 10, "Aqua", 0, 10],   # low conf
        [44.5, -0.5, "2019-07-02", 80, "Terra", 0, 10],  # wrong sat
        [44.5, -0.5, "2019-07-03", 80, "Aqua", 2, 10],   # static
    ]))
    out = clean(df, s)
    assert len(out) == 1 and out.loc[0, "confidence_raw"] == 80


def test_weekly_fire_days_counts_days_not_hotspots():
    df, s = validate(modis_df([[44.51, -0.49, "2019-07-01", 80, "Aqua", 0, 5]] * 3 +
                              [[44.52, -0.48, "2019-07-02", 80, "Aqua", 0, 5]]))
    w = weekly_fire_days(df)
    assert w["fire_days"].iloc[0] == 2 and w["hotspot_count"].iloc[0] == 4


def test_harmonize_contract_and_conversion():
    rng = np.random.default_rng(0)
    base = pd.DataFrame({"ilat": 445, "ilon": np.arange(-10, 10).repeat(2), "iso_year": 2019,
                         "iso_week": np.tile([27, 28], 20)})
    v = rng.integers(1, 6, len(base))
    modis_w = base.assign(fire_days=np.minimum(7, (v * 0.5).round().astype(int)))
    viirs_w = base.assign(fire_days=v)
    extra = viirs_w.assign(iso_year=2015)  # VIIRS-only era
    out, params = harmonize(modis_w, pd.concat([viirs_w, extra]))
    assert list(out.columns) == C.OUTPUT_COLUMNS
    assert set(out["source"]) == {"both", "viirs_converted"}
    old = out[out.iso_year == 2015]
    assert old["modis_fire_days"].isna().all()
    assert (out["harmonized_low"] <= out["harmonized_fire_days"]).all()
    assert (out["harmonized_fire_days"] <= out["harmonized_high"]).all()
    assert (old["harmonized_high"] > old["harmonized_low"]).any()
    assert 0.3 < params["other"]["k"] < 0.7
    assert out[["harmonized_low", "harmonized_high"]].min().min() >= 0
