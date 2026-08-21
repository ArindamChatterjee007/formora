# Formora — ISO Compliance Mapping

This document tracks Formora against the two ISO standards that matter for a
consumer web/mobile app: **ISO/IEC 25010** (product quality model) and
**ISO/IEC 27001:2022 Annex A** (information-security controls). It records what
is implemented, what is in progress, and the remaining gaps.

Status legend: ✅ met · 🟡 partial · 🔴 gap

## ISO/IEC 25010 — Product quality

| Characteristic          | Status | Evidence / control |
| ----------------------- | ------ | ------------------ |
| Functional suitability  | ✅ | QA regression suite run on every promotion (see PIPELINE.md) |
| Performance efficiency  | ✅ | Budgets in [PERFORMANCE_REQUIREMENTS.md](PERFORMANCE_REQUIREMENTS.md), enforced by CI `perf-budget` |
| Compatibility           | ✅ | Vanilla web + Capacitor iOS/Android from one codebase |
| Usability               | 🟡 | Reduced-motion support, semantic controls; formal a11y audit pending |
| Reliability             | 🟡 | CI syntax/version/security gates; no automated E2E yet |
| **Security**            | 🟡 | See 27001 table below — output escaping ✅, transport TLS ✅, access-control 🔴 |
| Maintainability         | ✅ | Modular files, four-stage pipeline, code owners |
| Portability             | ✅ | Static assets, no server lock-in for the client |

## ISO/IEC 27001:2022 Annex A — Security controls (selected)

| Control | Area | Status | Implementation |
| ------- | ---- | ------ | -------------- |
| A.5.15 Access control | Backend data | 🔴→🟡 | Supabase RLS being re-enabled with per-`uid` policies ([supabase/security.sql](../supabase/security.sql)); replaces the current open anon access |
| A.8.3 Information access restriction | Sensitive fields | 🟡 | Health fields (weight/BMI/height) restricted from the public read path |
| A.8.24 Use of cryptography | Passwords | ✅ | Salted **PBKDF2-SHA256, 150k iterations** ([js/auth.js](../js/auth.js)); legacy SHA-256 accounts auto-upgraded on next login |
| A.8.24 Use of cryptography | Transport | ✅ | HTTPS everywhere (GitHub Pages + Supabase TLS) |
| A.8.26 Application security requirements | XSS | ✅ | All user input HTML-escaped via `esc()`; CI guards against unescaped `src`/`href` sinks |
| A.8.9 Configuration management | CSP | ✅ | Content-Security-Policy + Referrer-Policy + X-Content-Type-Options meta in [index.html](../index.html) |
| A.8.12 Data leakage prevention | Secrets in source | ✅ | No hardcoded third-party API secrets; CI `secret-scan` blocks them (Supabase anon key is public-by-design) |
| A.5.34 Privacy & PII protection | Member data | 🟡 | Health data classified sensitive; server-side minimization in progress |
| A.8.28 Secure coding | Pipeline gate | ✅ | `dev → release → beta → main` with CI security gates before production |
| A.5.7 Threat intelligence | Disclosure | ✅ | [SECURITY.md](../SECURITY.md) vulnerability-reporting policy |
| A.8.16 Monitoring | Runtime | 🔴 | No server-side logging/alerting yet (client is static) |

## Residual gaps (prioritised)

1. **Access control (A.5.15)** — full fix requires real Supabase Auth so writes
   can be bound to an authenticated identity. Interim: RLS + revoked destructive
   anon grants + minimized public reads. Impersonation is only fully closed once
   identity comes from a verified session, not a client-supplied email.
2. **Monitoring (A.8.16)** — add Supabase logs/alerts on anomalous write volume.
3. **A11y audit (25010 Usability)** — formal WCAG pass.

_Last reviewed: 2026-08-22 (v95)._
