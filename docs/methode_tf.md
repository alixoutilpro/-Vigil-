# Vigil Trends — méthode

> Vue « Vigil Trends » du site (`app/Tendances.tsx`). Code : `pipeline/tf/`. Tests : `tests/test_tf.py`.
> Entrée unique : les fichiers harmonisés de la vue Analytics (`public/data`, contrat v2, VIGIL-K1). Aucune donnée brute.
> Date : 15 novembre 2026. Légende : ✅ vérifié · 🟡 partiel · ⚠️ non vérifié.

## 1. Question posée

La vue Analytics montre **combien** ça brûle. Vigil Trends répond à une autre question : **où** de vrais épisodes
d'incendie reviennent-ils, et à quel point chacun de ces lieux est-il exposé ?

Le même nombre de détections peut vouloir dire deux choses :
- réparti sur les mêmes mois chaque année → brûlage récurrent (surtout agricole), attendu ;
- concentré dans quelques hexagones voisins pendant un ou deux mois, très au-dessus de l'habitude → épisode d'incendie.

C'est la dimension **temps** qui les sépare. Toute la méthode repose là-dessus.

## 2. Foyers (« hubs ») : clustering espace-temps — `pipeline/tf/hubs.py`

Unité : hexagone H3 résolution 5 (~250 km², ~17 km) × mois, années complètes 2003-2025.

| Étape | Règle | Constante |
|---|---|---|
| 1. Sursaut | un hexagone-mois est un sursaut si ses détections sont **grandes** (≥ 10) **et inhabituelles pour cet hexagone et ce mois du calendrier** : ≥ 4 × (médiane du même mois sur toutes les années + 1) | `V_MIN`, `RATIO` |
| 2. Épisode | composante connexe de sursauts : hexagones identiques ou voisins (anneau H3 1), mois identiques ou consécutifs ; épisodes < 50 détections écartés | `EPISODE_MIN` |
| 3. Exposition | détections des sursauts de l'hexagone dans les épisodes gardés | — |
| 4. Hub | groupe connexe d'hexagones d'exposition ≥ 20 ; un groupe de plus de 19 hexagones est réduit à sa moitié la plus exposée, de façon répétée (l'intérêt est local : ≤ ~80 km) ; hubs < 100 détections écartés | `HEX_MIN`, `TAILLE_MAX`, `HUB_MIN` |
| 5. Score 1-100 | rang centile, parmi tous les hubs du monde, de la moyenne de trois rangs centiles : **fréquence** (part des années avec épisode), **ampleur** (détections d'épisode par 1 000 km² et par an), **intensité** (FRP par détection) | — |
| 6. Confiance | bootstrap sur les années : les 23 années sont retirées avec remise 500 fois ; confiance = part des tirages où le hub passe encore la règle 4 | `N_BOOT` |

Pourquoi la médiane du **même mois** : un champ brûlé chaque mars a une médiane de mars élevée, donc ne produit jamais de
sursaut. Le brûlage régulier est retiré par construction, sans carte d'occupation du sol.

Lecture de la confiance : un hub qui repose sur une seule année exceptionnelle est retrouvé dans ~64 % des tirages
(1 − (22/23)²³). C'est un vrai feu, mais sa récurrence n'est pas démontrée.

### Résultats ✅ (exécution du 15/11, `public/data/tf/hubs.json`)

| | Monde |
|---|---|
| Hexagones-mois avec feu | 13 491 949 |
| Sursauts retenus dans un épisode | 344 033 |
| Épisodes ≥ 50 détections | 34 511 (médiane : 4 hexagones, 2 mois) |
| Hubs | 6 438 (médiane : 3 hexagones, 4 années avec épisode) |
| Part des détections 2003-2025 dans un épisode de hub | 6,8 % |
| Confiance médiane | 87,6 % ; 2 951 hubs ≥ 90 % |

**Validité de face sur la Grèce** ✅ : les 8 hubs grecs correspondent aux épisodes connus, sans que la méthode les connaisse.

| Hub (centre) | Score | Confiance | Années | Plus gros épisode | Événement connu |
|---|---|---|---|---|---|
| 38,2°N 23,8°E | 71 | 100 % | 5 | août 2009 · 166 | Attique |
| 41,0°N 26,0°E | 53 | 72 % | 2 | août 2023 · 587 | Evros |
| 36,1°N 27,9°E | 52 | 57 % | 2 | juil. 2008 · 95 | Rhodes |
| 37,4°N 22,0°E | 43 | 74 % | 2 | août 2007 · 971 | Péloponnèse |
| 38,9°N 23,3°E | 39 | 62 % | 1 | août 2021 · 382 | Eubée |
| 38,3°N 26,0°E | 32 | 67 % | 2 | août 2012 · 107 | Chios |

### Limites

1. ⚠️ **Sensibilité aux seuils non mesurée.** Les 6 constantes sont des choix raisonnés, pas optimisés. À faire : refaire tourner avec `RATIO` 3 et 6, `V_MIN` 5 et 20, et mesurer le recouvrement des hubs.
2. Une détection n'est pas un feu ; un hexagone-mois de ~17 km ne sépare pas un grand feu de plusieurs feux proches.
3. Un brûlage récurrent qui se décale de son mois habituel peut entrer comme sursaut.
4. Le score **classe** les hubs entre eux sur 23 ans d'historique. Ce n'est ni une probabilité ni une prévision.
5. Les mois convertis (depuis nov. 2020) portent l'incertitude de VIGIL-K1, non propagée dans le score.
6. Les défauts connus des données sources s'appliquent (août 2020 sous-estimé par la panne d'Aqua ; correctif en cours).

## 3. Couches de contexte — `pipeline/tf/regimes.py`, `executer.py`

Unité : territoire H3 résolution 4 (~42 km), somme exacte des hexagones res 5. 67 550 territoires avec feu.

- **Tendance locale** : pente de Theil–Sen et test de Mann–Kendall sur la série annuelle du territoire **mis en commun avec ses 6 voisins** (le bruit d'une cellule se moyenne, une tendance partagée reste). 40 955 territoires testés sur la cellule seule : 35 % ont p < 0,05 (5 % attendus par hasard). Contrôle du taux de fausses découvertes (Benjamini–Hochberg, q ≤ 10 %) : 3 716 hausses, 8 611 baisses. Monde : −1,07 %/an (p = 0,0001).
- **Régimes de feu** : k-means sur 6 descripteurs standardisés (densité, saison en cos/sin alignée entre hémisphères, longueur de saison, variabilité entre années, FRP par détection). k = 4 par la règle du coude fixée d'avance (gain d'inertie < 10 %) ; stabilité (indice de Rand ajusté entre deux moitiés) ≈ 0,95. Silhouette ≈ 0,23 : les régimes forment un continuum.
- **Trajectoires** : k-means sur les séries 2003-2025 lissées et standardisées par territoire (forme seule). k = la partition la plus reproductible avec ≥ 3 groupes.
- Validation externe des régimes : occupation du sol (ESA WorldCover 2021, API Planetary Computer) et climat (TerraClimate, miroir Planetary Computer), **non fournis au clustering**, diffèrent bien d'un régime à l'autre.

## 4. Pourquoi il n'y a pas de prévision

Des modèles de prévision à 1-5 ans ont été construits et testés (`pipeline/tf/prevision.py`, option `--previsions`), puis
**retirés de l'interface**. Test sur les 135 territoires grecs, années 2021-2025 jamais vues, horizon 1 an :

| | Modèle | Moyenne historique |
|---|---|---|
| Déviance de Poisson | 14,3 | 19,8 |
| R² en échelle log | 0,33 | **0,49** |
| Erreur moyenne du total national par an | 319 | **275** |
| Années fortes manquées | 28 sur 38 | 25 sur 38 |

Le modèle donne un niveau moyen juste mais ne voit venir ni 2021 (Eubée) ni 2023 (Evros) : l'activité d'une année dépend
de la météo de l'été, qu'il ne connaît pas. Présenter ces sorties comme des prévisions aurait été trompeur.

## 5. Fichiers produits (contrat)

| Fichier | Contenu |
|---|---|
| `public/data/tf/hubs.json` | `parametres`, `resume`, `hubs[]` : `id, lat, lon, pays, h3[] (res 5), aire_km2, score, confiance, annees_episode, detections, densite, frp_det, part_episodique, pic{mois, detections}, dernier, serie[23]` |
| `public/data/tf/cellules.bin.gz` | table en colonnes (`VTF1` · uint32 longueur d'en-tête · en-tête JSON · colonnes alignées sur 8 octets) : un territoire res 4 par ligne, `a2003…a2025`, `regime`, `trajectoire`, `tendance`, `sen`, `q`, `tendance_l`, `sen_l`, `q_l`… |
| `public/data/tf/modele.json` | diagnostics des clusterings, résumé des tendances |

## 6. Reproduire

```
python -m pip install -r requirements.txt -r requirements-tf.txt
python -m pipeline.tf.table        # historique par territoire, depuis public/data
python -m pipeline.tf.statique     # occupation du sol + relief
python -m pipeline.tf.climat       # normales TerraClimate
python -m pipeline.tf.hubs         # foyers -> public/data/tf/hubs.json
python -m pipeline.tf.executer     # régimes, tendances, trajectoires -> public/data/tf/
python -m pytest
```

À relancer après toute régénération de `public/data` (les hubs en dépendent).
