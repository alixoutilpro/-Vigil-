# Contrat de données v2 — backend → frontend (Vigil)

> Produit par `python -m pipeline.v2.export_site` (voir l'ordre complet en bas).
> **Ne jamais `import` ces fichiers dans le code de la page** : ils se chargent **à la demande** avec `fetch`
> (le mois affiché, la zone choisie). Seul `index.json` et `incertitude.json` sont chargés au démarrage.
> Le contrat v1 (`data/data.json`, Grèce) reste valable et inchangé.

Emplacement (décision du 14/11) : **`public/data/` du dépôt `-Vigil-`, servi par Vercel** → `BASE = "/data"`
(ex. `fetch("/data/index.json")`). Les fichiers `.bin.gz` sont servis tels quels (pas d'en-tête Content-Encoding) :
la fonction `chargerBinaire` ci-dessous les décompresse. Ne pas régénérer ces fichiers souvent : chaque version
s'ajoute à l'historique Git (~100-200 Mo).

## 1. Unités et provenance (à afficher)

| Grandeur | Unité | Sens |
|---|---|---|
| `hotspots` | détections de feux actifs, **équivalent MODIS Aqua** | nombre de hotspots harmonisé (VIGIL-K1) |
| `frp` / `frp_MW` | MW, **équivalent Aqua** | puissance radiative du feu, harmonisée avec son propre k (VIGIL-K1-FRP) |

- Avant le **1er novembre 2020** (`index.json → bascule_viirs`) : valeur **observée par MODIS Aqua** (`modis_observed`).
- À partir de cette date : **VIIRS converti** (`viirs_converted`, S-NPP puis NOAA-20 les jours sans S-NPP) → afficher la fourchette.
- Libellé conseillé : « détections de feux actifs », pas « feux » (un feu = souvent plusieurs détections).

## 2. Fichiers

### `index.json` (au démarrage)
`mois` (liste `"AAAA-MM"`), `tuiles` (liste des parents H3 res 1 disponibles), `h3_resolution` (5),
`mois_index_0` (`"2002-01"`), `bascule_viirs`, `seuils_couleur_quantiles` (pour la légende),
`validation` (chiffres de validation à montrer), `tailles_octets`.

### `h3_5/mois/AAAA-MM.bin.gz` — la carte d'un mois
Binaire **little-endian**, compressé gzip, enregistrements de **16 octets**, triés par `h3` :

| Octets | Type | Champ |
|---|---|---|
| 0–7 | uint64 | identifiant H3 (résolution 5) |
| 8–11 | float32 | hotspots |
| 12–15 | float32 | frp (MW) |

Seuls les hexagones avec du feu ce mois-là sont présents (absent = 0 observé).

### `h3_5/tuiles/<parent>.bin.gz` — statistiques d'une zone
Tous les mois des hexagones contenus dans un même hexagone **parent H3 de résolution 1**. Enregistrements de **18 octets**
(non alignés → lire avec `DataView`), triés par (h3, mois) :

| Octets | Type | Champ |
|---|---|---|
| 0–7 | uint64 | H3 résolution 5 |
| 8–9 | uint16 | indice de mois (0 = 2002-01, 1 = 2002-02, …) |
| 10–13 | float32 | hotspots |
| 14–17 | float32 | frp (MW) |

### `pays.json` — mode Pays (échelle **validée**)
`{ "<Pays FIRMS>": { sous_region, fiabilite, fiabilite_frp, premier_mois, hotspots[], bas_80[], haut_80[], bas_95[], haut_95[], frp_MW[], frp_bas_80[], frp_haut_80[], couverture_jours[] } }`
Tableaux alignés mois par mois à partir de `premier_mois`. Noms de pays = noms FIRMS (ex. `Democratic_Republic_of_the_Congo`).
`fiabilite` ∈ `elevee | moyenne | faible` → **à afficher** (faible = peu de données, conversion moins sûre).

### `incertitude.json` — fourchette d'une zone quelconque
Pour un **total de zone** `x` d'un mois converti : classe `c` selon `classes_bornes`, puis
`bas = max(0, exp(log(1+x) + q_bas[c]) − 1)`, `haut = exp(log(1+x) + q_haut[c]) − 1` (niveau `"0.8"` ou `"0.95"`).
Mois observés par Aqua : `bas = haut = x`.
**Quelle table ?** mode Pays → `hotspots` (validée pays × mois) ; zone dessinée ou mode H3 → **`hotspots_sous_pays`**
(apprise et vérifiée sur des zones de ~55 à ~220 km : couverture observée 78–81 % pour 80 %, 94–95 % pour 95 %).
Pour une zone de moins de ~3 hexagones, afficher « fourchette indicative (zone plus petite que les zones testées) ».
FRP → `frp_MW` (validée pays × mois uniquement).

### `points_grece/AAAA.csv.gz` — chaque détection grecque (E9)
Colonnes : `latitude, longitude, acq_date, acq_time, satellite, instrument, daynight, confidence, frp, type, categorie,
compte_calendrier, origine, version`. `categorie` = raison quand le point n'est pas compté
(`confiance_basse`, `industriel_G6`, `volcan_ou_offshore`, `quasi_doublon`, …) ; `compte_calendrier = True` = compté.
Export CSV d'une recherche = filtrer zone + dates, garder toutes les colonnes (transparence).

### `brut/<Pays>.json` — calendriers brut / harmonisé (Grèce)
Produit par `python -m pipeline.v2.export_calendrier_brut --pays Greece`. Tableaux mensuels alignés sur `premier_mois`
(`hotspots` et `frp_MW`) : `naif_2012` (Aqua jusqu'en 2012-01 puis VIIRS brut), `brut_2020` (Aqua jusqu'en 2020-10 puis
VIIRS brut non converti), `harmonise` (série VIGIL-K1 publiée), et brut par satellite (`Terra`, `Aqua`, `SNPP`, `NOAA20`).
Mêmes tables nettoyées et même règle satellite/jour que la série harmonisée. Contrôle écrit dans `controle` :
`brut_2020 == harmonise` avant la bascule (écart max 0).

### `h3_5/pays/<Pays>.bin.gz` et `h3_5/pays_index.*` — hexagones d'un pays
`python -m pipeline.v2.export_h3_pays`. Par pays : uint64 little-endian triés (hexagones res 5 contenant au moins une
détection végétation Aqua / S-NPP / NOAA-20 de ce pays). `pays_index.bin.gz` = `[n uint32][4 octets][h3 uint64 × n][code uint16 × n]`
trié par h3, noms dans `pays_index.json` (infobulle de la carte). Un hexagone frontalier peut appartenir à plusieurs pays.

## 3. Lecture en JavaScript

```js
async function chargerBinaire(url) {
  const brut = new Uint8Array(await (await fetch(url)).arrayBuffer());
  // selon l'hébergeur, le navigateur a déjà décompressé (en-tête Content-Encoding) ou non : tester la signature gzip
  if (brut[0] === 0x1f && brut[1] === 0x8b) {
    const flux = new Blob([brut]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new DataView(await new Response(flux).arrayBuffer());
  }
  return new DataView(brut.buffer);
}

// carte d'un mois -> [{ h3: "851eda77fffffff", hotspots, frp }]
async function lireMois(BASE, mois) {
  const v = await chargerBinaire(`${BASE}/h3_5/mois/${mois}.bin.gz`), out = [];
  for (let o = 0; o < v.byteLength; o += 16)
    out.push({ h3: v.getBigUint64(o, true).toString(16), hotspots: v.getFloat32(o + 8, true), frp: v.getFloat32(o + 12, true) });
  return out;
}

// tuile -> Map(h3 -> Map(indiceMois -> {hotspots, frp}))
async function lireTuile(BASE, parent) {
  const v = await chargerBinaire(`${BASE}/h3_5/tuiles/${parent}.bin.gz`), out = new Map();
  for (let o = 0; o < v.byteLength; o += 18) {
    const h = v.getBigUint64(o, true).toString(16);
    if (!out.has(h)) out.set(h, new Map());
    out.get(h).set(v.getUint16(o + 8, true), { hotspots: v.getFloat32(o + 10, true), frp: v.getFloat32(o + 14, true) });
  }
  return out;
}
```
Avec `h3-js` : `cellToBoundary(h3, true)` → polygone GeoJSON de l'hexagone ; `polygonToCells(zone, 5)` → hexagones d'une
zone dessinée (règle : centre dans la zone) ; `cellToParent(h3, 1)` → nom de la tuile à charger.

## 4. Règle d'or des statistiques de zone

1. **D'abord additionner** les hexagones de la zone, mois par mois → série mensuelle de la zone.
2. **Ensuite seulement** calculer médiane, quartiles, rang, tendance, fourchette sur cette série.
   ❌ Jamais de médiane de médianes, jamais de somme de bornes de fourchettes (erreurs corrélées : même k).

## 5. Indicateurs à calculer sur la série d'une zone (méthode : `Hackathon-contexte/…/2 Choix de la méthode.md`)

| Indicateur | Formule | Exigence |
|---|---|---|
| Base de référence | années civiles complètes **2003–2025** (2002 partielle, 2026 en cours exclues) | E7 |
| Médiane, P10/P25/P75/P90, min, max du mois m | quantile **Hyndman–Fan type 8** : `j = ⌊n·p + (p+1)/3⌋`, interpolation | E6, E7 |
| Écart à la médiane | `Δ = x − med` ; `%med = 100·x/med` (si `med = 0` : « n.d. », afficher Δ et rang) | E7 |
| Rang centile | `PR = 100·(b + 0,5·e)/n` (b = années inférieures, e = égales, base sans l'année de x) | E6, E7 |
| Classe (5 niveaux) | < P10 très inférieure ; P10–P33 inférieure ; P33–P67 proche de la normale ; P67–P90 supérieure ; > P90 très supérieure | E7 |
| Mois de pic, longueur de saison | pic = argmax de la moyenne mensuelle ; saison = mois ≥ 10 % du total annuel moyen (Giglio 2006) | E6 |
| Tendance | pente de Sen (médiane des pentes) en %/an avec IC ; Mann-Kendall | E6, R4 |

Le **mois en cours est partiel** (données jusqu'au 7 nov. 2026) : ne pas le comparer à des mois complets
(biais vers « inférieur ») → l'afficher hachuré « partiel » tant qu'une comparaison jour à jour n'est pas fournie.

## 6. Couleurs (E10)
Comptes et FRP : palette séquentielle **perceptuellement uniforme et lisible par les daltoniens** (viridis, inferno ou
YlOrRd), **échelle logarithmique**, bornes depuis `seuils_couleur_quantiles`. Anomalies : palette **divergente**
centrée sur la normale (RdBu, vik). Jamais rouge–vert ni arc-en-ciel. Toujours doubler la couleur par un texte/valeur.

## 7. Régénérer (PC du backend uniquement : 43 Go de données brutes)
```
python -m pipeline.v2.mondial agreger
python -m pipeline.v2.mondial agreger --tables hex,jourfrp
python -m pipeline.v2.mondial calibrer
python -m pipeline.v2.mondial calibrer-frp
python -m pipeline.v2.nettoyage --region grece
python -m pipeline.v2.export_site --site public/data
```
