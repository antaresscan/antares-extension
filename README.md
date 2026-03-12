# Antares — Solana Token Risk Scanner

> Extension Chrome qui scanne automatiquement les tokens Solana en temps réel, sur **n'importe quelle page web**.

---

## Ce que ça fait

Antares injecte une overlay flottante dès qu'une adresse de token Solana est détectée dans la page (URL, DOM, attributs HTML, liens d'explorers). Elle affiche instantanément :

- **Niveau de risque** : `SAFE` / `CAUTION` / `DANGER` / `RUG`
- **Score** sur 1000
- **Flags** : mint authority active, freeze authority, concentration de holders, liquidité faible, etc.

Sans clic. Sans quitter la page. Sur Twitter, Telegram Web, Discord, DexScreener, Photon, n'importe où.

---

## Architecture

```
antares-extension/
├── contents/
│   └── antares-inject.ts   # Content script — détection + overlay
├── api/
│   └── scan.ts             # Backend Vercel — scoring multi-sources
├── background.ts           # Service worker Plasmo
└── public/
```

**Content script** (`contents/antares-inject.ts`)
- Tourne sur `<all_urls>` au chargement de chaque page
- Détecte les adresses Solana par scoring : data-attributes (200pts) → liens Solscan (180pts) → text nodes (120pts) → URL (60pts)
- Gère la navigation SPA via `pushState`, `replaceState`, `popstate` et `MutationObserver`
- Cache local 30s pour éviter les appels API redondants

**Backend** (`api/scan.ts`) — déployé sur Vercel
- Agrège DexScreener + RugCheck (full report) + GoPlus Solana
- Score part de 1000, dégradé par pénalités `critical` / `warning` / `info`
- Résolution pair → mint (adresse LP Raydium → vrai token)
- Cache HTTP `s-maxage=30`

---

## Installation (dev)

```bash
git clone https://github.com/COMEALAMAISONGROUPE/antares-extension
cd antares-extension
npm install
npm run dev
```

Charge le dossier `build/chrome-mv3-dev` dans `chrome://extensions` (mode développeur activé).

## Build production

```bash
npm run build
```

Le bundle est dans `build/chrome-mv3-prod`.

---

## Scoring

| Niveau | Score |
|--------|-------|
| SAFE   | ≥ 800 |
| CAUTION | ≥ 600 |
| DANGER | ≥ 350 |
| RUG    | < 350 |

---

## Déploiement

L'API est déployée sur Vercel : `https://antares-extension.vercel.app/api/scan`

Chaque push sur `master` déclenche un redéploiement automatique.

---

## Revenir en arrière

```bash
git revert HEAD
git push origin master
```
