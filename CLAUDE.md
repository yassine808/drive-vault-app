# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Vault** is an Electron desktop app for secure storage of passwords, notes, job applications, and TOTP authenticator secrets. All sensitive data is AES-256 encrypted client-side before being stored in Supabase (PostgreSQL). Authentication is via Google OAuth 2.0 with optional TOTP-based 2FA.

No frontend framework. TypeScript throughout: main process uses `tsc` + `tsx`, renderer uses Vite/esbuild bundling.

## Commands

```bash
npm install         # Install dependencies
npm run typecheck   # TypeScript check (tsc --noEmit), no emit
npm start           # Production: Vite build + run main
npm run dev         # Dev: Vite dev server + tsx main (DevTools detached)
npm run build:all   # Vite build + tsc (for packaging)
npm run build:win   # Windows installer (NSIS)
npm run build:mac   # macOS package
npm run build:linux # Linux AppImage
```

No tests, linting, or formatting tools exist.

## Architecture

### File Structure

| File | Role |
|---|---|
| `src/main.ts` | Electron main process — entry point. Loads config, creates window, registers IPC, contains OAuth flow, DB helpers, session management. |
| `src/modules/auth.ts` | Session token generation/validation, `requireAuth()` / `requireAuthNoArgs()` / `requireAdminNoArgs()` IPC guards, 2FA rate limiter. |
| `src/modules/crypto.ts` | Key derivation (`SHA-256("vault:" + googleId)`), AES-256-CBC + HMAC-SHA256 encrypt-then-MAC, backward-compatible CryptoJS legacy decryption. |
| `src/modules/validation.ts` | Shared validators: `sanitizeStr`, `validType`, `validEmail`, `validTotpSecret`, `validDomain`. |
| `src/modules/jobs.ts` | Job tracker CRUD — registered via `register()` pattern. Jobs stored as plaintext columns. |
| `src/modules/totp.ts` | TOTP secret management (encrypted) — registered via `register()` pattern. |
| `src/modules/settings.ts` | Settings load/save with validation — registered via `register()` pattern. |
| `src/modules/monitor.ts` | DB stats, log read/clear, admin user listing — registered via `register()`. All handlers use `requireAdminNoArgs`. |
| `src/modules/logo.ts` | Favicon fetching + caching as data URLs — registered via `register()` pattern. |
| `src/types/index.ts` | Shared TypeScript interfaces (Session, VaultItem, Job, TotpItem, Settings, etc.) |
| `src/logger.ts` | Structured logging to per-level files in `Logs/` directory. |
| `preload.ts` | Context bridge — session token in closure, auto-prepended to sensitive IPC calls. |
| `index.html` | All renderer UI (single file). |
| `app.css` | Single stylesheet, `oklch()` color space, glassmorphism. |
| `app.ts` | All renderer JS — event handlers, DOM manipulation, state, sounds. |

TypeScript is strict mode for main process (`tsconfig.json`) and renderer (`tsconfig.renderer.json` with `strictNullChecks: false`). Main process compiles to `dist/` via `tsc`; renderer bundles via Vite/esbuild.

### Process Model

```
Renderer (app.ts + index.html)
    │  IPC (context bridge via preload.ts)
    ▼
Main Process (src/main.ts)
    ├── OAuth local HTTP server (127.0.0.1:42813)
    ├── Crypto (AES-256-CBC + HMAC-SHA256)
    └── Supabase (PostgreSQL)
```

### Module Registration Pattern

`main.ts` is the entry point (~1400 lines). Domain modules (`jobs.ts`, `totp.ts`, `settings.ts`, `monitor.ts`, `logo.ts`) export a `register()` function called inside `app.whenReady()`. Each `register()` receives `ipcMain`, auth wrappers, `supabase`, `validation`, `getSession`, `logger`, and `logError` — then calls `ipcMain.handle()` directly. This avoids passing `supabase` as a constructor parameter before it's initialized.

Some modules with encrypted data (totp, settings) also receive `enc`/`dec` crypto functions directly in their `register()` signature.

### IPC Channels

All async handlers use `ipcMain.handle`. Channels are namespaced:

| Namespace | Auth | Description |
|---|---|---|
| `auth:` | No | Login, reauth, 2FA verify, logout, lock |
| `vault:` | Yes | CRUD for passwords & notes |
| `trash:` | Yes | Soft-delete restore & purge |
| `jobs:` | Yes | CRUD for job applications (including `jobs:trash:*`) |
| `totp:` | Yes | TOTP secret management |
| `2fa:` | Yes | 2FA setup/enable/disable |
| `settings:` | Yes | Settings read/write |
| `monitor:` | Admin | DB stats & log viewing |
| `admin:` | Admin | User listing & global stats |
| `logo:` | Yes | Favicon fetching & caching |
| `log:` | Admin | Error log access |
| `win:` | Yes | Window minimize/maximize/close |

All handlers return `{ ok: boolean, ... }` pattern. Errors are caught and returned as `{ ok: false, error: string }` — raw Supabase errors are never leaked to the renderer.

### Session & Auth

- **Session token**: 256-bit random hex string stored in a preload closure (inaccessible to renderer DOM). Auto-prepended to all sensitive IPC calls.
- **Validation**: `crypto.timingSafeEqual()` with safe fallback buffers to prevent timing attacks. 12-hour max token age.
- **Rotation**: Token is regenerated on every auth event (login, 2FA verify, reauth). Cleared on logout/lock.
- **Admin guard**: `requireAdminNoArgs` checks `session.email === ADMIN_EMAIL` (`ysmagri@gmail.com`, overridable via env var).
- **2FA rate limiting**: 5 attempts per 15-minute sliding window, 15-minute lockout.

### Encryption

- **New format**: AES-256-CBC + HMAC-SHA256 encrypt-then-MAC. Output: `base64(HMAC(32) || IV(16) || ciphertext)`.
- **Key derivation**: `SHA-256("vault:" + googleId)` → 32 hex chars. Separate enc/MAC keys via `SHA-256(key)` / `SHA-256(key + "mac")`.
- **Legacy fallback**: Old CryptoJS ciphertext (starts with `U2FsdGVk`) auto-detected and decrypted via CryptoJS.
- **What's encrypted**: Passwords, notes, TOTP secrets, 2FA secrets. Jobs are plaintext.

### Database Tables

All tables are scoped by `vault_users.id` via `user_id` foreign key. Soft deletes use `deleted_at` with 30-day auto-purge.

| Table | Purpose |
|---|---|
| `vault_users` | User profiles (google_id, email, name, avatar_url, last_seen) |
| `vault_items` | Encrypted passwords & notes (`type`, `encrypted_data`, `deleted_at`) |
| `vault_jobs` | Plaintext job applications (company, role, email, status, notes) |
| `vault_totp` | Encrypted TOTP secrets (name, issuer, secret, icon) |
| `vault_2fa` | User's own 2FA config (secret, enabled) |
| `vault_settings` | UI preferences (lock_timeout, accent, sounds, generator defaults, etc.) |
| `vault_logos` | Favicon cache (domain → data URL) |

Explicit column lists are used on all Supabase queries (never `SELECT *`).

### Security Measures

- **CSP**: `script-src 'self'`, `frame-src 'none'`, `worker-src 'none'`, no external fonts.
- **XSS**: User data rendered via `createElement` / `textContent` only. No `innerHTML` for dynamic content.
- **Navigation**: `will-navigate` blocks non-file: URLs. `setWindowOpenHandler` denies child windows.
- **OAuth hardening**: Origin validation, single-use `state`, 5-minute state expiry, exact pathname match.
- **Input validation**: All IPC handlers validate type, length, and format at the boundary. Errors sanitized before reaching renderer.
- **Clipboard**: Auto-clears after 30 seconds.
- **Lock**: Clears session from memory + clears sensitive DOM data.

### Preload Bridge (`preload.ts`)

- `window.api` — all IPC methods. Sensitive methods auto-prepend `sessionToken`.
- `window.__vaultToken` — exposes `set(token)` and `clear()` for the renderer.
- Auth methods (`login`, `reauth`, `verify2fa`) don't require a token.
- Bridge calls are logged to main via `preload:log` and `preload:token` IPC channels.

### Renderer

- **Tabs**: Passwords, Notes, Job Tracker, Authenticator, Trash, Generator, Monitor, Settings.
- **State**: In-memory JS objects, no state management library.
- **Sounds**: Web Audio API with configurable tones (chime, ding, soft, bright, click, tap, pop).
- **Accent colors**: 13 options applied via CSS custom properties on `:root`.
- **Password generator**: CSPRNG (`crypto.getRandomValues`) with Fisher-Yates shuffle. Guarantees at least one character from each enabled class.

### Environment Variables

Required in `.env` (gitignored):
- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `REDIRECT_URI` (optional, defaults to `http://localhost:42813/oauth2callback`)
- `ADMIN_EMAIL` (optional, defaults to `ysmagri@gmail.com`)

App exits with a dialog if any required var is missing.

### Logging

Per-level log files in `Logs/` directory: `debug.log`, `info.log`, `success.log`, `warn.log`, `error.log`, `auth.log`, `ipc.log`, `db.log`, plus a combined `all.log`. Legacy `vault-errors.log` kept for backward compat. Log rotation at 5 MB. Bak files cleaned up after 7 days.
