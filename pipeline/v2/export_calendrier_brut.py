"""Raw (non-harmonized) monthly calendars of one country, next to its harmonized series (Greece by default).

Purpose: show what harmonization changes, all other things being equal. The raw series use EXACTLY the same
cleaned daily tables (monde/jour = counts, monde/jourfrp = FRP), the same country assignment and the same
day-by-day satellite rule as the published harmonized series (mondial_calibration / mondial_frp):
  - Aqua on Aqua-observed days;
  - VIIRS = S-NPP on S-NPP-observed days, NOAA-20 on days with NOAA-20 data and no S-NPP data.
The only thing that differs between the series is the conversion factor (k, rho):

  naif_2012    Aqua until 2012-01, then raw VIIRS from 2012-02 (first complete S-NPP month): the naive splice
               that creates the classic false jump in 2012.
  brut_2020    Aqua until 2020-10, then raw VIIRS from 2020-11 (same switch date as VIGIL-K1, NOT converted).
  harmonise    published VIGIL-K1 series (serie_mensuelle_pays.csv / serie_frp_mensuelle_pays.csv), copied as is.
  satellites   raw monthly totals of each satellite (Terra, Aqua, S-NPP, NOAA-20), all its observed days.

Check written into the file and asserted: brut_2020 == harmonise for every month before the switch (both are
Aqua observed), to 0.01.

Command (backend PC, after `mondial calibrer` and `mondial calibrer-frp`):
    python -m pipeline.v2.export_calendrier_brut --pays Greece --site public/data
Output: <site>/brut/<pays>.json (a few tens of kB).
"""
import argparse
import glob
import json
import os
from datetime import datetime

import numpy as np
import pandas as pd

from . import parametres as P
from .harmonisation import BASCULE
from .mondial_calibration import jours_observes

BASCULE_NAIVE = pd.Timestamp("2012-02-01")   # first complete month of S-NPP data (S-NPP starts 2012-01-20)
SATS = ["Terra", "Aqua", "SNPP", "NOAA20"]


def _lire(dossier, sous, pays, col):
    fs = glob.glob(os.path.join(dossier, sous, "*.parquet"))
    J = pd.concat([pd.read_parquet(f, columns=["pays", "acq_date", "satellite", col], filters=[("pays", "==", pays)])
                   for f in fs], ignore_index=True)
    J["acq_date"] = pd.to_datetime(J["acq_date"])
    return J[J["satellite"].isin(SATS)]


def series_brutes(J, col, obs, mois):
    """Monthly raw series of one value column (n_vegetation or frp_vegetation). Returns a DataFrame indexed by month."""
    d = J.groupby(["acq_date", "satellite"])[col].sum().astype(float).unstack("satellite", fill_value=0.0)
    for s in SATS:
        if s not in d.columns:
            d[s] = 0.0
    j = d.index
    o = {s: j.isin(obs[s]) for s in obs}
    aqua = np.where(o["Aqua"], d["Aqua"], 0.0)
    viirs = np.where(o["SNPP"], d["SNPP"], np.where(o["NOAA20"] & ~o["SNPP"], d["NOAA20"], 0.0))
    t = pd.DataFrame({"aqua_jours_obs": aqua, "viirs": viirs}, index=j)
    for s in SATS:
        t[s] = d[s]
    m = t.groupby(t.index.to_period("M")).sum().reindex(mois, fill_value=0.0)
    debut = mois.to_timestamp()
    m["naif_2012"] = np.where(debut < BASCULE_NAIVE, m["aqua_jours_obs"], m["viirs"])
    m["brut_2020"] = np.where(debut < BASCULE, m["aqua_jours_obs"], m["viirs"])
    return m


def exporter(pays, sortie, site):
    dossier = os.path.join(sortie, "monde")
    jsd = pd.read_csv(os.path.join(os.path.dirname(__file__), P.FICHIER_JOURS_SANS_DONNEES))
    Jn = _lire(dossier, "jour", pays, "n_vegetation")
    Jf = _lire(dossier, "jourfrp", pays, "frp_vegetation")
    fin = max(pd.concat([pd.read_parquet(f, columns=["acq_date"]) for f in glob.glob(os.path.join(dossier, "jour", "*2026*.parquet"))])["acq_date"].pipe(pd.to_datetime).max(),
              Jn["acq_date"].max())
    obs = {s: jours_observes(s, jsd, fin) for s in ["Aqua", "SNPP", "NOAA20"]}
    mois = pd.period_range("2002-01", fin, freq="M")
    n = series_brutes(Jn, "n_vegetation", obs, mois)
    f = series_brutes(Jf, "frp_vegetation", obs, mois)

    h = pd.read_csv(os.path.join(dossier, "serie_mensuelle_pays.csv"))
    h = h[h["pays"] == pays].assign(m=lambda x: pd.PeriodIndex.from_fields(year=x["annee"], month=x["mois"], freq="M")).set_index("m")
    hf = pd.read_csv(os.path.join(dossier, "serie_frp_mensuelle_pays.csv"))
    hf = hf[hf["pays"] == pays].assign(m=lambda x: pd.PeriodIndex.from_fields(year=x["annee"], month=x["mois"], freq="M")).set_index("m")
    n["harmonise"] = h["valeur"].reindex(mois)
    f["harmonise"] = hf["frp_MW"].reindex(mois)

    # Aqua observed months (before the switch, from the first Aqua month): raw == harmonized, by construction
    # months holding Aqua outage days filled with converted S-NPP are "mixed": raw and harmonized differ there on purpose
    pannes = pd.to_datetime(jsd.loc[jsd["satellite"] == "Aqua", "date"])
    mixtes = sorted({str(d.to_period("M")) for d in pannes if d < BASCULE and d in obs["SNPP"]})
    avant = (mois.to_timestamp() < BASCULE) & (mois >= pd.Period(P.DEBUT_DONNEES_FIRMS["Aqua"], "M")) & ~mois.astype(str).isin(mixtes)
    ecart_n = float(np.nanmax(np.abs(n.loc[avant, "brut_2020"] - n.loc[avant, "harmonise"])))
    ecart_f = float(np.nanmax(np.abs(f.loc[avant, "brut_2020"] - f.loc[avant, "harmonise"])))
    assert ecart_n < 0.01 and ecart_f < 0.01, (ecart_n, ecart_f)

    apres = mois.to_timestamp() >= BASCULE
    complet = apres & (mois < pd.Period(fin, "M"))
    ratio = float(n.loc[complet, "harmonise"].sum() / max(n.loc[complet, "viirs"].sum(), 1))
    ratio_f = float(f.loc[complet, "harmonise"].sum() / max(f.loc[complet, "viirs"].sum(), 1))

    def col(t, c, nd=2):
        v = t[c].to_numpy(float)
        return [None if np.isnan(x) else round(float(x), nd) for x in v]

    aqua_debut = pd.Period(P.DEBUT_DONNEES_FIRMS["Aqua"], "M")
    out = {
        "pays": pays,
        "genere_le": datetime.now().isoformat(timespec="seconds"),
        "premier_mois": str(mois[0]),
        "dernier_mois": str(mois[-1]),
        "mois_partiel": str(mois[-1]) if pd.Timestamp(fin) < (mois[-1] + 1).to_timestamp() - pd.Timedelta(days=1) else None,
        "donnees_jusqu_au": str(pd.Timestamp(fin).date()),
        "premier_mois_aqua": str(aqua_debut),
        "bascule_naive": str(BASCULE_NAIVE.date()),
        "bascule_vigil": str(BASCULE.date()),
        "unite": {"hotspots": "detections (vegetation fires, cleaned)", "frp": "sum of FRP of the detections, MW"},
        "regle_satellites": "Aqua on Aqua-observed days; VIIRS = S-NPP on S-NPP-observed days, NOAA-20 on days without S-NPP data",
        "controle": {"max_ecart_brut2020_vs_harmonise_avant_bascule": {"hotspots": ecart_n, "frp": ecart_f},
                     "ratio_harmonise_sur_viirs_brut_depuis_bascule": {"hotspots": ratio, "frp": ratio_f}},
        "hotspots": {c: col(n, c) for c in ["naif_2012", "brut_2020", "harmonise", "Terra", "Aqua", "SNPP", "NOAA20"]},
        "frp_MW": {c: col(f, c, 1) for c in ["naif_2012", "brut_2020", "harmonise", "Terra", "Aqua", "SNPP", "NOAA20"]},
    }
    # months before Aqua's first data: the Aqua-based series have no data (not zero)
    nb_avant = int((mois < aqua_debut).sum())
    for bloc in ("hotspots", "frp_MW"):
        for c in ("naif_2012", "brut_2020", "Aqua"):
            out[bloc][c][:nb_avant] = [None] * nb_avant
    os.makedirs(os.path.join(site, "brut"), exist_ok=True)
    chemin = os.path.join(site, "brut", f"{pays}.json")
    with open(chemin, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    return chemin, out


def main(argv=None):
    ap = argparse.ArgumentParser(description="Vigil v2 - raw vs harmonized calendars of one country")
    ap.add_argument("--pays", default="Greece")
    ap.add_argument("--sortie", default=P.DOSSIER_SORTIE)
    ap.add_argument("--site", default="public/data")
    a = ap.parse_args(argv)
    chemin, out = exporter(a.pays, a.sortie, a.site)
    c = out["controle"]
    print(f"{chemin} : {out['premier_mois']} -> {out['dernier_mois']} (donnees jusqu'au {out['donnees_jusqu_au']})")
    print(f"  controle brut_2020 == harmonise avant {out['bascule_vigil']} : ecart max {c['max_ecart_brut2020_vs_harmonise_avant_bascule']}")
    print(f"  harmonise / VIIRS brut depuis la bascule : {c['ratio_harmonise_sur_viirs_brut_depuis_bascule']}")


if __name__ == "__main__":
    main()
