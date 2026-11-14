# Légende de la carte — méthode des paliers de couleur

> Code : `app/Vigil.tsx` (`DENS_BREAKS`, `HEX_COLORS`). Vérification : audit du 14/11 au soir
> (`Hackathon-contexte/audits/audit_donnees_dashboard_14nov_soir.md`), 13,5 M hexagones-mois res 5.

## 1. Grandeur représentée

**Densité mensuelle** d'un hexagone H3 :

```
densité = valeur de l'hexagone sur la période / nombre de mois / aire de l'hexagone (km²) × 1 000
```

- valeur = détections de feux actifs **harmonisées (équivalent MODIS Aqua, VIGIL-K1)**, ou Σ FRP (MW, équivalent Aqua) ;
- unité : **détections (ou MW) par 1 000 km² et par mois**.

Pourquoi une densité et pas un nombre :

1. **Les hexagones H3 n'ont pas tous la même aire.** À la résolution 5, elle va de 154 à 305 km² selon la latitude.
2. **La résolution affichée suit le zoom.** On passe de ~110 km (res 3) à ~42 km (res 4) puis ~17 km (res 5). Un hexagone res 4 additionne 7 hexagones res 5, donc un nombre brut changerait de sens à chaque zoom.
3. **Le « par mois » rend comparables des périodes de longueurs différentes.** C'est le cas des plages de dates choisies en mode zone.

En revanche, **les totaux de zone, le calendrier et le dashboard restent en nombre de détections**, l'unité exigée par l'énoncé (E5). La densité ne sert qu'à colorer la carte.

## 2. Paliers : 12 classes fixes

| | Bornes (11 seuils → 12 classes) |
|---|---|
| Détections / 1 000 km² / mois | 0,02 · 0,05 · 0,1 · 0,2 · 0,5 · 1 · **3 · 7** · 12 · 25 · 60 |
| Σ FRP (MW) / 1 000 km² / mois | 0,5 · 1 · 2 · 5 · 10 · 20 · 50 · 100 · 200 · 500 · 1 000 |

Les règles retenues, et leur raison :

1. **Les mêmes seuils à tous les zooms et pour tous les mois.** Une couleur correspond ainsi à une seule densité, partout. On peut donc comparer directement deux mois, deux saisons ou deux niveaux de zoom.
   - Les anciennes classes « à effectif égal par résolution » donnaient à une même couleur une densité ~20 fois différente entre res 3 et res 5. Elles ont été abandonnées.
2. **Une progression quasi géométrique** (chaque seuil vaut ×2 à ×2,5 le précédent, en nombres ronds). La raison : les densités s'étalent sur ~5 ordres de grandeur, avec une distribution à queue lourde.
   - Quantiles res 5 : P5 = 0,52 ; P50 = 6,9 ; P95 = 85 ; max = 2 240.
   - Une échelle linéaire mettrait plus de 90 % de la carte dans la première couleur.
   - Les classes géométriques sont l'usage standard pour des comptes log-normaux. Ce sont aussi elles que l'œil compare le mieux, en rapports.
3. **La classe [3 ; 7) est ancrée sur « une détection dans un hexagone res 5 ».** 19 % des hexagones-mois res 5 contiennent exactement 1 détection. Leur densité va de 3,3 à 6,5 selon la seule aire de l'hexagone.
   - Un seuil tombant dans cet intervalle colorerait la **taille de l'hexagone**, pas le feu. C'était le défaut des anciens seuils 3,35 / 3,79 / 4,45.
   - Ces hexagones tombent désormais tous dans la même couleur. C'est pourquoi la série 1-2-5 est ajustée à cet endroit (3, 7 au lieu de 2, 5).
4. **Occupation des classes vérifiée** sur les données réelles 2002-07 → 2026-10, mois partiel exclu, pour les 3 résolutions : aucune classe vide, aucune au-dessus de 28 %.

| % des hexagones-mois par classe (détections) | |
|---|---|
| res 5 | 0 / 0,3 / 0,8 / 1,3 / 2,4 / 7,7 / 10,1 / 27,8 / 14,8 / 14,6 / 12,0 / 8,2 |
| res 4 | 1,6 / 1,8 / 3,0 / 5,7 / 10,1 / 19,0 / 24,5 / 13,3 / 6,5 / 6,6 / 5,1 / 2,8 |
| res 3 | 6,1 / 4,5 / 14,6 / 11,8 / 18,6 / 11,8 / 14,3 / 7,6 / 3,6 / 3,5 / 2,5 / 1,1 |

| % par classe (Σ FRP) | |
|---|---|
| res 5 | 0,5 / 0,7 / 1,0 / 2,3 / 4,0 / 6,0 / 15,8 / 13,7 / 13,1 / 15,4 / 9,7 / 17,8 |
| res 4 | 3,3 / 2,2 / 3,7 / 10,7 / 11,9 / 12,0 / 14,8 / 10,0 / 8,7 / 9,3 / 5,3 / 8,2 |
| res 3 | 10,1 / 8,5 / 9,9 / 14,0 / 10,5 / 9,8 / 11,2 / 7,0 / 5,8 / 5,9 / 3,2 / 4,1 |

## 3. Couleurs

12 teintes séquentielles, du jaune très clair (`#ffffd4`) au rouge très foncé (`#6e0a10`). C'est la famille YlOrRd prolongée au-delà des 9 classes de ColorBrewer.

- La luminosité est monotone : l'ordre reste lisible en niveaux de gris et pour les daltonismes rouge-vert.
- Il n'y a ni vert ni arc-en-ciel.
- Chaque case de la rampe affiche ses bornes au survol, et l'infobulle d'un hexagone donne sa valeur et sa classe (x/12) : la couleur est toujours doublée d'un nombre (E10).

## 4. Limites

- La densité d'un mois dépend de la couverture satellite du mois. Elle est complète, sauf pendant les pannes, listées dans `pipeline/v2/jours_sans_donnees.csv`.
- Le mois en cours (2026-11, données jusqu'au 7) est partiel : sa couleur n'est pas comparable à celle d'un mois complet. La clé l'indique (« partial month »).
- En mode Pays, les hexagones frontaliers contiennent aussi les détections du pays voisin. Le total affiché dans la clé est celui de la série du pays, la même que le calendrier.
