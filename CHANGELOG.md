# Changelog

## [3.0.0] — 2026-06-24

### Added

- **PIN-based authentication** — skip Google OAuth on subsequent logins with a local PIN; supports account selection, alphanumeric option, and rate limiting
- **Sync tab** — local folder <-> Google Drive sync with debounce, dirty queue, and offline support
- **Saved accounts** — quick-switch between previously logged-in accounts on the PIN screen
- **Google Drive storage** — replaced Supabase; all vault data stored as per-item encrypted files in the user's Drive
- **TypeScript throughout** — complete JS -> TS migration for main process and renderer
- **Vite bundler** — replaced esbuild with Vite for renderer builds
- **CI workflow** — GitHub Actions with build, typecheck, lint, audit, and SonarCloud analysis
- **Dependabot** — automated dependency updates for npm and GitHub Actions

### Changed

- **Encryption** — AES-256-CBC + HMAC-SHA256 encrypt-then-MAC (replaces CryptoJS legacy; backward-compatible decryption)
- **Key derivation** — PBKDF2-SHA256 with 600k iterations and per-account salt (legacy SHA-256 fallback for old items)
- **Renderer** — full TypeScript typing, Vite bundling
- **Monitor dashboard** — redesigned with stat cards, activity timeline, log filters, and tab caching
- **Settings** — 2-column layout, PIN management controls, sync folder configuration
- **Dependencies** — updated to fix 14 vulnerabilities; removed Supabase leftovers and dead code

### Fixed

- OAuth direct redirect, modal blur sidebar, avatar fallback, sync OS drag-drop, per-file status, breach count
- PIN login flow — account selection required, delete always visible, status obvious
- PIN deletion now clears saved account and disables PIN setting
- Sync folder add/remove/toggle, PIN-only accounts, remove account button
- Key derivation fallback — decrypt old PBKDF2 items with legacy SHA-256
- OS drag-and-drop file paths — use `webUtils.getPathForFile` instead of removed `File.path`
- Sync engine now receives drive client after login
- Settings error visibility, monitor timer leak, SSRF hardening
- Multiple main.js bugs — trash purge, 2FA, lock resilience
- Strict date validation in `jobs:save` — reject invalid calendar dates
- `pintoken` ESM import, `save2fa` base64 encoding mismatch
- Logger API calls across all modules, PIN setup UI
- Renderer base path `'./'` for `file://` protocol compatibility
- `parse5` control-character warning in `index.html`
- SonarCloud Automatic Analysis conflict — CI now disables it via API before scanning

### Removed

- Supabase storage backend (replaced by Google Drive)
- Admin email concept — dead code with no functional use
- Animated glowing background effects (canvas nebulae + aurora blobs)
- CodeQL job from CI (replaced by SonarCloud)
- DESIGN.md and PRODUCT.md
- Temporary `fix_unicode.py` script

### Refactored

- Complete JS -> TypeScript migration (main process + all modules + renderer)
- Replaced esbuild with Vite for TypeScript-only architecture
- Finalized renderer TypeScript typing
- Removed build output JS files from git tracking
- Set `moduleResolution` to `bundler` to avoid deprecation warnings

## [2.0] — 2026-05-26

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

- Generic error messages (no internal details leaked to renderer)
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
- Electron 42
