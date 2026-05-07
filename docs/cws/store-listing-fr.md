# Chrome Web Store — Listing Copy (Français)

> Version FR du store listing. Pour la VO anglaise, voir `store-listing-en.md`.
> À copier-coller dans le Chrome Web Store Developer Dashboard pour la
> localisation française.

---

## Nom (max 75 caractères)

```
Antares — Scanner de Risque Token Solana
```

---

## Description courte / Résumé (max 132 caractères)

```
Repère les rugs Solana avant de cliquer. Scoring 7 couches sur chaque page token. Scans illimités gratuits, Pro pour les power users.
```

(127 caractères)

---

## Catégorie

Principale : **Productivité**
Secondaire : **Outils pour développeurs**

---

## Description détaillée

```
ANTARES — REPÈRE LES RUGS SOLANA AVANT DE CLIQUER

Antares scanne chaque token Solana que tu rencontres pendant ta navigation —
DexScreener, pump.fun, Axiom, Photon, Birdeye, GeckoTerminal, GMGN, Jupiter,
Raydium, Solscan — et te donne un verdict 7 couches en quelques secondes.
SAFE / CAUTION / DANGER / RUG, avec un score sur 1000 points et les raisons
derrière le verdict.

Tu ne colles pas d'adresse de contrat. Tu ne changes pas d'onglet. Tu ne
signes rien. Tu n'as même pas besoin d'un compte. Le verdict apparaît dans
une overlay déplaçable dès que tu ouvres la page d'un token.

POURQUOI ANTARES EST DIFFÉRENT

La plupart des détecteurs de rug regardent un seul signal. Antares en
agrège sept, puis les combine via une moyenne géométrique publiée (chaque
ligne est auditable sur GitHub) :

  • DexScreener  — liquidité, volume, âge, action prix
  • RugCheck     — risque honeypot, top holders, nom trompeur
  • GoPlus       — taxe de vente, blacklists, autorité mint/freeze
  • Helius       — supply, vrais holders, historique du créateur
  • Solscan      — signature des transferts, structure de marché
  • Chart Engine — patterns blow-off / wick trap / escalier
  • Validation croisée — vérification de cohérence entre les six couches

Une mauvaise source ne peut pas se cacher ; un faux positif ne peut pas
basculer un token clean en RUG. Un "Safe Gate" override sur les flags
critiques (LP ouvert, honeypot, autorité mint active, nom trompeur).

CE QUE TU OBTIENS

  Dans l'overlay (live sur chaque page token) :
  • Le score sur 1000, coloré par verdict
  • Panel Critical Flags — pourquoi ce token est flag, classé par impact
  • AI Summary — le verdict expliqué en 2-4 phrases
  • Grille Sell / Mint / Freeze / LP / Liquidité
  • Critical Actors — top 3 holders enrichis avec créateur + cluster

  Dans la page Full Analysis (section Deep Analysis, 5 onglets dédiés) :
  • Insider Watch — heatmap des top wallets, qui accumule vs qui dump,
                    avec fallback top-10 holders quand pas d'activité
  • Buy/Sell Flow — argent qui entre vs qui sort sur 5min / 1h / 6h
  • Wash Volume — score wash 0-100, estimation volume réel vs annoncé
  • Sniper Map — activité bots au launch + état de rétention
  • Exit Liquidity — slippage à $100 / $1K / $5K / $10K / $20K de sell

TARIFICATION — HONNÊTE ET CAPPÉE

  • Free        0 $          Scans ILLIMITÉS sur tous les sites supportés
                             Verdict + score + grille Sell/Mint/Freeze/LP
                             Soumis à un rate limit par minute pour
                             garder l'API saine

  • Pro         24,99 $ / 30 jours
                             Critical Flags + AI Summary débloqués
                             Page Full Analysis avec ses 5 onglets
                             Critical Actors + Insider Watch
                             Historique de scans, export CSV/JSON, cache
                             prioritaire

  • Yearly      149,99 $ / an
                             Tout ce qu'il y a en Pro
                             Meilleur deal — paye 6 mois, tu en as 12

Paye en 200+ cryptos via NOWPayments hosted checkout (BTC, ETH, SOL,
USDC, USDT, BNB, MATIC, DOGE… auto-converti en USD côté NOWPayments,
tu ne gères pas les swaps). Ton tier sync sur tous les appareils où tu
te connectes à ton compte Antares — pas de license-key à coller, pas
d'activation manuelle.

Aucun bait-and-switch. Le tier Free reste illimité.

VIE PRIVÉE

  • Compte optionnel (email + mot de passe) — utile uniquement pour les
    tiers payants et la sync multi-device. Free fonctionne sans compte.
  • L'API reçoit l'adresse du contrat scanné + métadonnées HTTPS
    standards (IP, user-agent) utilisées uniquement pour le rate limiting
  • L'historique de scans (feature Pro) est lié à ton compte, jamais vendu
  • Pas d'analytics tiers, pas de pixels de tracking, pas de fingerprinting
  • On ne lit pas les champs de formulaire, credentials, cookies ou
    historique de navigation
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
  • Jupiter (jup.ag)
  • Raydium (raydium.io)
  • Solscan (solscan.io)
  • Telemetry (app.telemetry.io)

OPEN SOURCE

Le code de l'extension est entièrement open source — chaque ligne du
moteur de scoring est auditable.
https://github.com/COMEALAMAISONGROUPE/antares-extension

LIMITES — LIRE CECI

Antares est un screen probabiliste de risque, pas une garantie. On surface
ce que sept sources indépendantes remontent au moment du scan. Les
exploits inédits, les dumps coordonnés via wallets fresh, et les attaques
social-engineering peuvent ne pas registrer. SAFE veut dire "pas de
signaux critiques sur nos sept couches" — c'est PAS "money guaranteed",
et Antares N'EST PAS un conseil financier.

Fais toujours tes propres recherches. Le score est un outil, pas une
recommandation. Les marchés crypto bougent plus vite que n'importe quel
scanner ; ce qui est SAFE à 14h00 UTC peut rug à 14h05.
```

(~4,100 caractères — bien sous la limite de 16,000)

---

## Tags / Mots-clés (ranking de recherche)

solana, détecteur rug, anti-arnaque, scanner token, honeypot, rugpull,
dexscreener, pump.fun, sécurité web3, défi safety, memecoin,
sécurité crypto, jupiter, raydium, solscan, photon, birdeye

---

## Promo Twitter

```
🛡️ Antares v1.3 — Scanner de Risque Token Solana

Repère les rugs avant de cliquer. 7 couches de détection, score sur 1000,
dans ton overlay sur chaque dex.

Free : scans illimités sur tous les sites
Pro 24,99 $/30j · Yearly 149,99 $/an · paie en 200+ cryptos
Sync multi-device · open-source · zéro tracking

Install → [link]
```
