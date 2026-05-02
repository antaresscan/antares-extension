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
Scanner de tokens Solana en temps réel. Détecte rug pulls, honeypots, bundlers et manipulation de charts. Gratuit.
```

(115 caractères)

---

## Catégorie

Principale : **Productivité**
Secondaire : **Outils pour développeurs**

---

## Description détaillée

```
ANTARES — STOP AUX ARNAQUES SUR SOLANA

Antares scanne chaque token Solana que tu rencontres pendant ta navigation —
DexScreener, pump.fun, Axiom, Photon, Birdeye, GeckoTerminal, GMGN — et te
donne un verdict en quelques secondes. SAFE / CAUTION / DANGER / RUG, avec
un score sur 1000 points basé sur sept couches d'analyse indépendantes.

Tu ne colles pas d'adresse de contrat. Tu ne changes pas d'onglet. Tu ne
signes rien. Le verdict apparaît dans une overlay déplaçable dès que tu
ouvres la page d'un token.

POURQUOI ANTARES EST DIFFÉRENT

La plupart des détecteurs de rug regardent un seul signal. Antares en
agrège sept :

  • DexScreener  — liquidité, volume, âge, action prix
  • RugCheck     — honeypot, top holders, nom trompeur
  • GoPlus       — taxe de vente, blacklists, autorité mint/freeze
  • Helius       — supply, vrais holders, historique du créateur
  • Solscan      — signature des transferts, structure de marché
  • Chart Engine — patterns blow-off / wick trap / escalier
  • Validation croisée — vérification de cohérence entre les six couches

Le verdict final est une moyenne géométrique des trusts par couche. Une
mauvaise source ne peut pas se cacher ; un faux positif ne peut pas
basculer un token clean en RUG. Un "Safe Gate" override sur les flags
critiques (LP ouvert, honeypot, autorité mint active, nom trompeur).

CE QUE TU VOIS DANS L'OVERLAY

  • Le score sur 1000, coloré par verdict
  • Panel Critical Flags (pourquoi ce token est flag, classé par impact)
  • AI Summary qui explique le verdict en 2-4 phrases
  • Holder Activity (60 dernières minutes — vois les whales dump en live)
  • Verdict Timeline (historique des verdicts pour ce token)
  • Grille Sell / Mint / Freeze / LP / Liquidité

TARIFICATION — HONNÊTE ET PLAFONNÉE

  • Free      0 €         50 scans/jour (reset à 00h00 UTC)
  • Pro       14,99 $/mo  Scans illimités, historique, watchlist (50),
                          breakdown détaillé du scoring, cache prioritaire,
                          export CSV/JSON, pas de prompts affiliés
  • Lifetime  99 $ une    Features Pro à vie, badge Sentinel Founder,
              fois        Discord privé, vote roadmap — limité aux 1000
                          premiers supporters

Le tier gratuit ne sera jamais downgradé. Aucun bait-and-switch. Le cap
50/jour est annoncé dès le jour 1 — tu peux scanner autant de tokens
qu'un user normal le ferait sans jamais payer un centime.

VIE PRIVÉE

  • Pas de comptes, pas de tracking, pas d'analytics
  • L'API reçoit l'adresse du contrat scanné + métadonnées HTTPS standards
    (IP, user-agent) utilisées uniquement pour le rate limiting
  • L'historique de scans (feature Pro) est lié à un identifiant
    d'installation généré aléatoirement, jamais à un email ou un wallet
  • On ne lit pas les champs de formulaire, credentials, cookies ou
    historique de navigation
  • On ne vend rien à personne
  • Politique complète : https://antares-website.vercel.app/privacy

PLATEFORMES SUPPORTÉES

L'overlay s'active automatiquement sur :
  • DexScreener (dexscreener.com)
  • pump.fun
  • Axiom (axiom.trade)
  • Photon (photon-sol.tinyastro.io)
  • Birdeye (birdeye.so)
  • GeckoTerminal (geckoterminal.com)
  • GMGN (gmgn.ai)
  • Telemetry (app.telemetry.io)

OPEN SOURCE

Le code de l'extension est entièrement open source — chaque ligne du
moteur de scoring est auditable.
https://github.com/COMEALAMAISONGROUPE/antares-extension

LIMITES — LIRE CECI

Antares est un screen probabiliste de risque, pas une garantie. On peut
détecter ce que six sources indépendantes remontent au moment du scan.
Les exploits inédits, les dumps coordonnés via wallets fresh, ou les
attaques social-engineering peuvent ne pas registrer. SAFE veut dire
"pas de signaux critiques sur nos sept couches" — pas "money guaranteed".

Fais toujours tes propres recherches. Le score est un outil, pas une
recommandation.
```
