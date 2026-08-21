# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Email the
maintainer with details and steps to reproduce; you will get an acknowledgement
and a fix timeline. Coordinated disclosure is appreciated.

## Security posture (v95)

- **Transport:** HTTPS everywhere (GitHub Pages, Supabase).
- **Passwords:** salted PBKDF2-SHA256 (150k iterations); legacy accounts are
  transparently re-hashed to PBKDF2 on next successful login.
- **XSS:** all user-controlled values are HTML-escaped via `esc()`; CI blocks
  unescaped `src`/`href` interpolations in the feed.
- **CSP:** Content-Security-Policy, Referrer-Policy and X-Content-Type-Options
  are set via `<meta>` in `index.html`.
- **Secrets:** no third-party API secrets are committed; CI `secret-scan`
  enforces this. The Supabase **anon** key is public by design and must be
  paired with Row Level Security.
- **Access control:** Supabase RLS with per-`uid` policies (see
  `supabase/security.sql`). The complete fix (removing identity spoofing)
  depends on migrating to authenticated Supabase sessions.

## Data classified as sensitive

Biometric/health fields (weight, BMI, height, gender) and email. These are
minimized on the public read path and must never be exposed to unauthenticated
callers.

## Supported versions

Only the latest production release on `main` is supported.
