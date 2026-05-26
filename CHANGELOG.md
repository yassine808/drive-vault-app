# Changelog

## [2.0.0] — 2026-05-26

### Major Changes

- **Rewritten encryption** — Replaced CryptoJS EVP_BytesToKey with AES-256-CBC + HMAC-SHA256 encrypt-then-MAC for authenticated encryption. Old CryptoJS ciphertext is auto-detected and decrypted via backward-compat fallback.
- **Module architecture** — Split 1253-line `main.js` into 8 focused modules: `auth.js`, `crypto.js`, `validation.js`, `jobs.js`, `totp.js`, `settings.js`, `logo.js`, `monitor.js`. Main process reduced to 717 lines.
- **Settings persistence** — All settings now fully persisted to `vault_settings` table with instant-apply and debounced DB writes (removed save/reset buttons).
- **New settings** — Compact mode, animations toggle, lock countdown, lock-on-minimize, password generator defaults, granular sound controls (per-event tone pickers + test buttons).
- **Admin dashboard** — Monitor tab with user management, global stats, error log viewer — all gated to admin email.
- **System tray** — App minimizes to tray on close. Tray menu includes Lock Vault + Logout.
- **Sound system** — Web Audio API with per-event tone presets (chime, ding, soft, bright, click, tap, pop) and test buttons in Settings.

### Security Hardening (32 fixes)

A comprehensive audit scanned every file across 5 attack surfaces:

**IPC & Auth (7 fixes)**
- Timing-safe token validation (`crypto.timingSafeEqual`, no early returns)
- Session fixation prevention on login and reauth (token invalidated before OAuth flow)
- Lock/logout now fully clears session state (`session = null`)
- 2FA rate-limit checked before format validation
- Monitor endpoints switched to `requireAdminNoArgs`
- 2FA disable now requires valid TOTP code + rate limiting

**Cryptography & Secrets (4 fixes)**
- AES-256-CBC + HMAC-SHA256 encrypt-then-MAC (replaces unauthenticated CryptoJS)
- Dual key derivation: separate `encKey` and `macKey` from single hex key
- Lock clears all sensitive data from renderer memory + DOM
- Clipboard auto-clears after 30 seconds

**Database & SQL (8 fixes)**
- Generic error messages (no Supabase internal details leaked to renderer)
- Explicit column SELECT statements instead of `SELECT *`
- Domain validation on logo fetch (SSRF prevention)
- Job status validated against whitelist
- Email `mailto:` links use `encodeURIComponent`
- Admin error messages sanitized

**Config & Electron (6 fixes)**
- `will-navigate` blocks non-file: protocol navigation
- `setWindowOpenHandler` denies child windows
- OAuth pathname exact match + strict origin validation
- CSP hardened: `frame-src 'none'`, `worker-src 'none'`, Google Fonts removed
- System font stack replaces external Google Fonts dependency

**XSS & DOM Hardening (7 fixes)**
- All `innerHTML` replaced with `createElement`/`textContent` for user-controlled data
- QR code generation moved client-side (no secret sent to third-party server)
- Avatar/image URLs validated (`https://` prefix)
- All error display sanitized
- Toast messages use safe DOM insertion

### UI

- Glassmorphism design with backdrop-filter on all elevated surfaces
- 13 accent colors (violet, blue, teal, cyan, green, lime, yellow, amber, orange, red, rose, pink, indigo)
- Canvas background animation with particles
- Custom frameless titlebar with minimize/maximize/close
- CSPRNG password generator (Fisher-Yates shuffle) with configurable options

### Logging

- New `src/logger.js`: per-level log files in `Logs/` directory (debug, info, success, warn, error, auth, ipc, db) + combined `all.log`
- Log rotation at 5 MB with session headers
- Every IPC handler, DB operation, OAuth flow, and token event logged

### Build

- Windows builds now produce both NSIS installer and portable `.exe`
- Electron 42, Supabase JS 2.43
