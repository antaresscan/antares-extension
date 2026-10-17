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
Scanner de tokens Solana en temps réel. Verdict multi-sources sur chaque token. Scans illimités gratuits, Pro pour les power users.
```

(131 caractères)

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
>
> Corrigée le 17/10/2026 (audit fichier par fichier) : chaque phrase
> ci-dessous dit ce que fait le code. Cinq sources de données au lieu de
> « sept couches » ; pas de blacklists ; pas d'historique de scans ni
> d'export CSV/JSON ; Critical Actors dans la page Full Analysis, pas
> dans l'overlay. À coller dans le dashboard (la fiche publiée porte
> encore les anciennes phrases).

```
ANTARES — PROTECTION TEMPS RÉEL POUR LES TOKENS SOLANA

Antares scanne chaque token Solana que tu rencontres pendant ta
navigation sur les principales plateformes de trading et te livre un
verdict multi-sources en quelques secondes. SAFE / CAUTION / DANGER / RUG,
avec un score sur 1000 points et les raisons derrière le verdict.

Tu ne colles pas d'adresse de contrat. Tu ne changes pas d'onglet.
Tu ne signes rien. Tu n'as même pas besoin d'un compte. Le verdict
apparaît dans une overlay déplaçable dès que tu ouvres la page d'un
token.

POURQUOI ANTARES EST DIFFÉRENT

La plupart des détecteurs de rug regardent un seul signal. Antares lit
cinq sources de données indépendantes et les combine via une moyenne
géométrique pondérée, puis recoupe la chaîne avec GoPlus :

  • Marché : liquidité, volume, âge du token, action prix
  • Contrat : autorités mint et freeze lues sur la chaîne, le token
    peut-il lui-même bloquer une vente, frais de transfert Token-2022
  • Signaux de risque : noms trompeurs, historique de rug du créateur,
    liquidité non verrouillée
  • Holders : nombre de holders, concentration du top holder et du top 10
  • Chart : blow-off, wick trap, patterns en escalier

Une mauvaise source ne peut pas se cacher ; un faux positif ne peut
pas basculer un token clean en RUG. Un Safe Gate bloque le verdict SAFE
dès qu'un flag dur est présent (liquidité ouverte, mécanisme qui bloque
la vente, autorité mint ou freeze active, nom trompeur, concentration
sévère).

CE QUE TU OBTIENS

Dans l'overlay, live sur chaque page supportée :
  • Le score sur 1000, coloré par verdict
  • Panel Critical Flags — pourquoi ce token est flag, classé par impact
  • AI Summary — le verdict expliqué en quelques courts paragraphes
  • Grille Sell / Mint / Freeze / LP / Liquidité

Dans la page Full Analysis, les 3 plus gros holders (Critical Actors,
avec tags créateur et cluster) et cinq onglets dédiés :
  • Insider Watch — ce que les 10 plus gros wallets ont fait ces 6
    dernières heures
  • Buy/Sell Flow — achats et ventes sur 5 min / 1 h / 6 h
  • Wash Volume — score de wash trading 0–100 d'après les trades
    DexScreener
  • Sniper Map — part du supply détenue par le top 10, et signal sniper
    ou bundle
  • Exit Liquidity — slippage à 100 $ / 1 K$ / 5 K$ / 10 K$ / 20 K$

TARIFICATION — HONNÊTE ET CAPPÉE

  • Free       0 $          Scans illimités, verdict + score + grille
                            de sécurité, soumis à un rate limit par minute

  • Pro        24,99 $/30j  Critical Flags + AI Summary + page Full
                            Analysis

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
  • L'API reçoit l'adresse du contrat scanné, un identifiant
    d'installation aléatoire, ton jeton de connexion si tu es connecté,
    et les métadonnées HTTPS standards (IP, user-agent).
  • Les scans sont enregistrés par installation (les plus récents), liés
    à ton compte si tu en as un, jamais vendus.
  • Pas d'analytics tiers, pas de pixels de tracking, pas de
    fingerprinting. Les rapports d'erreur vont à Sentry, sans adresse
    e-mail, sans adresse IP et sans paramètres d'URL.
  • On ne lit pas les champs de formulaire, credentials ni cookies.
    L'extension compare seulement les adresses de tes onglets ouverts,
    sur ton appareil, pour réutiliser un onglet d'analyse déjà ouvert ;
    elles ne sont jamais stockées ni envoyées.
  • Sur le site Antares uniquement, l'extension donne à la page ton
    identifiant d'installation (pour rattacher un achat à ton
    installation) et garde le jeton de connexion que la page lui remet.
  • Politique complète : https://antaresscan.com/privacy

LIMITES — LIRE CECI

Antares est un screen probabiliste de risque, pas une garantie. Il
détecte ce que ses sources de données remontent au moment du scan.
Les exploits inédits, les dumps coordonnés via wallets fresh, ou les
attaques de social engineering peuvent ne pas registrer. SAFE veut
dire "aucun signal critique dans aucune de nos sources de données" —
pas "money guaranteed".

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

Scanner temps réel pour tokens Solana — verdict multi-sources, score sur
1000, livré en overlay sur chaque page de token.

Free : scans illimités.
Pro 24,99 $/30j · Yearly 149,99 $/an · paie en 200+ cryptos.
Sync multi-device · zéro tracking.

Install → [link]
```
