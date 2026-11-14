"""Parameters of the v2 pipeline. Every value here was checked on the real FIRMS files
(audits of 14 Nov 2026) unless marked as a choice."""
from datetime import date

# Default local folders (outside Git: the repo is public, data never goes in it)
DOSSIER_BRUT = r"C:\Hackathon-NASA\Donnees-FIRMS"
DOSSIER_SORTIE = r"C:\Hackathon-NASA\Donnees-propres"
FICHIER_FRONTIERES = r"C:\Hackathon-NASA\Referentiels\ne_10m_admin_0_countries.geojson"
# Natural Earth pinned to release v5.1.2 (public domain) + expected SHA-256, for reproducibility
URL_FRONTIERES = ("https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/"
                  "geojson/ne_10m_admin_0_countries.geojson")
SHA256_FRONTIERES = "239eec57ac17f100a11e2536cffc56752c318b50ae765b0918ff7aab4ce8f255"

# Coastal tolerance: a point outside every polygon is assigned to the nearest country if it is
# closer than this. Measured on the Greece files: 4.2 % of points fall outside the Natural Earth
# polygon (mostly industrial/offshore), median 0.25 km, 90 % < 1.25 km from the coast.
TOLERANCE_COTE_KM = 2.0

# Folders of FIRMS yearly country files: <brut>/<dossier>/<year>/<dossier>_<year>_<Country>.csv
DOSSIERS_ANNUELS = ["modis", "viirs-snpp", "viirs-jpss1"]

# 2026 "World" downloads of the FIRMS form (the Argentina ones are not used for Greece)
DEMANDES_MONDE_2026 = ["DL_FIRE_M-C61_846262", "DL_FIRE_SV-C2_846272", "DL_FIRE_J1V-C2_846267"]

# Raw satellite codes seen in the files -> normalized code
CODES_SATELLITES = {
    "TERRA": "Terra", "T": "Terra",
    "AQUA": "Aqua", "A": "Aqua",
    "N": "SNPP", "SNPP": "SNPP", "S-NPP": "SNPP", "SUOMI-NPP": "SNPP", "NPP": "SNPP",
    "N20": "NOAA20", "NOAA-20": "NOAA20", "NOAA20": "NOAA20", "J1": "NOAA20", "1": "NOAA20",
    "N21": "NOAA21", "NOAA-21": "NOAA21", "NOAA21": "NOAA21", "J2": "NOAA21",
}
INSTRUMENT = {"Terra": "MODIS", "Aqua": "MODIS", "SNPP": "VIIRS", "NOAA20": "VIIRS", "NOAA21": "VIIRS"}

# Lifetime of each satellite (first possible date, last possible date or None = today)
VIE_SATELLITES = {
    "Terra": (date(2000, 2, 24), None),
    "Aqua": (date(2002, 7, 4), None),
    "SNPP": (date(2012, 1, 19), date(2026, 11, 2)),
    "NOAA20": (date(2017, 11, 29), None),
    "NOAA21": (date(2022, 11, 10), None),
}

# First date with data in the FIRMS files (measured), used to know when a satellite OBSERVES.
# Differs from the launch date (e.g. NOAA-20 launched 2017-11-18, FIRMS data from 2018-04-01):
# before this date a satellite means "not observed", never "0 fire".
DEBUT_DONNEES_FIRMS = {"Terra": date(2000, 11, 1), "Aqua": date(2002, 7, 4), "SNPP": date(2012, 1, 20),
                       "NOAA20": date(2018, 4, 1), "NOAA21": date(2023, 3, 1)}

# Confidence: MODIS 0-100 (low <30, nominal 30-79, high >=80); VIIRS l/n/h
SEUIL_MODIS_NOMINAL = 30
SEUIL_MODIS_HAUT = 80
CLASSES_VIIRS = {"l": "low", "n": "nominal", "h": "high"}
CLASSES_GARDEES = {"nominal", "high"}

# FIRMS 'type' column
TYPES_STATIQUES = {1: "volcan", 2: "industriel", 3: "offshore"}

# Static-site mask for NRT rows (no 'type'). Learned on all sensors from rows whose FIRMS 'type'
# is known; resolution and neighbour ring chosen PER INSTRUMENT on 2024 (validation), reported
# on 2025 (test). Measured: VIIRS sens ~0.94 / spec ~0.98; MODIS sens ~0.45 only (documented limit).
MASQUE_RESOLUTIONS_CANDIDATES = [7, 8]
MASQUE_ANNEAUX_CANDIDATS = [0, 1]   # 1 = also the 6 neighbouring cells
MASQUE_MIN_DETECTIONS = 3      # choice: a site must be seen at least 3 times
MASQUE_PART_MIN = 0.5          # choice: at least half of its detections typed static

# Near-duplicates (Fu et al. 2020, doi:10.3390/rs12182870): same satellite, same granule
# (date + time), centres closer than half a pixel -> counted once. Measured ~6-8 % for every
# satellite, day and night alike, so the MODIS/VIIRS ratio is not distorted.
QUASI_DOUBLON_FRACTION_PIXEL = 0.5

# Days with ZERO detections worldwide (satellite outage), generated (not typed) from the full
# FIRMS archive scan: audits/donnees_firms_resume/daily_gaps.csv, rows flagged "zero".
# A day listed there means "not observed", not "no fire". 138 days: Terra 57, SNPP 49, Aqua 26, NOAA20 6.
FICHIER_JOURS_SANS_DONNEES = "jours_sans_donnees.csv"   # next to this file

# Spatial base grid (contract v2: H3 resolution 6, ~36 km2)
H3_RESOLUTION = 6

# Regions: countries whose yearly files are read + Natural Earth names used for the polygon test.
# The same polygons are applied to every year and every product (consistency 2000-2026).
REGIONS = {
    "grece": {
        "fichiers_pays": ["Greece", "Albania", "Macedonia_Former_Yugoslav_Republic_of", "Bulgaria", "Turkey"],
        "pays_ne": ["Greece", "Albania", "North Macedonia", "Bulgaria", "Turkey"],
        "pays_demo": "Greece",
    },
}
