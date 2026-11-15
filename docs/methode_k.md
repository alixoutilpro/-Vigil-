# Audit scientifique du facteur k — méthode VIGIL-K1

> Conversion des détections VIIRS en « équivalent Aqua-MODIS » pour un calendrier d'activité de feu homogène de 2002 à aujourd'hui.
> Étude reproductible : `etudes/etude_k.py` · Production : `pipeline/v2/harmonisation.py` · Tests : `tests/test_v2.py`
> Données : NASA FIRMS (MODIS C6.1, VIIRS 375 m C2), zone Grèce + Albanie + Macédoine du Nord + Bulgarie + Turquie, 1 966 374 détections, nettoyées par `pipeline/v2/nettoyage.py`.
> Date : 14 novembre 2026.

---

## 0. Verdict

| Décision | Choix retenu | Preuve principale |
|---|---|---|
| Faut-il harmoniser ? | **Oui** | Sans harmonisation, R² = −52 sur la Grèce : le capteur fabrique un « saut » ×6 en 2012 |
| Capteur de référence | **Aqua MODIS** (pas Terra) | Le rapport Terra/Aqua dérive (Mann-Kendall p = 0,0003) |
| Début de la série | **juillet 2002** (Aqua) | Terra seul en 2000-2002 n'est pas une référence stable (décision G9) |
| Fenêtre de calibration | **2012-02-01 → 2020-10-31** | Rupture de Pettitt du rapport de jour en **2020-11** (p = 0,006) : dérive d'orbite d'Aqua |
| Source publiée | Aqua observé **avant 2020-11**, VIIRS converti **ensuite** | On ne remplace jamais une observation valide par une estimation |
| Estimateur | **Rapport des totaux** (maximum de vraisemblance de Poisson) | Sans biais (±0,5 %) ; les moyennes et médianes de rapports sont biaisées de −9 à −60 % |
| Découpage | **pays × jour/nuit × mois**, avec **compromis bayésien gamma-Poisson** (α = 10) | Déviance de Poisson −62 % sur la Grèce par rapport à un k jour/nuit unique |
| NOAA-20 | **Chaîné à S-NPP** (ρ ≈ 0,97), utilisé pendant les pannes de S-NPP et après le 2 nov. 2026 | Variantes équivalentes en validation ; la chaîne utilise le recouvrement le plus long |
| Incertitude | **Intervalle conforme 80 % par classe de taille** (Mondrian), jamais négatif | Couverture observée 77-79 % dans toutes les classes (le global sous-couvrait les petits mois : 62 %) |
| Validation finale | Une année laissée de côté (2012-2020) | **R² = 0,983, biais −0,43 %**, déviance 3,90 |

---

## 1. Protocole (fixé avant de regarder les résultats)

- **Cible** : nombre **mensuel** de hotspots Aqua (unité du calendrier, exigence E5), jour + nuit.
- **Prédicteur** : nombre de hotspots VIIRS (S-NPP ; NOAA-20 en test), mêmes jours, même zone.
- **Données de calibration** : jours où **les deux** satellites observent. Les jours de panne (138 jours mesurés sur l'archive mondiale) et les jours **discordants** sont exclus. Un jour est discordant si l'écart robuste du log-rapport dépasse 3,5 (MAD, Iglewicz & Hoaglin 1993), soit 84 jours.
  Médiane et MAD sont calculées **sur la fenêtre de calibration seulement** (correctif du 15/11, version mondiale) :
  la distribution de référence est celle du régime calibré (Aqua dérive après 2020-11), et k ne bouge jamais quand des
  données hors fenêtre changent (test `tests/test_calibration_fenetre.py`).
- **Juge** : validation croisée **« une année laissée de côté »** (LOYO). On apprend sur toutes les années sauf une, on prédit l'année cachée, et on recommence pour chaque année.
- **Références à battre** : la **prévision constante** (médiane climatologique du même mois) et **k = 1** (aucune harmonisation).
- **Critère principal** : **déviance de Poisson**, la mesure adaptée à des comptages. La RMSE, qui élève les erreurs au carré, est dominée par les très gros mois ; la RMSE en log, par les très petits. Critères secondaires : biais total inférieur à 2 % (sinon les totaux annuels et les anomalies sont faussés), puis parcimonie (à performance indiscernable, on garde le modèle le plus simple ou le plus régularisé).

---

## 2. Résultats, question par question

### Q1. Faut-il harmoniser ?

| Prévision des mois Aqua, Grèce (LOYO 2012-2021) | R² | Biais | Déviance |
|---|---|---|---|
| k = 1 (VIIRS brut) | **−52,4** | **+525 %** | 428 |
| Prévision constante (climatologie) | 0,21 | −18 % | 50,7 |
| k jour/nuit unique (rapport des totaux) | 0,885 | +0,1 % | 5,38 |
| **VIGIL-K1** | **0,972** | **+0,1 %** | **2,02** |

VIIRS détecte environ 5 fois plus de feux de jour et 22 fois plus la nuit. Sans correction, la série gonfle artificiellement à partir de 2012.

### Q2. Capteur de référence : Aqua ou Terra ?

- Le rapport Terra/Aqua de jour **baisse significativement** sur 2003-2025 (Mann-Kendall z = −3,59, p = 0,0003) et s'effondre après 2021 : 0,72 → 0,42. C'est la dérive d'orbite de Terra vers le matin.
- **Décision : Aqua seul.** La série commence en juillet 2002, ce qui satisfait « early 2000s ». Terra n'est pas utilisé dans le calendrier.

### Q3. Fenêtre de calibration et dérive d'Aqua

| Test | Résultat |
|---|---|
| k de jour par an, 2012-2021 | Stable : 0,199 à 0,233, Mann-Kendall p = 1,0 |
| k de jour par an, 2012-2025 | Hausse significative (p = 0,018) : 0,268 en 2025 |
| **Rupture de Pettitt**, rapport mensuel de jour | **2020-11**, p = 0,006 (annuel : 2021, p = 0,032) |
| Aqua observé / VIIRS converti après la bascule | 0,97 (fin 2020) → **1,09** (2021-23) → **1,22** (2024-25) |

Aqua passe de plus en plus tard dans l'après-midi, au moment où les feux sont les plus actifs, et détecte donc plus. **Après octobre 2020, Aqua n'est plus la référence stable.**

**Décision :**
- calibration sur 2012-02-01 → 2020-10-31 ;
- la série publiée utilise Aqua observé jusqu'en octobre 2020, puis VIIRS converti ;
- l'écart de −13 % mesuré en 2022-2025 n'est pas une erreur de la méthode : c'est la dérive d'Aqua, que la méthode neutralise.

### Q4. Quel estimateur ? (7 comparés)

| Estimateur | Forme | Verdict |
|---|---|---|
| **Rapport des totaux** | k = ΣA / ΣV | **Retenu.** C'est l'estimateur du maximum de vraisemblance si A ~ Poisson(k·V) ; il conserve les totaux (biais ≈ 0) |
| Moyenne des rapports | moyenne(A/V) | Rejeté : biaisé (−6 à −31 %), dominé par les petits mois instables |
| Médiane des rapports | médiane(A/V) | Rejeté : biais jusqu'à −60 % (rapport non défini ou nul pour les petits comptes) |
| Moindres carrés par l'origine | ΣAV / ΣV² | Rejeté : pondère par V², donc dominé par quelques mois extrêmes ; biais jusqu'à +6 % |
| RMA / Deming | √(ΣA² / ΣV²) | Rejeté : relation **symétrique**, alors qu'on veut **prédire** A à partir de V (espérance conditionnelle) ; biais +14 à +16 % sans découpage |
| Loi puissance (GLM de Poisson) | E[A] = a·V^b | Non retenu : b(jour) = 0,94 [0,91 ; 0,98], b(nuit) = 1,38. La non-linéarité est largement absorbée par le découpage mensuel ; on garde un k interprétable |
| Appariement de quantiles | F_A⁻¹(F_V(V)) | Non retenu : bon sur la RMSE mais instable sans découpage (déviance ×3) et peu explicable |

### Q5. Quel découpage ?

| Découpage (rapport des totaux) | Déviance Grèce | Déviance 5 pays | Déviance zone |
|---|---|---|---|
| Aucun | 4,51 | 9,33 | 28,5 |
| Jour/nuit | 5,38 | 7,98 | 23,2 |
| Jour/nuit × saison (été/hors été) | 5,28 | 7,79 | 22,5 |
| **Jour/nuit × mois** | **4,13** | **5,93** | **13,3** |

- **Jour/nuit est indispensable** : k vaut environ 0,21 de jour et 0,045 la nuit. Les mélanger produit un k faux dans les deux cas.
- Le **mois** apporte bien plus que la saison. Le rapport dépend de la taille des feux (feux agricoles d'hiver contre grands feux d'été), et MODIS rate davantage les petits feux.

### Q6. Un k par pays ? Le compromis bayésien

Modèle gamma-Poisson. Si A ~ Poisson(k·V) et que l'a priori est k ~ Gamma(α, α/k₀), de moyenne k₀, alors la moyenne a posteriori vaut :

```
k₀[c,d,m] = k[c,d] · k[d,m] / k[d]          (niveau du pays × saisonnalité commune)
k[c,d,m]  = (A[c,d,m] + α) / (V[c,d,m] + α / k₀[c,d,m])
```

| α (force du compromis) | Déviance Grèce | Déviance 5 pays |
|---|---|---|
| 0 (k propre à chaque case) | 2,041 | 3,904 |
| 3 | 2,032 | **3,825** |
| **10 (retenu)** | **2,019** | 3,833 |
| 30 | **2,010** | 3,871 |
| ∞ (k₀ seul) | 2,876 | 4,930 |
| k commun jour/nuit × mois | 3,386 | 5,446 |

α est choisi par validation. Les valeurs de 3 à 30 sont indiscernables (moins de 1,2 % d'écart). On retient **α = 10**, la valeur la plus régularisée qui reste à moins de 0,5 % du meilleur score sur les deux niveaux : c'est l'analogue de la règle « un écart-type ». Les zones hors des pays calibrés utilisent le k commun jour/nuit × mois.

### Q7. NOAA-20

| Prévision d'Aqua 2018-2021 (LOYO) | Déviance | Biais |
|---|---|---|
| S-NPP seul | 26,8 | −0,6 % |
| NOAA-20 direct | 23,3 | −0,6 % |
| **NOAA-20 chaîné via S-NPP** | 23,7 | −1,9 % |
| Moyenne S-NPP + NOAA-20 | 24,7 | −0,6 % |

Les variantes sont équivalentes. On retient la **chaîne**, ρ[d,m] = ΣSNPP / ΣNOAA20, médiane 0,97. Elle utilise le recouvrement le plus long (2018-04 → 2026-11-02) et rend la relève de S-NPP par NOAA-20 transparente. Contrôle *a posteriori* : NOAA-20 converti et S-NPP converti diffèrent de moins de 5 % par an sur 2021-2024. On ne fait jamais la somme des deux, ce qui doublerait les feux.

### Q8. Sensibilité aux choix de nettoyage

| Variante | k jour | k nuit | Déviance Grèce |
|---|---|---|---|
| **Protocole** (jours appariés, hors discordants) | 0,212 | 0,045 | **5,38** |
| Jours discordants inclus | 0,211 | 0,045 | 5,58 |
| Quasi-doublons conservés | 0,210 | 0,045 | 6,40 |
| **Sources industrielles incluses** | 0,213 | **0,027** | **7,21** |

k de jour est **robuste** à tous les choix (0,210 à 0,213). Inclure les sources industrielles fausse k de nuit (−39 %) et dégrade la prévision (+34 %), ce qui confirme leur exclusion du calcul. VIIRS les détecte 80 fois plus que MODIS, contre 6 fois plus pour les feux de végétation.

### Q9. Incertitude

Résidus r = log(1 + A) − log(1 + Â) des prévisions LOYO. Intervalle 80 % : [exp(log(1 + Â) + q₁₀) − 1, exp(log(1 + Â) + q₉₀) − 1], borné à 0.

| Classe de taille (prévision mensuelle) | Couverture, quantiles globaux | **Couverture, quantiles par classe (retenu)** |
|---|---|---|
| < 5 hotspots | 62 % | **79 %** |
| 5-30 | 70 % | **79 %** |
| 30-150 | 91 % | **77 %** |
| > 150 | 97 % | **79 %** |

Quantiles retenus (log) : < 5 : [−0,96 ; +0,56] · 5-30 : [−0,73 ; +0,42] · 30-150 : [−0,29 ; +0,27] · > 150 : [−0,22 ; +0,18]. Les mois observés par Aqua (avant 2020-11) n'ont pas d'incertitude de conversion.

### Q10. Homogénéité de la série fusionnée

- Biais annuel LOYO sur 2012-2021 : entre −23 % et +11 % pour la Grèce (le −23 % est 2021, déjà touché par la dérive d'Aqua) et entre −16 % et +8 % pour les 5 pays, **sans tendance** (Mann-Kendall p = 0,59 et 1,0).
- Série grecque harmonisée : **aucun saut en 2012** (1 463 en 2011 → 1 027 en 2012). Les grandes années connues ressortent : **2007** Péloponnèse (2 652), **2021** Eubée (1 081), **2023** Evros (1 274).

---

## 3. Méthode VIGIL-K1 (formules finales)

Pour une case H3, un jour t, une strate jour/nuit d, le pays c et le mois m(t) :

```
si t < 2020-11-01 et Aqua observe :     valeur = N_Aqua                                  (source = modis_observed)
sinon si S-NPP observe :                 valeur = k[c,d,m] · N_SNPP                       (source = viirs_converted)
sinon si NOAA-20 observe :               valeur = k[c,d,m] · ρ[d,m] · N_NOAA20            (source = viirs_converted)
sinon :                                  non observé (null, jamais 0)
```

Le total d'une zone et d'un mois est la somme sur les cases, les jours et les strates. L'intervalle 80 % est celui de la Q9, appliqué au total mensuel.

## 4. Limites (assumées et documentées)

1. **La nuit** : Aqua détecte peu de feux nocturnes (6 % de ses détections), donc k de nuit est moins précis. Son poids dans les totaux est faible.
2. **Certains mois d'hiver** ont peu de feux, donc un k mensuel plus bruité. Le compromis bayésien le stabilise sans l'annuler.
3. **Stationnarité** : on suppose que la relation entre VIIRS et l'Aqua d'avant la dérive reste valable après 2020. C'est soutenu par la stabilité de ρ (NOAA-20/S-NPP, médiane 0,97) et la cohérence de NOAA-20 et S-NPP convertis (moins de 5 % d'écart).
4. **Calibration régionale** (5 pays) : ailleurs, le k commun s'applique. Une autre région devra être recalibrée avec la même chaîne.
5. **Les intervalles portent sur les totaux mensuels** de zone, pas sur les valeurs journalières par case.
6. **Non utilisés** : Terra, NOAA-21. **Données manquantes** : les 7 derniers jours (à retélécharger pour la démo).

## 5. Lien avec les notions de science des données

| Notion | Où elle intervient |
|---|---|
| Prévision constante comme référence | La climatologie (R² = 0,21) et k = 1 (R² = −52) sont battues |
| Train / test, validation croisée | LOYO : chaque année est testée sans avoir servi à apprendre |
| RMSE comparée à l'écart-type, R² | Tableaux Q1, Q4, Q5 |
| Le carré pondère les grosses erreurs | Pourquoi les moindres carrés sont dominés par les mois extrêmes (Q4) |
| Logarithme pour variables étalées | Résidus et intervalles calculés sur log(1 + x) (Q9) |
| Courbe surapprentissage / sous-apprentissage | Le choix de α (Q6) : α = 0 suit le bruit, α = ∞ ignore le pays |
| Matrice de confusion | Validation du masque des sites fixes (sensibilité 0,96, spécificité 0,97 pour VIIRS) |
| Boîte à moustaches : extrême ≠ erreur | Les grands feux, vus par tous les satellites, ne sont jamais supprimés |

## 6. Reproduire

```
python -m pipeline.v2.nettoyage --region grece
python -m etudes.etude_k
python -m pipeline.v2.harmonisation --region grece
python -m pytest
```

Références principales : Giglio, Schroeder & Justice 2016 (RSE 178:31) ; Schroeder et al. 2014 (RSE 143:85) ; Fu et al. 2020 (Remote Sensing 12:2870) ; Pettitt 1979 (Applied Statistics 28:126) ; Mann 1945 / Kendall 1975 ; Iglewicz & Hoaglin 1993 ; Vovk et al. 2005 et Lei et al. 2018 (prédiction conforme) ; NASA FIRMS (transition S-NPP, nov. 2026).
