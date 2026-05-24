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
| **Monitor** | View database stats, app logs, and error logs |
| **Settings** | Auto-lock, accent colors, sound effects, 2FA, password generator defaults |

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
| `src/main.js` | **Electron main process** — all backend logic (~900 lines). IPC handlers, OAuth, crypto, Supabase queries |
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
- 28 sensitive IPC handlers wrapped with `requireAuth()` guard
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
| `logo:` | Yes | Favicon fetching & caching |
| `log:` | Yes | Error log access |
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
| **Encryption** | AES-256 client-side — server never sees plaintext |
| **Key derivation** | `SHA-256("vault:" + googleId)` — unique per user |
| **Auth** | Google OAuth 2.0 with CSRF `state` parameter, origin validation, 5-minute state expiry |
| **Session** | 256-bit token in closure, rotated on every auth event |
| **2FA** | TOTP-based with 5 attempts / 15-min sliding window, 15-min lockout |
| **CSP** | `script-src 'self'` only — blocks inline scripts and unauthorized connections |
| **XSS** | User-controlled data rendered via `createElement`, not `innerHTML` |
| **Input** | All IPC handlers validate type, length, and format at the boundary |
| **Soft deletes** | `deleted_at` timestamps with 30-day auto-purge |

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
| Encryption | CryptoJS AES-256 |
| Authentication | Google OAuth 2.0 |
| TOTP | Speakeasy |
| Styling | Vanilla CSS (no framework) |
| Frontend | Vanilla JavaScript (no framework) |
| Color space | `oklch()` |
| CSPRNG | `crypto.getRandomValues` (Fisher-Yates shuffle) |
| Sound | Web Audio API |

---

## Project Notes

- **No test suite** — there are no test files or test configuration
- **Plain JavaScript** — no TypeScript, no frontend framework
- **Secrets in `.env`** — gitignored, see `.env.example` for template
- **Error logging** — writes to `Logs/error.log` and viewable in the Monitor tab
- **Password generator** — uses CSPRNG with Fisher-Yates shuffle, guarantees at least one character from each enabled class
