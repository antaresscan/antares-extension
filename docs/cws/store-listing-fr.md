# Chrome Web Store — Listing Copy (Français)

> Version FR du store listing. Pour la VO anglaise, voir `store-listing-en.md`.
> À copier-coller dans le Chrome Web Store Developer Dashboard pour la
> localisation française.

---

## Nom (max 75 caractères)

```
Antares — Scanner Anti-Arnaques pour Solana
```

---

## Description courte / Résumé (max 132 caractères)

```
Scanner de tokens Solana en temps réel. Scoring 7 couches sur chaque page token. Scans illimités gratuits, Pro pour les power users.
```

(127 caractères)

---

## Catégorie

Principale : **Productivité**
Secondaire : **Outils pour développeurs**

---

## Description détaillée

> Reconstruite après le rejet CWS du 09/05/2026 (cas Yellow Argon —
> Spam dans les mots-clés). Le reviewer a explicitement pointé la liste
> "PLATEFORMES SUPPORTÉES" avec ses parenthèses `(domaine.tld)` comme
> du bourrage de mots-clés. La version ci-dessous retire la liste
> explicite, supprime le faux claim "open source" (le repo est privé),
> et met à jour l'URL privacy vers le domaine custom antaresscan.com.
> Chaque API upstream et chaque plateforme est mentionnée au plus une
> fois, en contexte, jamais sous forme de liste à plat de keywords.

```
ANTARES — PROTECTION TEMPS RÉEL POUR LES TOKENS SOLANA

Antares scanne chaque token Solana que tu rencontres pendant ta
navigation sur les principales plateformes de trading et te livre un
verdict 7 couches en quelques secondes. SAFE / CAUTION / DANGER / RUG,
avec un score sur 1000 points et les raisons derrière le verdict.

Tu ne colles pas d'adresse de contrat. Tu ne changes pas d'onglet.
Tu ne signes rien. Tu n'as même pas besoin d'un compte. Le verdict
apparaît dans une overlay déplaçable dès que tu ouvres la page d'un
token.

POURQUOI ANTARES EST DIFFÉRENT

La plupart des détecteurs de rug regardent un seul signal. Antares en
agrège sept et les combine via une moyenne géométrique publiée :

  • Liquidité, volume, âge, action prix
  • Risque honeypot, top holders, détection de nom trompeur
  • Taxe de vente, blacklists, autorité mint et freeze
  • Vrais holders, historique du créateur, distribution du supply
  • Signature des transferts, structure de marché
  • Moteur chart — patterns blow-off, wick trap, escalier
  • Validation croisée de cohérence entre les six couches

Une mauvaise source ne peut pas se cacher ; un faux positif ne peut
pas basculer un token clean en RUG. Un Safe Gate override sur les
flags critiques (LP ouvert, honeypot, autorité mint active, nom
trompeur).

CE QUE TU OBTIENS

Dans l'overlay, live sur chaque page supportée :
  • Le score sur 1000, coloré par verdict
  • Panel Critical Flags — pourquoi ce token est flag, classé par impact
  • AI Summary — le verdict expliqué en 2 à 4 phrases
  • Grille Sell / Mint / Freeze / LP / Liquidité
  • Critical Actors — top 3 holders enrichis avec créateur et cluster

Dans la page Full Analysis, cinq onglets dédiés :
  • Insider Watch — heatmap des top wallets, qui accumule vs qui dump
  • Buy/Sell Flow — argent qui entre vs qui sort sur 5 min / 1 h / 6 h
  • Wash Volume — score wash 0–100, estimation volume réel vs annoncé
  • Sniper Map — activité bots au launch et état de rétention
  • Exit Liquidity — slippage à 100 $ / 1 K$ / 5 K$ / 10 K$ / 20 K$

TARIFICATION — HONNÊTE ET CAPPÉE

  • Free       0 $          Scans illimités, verdict + score + grille
                            de sécurité, soumis à un rate limit par minute

  • Pro        24,99 $/30j  Critical Flags + AI Summary + page Full
                            Analysis + historique de scans + export CSV/JSON

  • Yearly     149,99 $/an  Tout ce qu'il y a en Pro. Paye 6 mois,
                            tu en as 12.

Paye en plus de 200 cryptos via NOWPayments hosted checkout. Ton tier
sync sur chaque appareil où tu te connectes à ton compte Antares.
Pas de clé de licence à coller, pas d'activation manuelle.

Le tier Free est, et reste, illimité.

VIE PRIVÉE

  • Compte optionnel (email + mot de passe) — utile uniquement pour
    les tiers payants et la sync multi-device. Free fonctionne sans
    compte.
  • L'API reçoit l'adresse du contrat scanné plus les métadonnées HTTPS
    standards (IP, user-agent) utilisées uniquement pour le rate limiting.
  • L'historique de scans (feature Pro) est lié à ton compte, jamais
    vendu.
  • Pas d'analytics tiers, pas de pixels de tracking, pas de
    fingerprinting.
  • On ne lit pas les champs de formulaire, credentials, cookies ou
    historique de navigation.
  • Politique complète : https://antaresscan.com/privacy

LIMITES — LIRE CECI

Antares est un screen probabiliste de risque, pas une garantie. Il
détecte ce que sept sources indépendantes remontent au moment du scan.
Les exploits inédits, les dumps coordonnés via wallets fresh, ou les
attaques de social engineering peuvent ne pas registrer. SAFE veut
dire "pas de signaux critiques sur nos sept couches" — pas "money
guaranteed".

Fais toujours tes propres recherches. Le score est un outil, pas une
recommandation.
```

(~3,400 caractères — bien sous la limite de 16,000)

---

## Tags / Mots-clés

CWS n'expose pas de champ tags / mots-clés séparé — le ranking de
recherche provient de la copie de la fiche elle-même. Ne colle aucune
liste à plat de keywords sur le dashboard : c'est exactement le pattern
flagué Yellow Argon (Spam dans les mots-clés) le 09/05/2026.

---

## Promo Twitter

```
Antares v1.3 est live sur le Chrome Web Store.

Scanner temps réel pour tokens Solana — verdict 7 couches, score sur
1000, livré en overlay sur chaque page de token.

Free : scans illimités.
Pro 24,99 $/30j · Yearly 149,99 $/an · paie en 200+ cryptos.
Sync multi-device · zéro tracking.

Install → [link]
```
