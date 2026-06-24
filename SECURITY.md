# Security Policy

## Supported Versions

We fix security issues on the latest release only.

| Version | Supported          |
| ------- | ------------------ |
| 1.x.x   | ✅ Yes              |
| < 1.0   | ❌ No               |

## Reporting a Vulnerability

**Please do not open a public GitHub issue, discussion, or pull
request for security problems** — doing so exposes users before a fix
is available.

Instead, report the issue privately via GitHub's
**[Private Vulnerability Reporting](https://github.com/antaresscan/antares-extension/security/advisories/new)**
form. That channel is end-to-end private between reporters and
maintainers, and it is the only supported intake for security issues.

If for some reason you cannot use the form, open a **confidential**
draft security advisory from the repository's Security tab.

### What to include

- A clear description of the vulnerability and its impact
- Reproduction steps (a minimal PoC is ideal)
- The affected component (API route, content-script module, scoring
  layer, extension surface)
- The version / commit hash where you observed it
- Any suggested mitigation if you have one

### What to expect

| Stage                   | Target                |
| ----------------------- | --------------------- |
| Initial acknowledgement | Within **72 hours**   |
| Triage and severity     | Within **7 days**     |
| Fix or mitigation plan  | Within **14 days** for critical issues, **30 days** for lower severity |
| Public disclosure       | Coordinated with the reporter after a fix ships |

We do not currently operate a paid bug bounty, but we credit reporters
in release notes and in the fix PR unless you ask to remain anonymous.

## Scope

In scope for a security report:

- Backend API handlers (`api/*`)
- Shared backend libraries (`api/_lib/*`) — scoring, pipeline,
  rate limiting, input validation, Redis usage
- Chrome extension service worker (`background.ts`), content scripts
  (`contents/*`), popup / options UI
- Extension manifest permissions and CSP configuration
- CI / release pipelines (`.github/workflows/*`) as they affect what
  ships to users

## Out of scope

- Vulnerabilities in third-party APIs we query (Helius, GoPlus,
  RugCheck, DexScreener, Solscan, GeckoTerminal) — report those to the
  upstream provider
- Generic browser-level issues not specific to this extension
- Issues that require a privileged attacker already on the victim's
  machine (physical access, existing malware)
- Social-engineering attacks against maintainers
- Reports that consist only of the output of a generic scanner
  without any exploitability analysis
- Denial-of-service against our own infrastructure through request
  volume alone (covered by our rate limiter, not a product bug)

## Safe Harbor

We will not pursue legal action against researchers who follow this
policy in good faith, act only against their own test accounts or
data, and avoid degrading service for other users during testing.
