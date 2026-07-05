# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Vault** is an Electron desktop app for secure storage of passwords, notes, job applications, and TOTP authenticator secrets. All sensitive data is AES-256 encrypted client-side and stored in the user's Google Drive. Authentication is via Google OAuth 2.0 with optional TOTP-based 2FA.

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

| File                        | Role                                                                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/main.ts`               | Electron main process — entry point. Loads config, creates window, registers IPC, contains OAuth flow, Drive-backed data helpers, session management.                                      |
| `src/modules/auth.ts`       | Session token generation/validation, `requireAuth()` / `requireAuthNoArgs()` IPC guards, 2FA rate limiter.                                                                                 |
| `src/modules/crypto.ts`     | Key derivation (PBKDF2-SHA256, 600k iterations, per-account salt; legacy SHA-256 fallback), AES-256-CBC + HMAC-SHA256 encrypt-then-MAC, backward-compatible CryptoJS legacy decryption.    |
| `src/modules/validation.ts` | Shared validators: `sanitizeStr`, `validType`, `validEmail`, `validTotpSecret`, `validDomain`.                                                                                             |
| `src/modules/jobs.ts`       | Job tracker CRUD — registered via `register()` pattern. Jobs stored as plaintext columns.                                                                                                  |
| `src/modules/totp.ts`       | TOTP secret management (encrypted) — registered via `register()` pattern.                                                                                                                  |
| `src/modules/settings.ts`   | Settings load/save with validation — registered via `register()` pattern.                                                                                                                  |
| `src/modules/cache.ts`      | Local file-based cache for all vault data. Stores encrypted items as JSON on disk. Provides offline support and dirty tracking for Drive sync.                                             |
| `src/modules/logo.ts`       | Favicon fetching + caching as data URLs — registered via `register()` pattern.                                                                                                             |
| `src/modules/drive.ts`      | Google Drive storage client — per-item encrypted file CRUD, local cache, debounce sync, ETag-based conflict resolution, offline support.                                                   |
| `src/modules/pin.ts`        | PIN-based authentication — setup, verify, change, disable, status. Local file storage only. Rate limited.                                                                                  |
| `src/modules/accounts.ts`   | Saved accounts for quick PIN login — list, save, remove, touch. Stores account info (googleId, email, name, avatar) locally in `vault_accounts` file. Max 10 accounts, sorted by lastUsed. |
| `src/types/index.ts`        | Shared TypeScript interfaces (Session, VaultItem, Job, TotpItem, Settings, etc.)                                                                                                           |
| `src/logger.ts`             | Structured logging to per-level files in `Logs/` directory.                                                                                                                                |
| `preload.ts`                | Context bridge — session token in closure, auto-prepended to sensitive IPC calls.                                                                                                          |
| `index.html`                | All renderer UI (single file).                                                                                                                                                             |
| `app.css`                   | Single stylesheet, `oklch()` color space, glassmorphism.                                                                                                                                   |
| `app.ts`                    | All renderer JS — event handlers, DOM manipulation, state, sounds.                                                                                                                         |

TypeScript is strict mode for main process (`tsconfig.json`) and renderer (`tsconfig.renderer.json` with `strictNullChecks: false`). Main process compiles to `dist/` via `tsc`; renderer bundles via Vite/esbuild.

### Process Model

```
Renderer (app.ts + index.html)
    │  IPC (context bridge via preload.ts)
    ▼
Main Process (src/main.ts)
    ├── OAuth local HTTP server (127.0.0.1:42813)
    ├── Crypto (AES-256-CBC + HMAC-SHA256)
    ├── Google Drive (per-item encrypted files)
    └── Local cache (offline support)
```

### Module Registration Pattern

`main.ts` is the entry point (~1400 lines). Domain modules (`jobs.ts`, `totp.ts`, `settings.ts`, `logo.ts`, `pin.ts`, `accounts.ts`) export a `register()` function called inside `app.whenReady()`. Each `register()` receives `ipcMain`, auth wrappers, `DriveClient`, `validation`, `getSession`, `logger`, and `logError` — then calls `ipcMain.handle()` directly.

Some modules with encrypted data (totp, settings, pin) also receive `enc`/`dec` crypto functions directly in their `register()` signature. The `pin.ts` module uses local file storage only. The `accounts.ts` module stores saved accounts locally. Both `pin.ts` and `accounts.ts` receive `app.getPath('userData')` via a `setUserDataPath()` initializer.

### IPC Channels

All async handlers use `ipcMain.handle`. Channels are namespaced:

| Namespace   | Auth  | Description                                                                                                                                                                    |
| ----------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `auth:`     | No    | Login, reauth, 2FA verify, logout, lock                                                                                                                                        |
| `vault:`    | Yes   | CRUD for passwords & notes                                                                                                                                                     |
| `trash:`    | Yes   | Soft-delete restore & purge                                                                                                                                                    |
| `jobs:`     | Yes   | CRUD for job applications (including `jobs:trash:*`)                                                                                                                           |
| `totp:`     | Yes   | TOTP secret management                                                                                                                                                         |
| `2fa:`      | Yes   | 2FA setup/enable/disable                                                                                                                                                       |
| `settings:` | Yes   | Settings read/write                                                                                                                                                            |
| `logo:`     | Yes   | Favicon fetching & caching                                                                                                                                                     |
| `win:`      | Yes   | Window minimize/maximize/close                                                                                                                                                 |
| `pin:`      | Mixed | PIN auth: `verify` is public; `setup`, `change`, `disable` require auth; `status` is public. `status` returns `{ ok, enabled, allowAlpha }`. PIN settings stored locally only. |
| `accounts:` | Mixed | Saved accounts: `list` and `touch` are public; `save` and `remove` require auth. Used for quick PIN login screen.                                                              |

All handlers return `{ ok: boolean, ... }` pattern. Errors are caught and returned as `{ ok: false, error: string }` — raw errors are never leaked to the renderer.

### Session & Auth

- **Session token**: 256-bit random hex string stored in a preload closure (inaccessible to renderer DOM). Auto-prepended to all sensitive IPC calls.
- **Validation**: `crypto.timingSafeEqual()` with safe fallback buffers to prevent timing attacks. 12-hour max token age.
- **Rotation**: Token is regenerated on every auth event (login, 2FA verify, reauth). Cleared on logout/lock.
- **2FA rate limiting**: 5 attempts per 15-minute sliding window, 15-minute lockout.

### PIN Authentication

- **Purpose**: Skip Google OAuth on subsequent logins. Users first sign in with Google, then enable PIN in settings.
- **Storage**: All PIN data is local only — never sent to any remote server. Two files under `%APPDATA%/Vault/` (or `~/Library/Application Support/Vault/` on macOS, `~/.config/Vault/` on Linux):
  - `vault_user_key` — encrypted PIN payload (see below).
  - `vault_pin_meta` — small **unencrypted** file: `{ googleId, allowAlpha }`. Neither field is sensitive; this only exists so the pre-login PIN screen (before any session/settings exist) knows *which* account has a PIN and whether it may contain letters. Reads of this file are defensive (missing/corrupt → `null`), since a PIN created by an older app version won't have it yet.
- **File format** (`vault_user_key`): `JSON.stringify({ version: 1, salt: base64, data: enc({ pinHash, userKey: { googleId, email }, allowAlpha }, derivePinKey(pin, salt)) })`
- **Key derivation**: `derivePinKey(pin, salt)` — PBKDF2-SHA256, 600k iterations → 32-byte hex string.
- **PIN hash**: Separate PBKDF2-SHA256 (600k iterations) stored inside the encrypted payload for verification.
- **PIN policy**: 4-12 characters. Numbers-only by default; alphanumeric optional (`pin_allow_alpha` setting, mirrored into `vault_pin_meta` on setup/change).
- **Rate limiting**: 5 attempts per 15-minute sliding window, 15-minute lockout (same pattern as 2FA). Persisted to `vault_pin_rate_limit` so it survives restarts; reset on successful verify, on PIN change, and on PIN disable (so deleting and re-creating a PIN never leaves a stale lockout behind).
- **Flow**:
  1. Startup: renderer calls `pin:status` → `{ ok, enabled, allowAlpha }`. If `enabled`, apply `allowAlpha` to the PIN input's `inputmode` and show `#s-pin`; else show `#s-login`.
  2. User enters PIN → `pin:verify` validates it and, on success, stashes `{ googleId, email }` server-side and returns `{ ok, verifyId, email }`. The token/credentials never pass through the renderer.
  3. Renderer calls `auth:loginWithPin(verifyId)` → main consumes the verify entry, creates a session, loads the vault.
  4. Lock: if `pin_login_enabled` → show `#s-pin` (using the already-loaded `S.settings.pin_allow_alpha`); else → show `#s-lock`.
  5. Logout: same as lock.
- **Recovery**: "Sign in with Google instead" link on PIN screen falls back to full OAuth flow.
- **Drive sync on PIN login**: The initial Google login requests `access_type: "offline"`, so Google issues a `refresh_token`. That token is encrypted via Electron's `safeStorage` and stored in the account's cache settings (`oauthTokens`). PIN login rehydrates `oauth2Client` from this stored token before initializing `DriveClient` — without this, PIN login would silently fall back to a local-only cache and nothing would sync to Drive.
- **IPC handlers**:
  - `pin:setup` (auth): validates PIN, creates encrypted user key file + `vault_pin_meta`
  - `pin:verify` (public): rate-limited, decrypts file, returns a one-time `verifyId`
  - `pin:change` (auth): verifies old PIN, writes new file with new salt/key, updates `vault_pin_meta`
  - `pin:disable` (auth): deletes user key file + `vault_pin_meta`, resets the rate limiter
  - `pin:status` (public): returns `{ ok, enabled, allowAlpha }` — `allowAlpha` read from `vault_pin_meta`, not `vault_settings` (settings are behind auth and unavailable pre-login)
- **Settings columns**: `pin_login_enabled` and `pin_allow_alpha` live in `vault_settings` and are managed entirely by the renderer's Settings screen (toggled and saved directly via `settings:save`). `pin:setup`/`pin:change`/`pin:disable` do **not** touch `vault_settings` themselves — they only read the `allowAlpha` flag passed in from the renderer for that call.

### Saved Accounts

- **Purpose**: Show previously logged-in accounts on the PIN screen for quick switching. Users click an account avatar and enter their PIN.
- **Storage**: Local file only — `%APPDATA%/Vault/vault_accounts` (or platform equivalent via `app.getPath('userData')`). Never sent to any remote server.
- **File format**: JSON array of `{ googleId, email, name, avatar, lastUsed }`. Max 10 accounts, sorted by `lastUsed` descending.
- **Flow**:
  1. On successful login (Google or PIN), `accounts:save` is called to upsert the account
  2. On PIN screen load, `accounts:list` returns saved accounts
  3. User clicks an account → account info shown → PIN input focused
  4. On successful PIN verify, `accounts:touch` updates `lastUsed` for the account
- **IPC handlers**:
  - `accounts:list` (public): returns `{ ok, accounts[] }`
  - `accounts:save` (auth): upserts current session's account
  - `accounts:remove` (auth): removes current session's account
  - `accounts:touch` (public): updates `lastUsed` timestamp for a given googleId
- **UI**: Account avatars shown in a row above the PIN input. Selected account shown with back button to return to account list.

### Encryption

- **New format**: AES-256-CBC + HMAC-SHA256 encrypt-then-MAC. Output: `base64(HMAC(32) || IV(16) || ciphertext)`.
- **Key derivation**: `SHA-256("vault:" + googleId)` → 32 hex chars. Separate enc/MAC keys via `SHA-256(key)` / `SHA-256(key + "mac")`.
- **Legacy fallback**: Old CryptoJS ciphertext (starts with `U2FsdGVk`) auto-detected and decrypted via CryptoJS.
- **What's encrypted**: All data types — passwords, notes, TOTP secrets, 2FA secrets, jobs — are encrypted before storage.

### Google Drive Storage

All user data is stored in the user's Google Drive inside a `Vault` folder. Each item (password, note, job, TOTP) is a separate encrypted file. Settings, 2FA config, and logo cache are stored as single JSON files.

- **Folder**: `Vault` (created automatically in Drive root)
- **Per-item files**: `vault_{type}_{uuid}` — each contains AES-256-CBC + HMAC encrypted JSON
- **Settings file**: `vault_settings` — JSON with UI preferences
- **2FA file**: `vault_2fa` — JSON with secret and enabled flag
- **Logos file**: `vault_logos` — JSON array of cached favicon data URLs
- **Local cache**: `%APPDATA%/Vault/Cache/vault_cache.json` — full offline copy of all data
- **Sync**: Event-driven debounce (2s) with dirty queue retry on failure.
- **Conflict resolution on startup** (`DriveClient.init()` → `resolveConflicts()`): a snapshot of the previously-synced Drive `modifiedTime` per file is taken *before* `buildFileIcCache()` refreshes `cache.etags` to the current Drive state, so the two can actually be diffed. For each Drive file:
  - Missing locally → downloaded and added to the cache.
  - Present locally but Drive's `modifiedTime` has changed since the last sync → re-downloaded and the local item is updated in place (unless that item has an unsynced local change still sitting in the dirty queue, in which case the local edit wins and the remote refresh is skipped).
  - Unchanged → left alone.
  This is what lets an edit made on another device actually show up here; a version that only checked "does this item exist locally at all" would never pick up remote edits to items you already have cached.
- **Offline**: Full offline support via local cache. Dirty queue flushes when connectivity returns.

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
- Auth methods (`login`, `reauth`, `verify2fa`, `loginWithPin`) don't require a token.
- `pin:verify` and `pin:status` don't require a token (used for startup screen decision).
- All other `pin:*` methods require a token (user must be authenticated via Google first).
- Bridge calls are logged to main via `preload:log` and `preload:token` IPC channels.

### Renderer

- **Tabs**: Passwords, Notes, Job Tracker, Authenticator, Trash, Generator, Settings.
- **State**: In-memory JS objects, no state management library.
- **Sync indicator**: `withSyncSpin(promise)` (top of `app.ts`) increments an in-flight counter, adds `.syncing` to the sidebar `#btn-sync` icon (CSS spins it via `@keyframes syncSpin`), and removes it once the counter returns to zero. Every save/sync call that should visibly spin the icon — password/note/settings saves, the manual "Sync now" button, sync-folder operations — is wrapped in `withSyncSpin(...)`.
- **Sounds**: Web Audio API with configurable tones (chime, ding, soft, bright, click, tap, pop).
- **Accent colors**: 13 options applied via CSS custom properties on `:root`.
- **Password generator**: CSPRNG (`crypto.getRandomValues`) with Fisher-Yates shuffle. Guarantees at least one character from each enabled class.

### Environment Variables

Required in `.env` (gitignored):

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `REDIRECT_URI` (optional, defaults to `http://localhost:42813/oauth2callback`)

App exits with a dialog if any required var is missing.

### Logging

Per-level log files in `Logs/` directory: `debug.log`, `info.log`, `success.log`, `warn.log`, `error.log`, `auth.log`, `ipc.log`, `db.log`, plus a combined `all.log`. Legacy `vault-errors.log` kept for backward compat. Log rotation at 5 MB. Bak files cleaned up after 7 days.

## Git commit identity

Always commit as:

- Author/committer: `yassine808 <166349232+yassine808@users.noreply.github.com>`
- Add trailer: `Co-Authored-By: Claude <noreply@anthropic.com>`

Never use any other name/email.
