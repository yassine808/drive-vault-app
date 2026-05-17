# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
| `src/main.js` | **Electron main process** — all backend logic (462 lines). IPC handlers, OAuth, crypto, Supabase queries. |
| `preload.js` | **Context bridge** — exposes a `window.api` object to the renderer. All IPC channels are defined here. |
| `index.html` | **Renderer UI** — all screens and tab views in one file. |
| `app.css` | **Styles** — single stylesheet for the entire app. |
| `app.js` | **Renderer logic** — all frontend JS (event handlers, DOM manipulation, state). |

### Main process (`src/main.js`)

- **Auth flow**: Google OAuth 2.0 via a local HTTP server on `127.0.0.1:42813`. On success, derives an AES key from `SHA-256("vault:" + googleId)`, then loads encrypted vault items from Supabase.
- **Encryption**: `CryptoJS.AES` with a 32-char key derived from the user's Google ID. Encryption/decryption functions: `enc(obj, key)` and `dec(str, key)`.
- **Supabase**: Uses the **service role key** (not anon) — the app operates with full DB access scoped by `user_id`. Tables: `vault_users`, `vault_items`, `vault_jobs`, `vault_totp`, `vault_2fa`, `vault_settings`, `vault_logos`.
- **Soft deletes**: Items and jobs use `deleted_at` timestamps. Auto-purged after 30 days.
- **IPC channels**: All async handlers use `ipcMain.handle`; window controls use `ipcMain.on`. Channels are namespaced (`auth:`, `vault:`, `jobs:`, `totp:`, `trash:`, `2fa:`, `settings:`, `monitor:`, `logo:`, `log:`, `win:`).

### Renderer (`app.js` + `index.html`)

- **Tab-based UI**: Passwords, Notes, Job Tracker, Authenticator (TOTP), Trash, Generator, Monitor, Settings.
- **State**: Held in-memory in `app.js` (no state management library). Vault data is loaded on login and kept in JS objects; changes are pushed to Supabase via IPC and the local state is updated optimistically or re-synced.
- **Custom titlebar**: Frameless Electron window with HTML titlebar buttons (minimize/maximize/close).
- **CSP**: Restrictive Content-Security-Policy in `index.html` meta tag.

### Key data model

- `vault_items`: `id, user_id, type ('password'|'note'), encrypted_data, sort_order, created_at, deleted_at`
- `vault_jobs`: `id, user_id, company, role, email, applied_at, status, notes, sort_order, created_at, updated_at, deleted_at` (jobs are NOT encrypted — stored as plaintext columns)
- `vault_totp`: `id, user_id, name, issuer, secret (encrypted), icon, sort_order`
- `vault_2fa`: `user_id, secret, enabled` (for the user's own 2FA)
- `vault_settings`: `user_id, lock_timeout, lock_action`
- `vault_logos`: `domain, url, cached_at` (favicon cache)

### Important notes

- **No test suite exists.** There are no test files or test configuration.
- **No TypeScript.** All code is plain JavaScript.
- **No frontend framework.** Vanilla JS DOM manipulation only.
- **The Supabase service key and Google OAuth credentials are hardcoded** in `src/main.js`. This is by design for a desktop app (the service key is scoped to Row Level Security policies, though RLS is not visibly enforced in the app code — queries filter by `user_id` manually).
- **Error logging** writes to `vault-errors.log` next to the executable. The Monitor tab can view and clear this log.
