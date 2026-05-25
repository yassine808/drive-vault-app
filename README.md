# 🔐 Vault

A desktop app for secure storage of passwords, notes, job applications, and TOTP authenticator secrets — all AES-256 encrypted on-device before touching the cloud.

**Built with Electron + Supabase + Vanilla JS.** No frontend framework. No build step.

---

## Table of Contents

- [Features](#features)
- [How It Works](#how-it-works)
- [Architecture](#architecture)
- [Database Schema](#database-schema)
- [IPC Channels](#ipc-channels)
- [Security](#security)
- [Getting Started](#getting-started)
- [Commands](#commands)
- [Tech Stack](#tech-stack)

---

## Features

| Tab | Description |
|---|---|
| **Passwords** | Store login credentials — encrypted with AES-256 before leaving your device |
| **Notes** | Encrypted private notes with character & word count |
| **Job Tracker** | Track job applications — company, role, status, email, dates (stored as plaintext columns) |
| **Authenticator** | TOTP code generator — secrets encrypted and synced across devices |
| **Trash** | Soft-delete with 30-day auto-purge and one-click restore |
| **Generator** | CSPRNG password generator with configurable length, symbols, and auto-copy |
| **Monitor** | View database stats, app logs, error logs — plus admin dashboard for the admin user (user management, global stats) |
| **Settings** | Auto-lock, accent colors, sound effects with test buttons, 2FA, password generator defaults — all persisted to Supabase |

### UI Features

- **13 accent colors** — violet, blue, teal, cyan, green, lime, yellow, amber, orange, red, rose, pink, indigo
- **Sound system** — Web Audio API with per-event tone presets (chime, ding, soft, bright, click, tap, pop)
- **Glassmorphism theme** — deep black base with purple accent and canvas background animation
- **Custom titlebar** — frameless Electron window with minimize/maximize/close buttons
- **Compact mode, animations toggle, and more**

---

## How It Works

### Authentication Flow

```
┌──────────┐    Google OAuth 2.0    ┌──────────────┐
│          │ ──────────────────────▶ │              │
│  Browser │ ◀────── auth code ──── │  Local HTTP  │
└──────────┘                        │  Server      │
                                    │  :42813      │
                                    └──────┬───────┘
                                           │
                                    ┌──────▼───────┐
                                    │  Derive key  │
                                    │  SHA-256(    │
                                    │  "vault:" +  │
                                    │  googleId)   │
                                    └──────┬───────┘
                                           │
                                    ┌──────▼───────┐
                                    │ Load vault   │
                                    │ from Supabase│
                                    └──────────────┘
```

1. Sign in via Google OAuth — app opens a browser, you approve, and an auth code is returned to a local HTTP server (`127.0.0.1:42813`)
2. AES key is derived from `SHA-256("vault:" + googleId)`
3. Encrypted vault items are loaded from Supabase
4. A 256-bit session token is generated and stored in a secure closure
5. If 2FA is enabled, a TOTP code is also required

### Encryption & Data Flow

```
Your device  ──AES-256──▶  Encrypted data  ──▶  Supabase (PostgreSQL)
     ▲                                                    │
     └──────────── Decrypt with your key ◀────────────────┘
```

- Passwords, notes, and TOTP secrets are encrypted **client-side** before being sent to Supabase
- The server only ever sees ciphertext — it cannot read any sensitive data
- Job applications are stored as plaintext columns (not encrypted)

### Session Security

- 256-bit random session token generated at login
- Every sensitive IPC call requires the token (stored in a closure, inaccessible from renderer DOM)
- Token is rotated on every auth event (login, 2FA verify, reauth)
- Token is cleared on logout

---

## Architecture

### File Structure

The codebase is intentionally minimal — no frontend framework, no build step for renderer code:

| File | Role |
|---|---|
| `src/main.js` | **Electron main process** — all backend logic (~1000 lines). IPC handlers, OAuth, crypto, Supabase queries, admin functions |
| `src/logger.js` | **Structured logging** — per-level log files in `Logs/` directory |
| `preload.js` | **Context bridge** — exposes `window.api` and session token management |
| `index.html` | **Renderer UI** — all screens and tab views |
| `app.css` | **Styles** — single stylesheet, all colors in `oklch()` color space |
| `app.js` | **Renderer logic** — event handlers, DOM manipulation, state, sounds |

### Process Model

```
┌─────────────────────────────────────────────────┐
│                  Electron App                    │
│                                                  │
│  ┌──────────────┐     IPC      ┌──────────────┐ │
│  │   Renderer    │ ◀────────▶ │    Main       │ │
│  │  (app.js +    │  context   │  (main.js)    │ │
│  │  index.html)  │  bridge    │              │ │
│  │               │ (preload)   │  ┌────────┐  │ │
│  └──────────────┘             │  │ OAuth  │  │ │
│                                │  │ Server │  │ │
│                                │  │ :42813 │  │ │
│                                │  └────────┘  │ │
│                                │  ┌────────┐  │ │
│                                │  │Crypto  │  │ │
│                                │  │AES-256 │  │ │
│                                │  └────────┘  │ │
│                                └──────┬───────┘ │
│                                       │          │
└───────────────────────────────────────┼──────────┘
                                        │
                                        ▼
                                ┌──────────────┐
                                │   Supabase   │
                                │ (PostgreSQL) │
                                └──────────────┘
```

### Main Process — Key Details

- Secrets loaded from `.env` via `dotenv` at startup
- App exits with a dialog if any required env var is missing
- Uses Supabase **service role key** — full DB access scoped by `user_id`
- 30+ sensitive IPC handlers wrapped with `requireAuth()` guard
- All input validated at the boundary (type, length, regex)

### Preload Bridge

- Session token stored in a **closure variable** (inaccessible to renderer DOM)
- `window.__vaultToken.set()` / `clear()` for renderer token management
- All sensitive `window.api` methods auto-prepend the session token
- Auth methods (`login`, `reauth`, `verify2fa`) do not require a token

---

## Database Schema

### Entity-Relationship Overview

```
vault_users ──┬── vault_items (encrypted passwords & notes)
              ├── vault_jobs (plaintext job applications)
              ├── vault_totp (encrypted TOTP secrets)
              ├── vault_2fa (user's own 2FA config)
              ├── vault_settings (UI preferences)
              └── vault_logos (favicon cache)
```

### `vault_users`

| Column | Type | Description |
|---|---|---|
| `id` | uuid | Primary key |
| `google_id` | text | Google account ID (used for key derivation) |
| `email` | text | User email |
| `name` | text | Display name |
| `avatar_url` | text | Profile picture URL |
| `created_at` | timestamp | Account creation time |

### `vault_items`

| Column | Type | Description |
|---|---|---|
| `id` | uuid | Primary key |
| `user_id` | uuid | Foreign key → `vault_users` |
| `type` | text | `'password'` or `'note'` |
| `encrypted_data` | text | AES-256 encrypted JSON (500-char limit for passwords) |
| `sort_order` | int | Display ordering |
| `created_at` | timestamp | Creation time |
| `deleted_at` | timestamp | Soft-delete timestamp (auto-purged after 30 days) |

### `vault_jobs`

| Column | Type | Description |
|---|---|---|
| `id` | uuid | Primary key |
| `user_id` | uuid | Foreign key → `vault_users` |
| `company` | text | Company name |
| `role` | text | Job title / role |
| `email` | text | Contact email |
| `applied_at` | date | Date of application |
| `status` | text | Application status |
| `notes` | text | Free-form notes |
| `sort_order` | int | Display ordering |
| `created_at` | timestamp | Creation time |
| `updated_at` | timestamp | Last update time |
| `deleted_at` | timestamp | Soft-delete timestamp (auto-purged after 30 days) |

> **Note:** Jobs are stored as plaintext columns — not encrypted.

### `vault_totp`

| Column | Type | Description |
|---|---|---|
| `id` | uuid | Primary key |
| `user_id` | uuid | Foreign key → `vault_users` |
| `name` | text | Account name |
| `issuer` | text | Service issuer |
| `secret` | text | AES-256 encrypted TOTP secret |
| `icon` | text | Icon identifier |
| `sort_order` | int | Display ordering |

### `vault_2fa`

| Column | Type | Description |
|---|---|---|
| `user_id` | uuid | Primary key, foreign key → `vault_users` |
| `secret` | text | TOTP secret (encrypted) |
| `enabled` | bool | Whether 2FA is active |

### `vault_settings`

| Column | Type | Default | Description |
|---|---|---|---|
| `user_id` | uuid | — | Primary key, FK → `vault_users` |
| `lock_timeout` | int | 5 | Minutes before auto-lock (0–120) |
| `lock_action` | text | `'lock'` | Action: `lock` or `exit` |
| `lock_countdown` | bool | true | Show countdown in titlebar |
| `lock_on_minimize` | bool | false | Lock on minimize |
| `compact` | bool | false | Compact list spacing |
| `animations` | bool | true | Enable CSS transitions |
| `accent` | text | `'violet'` | Accent color (13 options) |
| `gen_length` | int | 20 | Password generator length (8–128) |
| `gen_symbols` | bool | true | Include symbols |
| `gen_numbers` | bool | true | Include numbers |
| `gen_ambiguous` | bool | false | Exclude similar chars |
| `gen_copy` | bool | true | Auto-copy generated passwords |
| `sounds` | bool | true | Master sound toggle |
| `sound_login` | bool | true | Sound on login |
| `sound_exit` | bool | true | Sound on lock/exit |
| `sound_hover` | bool | false | Sound on hover |
| `sound_login_tone` | text | `'chime'` | Login tone (chime/ding/soft/bright) |
| `sound_exit_tone` | text | `'chime'` | Exit tone (chime/ding/soft/bright) |
| `sound_hover_tone` | text | `'click'` | Hover tone (click/tap/pop/none) |
| `toast_duration` | int | 2400 | Toast visibility in ms |

### `vault_logos`

| Column | Type | Description |
|---|---|---|
| `domain` | text | Primary key — website domain |
| `url` | text | Favicon URL |
| `cached_at` | timestamp | Cache timestamp |

---

## IPC Channels

All async handlers use `ipcMain.handle`. Window controls use `ipcMain.on`. Channels are namespaced:

| Namespace | Requires Auth | Description |
|---|---|---|
| `auth:` | No | Login, reauth, 2FA verify |
| `vault:` | Yes | CRUD for passwords & notes |
| `jobs:` | Yes | CRUD for job applications |
| `totp:` | Yes | TOTP secret management |
| `trash:` | Yes | Soft-delete restore & purge |
| `2fa:` | Yes | 2FA setup & management |
| `settings:` | Yes | Settings read/write |
| `monitor:` | Yes | Database stats & log viewing |
| `admin:` | Yes | Admin-only: list all users, global cross-user stats |
| `logo:` | Yes | Favicon fetching & caching |
| `log:` | Yes | Error log access (reads from `Logs/error.log`) |
| `win:` | No | Window minimize/maximize/close |

### Auth Guard

28 sensitive IPC channels use `requireAuth()` or `requireAuthNoArgs()`:

```
Renderer call ──▶ Prepend session token ──▶ requireAuth() validates ──▶ Handler executes
                       (from closure)        (rejected if invalid)
```

---

## Security

| Layer | Measure |
|---|---|
| **Encryption** | AES-256-CBC + HMAC-SHA256 encrypt-then-MAC — authenticated, with backward compat for legacy CryptoJS data |
| **Key derivation** | `SHA-256("vault:" + googleId)` — unique per user; separate encKeys and macKeys via `SHA-256(key)` / `SHA-256(key + "mac")` |
| **Auth** | Google OAuth 2.0 with CSRF `state`, origin validation, 5-minute state expiry, exact pathname matching |
| **Session** | 256-bit token in closure, timing-safe validation, rotated on every auth event, cleared on lock/logout |
| **2FA** | TOTP-based with 5 attempts / 15-min sliding window, 15-min lockout |
| **CSP** | Restrictive: `script-src 'self'`, `frame-src 'none'`, `worker-src 'none'`, no external fonts |
| **XSS** | User-controlled data rendered via `createElement` / `textContent` — no `innerHTML` for dynamic content |
| **Navigation** | `will-navigate` blocks non-file: URLs; `setWindowOpenHandler` denies child windows |
| **Input** | All IPC handlers validate type, length, and format at the boundary; errors sanitized |
| **Soft deletes** | `deleted_at` timestamps with 30-day auto-purge |
| **Admin gating** | Monitor tab and admin dashboard only visible to the admin email |
| **Memory** | Lock clears all sensitive data from renderer memory + clipboard auto-clear after 30s |

---

## Getting Started

### Prerequisites

- Node.js v16+
- A Supabase project with the required tables
- A Google Cloud OAuth 2.0 client (configured with redirect URI `http://localhost:42813/oauth2callback`)

### Installation

```bash
git clone https://github.com/yassine808/vault-app.git
cd vault-app
npm install
```

### Configuration

Copy `.env.example` to `.env` and fill in your credentials:

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
```

### Run

```bash
npm start       # Production mode
npm run dev     # Development mode (DevTools detached)
```

### Build

```bash
npm run build:win    # Windows installer (NSIS)
npm run build:mac    # macOS package
npm run build:linux  # Linux AppImage
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop framework | Electron 28 |
| Database | Supabase (PostgreSQL) |
| Encryption | AES-256-CBC + HMAC-SHA256 encrypt-then-MAC (native `crypto`) |
| Authentication | Google OAuth 2.0 |
| TOTP | Speakeasy |
| Styling | Vanilla CSS (no framework) |
| Frontend | Vanilla JavaScript (no framework) |
| Color space | `oklch()` |
| CSPRNG | `crypto.getRandomValues` (Fisher-Yates shuffle) |
| Sound | Web Audio API |

---

## Changelog

### 2026-05-25 — Security Hardening Audit

A comprehensive security audit scanned every file across 5 attack surfaces. All findings were fixed and deployed in a single commit.

#### IPC & Authentication (7 fixes)

| # | Finding | Severity | Fix |
|---|---------|----------|-----|
| 1 | Token validation had early-return timing side-channel | HIGH | `validateToken()` always runs `crypto.timingSafeEqual` on safe buffers |
| 2 | Session fixation on login — old token reused | HIGH | Invalidate session before OAuth flow starts |
| 3 | Session fixation on reauth | HIGH | Invalidate session before reauth flow |
| 4 | Lock preserved session data in memory | MEDIUM | `session = null` clears everything |
| 5 | 2FA rate-limit checked after format validation | MEDIUM | `isRateLimited()` now runs first |
| 6 | Monitor endpoints unprotected | MEDIUM | Changed to `requireAdminNoArgs` |
| 7 | 2FA disable required no code | MEDIUM | Now requires valid TOTP code + rate limiting |

#### Cryptography & Secrets (4 fixes)

| # | Finding | Severity | Fix |
|---|---------|----------|-----|
| 1 | CryptoJS AES without authentication (bit-flipping) | HIGH | AES-256-CBC + HMAC-SHA256 encrypt-then-MAC with backward compat |
| 2 | Plaintext secrets in renderer memory on lock | HIGH | `doLock()` clears sensitive arrays + DOM elements |
| 3 | Passwords persist in clipboard indefinitely | MEDIUM | Auto-clear clipboard after 30 seconds |
| 4 | TOTP copy regex bug (`/s/g` vs `/\s/g`) | LOW | Restored correct regex |

#### Database & SQL (8 fixes)

| # | Finding | Severity | Fix |
|---|---------|----------|-----|
| 1 | Supabase errors leaked internal details to renderer | HIGH | Generic error messages (no DB detail leakage) |
| 2 | `SELECT *` on sensitive tables | MEDIUM | Explicit column lists on all queries |
| 3 | No domain validation on logo fetch (SSRF risk) | MEDIUM | `validDomain()` regex check before any fetch |
| 4 | Job status not validated | LOW | Whitelist check against allowed statuses |
| 5 | Job date format not validated | LOW | ISO date regex validation |
| 6 | Email href injection in job tracker | LOW | `encodeURIComponent` on mailto: links |
| 7 | SVG injection in monitor charts | LOW | Input sanitization for pct/color values |
| 8 | Admin errors leaked DB details | MEDIUM | Sanitized error messages |

#### Config & Electron Hardening (6 fixes)

| # | Finding | Severity | Fix |
|---|---------|----------|-----|
| 1 | No navigation prevention in renderer | HIGH | `will-navigate` blocks non-file: URLs |
| 2 | No child window control | HIGH | `setWindowOpenHandler` denies all, opens external in browser |
| 3 | OAuth pathname prefix match too loose | MEDIUM | Exact match `/oauth2callback` |
| 4 | OAuth origin validation used startsWith | MEDIUM | Proper URL parsing with host check |
| 5 | CSP allowed external fonts + frames | MEDIUM | Removed Google Fonts, added `frame-src 'none'`, `worker-src 'none'` |
| 6 | Google Fonts external dependency | LOW | System font stack |

#### XSS & DOM Hardening (7 fixes)

| # | Finding | Severity | Fix |
|---|---------|----------|-----|
| 1 | `innerHTML` used for user-controlled data | HIGH | Replaced with `createElement` / `textContent` |
| 2 | QR code TOTP secret sent to third-party server | HIGH | Client-side QR generation (no network leak) |
| 3 | `esc()` XSS utility unnecessary | MEDIUM | Removed (textContent used everywhere) |
| 4 | User avatar/image URLs not validated | MEDIUM | `https://` prefix validation |
| 5 | Error display could inject HTML | LOW | Sanitized all error rendering |
| 6 | SVG color injection in monitor | LOW | Input sanitization on color values |
| 7 | Unescaped user data in toasts | LOW | Toast text now uses safe DOM insertion |

---

## Project Notes

- **No test suite** — there are no test files or test configuration
- **Plain JavaScript** — no TypeScript, no frontend framework
- **Secrets in `.env`** — gitignored, see `.env.example` for template
- **Error logging** — writes to `Logs/error.log` and viewable in the Monitor tab
- **Admin dashboard** — admin user can view all registered users, global vault items/jobs/TOTP counts, and per-user join/login dates
- **Password generator** — uses CSPRNG with Fisher-Yates shuffle, guarantees at least one character from each enabled class
