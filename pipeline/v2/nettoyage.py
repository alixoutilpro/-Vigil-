"""Phases 0-2 of the v2 pipeline for one region: inventory, cleaning, daily H3 aggregation,
cross-satellite consistency check.

Usage (from the repo root):
    .\\.venv\\Scripts\\python.exe -m pipeline.v2.nettoyage --region grece

Principles
- Every row read is accounted for in entonnoir.csv (no silent loss).
- ERRORS are removed or flagged per satellite (sensor-specific rules); EXTREME values are never
  removed (a large fire seen by all satellites is signal, not noise).
- Rows are flagged rather than deleted whenever the decision belongs to a later step.
Outputs go to <sortie>/<region>/ (outside Git: the repository is public).
"""
import argparse
import glob
import hashlib
import json
import os
import platform
import subprocess
import time
from datetime import date, datetime

import duckdb
import h3
import numpy as np
import pandas as pd
import shapely
from shapely.geometry import shape

from . import parametres as P

COLONNES = ["latitude", "longitude", "brightness", "bright_ti4", "bright_t31", "bright_ti5",
            "scan", "track", "acq_date", "acq_time", "satellite", "instrument", "confidence",
            "version", "frp", "daynight", "type", "filename"]
KM_PAR_DEGRE = 111.2


# ---------------------------------------------------------------- reading
def lister_fichiers(brut, region):
    annuels = []
    for dossier in P.DOSSIERS_ANNUELS:
        for pays in region["fichiers_pays"]:
            annuels += glob.glob(os.path.join(brut, dossier, "*", f"{dossier}_*_{pays}.csv"))
    formulaire = []
    for demande in P.DEMANDES_MONDE_2026:
        formulaire += glob.glob(os.path.join(brut, "2026-formulaire", demande, "fire_*.csv"))
    return sorted(annuels), sorted(formulaire)


def lire_csv(con, fichiers, bbox=None):
    """Read many CSVs at once as text (no silent type conversion), optionally inside a bbox."""
    liste = "[" + ",".join("'" + f.replace("'", "''") + "'" for f in fichiers) + "]"
    sql = (f"SELECT * FROM read_csv({liste}, union_by_name=true, all_varchar=true, "
           f"filename=true, header=true)")
    if bbox is not None:
        la0, la1, lo0, lo1 = bbox
        sql += (f" WHERE TRY_CAST(latitude AS DOUBLE) BETWEEN {la0} AND {la1}"
                f" AND TRY_CAST(longitude AS DOUBLE) BETWEEN {lo0} AND {lo1}")
    df = con.execute(sql).df()
    for c in COLONNES:
        if c not in df.columns:
            df[c] = None
    return df[COLONNES]


def sha256(chemin):
    h = hashlib.sha256()
    with open(chemin, "rb") as f:
        for bloc in iter(lambda: f.read(1 << 20), b""):
            h.update(bloc)
    return h.hexdigest()


def charger_frontieres(chemin, noms, sha_attendu=None):
    if not os.path.exists(chemin):
        raise SystemExit(f"Fichier des frontieres introuvable : {chemin}\nTelechargez-le depuis {P.URL_FRONTIERES}")
    empreinte = sha256(chemin)
    if sha_attendu and empreinte != sha_attendu:
        raise SystemExit(f"Empreinte inattendue pour {chemin} ({empreinte}). "
                         f"Retelechargez la version figee : {P.URL_FRONTIERES}")
    with open(chemin, encoding="utf-8") as f:
        gj = json.load(f)
    geoms = {feat["properties"].get("ADMIN"): shape(feat["geometry"])
             for feat in gj["features"] if feat["properties"].get("ADMIN") in noms}
    manquants = set(noms) - set(geoms)
    if manquants:
        raise SystemExit(f"Pays introuvables dans {chemin} : {sorted(manquants)}")
    for g in geoms.values():
        shapely.prepare(g)
    return geoms, empreinte


# ---------------------------------------------------------------- phase 0
def inventaire(df):
    g = df.groupby("filename", dropna=False)
    inv = pd.DataFrame({
        "lignes": g.size(),
        "satellites": g["satellite"].agg(lambda s: "|".join(sorted(set(s.dropna().astype(str))))),
        "versions": g["version"].agg(lambda s: "|".join(sorted(set(s.dropna().astype(str))))),
        "colonne_type_remplie": g["type"].agg(lambda s: bool(s.notna().any())),
        "colonnes_viirs_ti4": g["bright_ti4"].agg(lambda s: bool(s.notna().any())),
    }).reset_index()
    inv["fichier"] = inv["filename"].map(os.path.basename)
    return inv.drop(columns="filename")


# ---------------------------------------------------------------- phase 1
def normaliser(df):
    out = pd.DataFrame(index=df.index)
    fn = df["filename"].astype(str)
    out["fichier"] = fn.map(os.path.basename)
    out["origine"] = np.select([fn.str.contains("fire_archive"), fn.str.contains("fire_nrt")],
                               ["archive", "nrt"], default="sp_annuel")
    out["satellite_brut"] = df["satellite"].astype(str).str.strip()
    out["satellite"] = out["satellite_brut"].str.upper().map(P.CODES_SATELLITES)
    out["instrument"] = out["satellite"].map(P.INSTRUMENT)
    out["latitude"] = pd.to_numeric(df["latitude"], errors="coerce")
    out["longitude"] = pd.to_numeric(df["longitude"], errors="coerce")
    # VIIRS rows of the FIRMS form use MODIS column names: take whichever is filled
    out["bright_4um"] = pd.to_numeric(df["bright_ti4"].fillna(df["brightness"]), errors="coerce")
    out["bright_11um"] = pd.to_numeric(df["bright_ti5"].fillna(df["bright_t31"]), errors="coerce")
    out["scan"] = pd.to_numeric(df["scan"], errors="coerce")
    out["track"] = pd.to_numeric(df["track"], errors="coerce")
    out["frp"] = pd.to_numeric(df["frp"], errors="coerce")
    out["acq_date"] = pd.to_datetime(df["acq_date"], format="%Y-%m-%d", errors="coerce")
    out["acq_time"] = df["acq_time"].astype(str).str.strip().str.zfill(4)  # text: keep '0010'
    out["daynight"] = df["daynight"].astype(str).str.strip().str.upper()
    out["confidence_brut"] = df["confidence"].astype(str).str.strip()
    out["version"] = df["version"].astype(str).str.strip()
    out["type"] = pd.to_numeric(df["type"], errors="coerce").astype("Int64")
    return out


def valider(df, aujourdhui):
    """Exclusion reason of each row (None = valid). First failing rule wins."""
    raison = pd.Series(None, index=df.index, dtype=object)

    def poser(masque, motif):
        raison[masque & raison.isna()] = motif

    poser(df["satellite"].isna(), "satellite_inconnu")
    poser(df["latitude"].isna() | df["longitude"].isna()
          | ~df["latitude"].between(-90, 90) | ~df["longitude"].between(-180, 180),
          "coordonnees_invalides")
    poser(df["acq_date"].isna(), "date_invalide")
    hh = pd.to_numeric(df["acq_time"].str[:2], errors="coerce")
    mm = pd.to_numeric(df["acq_time"].str[2:], errors="coerce")
    poser(~df["acq_time"].str.fullmatch(r"\d{4}") | (hh > 23) | (mm > 59), "heure_invalide")
    poser(~df["daynight"].isin(["D", "N"]), "jour_nuit_invalide")
    debut = df["satellite"].map(lambda s: pd.Timestamp(P.VIE_SATELLITES[s][0]) if s in P.VIE_SATELLITES else pd.NaT)
    fin = df["satellite"].map(lambda s: pd.Timestamp(P.VIE_SATELLITES[s][1] or aujourdhui)
                              if s in P.VIE_SATELLITES else pd.NaT)
    poser((df["acq_date"] < debut) | (df["acq_date"] > fin), "hors_vie_satellite")
    # VIIRS 'low' at night only exists in the South Atlantic Anomaly: elsewhere it is a data error
    poser((df["instrument"] == "VIIRS") & (df["daynight"] == "N")
          & (df["confidence_brut"].str.lower() == "l"), "viirs_nuit_low_anormal")
    return raison


def assigner_pays(lat, lon, geoms, tolerance_km):
    """Country of each point: inside a polygon, else the nearest polygon closer than tolerance_km
    (degree distance x 111.2 km: over-estimates east-west distances, hence conservative)."""
    pays = np.full(len(lat), None, dtype=object)
    for nom, g in geoms.items():
        dedans = shapely.contains_xy(g, lon, lat)
        pays[dedans & (pays == None)] = nom  # noqa: E711
    reste = np.flatnonzero(pays == None)  # noqa: E711
    cotier = np.zeros(len(lat), dtype=bool)
    if len(reste):
        pts = shapely.points(lon[reste], lat[reste])
        noms = list(geoms)
        dist = np.vstack([shapely.distance(geoms[n], pts) * KM_PAR_DEGRE for n in noms])
        imin = dist.argmin(axis=0)
        proche = dist.min(axis=0) < tolerance_km
        pays[reste[proche]] = np.array(noms, dtype=object)[imin[proche]]
        cotier[reste[proche]] = True
    return pays, cotier


def doublons_exacts(df, ok):
    cle = (df["satellite"].astype(str) + "|" + df["acq_date"].dt.strftime("%Y-%m-%d") + "|" + df["acq_time"]
           + "|" + df["latitude"].round(4).astype(str) + "|" + df["longitude"].round(4).astype(str))
    dup = pd.Series(False, index=df.index)
    dup[ok] = cle[ok].duplicated(keep="first")
    return dup


def classer_confiance(df):
    modis = df["instrument"] == "MODIS"
    num = pd.to_numeric(df["confidence_brut"], errors="coerce")
    classe_modis = np.select([num < P.SEUIL_MODIS_NOMINAL, num < P.SEUIL_MODIS_HAUT, num <= 100],
                             ["low", "nominal", "high"], default="inconnue")
    classe_viirs = df["confidence_brut"].str.lower().map(P.CLASSES_VIIRS).fillna("inconnue")
    return pd.Series(np.where(modis, classe_modis, classe_viirs), index=df.index)


def cellules(lat, lon, res):
    return np.array([h3.latlng_to_cell(a, b, res) for a, b in zip(lat, lon)], dtype=object)


def masque_statique(connus, res):
    """H3 cells where FIRMS 'type' says static (1/2/3) in a persistent way."""
    c = pd.DataFrame({"cell": cellules(connus["latitude"].to_numpy(), connus["longitude"].to_numpy(), res),
                      "stat": connus["type"].isin([1, 2, 3]).to_numpy()})
    g = c.groupby("cell")["stat"].agg(["sum", "size"])
    return set(g.index[(g["sum"] >= P.MASQUE_MIN_DETECTIONS) & (g["sum"] / g["size"] >= P.MASQUE_PART_MIN)])


def dilater(masque, anneau):
    return set().union(*[h3.grid_disk(c, anneau) for c in masque]) if anneau else set(masque)


def evaluer_masque(entrainement, test, res, anneau, jeu, instrument):
    m = dilater(masque_statique(entrainement, res), anneau)
    pred = pd.Series(cellules(test["latitude"].to_numpy(), test["longitude"].to_numpy(), res)).isin(m).to_numpy()
    vrai = test["type"].isin([1, 2, 3]).to_numpy()
    vp, fn = int((pred & vrai).sum()), int((~pred & vrai).sum())
    fp, vn = int((pred & ~vrai).sum()), int((~pred & ~vrai).sum())
    sens = vp / (vp + fn) if vp + fn else np.nan
    spec = vn / (vn + fp) if vn + fp else np.nan
    ppv = vp / (vp + fp) if vp + fp else np.nan
    return {"instrument": instrument, "resolution_h3": res, "anneau": anneau, "jeu": jeu,
            "VP": vp, "FN": fn, "FP": fp, "VN": vn,
            "sensibilite": sens, "specificite": spec, "PPV": ppv, "youden": sens + spec - 1}


def quasi_doublons(pts):
    """Same satellite and granule (date + time), centres closer than a fraction of the pixel size
    (Fu et al. 2020): the later rows are flagged. Returns a boolean array aligned on pts."""
    g = (pts["satellite"].astype(str) + "|" + pts["acq_date"].dt.strftime("%Y%m%d") + "|" + pts["acq_time"]).to_numpy()
    taille = pd.Series(g).map(pd.Series(g).value_counts()).to_numpy()
    flag = np.zeros(len(pts), dtype=bool)
    la_all, lo_all = pts["latitude"].to_numpy(), pts["longitude"].to_numpy()
    px_all = P.QUASI_DOUBLON_FRACTION_PIXEL * np.sqrt(pts["scan"].to_numpy() * pts["track"].to_numpy())
    multi = np.flatnonzero(taille > 1)
    ordre = multi[np.argsort(g[multi], kind="stable")]
    bornes = np.flatnonzero(np.r_[True, g[ordre][1:] != g[ordre][:-1], True])
    for a, b in zip(bornes[:-1], bornes[1:]):
        idx = ordre[a:b]
        la, lo, px = la_all[idx], lo_all[idx], px_all[idx]
        dy = (la[:, None] - la[None, :]) * KM_PAR_DEGRE
        dx = (lo[:, None] - lo[None, :]) * KM_PAR_DEGRE * np.cos(np.radians(la[:, None]))
        proche = np.hypot(dx, dy) < np.minimum(px[:, None], px[None, :])
        flag[idx[np.triu(proche, 1).any(axis=0)]] = True
    return flag


def controle_croise(agg, jours_sans_donnees=None, seuil_z=3.5, min_total=20):
    """Daily totals per satellite (daytime, vegetation) and robust z-score of log(VIIRS/Aqua).
    |z| > 3.5 (Iglewicz & Hoaglin 1993 modified z) = discordant day = probable non-observation
    by one satellite. Flag only: the decision belongs to the k study."""
    d = (agg[agg["daynight"] == "D"].groupby(["acq_date", "satellite"])["n_vegetation"].sum()
         .unstack(fill_value=0))
    for s in ["Terra", "Aqua", "SNPP", "NOAA20"]:
        if s not in d.columns:
            d[s] = 0
    d = d[["Terra", "Aqua", "SNPP", "NOAA20"]].astype(float)
    # a satellite outside its lifetime or in a listed outage is NOT observed (NaN), not "0 fire"
    for s in d.columns:
        debut, fin = P.DEBUT_DONNEES_FIRMS[s], P.VIE_SATELLITES[s][1]
        hors = (d.index < pd.Timestamp(debut)) | (d.index > pd.Timestamp(fin or date.today()))
        d.loc[hors, s] = np.nan
    if jours_sans_donnees is not None:
        for s, jours in jours_sans_donnees.groupby("satellite")["date"]:
            if s in d.columns:
                d.loc[d.index.isin(pd.to_datetime(jours)), s] = np.nan
    for v in ["SNPP", "NOAA20"]:
        lr = np.log((d[v] + 1) / (d["Aqua"] + 1))
        ok = ((d[v] + d["Aqua"]) >= min_total) & d[v].notna() & d["Aqua"].notna()
        med = lr[ok].median()
        mad = 1.4826 * (lr[ok] - med).abs().median()
        d[f"z_{v}_Aqua"] = np.where(ok, (lr - med) / mad, np.nan)
    d["discordant"] = (d[["z_SNPP_Aqua", "z_NOAA20_Aqua"]].abs() > seuil_z).any(axis=1)
    return d.reset_index()


def versions_logiciels():
    v = {"python": platform.python_version(), "pandas": pd.__version__, "numpy": np.__version__,
         "duckdb": duckdb.__version__, "h3": h3.__version__, "shapely": shapely.__version__}
    try:
        v["git_commit"] = subprocess.run(["git", "rev-parse", "--short", "HEAD"], capture_output=True,
                                         text=True, timeout=10).stdout.strip()
    except Exception:
        v["git_commit"] = None
    return v


# ---------------------------------------------------------------- main
def main(argv=None):
    ap = argparse.ArgumentParser(description="Vigil v2 - nettoyage et agregation H3 x jour")
    ap.add_argument("--region", default="grece", choices=sorted(P.REGIONS))
    ap.add_argument("--brut", default=P.DOSSIER_BRUT)
    ap.add_argument("--sortie", default=P.DOSSIER_SORTIE)
    ap.add_argument("--frontieres", default=P.FICHIER_FRONTIERES)
    ap.add_argument("--memoire", default="4GB", help="limite memoire DuckDB")
    a = ap.parse_args(argv)
    t0 = time.time()
    region = P.REGIONS[a.region]
    sortie = os.path.join(a.sortie, a.region)
    os.makedirs(sortie, exist_ok=True)
    aujourdhui = date.today()

    def etape(msg):
        print(f"[{time.time() - t0:6.0f} s] {msg}", flush=True)

    # Phase 0 - files and reference polygons
    annuels, formulaire = lister_fichiers(a.brut, region)
    etape(f"{len(annuels)} fichiers annuels pays, {len(formulaire)} fichiers formulaire 2026")
    if not annuels:
        raise SystemExit(f"Aucun fichier annuel trouve sous {a.brut}")
    geoms, empreinte = charger_frontieres(a.frontieres, region["pays_ne"], P.SHA256_FRONTIERES)
    lo0, la0, lo1, la1 = shapely.union_all(list(geoms.values())).bounds
    marge = P.TOLERANCE_COTE_KM / KM_PAR_DEGRE * 2
    bbox = (la0 - marge, la1 + marge, lo0 - marge, lo1 + marge)

    con = duckdb.connect()
    con.execute(f"SET memory_limit='{a.memoire}'")
    brut = lire_csv(con, annuels)
    etape(f"fichiers annuels lus : {len(brut):,} lignes")
    if formulaire:
        b26 = lire_csv(con, formulaire, bbox=bbox)
        etape(f"formulaire 2026 (filtre rectangle de la zone) : {len(b26):,} lignes")
        brut = pd.concat([brut, b26], ignore_index=True)
    con.close()
    inventaire(brut).to_csv(os.path.join(sortie, "inventaire_fichiers.csv"), index=False)
    octets = int(sum(os.path.getsize(f) for f in annuels + formulaire))

    # Phase 1 - normalize, validate (per satellite rules)
    df = normaliser(brut)
    del brut
    df["exclusion"] = valider(df, aujourdhui)
    etape(f"normalisation + validation : {int(df['exclusion'].notna().sum()):,} lignes invalides")

    # Zone: same polygons for every year and product, with coastal tolerance
    ok = df["exclusion"].isna()
    pays, cotier = assigner_pays(df.loc[ok, "latitude"].to_numpy(), df.loc[ok, "longitude"].to_numpy(),
                                 geoms, P.TOLERANCE_COTE_KM)
    df["pays"] = None
    df["cotier"] = False
    df.loc[ok, "pays"] = pays
    df.loc[ok, "cotier"] = cotier
    df.loc[ok & df["pays"].isna(), "exclusion"] = "hors_zone"

    # Exact duplicates (same detection in two country files)
    ok = df["exclusion"].isna()
    df.loc[doublons_exacts(df, ok), "exclusion"] = "doublon_exact"

    # Archive / NRT overlap: keep NRT only after the last archive date of the same satellite
    ok = df["exclusion"].isna()
    der_archive = df[ok & (df["origine"] == "archive")].groupby("satellite")["acq_date"].max()
    lim = df["satellite"].map(der_archive)
    df.loc[ok & (df["origine"] == "nrt") & (df["acq_date"] <= lim), "exclusion"] = "chevauchement_archive_nrt"
    etape(f"zone ({int(df['cotier'].sum()):,} points cotiers rattaches), doublons, archive/NRT traites")

    # Confidence (flag, not delete)
    df["classe_confiance"] = classer_confiance(df)
    df["confiance_ok"] = df["classe_confiance"].isin(P.CLASSES_GARDEES)

    # Static sources: FIRMS 'type' when present; for NRT rows, an H3 mask whose resolution and
    # neighbour ring are chosen PER INSTRUMENT on 2024 (validation) and reported on 2025 (test)
    df["statique"] = df["type"].map(lambda t: P.TYPES_STATIQUES.get(int(t), "non") if pd.notna(t) else None)
    valides = df[df["exclusion"].isna()]
    connus = valides[valides["type"].notna()]
    an = connus["acq_date"].dt.year
    lignes, choix = [], {}
    for inst in ["MODIS", "VIIRS"]:
        cand = []
        for res in P.MASQUE_RESOLUTIONS_CANDIDATES:
            for anneau in P.MASQUE_ANNEAUX_CANDIDATS:
                cand.append(evaluer_masque(connus[an <= 2023], connus[(an == 2024) & (connus["instrument"] == inst)],
                                           res, anneau, "validation_2024", inst))
        meilleur = max(cand, key=lambda r: r["youden"])
        choix[inst] = (meilleur["resolution_h3"], meilleur["anneau"])
        test = evaluer_masque(connus[an <= 2024], connus[(an == 2025) & (connus["instrument"] == inst)],
                              *choix[inst], "test_2025", inst)
        lignes += cand + [test]
        etape(f"masque {inst} : resolution {choix[inst][0]}, anneau {choix[inst][1]} -> test 2025 : "
              f"sensibilite {test['sensibilite']:.2f}, specificite {test['specificite']:.3f}, PPV {test['PPV']:.2f}")
    val = pd.DataFrame(lignes)
    val["choisi"] = [(r["resolution_h3"], r["anneau"]) == choix[r["instrument"]] for _, r in val.iterrows()]
    val.to_csv(os.path.join(sortie, "validation_masque_statique.csv"), index=False)
    for inst, (res, anneau) in choix.items():
        m = dilater(masque_statique(connus, res), anneau)
        sel = df["exclusion"].isna() & df["type"].isna() & (df["instrument"] == inst)
        if sel.any():
            cel = cellules(df.loc[sel, "latitude"].to_numpy(), df.loc[sel, "longitude"].to_numpy(), res)
            df.loc[sel, "statique"] = np.where(pd.Series(cel).isin(m).to_numpy(), "statique_estime", "non")

    # Clean points and near-duplicates (same granule, < half a pixel)
    v = df["exclusion"].isna()
    pts = df[v].copy()
    pts["quasi_doublon"] = quasi_doublons(pts)
    df["quasi_doublon"] = False
    df.loc[pts.index, "quasi_doublon"] = pts["quasi_doublon"]
    etape(f"quasi-doublons : {int(pts['quasi_doublon'].sum()):,} points marques")

    # Funnel (every row read is accounted for)
    df["annee"] = df["acq_date"].dt.year.astype("Int64")
    categorie = df["exclusion"].copy()
    categorie[v & ~df["confiance_ok"]] = "confiance_basse"
    base = v & df["confiance_ok"]
    categorie[base & df["statique"].isin(["volcan", "offshore"])] = "volcan_ou_offshore"
    categorie[base & df["statique"].isin(["industriel", "statique_estime"])] = "industriel_G6"
    categorie[base & (df["statique"] == "non") & df["quasi_doublon"]] = "quasi_doublon"
    categorie[base & (df["statique"] == "non") & ~df["quasi_doublon"]] = "retenu_vegetation"
    df["categorie"] = categorie.fillna("autre")
    ent = (df.groupby(["satellite_brut", "annee", "origine", "categorie"], dropna=False).size()
           .unstack("categorie", fill_value=0).reset_index())
    ent.insert(3, "lignes_lues", ent.drop(columns=["satellite_brut", "annee", "origine"]).sum(axis=1))
    ent.to_csv(os.path.join(sortie, "entonnoir.csv"), index=False)

    pts = df[v].copy()
    pts["h3_6"] = cellules(pts["latitude"].to_numpy(), pts["longitude"].to_numpy(), P.H3_RESOLUTION)
    pts["compte_calendrier"] = pts["categorie"] == "retenu_vegetation"
    cols = ["latitude", "longitude", "acq_date", "acq_time", "satellite", "instrument", "daynight",
            "confidence_brut", "classe_confiance", "frp", "bright_4um", "bright_11um", "scan", "track",
            "type", "statique", "quasi_doublon", "origine", "version", "pays", "cotier", "h3_6",
            "categorie", "compte_calendrier", "fichier"]
    pts[cols].to_parquet(os.path.join(sortie, "hotspots_propres.parquet"), index=False)
    etape(f"points propres : {len(pts):,} lignes ecrites")

    # Phase 2 - aggregation H3 res 6 x day x satellite x day/night x country
    a_ = pts[pts["confiance_ok"] & pts["statique"].isin(["non", "industriel", "statique_estime"])].copy()
    a_["veg_brut"] = (a_["statique"] == "non").astype(int)
    a_["veg"] = (a_["veg_brut"] == 1) & ~a_["quasi_doublon"]
    a_["ind"] = 1 - a_["veg_brut"]
    a_["frp_veg"] = a_["frp"].where(a_["veg"])
    agg = (a_.groupby(["h3_6", "acq_date", "satellite", "daynight", "pays"])
           .agg(n_vegetation=("veg", "sum"), n_vegetation_brut=("veg_brut", "sum"),
                n_industriel=("ind", "sum"), frp_sum=("frp_veg", "sum"), frp_max=("frp_veg", "max"))
           .reset_index())
    agg["n_vegetation"] = agg["n_vegetation"].astype(int)
    agg.to_parquet(os.path.join(sortie, "agregat_h3_jour.parquet"), index=False)
    etape(f"agregat H3 x jour : {len(agg):,} lignes")

    # Cross-satellite consistency (flag discordant days) + outage calendar
    jsd = pd.read_csv(os.path.join(os.path.dirname(__file__), P.FICHIER_JOURS_SANS_DONNEES))
    jsd.to_csv(os.path.join(sortie, "jours_sans_donnees.csv"), index=False)
    cc = controle_croise(agg, jsd)
    cc.to_csv(os.path.join(sortie, "controle_croise_jours.csv"), index=False)

    resume = {
        "region": a.region, "genere_le": datetime.now().isoformat(timespec="seconds"),
        "entrees": {"fichiers_annuels": len(annuels), "fichiers_formulaire": len(formulaire), "octets": octets,
                    "frontieres_sha256": empreinte},
        "lignes_lues": int(len(df)), "points_propres": int(len(pts)),
        "retenus_calendrier": int(pts["compte_calendrier"].sum()),
        "categories": {k: int(n) for k, n in df["categorie"].value_counts().items()},
        "periode_par_satellite": {s: [str(g["acq_date"].min().date()), str(g["acq_date"].max().date()), int(len(g))]
                                  for s, g in pts.groupby("satellite")},
        "masque_statique": {k: {"resolution": int(r), "anneau": int(n)} for k, (r, n) in choix.items()},
        "jours_discordants": int(cc["discordant"].sum()),
        "parametres": {"h3_resolution": P.H3_RESOLUTION, "modis_seuil_nominal": P.SEUIL_MODIS_NOMINAL,
                       "classes_gardees": sorted(P.CLASSES_GARDEES), "tolerance_cote_km": P.TOLERANCE_COTE_KM,
                       "quasi_doublon_fraction_pixel": P.QUASI_DOUBLON_FRACTION_PIXEL},
        "logiciels": versions_logiciels(),
        "duree_s": round(time.time() - t0, 1),
    }
    with open(os.path.join(sortie, "resume.json"), "w", encoding="utf-8") as f:
        json.dump(resume, f, ensure_ascii=False, indent=2)

    print("\n================ RESUME ================")
    print(f"Region : {a.region}   |   lignes lues : {resume['lignes_lues']:,}")
    for k, n in sorted(resume["categories"].items(), key=lambda kv: -kv[1]):
        print(f"  {k:<28} {n:>10,}  ({n / resume['lignes_lues']:.1%})")
    print("Periode par satellite (points propres) :")
    for s, (d0, d1, n) in resume["periode_par_satellite"].items():
        print(f"  {s:<8} {d0} -> {d1}   {n:>9,} points")
    print(f"Jours discordants entre satellites (signales) : {resume['jours_discordants']}")
    print(f"Fichiers ecrits dans : {sortie}")
    print(f"Duree : {resume['duree_s']} s")


if __name__ == "__main__":
    main()
