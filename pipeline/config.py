"""Constants taken from the Vigil project spec (pillars 1-6)."""
from datetime import date

CELL_DEG = 0.1
MAX_UPLOAD_MB = 50

# Sensor lifetime (start dates); end = today.
SENSOR_START = {
    "modis": date(2000, 11, 1),   # Terra; Aqua starts 2002-07
    "viirs": date(2012, 1, 1),    # S-NPP
}

# Satellite codes kept for calibration. verify_on_saturday: check real files.
KEEP_SATELLITES = {
    "modis": {"Aqua", "A"},
    "viirs": {"N", "Suomi-NPP", "S-NPP", "NPP"},
}

MODIS_CONF_BINS = {"low": (0, 29), "nominal": (30, 79), "high": (80, 100)}
VIIRS_CONF_MAP = {"l": "low", "n": "nominal", "h": "high",
                  "low": "low", "nominal": "nominal", "high": "high"}
KEEP_CONFIDENCE = ("nominal", "high")

REQUIRED_COLUMNS = ["latitude", "longitude", "acq_date", "confidence"]

ERRORS = {
    "missing_column": "Missing column '{col}'. This does not look like a FIRMS export.",
    "unknown_sensor": "Could not detect MODIS or VIIRS from the columns.",
    "bad_dates": "Some dates are outside the sensor's lifetime ({sensor}: {start} to today).",
    "too_large": "File is larger than {max_mb} MB. Please select a smaller area or period.",
    "bad_coords": "Some coordinates are outside valid ranges.",
    "not_csv": "File is not a readable CSV.",
}

LAND_COVER_CLASSES = ("forest", "cropland", "shrub_grass", "other")

# FROZEN output contract (pillar 6) -- do not change without team agreement.
OUTPUT_COLUMNS = [
    "cell_id", "lat", "lon", "iso_year", "iso_week",
    "modis_fire_days", "viirs_fire_days",
    "harmonized_fire_days", "harmonized_low", "harmonized_high",
    "land_cover_class", "source",
]
