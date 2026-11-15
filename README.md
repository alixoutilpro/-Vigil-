# Vigil — a harmonized MODIS + VIIRS fire calendar, 2002 → today

**NASA Space Apps Challenge 2026 · Paris · Challenge: *Harmonization of MODIS and VIIRS Hot Spots***

MODIS (Terra, Aqua) has recorded active fires since 2000 but reaches its end of life in 2027. VIIRS (S-NPP, NOAA-20, NOAA-21) replaces it, with 375 m pixels instead of 1 km: it sees **many more, smaller fires**. Stitching the two records naively creates a false increase in fire activity. Without a harmonization, **~10 years of history** stop being comparable with today, and fire managers lose their burning calendars.

Vigil converts every VIIRS detection into a **MODIS-Aqua-equivalent** count, with a calibrated uncertainty band. It serves the result in a web application where the sensor of origin no longer matters: only patterns, trends and anomalies do.

| Same country (Greece), same detections, same cleaning | Monthly hotspots, Feb 2012 – Oct 2020 |
|---|---|
| Naive splice (Aqua until 2012, raw VIIRS after) | **×6.02** the MODIS-Aqua reference: a sensor artefact, not more fire |
| Vigil (VIGIL-K1) | Aqua observed until Oct 2020, VIIRS converted after; validated out of sample (below) |

---

## 1. What the application does

| Challenge requirement | In Vigil |
|---|---|
| Harmonize MODIS and VIIRS into one consistent series (E1, E2) | VIGIL-K1 conversion, k per country × day/night × month; provenance (`modis_observed` / `viirs_converted`) and an 80 % band on every converted month |
| Web app taking harmonized data as input (E3) | Next.js + MapLibre; static files produced by the pipeline (`public/data/`, contract `docs/contrat_donnees_v2.md`) |
| Select a region and a date range (E4) | Search a **country**, draw a **box or polygon**, or type **latitude / longitude / size**; study period from–to (month) |
| Burning calendar, number of hotspots, early 2000s → present (E5) | Year × month calendar from **July 2002** (first Aqua month) to **November 2026** (data until 2026-11-07) |
| Which months / years burn most, how the current fire compares (E6) | Anomaly calendar, peak month and fire-season length, annual totals and rank, year-to-date vs normal |
| Current month vs **historical median** (E7) | Median 2003–2025 of the same month, % of median, percentile rank, 5-class verdict |
| Download analytics and visualizations (E8) | CSV of the zone series (with bands and provenance), PNG of the calendar |
| CSV of the hotspots of a search (E9) | Every raw FIRMS detection of the zone and period (Greece), all original columns + why a point is not counted |
| Accessible colour ramps (E10) | Colour-blind-safe sequential (yellow → dark red) and diverging (blue ↔ red) ramps, always doubled by numbers |

**Three ways to look at the data**
- **World map, H3 hexagons**: harmonized density per 1,000 km² and per month. The cell size follows the zoom (~110 km → ~42 km → ~17 km). Hovering a hexagon shows the country, detections, density class, Σ FRP, FRP per detection and the source.
- **Country mode**: the validated country × month series (238 FIRMS countries and territories), with its reliability.
- **Greece, fire by fire**: every satellite detection of the month on the map (MODIS / VIIRS / not counted). Hovering shows date, UTC time, satellite, FRP and confidence. The Greek calendar has **3 tabs**: *Raw · naive 2012*, *Raw · switch 2020*, *Harmonized*. All three use the same cleaning and colour scale, so the only difference you see is the effect of the harmonization.

**Two interfaces** (selector at the top of the page): *Vigil Analytics*, described here, and *Vigil Trends*: wildfire hubs found by space-time clustering, each with an exposure score (1–100) and a bootstrap confidence (`docs/methode_tf.md`).

**Map**: 3D globe by default; 2D in Gall-Peters (equal-area, so densities compare fairly across latitudes) or Mercator; colour-blind mode; a slider hides hexagons under a chosen density.

**Analyst dashboard** (expand button of the analytics panel):
- KPIs of the focus month: value and band, median, percentile range across the band, class.
- Year to date, last 12 months, peak month and season, Sen trend with Mann–Kendall test, intensity (MW per detection).
- An anomaly calendar whose top row is the 2003–2025 median of each month.
- A monthly climatology table: n, min, P10, Q1, median with its 95 % CI, mean, Q3, P90, max, SD, CV.
- Annual totals with P10–P90 band, and FRP profiles.

Every metric has a hover definition.

---

## 2. Method

### 2.1 Pipeline (Python, `pipeline/v2/`)

```
NASA FIRMS CSV (43 GB, 10,191 country-year files + 2026 archive/NRT files)
  → clean      confidence ≥ nominal, volcanoes/offshore removed, fixed industrial sites removed
               (FIRMS `type`, + a persistence mask for 2026 NRT rows that have no `type`), exact and near duplicates
  → aggregate  country × day × satellite × day/night, and H3 res-5 hexagon × month (DuckDB + h3)
  → harmonize  VIGIL-K1 (counts) and VIGIL-K1-FRP (fire radiative power)
  → export     static files for the web app (public/data/)
```

Every step counts what it removes. The Greek funnel is in `Donnees-propres/grece/entonnoir.csv`, produced by `pipeline/v2/nettoyage.py`.

### 2.2 VIGIL-K1 (full study: `docs/methode_k.md`, reproducible with `etudes/etude_k.py`)

| Choice | Decision | Evidence |
|---|---|---|
| Reference sensor | **MODIS Aqua** | The Terra/Aqua ratio drifts (Mann–Kendall p = 0.0003) |
| Calibration window | **2012-02 → 2020-10** | Pettitt change point of the Aqua/S-NPP daytime ratio in 2020-11 (p = 0.006, regional study): Aqua orbit drift. The same test on the pooled world ratio is not conclusive (p = 0.17) and is not used as evidence |
| Published value | Aqua **observed** before 2020-11, VIIRS **converted** after | A valid observation is never replaced by an estimate |
| Estimator | ratio of totals k = ΣAqua / ΣVIIRS (Poisson maximum likelihood) | Unbiased; mean or median of ratios are biased by −9 % to −60 % |
| Stratification | country × day/night × calendar month, gamma–Poisson shrinkage toward the sub-region (α = 30 for the world, chosen by cross-validation; the regional study of `docs/methode_k.md` found α = 10 on 5 countries) | Small countries borrow strength, large ones keep their own k |
| NOAA-20 | chained to S-NPP (ρ = ΣS-NPP / ΣNOAA-20 per day/night × month, median ≈ 0.97); used on S-NPP outage days and after S-NPP's end (2 Nov 2026) | S-NPP and NOAA-20 are never summed (that would double-count fires) |
| Uncertainty | split-conformal, Mondrian by size class, on log(1 + x) → 80 % and 95 % bands, never negative | Observed coverage 79.8 % (80 %) and 94.9 % (95 %) |
| FRP | its own k (VIGIL-K1-FRP), same design | Reusing the count k for FRP would bias it by −75 % |

### 2.3 Validation: leave-one-year-out, world, 235 countries, 20,235 country-months

Each year is predicted by a model that never saw it.

| | R² | R² of anomalies* | RMSE / SD | Bias | Skill vs one global k |
|---|---|---|---|---|---|
| Hotspots, country × month | 0.996 | **0.948** | 0.062 (global k: 0.181) | −0.03 % | **0.88** |
| Σ FRP, country × month | 0.991 | 0.940 | 0.095 | −0.26 % | 0.72 vs a global ratio |
| Hotspots, 2° cells (~222 km) | 0.974 | 0.826 | 0.162 | +0.57 % | 0.57 |
| Hotspots, 0.5° cells (~56 km) | 0.939 | 0.794 | 0.246 | +0.57 % | 0.38 |

\* Anomalies = value minus the mean of the same month. This is the hard part: seasonality alone already gives a high plain R².

Mean Poisson deviance 12.70; observed coverage of the bands 79.7 % (80 %) and 94.9 % (95 %).

Country reliability shown in the app (235 calibrated countries): 127 high, 24 medium, 84 low.

### 2.4 Statistics shown (`app/zone.ts`, `app/stats.ts`, tested in `scripts/test_stats.mjs`)

- **Baseline**: complete years 2003–2025. 2002 starts in July and 2026 is ongoing, so neither enters a baseline.
- **Quantiles**: Hyndman–Fan type 8. The percentile rank PR = 100 · (below + ½ · equal) / n excludes the year itself.
- **Classes**: below P10 · P10–P33 · P33–P67 · P67–P90 · above P90.
- **Converted months**: the percentile is also given at both ends of the 80 % band. A record is claimed only when the whole band exceeds the historical maximum.
- **Robustness**: the 95 % confidence interval of a median uses order statistics (distribution-free). The trend is Sen's slope with a Mann–Kendall test on annual totals.
- **Partial periods** (the current month, the current year) are never compared with complete ones. They are compared year-to-date (same months) or flagged "partial".
- **Rule**: hexagons are summed first, statistics come after. There is never a median of medians, and band bounds are never summed: bands of different months are correlated through k.
- All figures were cross-checked against an independent numpy computation. Example, Greece: Oct 2026 = 71 detections, median 153, 47 % of median, PR 26.

### 2.5 Map colours (`docs/legende_carte.md`)

- **Value**: density per 1,000 km² per month. H3 cells differ in area, and the drawn resolution changes with the zoom.
- **12 fixed classes**, identical at every zoom and month, with near-geometric steps (×2–2.5).
- The class 3–7 is anchored on *one detection in a ~17 km cell*, so colour never encodes cell area.
- Occupancy was checked on 13.5 M hexagon-months: no empty class, none above 28 %.

---

## 3. Data

| Source | Product | Use |
|---|---|---|
| NASA FIRMS, MODIS | Collection 6.1 (Terra, Aqua), 1 km | Aqua = reference |
| NASA FIRMS, VIIRS S-NPP | 375 m, Collection 2 (2012-01 → 2026-11-02) | converted |
| NASA FIRMS, VIIRS NOAA-20 | 375 m, Collection 2 (2018-04 → ) | converted, chained to S-NPP |
| Natural Earth v5.1.2 | admin-0 boundaries | sub-regions for k shrinkage |

- **2000–2025**: FIRMS yearly country files.
- **2026**: FIRMS archive download, world, through 2026-11-07; NRT rows after the archive end. These files carry no country: it is assigned by `pipeline/v2/attribution_pays.py` (Natural Earth polygon, then cell history, then H3 parent), right for 99.94 % of detections on held-out years; 0.037 % of 2026 hotspots stay without a country and are counted in `index.json`.
- Weather in the dashboard (optional): Meteomatics API, descriptive only. It needs `MM_USER` / `MM_PASS` as server environment variables, and the dashboard degrades cleanly without them.

---

## 4. Limitations (read before using the numbers)

1. **Series start in July 2002** (Aqua). Terra (from Nov 2000) is not used as a reference because its ratio to Aqua drifts.
2. **Stationarity assumption**: the VIIRS ↔ pre-drift Aqua relation calibrated on 2012–2020 is assumed to hold after 2020.
   - Supported by the stability of ρ (NOAA-20 / S-NPP) and by converted S-NPP and NOAA-20 agreeing within 5 % per year.
   - It cannot be checked against a stable MODIS after 2020, because Aqua itself drifts.
3. **Below country scale** the conversion is less precise (anomaly R² ≈ 0.8, median error ≈ 16 % on months ≥ 50 detections). The app uses a sub-country uncertainty table there, and flags zones smaller than the tested ones.
4. **Low-reliability countries** (few detections) have wide bands; the app shows the reliability.
5. **2026 near-real-time rows** (from Aug 2026) have no FIRMS `type` column. Fixed industrial sites are removed with a persistence mask, tested on the Greek region where `type` is known (2025 held out).
   - For **VIIRS**, the source of every published value since Nov 2020, the mask catches **96 %** of fixed-site detections on the held-out year (97 % on 2024).
   - For **MODIS** it catches only **43 %**. This affects only raw MODIS views of those months.
   - **November 2026 is partial** (until the 7th).
6. **Industrial fires** (FIRMS type 2) are excluded, a team decision: Vigil tracks vegetation fires. Volcanoes and offshore flares are always excluded.
   - FIRMS labels some fixed industrial sites as vegetation fires (type 0). Measured on Aqua 2010: 0.5 % of detections worldwide, but 52 % in Saudi Arabia, 22 % in Iran, 13 % in Italy, 8 % in France. Not corrected: read those countries with care.
7. **A detection is not a fire**: one fire is seen by several passes and satellites. Totals are detections, MODIS-Aqua equivalent, and Σ FRP is a sum of instantaneous powers (MW), not an energy.
8. **Border hexagons** can hold detections of two countries. In country mode the totals come from the country series, not from summing hexagons.
9. **Point-level export (E9)** is available for Greece only. Elsewhere the export is the monthly zone series plus hexagon-months.

---

## 5. Run it

**Web app** (data already in `public/data/`):
```bash
npm install
npm run dev        # http://localhost:3000
```

**Pipeline** (backend PC with the raw FIRMS files; paths in `pipeline/v2/parametres.py`):
```bash
python -m pip install -r requirements.txt
python -m pipeline.v2.mondial agreger
python -m pipeline.v2.mondial agreger --tables hex,jourfrp
python -m pipeline.v2.mondial calibrer
python -m pipeline.v2.mondial calibrer-frp
python -m pipeline.v2.nettoyage --region grece
python -m pipeline.v2.export_site --site public/data
python -m pipeline.v2.export_h3_pays --site public/data
python -m pipeline.v2.export_calendrier_brut --pays Greece --site public/data
```

**Tests**:
```bash
python -m pytest
node scripts/test_stats.mjs --greece
```

---

## 6. Repository

| Path | Content |
|---|---|
| `app/` | Web app: `Vigil.tsx` (map, panel), `DeepDive.tsx` (analyst dashboard), `zone.ts` / `stats.ts` (statistics), `donnees.ts` (data loaders) |
| `pipeline/v2/` | Cleaning, aggregation, calibration (VIGIL-K1, K1-FRP), exports |
| `etudes/` | Reproducible method studies (`etude_k.py`, sub-country validation) |
| `docs/` | `methode_k.md` (k study), `contrat_donnees_v2.md` (data contract), `legende_carte.md` (colour classes), `methode_tf.md` (Vigil Trends: wildfire hubs) |
| `tests/`, `scripts/` | Python tests, statistics tests (JS vs numpy) |
| `public/data/` | Pre-computed static data served to the app (no raw data, no keys) |

Data: NASA FIRMS (Fire Information for Resource Management System), NASA Earthdata. Built by team Vigil for NASA Space Apps Challenge 2026, Paris.
