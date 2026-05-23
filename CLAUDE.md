# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with this repository.

## Project Overview

**Vault** is an Electron-based desktop application for secure storage of passwords, notes, job applications, and TOTP authenticator secrets. All sensitive data is AES-encrypted client-side before being stored in Supabase (PostgreSQL). The user authenticates via Google OAuth 2.0, with optional TOTP-based 2FA.

## Commands

```bash
npm install        # Install dependencies
npm start          # Run the app in production mode
npm run dev        # Run the app with DevTools detached
npm run build:win  # Build Windows installer (NSIS)
npm run build:mac  # Build macOS package
npm run build:linux # Build Linux AppImage
```

There are no tests, linting, or formatting tools configured.

## Architecture

### Single-file structure

The codebase is intentionally minimal — no frontend framework, no build step for renderer code:

| File | Role |
|---|---|
| `src/main.js` | **Electron main process** — all backend logic (~900 lines). IPC handlers, OAuth, crypto, Supabase queries. |
| `src/logger.js` | **Structured logging** — per-level log files in `Logs/` directory. |
| `preload.js` | **Context bridge** — exposes `window.api` and `window.__vaultToken`. Stores session token in closure, auto-injects it into all sensitive IPC calls. |
| `index.html` | **Renderer UI** — all screens and tab views in one file. |
| `app.css` | **Styles** — single stylesheet, Black + Purple theme with glassmorphism. |
| `app.js` | **Renderer logic** — all frontend JS (event handlers, DOM manipulation, state, sounds). |

### Main process (`src/main.js`)

- **Secrets**: Loaded from `.env` via `dotenv` at startup. Required vars: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`. Optional: `REDIRECT_URI` (defaults to `http://localhost:42813/oauth2callback`). App exits with a dialog if any required var is missing.
- **Auth flow**: Google OAuth 2.0 via a local HTTP server on `127.0.0.1:42813`. Callback hardened with `Origin` header validation, single-use `state` parameter, 5-minute state expiry, and nonce-based CSP. On success, derives an AES key from `SHA-256("vault:" + googleId)`, then loads encrypted vault items from Supabase. A 256-bit session token (`crypto.randomBytes(32)`) is generated and returned to the renderer.
- **Session tokens**: All 28 sensitive IPC handlers are wrapped with `requireAuth()` / `requireAuthNoArgs()` which validate the session token before executing. Tokens are rotated on every auth event (login, 2FA verify, reauth). Token is cleared on logout.
- **Encryption**: `CryptoJS.AES` with a 32-char key derived from the user's Google ID. Encryption/decryption functions: `enc(obj, key)` and `dec(str, key)`.
- **Supabase**: Uses the **service role key** (not anon) — the app operates with full DB access scoped by `user_id`. Tables: `vault_users`, `vault_items`, `vault_jobs`, `vault_totp`, `vault_2fa`, `vault_settings`, `vault_logos`.
- **Soft deletes**: Items and jobs use `deleted_at` timestamps. Auto-purged after 30 days.
- **Input validation**: All IPC handlers validate input at the boundary — item type must be `password`/`note` (500-char limit), emails validated via regex, TOTP secrets validated as base32, settings ranges enforced (timeout 0–120 min), notes capped at 5000 chars.
- **2FA rate limiting**: 5 attempts per 15-minute sliding window, 15-minute lockout on exceeded attempts, automatic reset on success.
- **IPC channels**: All async handlers use `ipcMain.handle`; window controls use `ipcMain.on`. Channels are namespaced (`auth:`, `vault:`, `jobs:`, `totp:`, `trash:`, `2fa:`, `settings:`, `monitor:`, `logo:`, `log:`, `win:`).
- **Window management**: Frameless window with custom titlebar. Maximize button toggles icon (□/❐) and responds to OS-level maximize/unmaximize events (snap, double-click). `win:maximized-state` IPC channel notifies renderer of state changes.

### Preload (`preload.js`)

- Stores the session token in a **closure variable** (inaccessible to renderer DOM).
- `window.__vaultToken` exposes `set()` and `clear()` methods for the renderer to manage the token.
- All sensitive `window.api` methods auto-prepend the session token as the first IPC argument.
- Auth methods (`login`, `reauth`, `verify2fa`) do not require a token (they obtain one).
- Exposes `onMaximizedState(cb)` for window maximize/unmaximize state changes.

### Renderer (`app.js` + `index.html`)

- **Tab-based UI**: Passwords, Notes, Job Tracker, Authenticator (TOTP), Trash, Generator, Monitor, Settings.
- **State**: Held in-memory in `app.js` (no state management library). Vault data is loaded on login and kept in JS objects; changes are pushed to Supabase via IPC and the local state is updated optimistically or re-synced.
- **Custom titlebar**: Frameless Electron window with HTML titlebar buttons (minimize/maximize/close). Double-click titlebar toggles maximize.
- **CSP**: Restrictive Content-Security-Policy in `index.html` meta tag — `script-src 'self'` only (no `unsafe-inline`), `connect-src` scoped to Supabase/HIBP, `object-src 'none'`, `base-uri 'self'`.
- **XSS prevention**: User-controlled data (avatars, favicons, QR codes) rendered via `createElement` instead of `innerHTML`. Image URLs validated for `https://` prefix.
- **Sound system**: Web Audio API with configurable tones. Master toggle + per-event toggles (login, exit, hover) with selectable tone presets (chime, ding, soft, bright, click, tap, pop). Hover sounds play on interactive elements with debounce.
- **Accent colors**: 13 color options (violet, blue, teal, cyan, green, lime, yellow, amber, orange, red, rose, pink, indigo). Applied via CSS custom properties on `:root`.
- **Settings**: All settings persist to Supabase `vault_settings` table. Debounced save (400ms). Instant-apply with visual feedback via toast.

### Settings data model

The `vault_settings` table stores all user preferences:

| Field | Type | Default | Description |
|---|---|---|---|
| `lock_timeout` | int | 5 | Minutes before auto-lock (0–120) |
| `lock_action` | text | 'lock' | Action on timeout: `lock` or `exit` |
| `lock_countdown` | bool | true | Show countdown in titlebar |
| `lock_on_minimize` | bool | false | Lock when window minimized |
| `compact` | bool | false | Compact list view spacing |
| `animations` | bool | true | Enable CSS transitions |
| `accent` | text | 'violet' | Accent color name (13 options) |
| `gen_length` | int | 20 | Default password length (8–128) |
| `gen_symbols` | bool | true | Include symbols in generator |
| `gen_numbers` | bool | true | Include numbers in generator |
| `gen_ambiguous` | bool | false | Exclude similar chars |
| `gen_copy` | bool | true | Auto-copy generated passwords |
| `sounds` | bool | true | Master sound toggle |
| `sound_login` | bool | true | Play sound on login |
| `sound_exit` | bool | true | Play sound on lock/exit |
| `sound_hover` | bool | false | Play sound on hover |
| `sound_login_tone` | text | 'chime' | Tone for login (chime/ding/soft/bright) |
| `sound_exit_tone` | text | 'chime' | Tone for exit (chime/ding/soft/bright) |
| `sound_hover_tone` | text | 'click' | Tone for hover (click/tap/pop/none) |
| `toast_duration` | int | 2400 | Toast visibility in ms |

### Key data model

- `vault_items`: `id, user_id, type ('password'|'note'), encrypted_data, sort_order, created_at, deleted_at`
- `vault_jobs`: `id, user_id, company, role, email, applied_at, status, notes, sort_order, created_at, updated_at, deleted_at` (jobs are NOT encrypted — stored as plaintext columns)
- `vault_totp`: `id, user_id, name, issuer, secret (encrypted), icon, sort_order`
- `vault_2fa`: `user_id, secret, enabled` (for the user's own 2FA)
- `vault_settings`: `user_id, lock_timeout, lock_action, lock_countdown, lock_on_minimize, compact, animations, accent, gen_length, gen_symbols, gen_numbers, gen_ambiguous, gen_copy, sounds, sound_login, sound_exit, sound_hover, sound_login_tone, sound_exit_tone, sound_hover_tone, toast_duration`
- `vault_logos`: `domain, url, cached_at` (favicon cache)

### Important notes

- **No test suite exists.** There are no test files or test configuration.
- **No TypeScript.** All code is plain JavaScript.
- **No frontend framework.** Vanilla JS DOM manipulation only.
- **Secrets are in `.env`** (gitignored), not in source code. See `.env.example` for the template.
- **Error logging** writes to `vault-errors.log` next to the executable and to `Logs/error.log`. The Monitor tab can view and clear this log.
- **Password generator** uses CSPRNG (`crypto.getRandomValues`) with Fisher-Yates shuffle and guarantees at least one character from each enabled class. Toggling character class options auto-generates a new password.
- **Theme**: Deep black base with purple accent, glassmorphism panels, canvas background animation. All colors use `oklch()` color space.
