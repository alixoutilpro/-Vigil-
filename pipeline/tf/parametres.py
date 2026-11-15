"""Parameters of the Trends & Forecasts pipeline (choices are justified in docs/methode_tf.md)."""
import os

from ..v2 import parametres as P2

SITE = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "public", "data")
CACHE = os.path.join(P2.DOSSIER_SORTIE, "tf")          # outside Git (covariate downloads, intermediate tables)
FRONTIERES = P2.FICHIER_FRONTIERES

RES = 4                      # H3 resolution of the analysis (~1,770 km2, ~42 km): parents of the res-5 site hexagons
AN0, AN1 = 2003, 2025        # complete calendar years of the harmonized series (2002 starts in July, 2026 is ongoing)
HORIZONS = [1, 2, 3, 4, 5]   # forecast horizons in years (origin = last complete year)

# "High-activity year" of a cell: annual mean density >= 1 harmonized detection per 1,000 km2 per month,
# i.e. the lower bound of map class 6/12 of the Analytics legend (docs/legende_carte.md). Absolute, same everywhere.
SEUIL_DENSITE = 1.0          # detections / 1,000 km2 / month, annual mean

# Temporal split of the TARGET years (never shuffled: the future must not leak into the past)
AN_TRAIN_MAX = 2017          # train:      targets <= 2017
AN_VALID = (2018, 2020)      # validation: model and hyper-parameter choice, conformal calibration
AN_TEST = (2021, 2025)       # test:       touched once, final metrics

# TerraClimate (Abatzoglou et al. 2018), monthly, ~4 km (see pipeline/tf/climat.py for the two access routes)
TC_URL = "http://thredds.northwestknowledge.net:8080/thredds/dodsC/TERRACLIMATE_ALL/data/TerraClimate_{var}_{an}.nc"
TC_VARS = ["vpd", "ppt", "soil", "def", "PDSI", "tmax", "aet", "ws"]
TC_PAS = 6                   # thredds route: 1 pixel out of 6 (0.25 degree: every res-4 cell holds >= 1 sample)
TC_AN0, TC_AN1 = 2001, 2025  # thredds route: years read
# Climate normal = mean of 5 years spread over 2002-2018 (one every 4 years: no single extreme year dominates),
# all BEFORE the test years (2021-2025): the climate features cannot leak the future.
TC_ANNEES_NORMALE = [2010, 2018, 2002, 2014, 2006]
