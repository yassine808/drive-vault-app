# 🔐 Vault

A desktop app for secure storage of passwords, notes, job applications, and TOTP authenticator secrets — all AES-256 encrypted on-device. Data lives in your Google Drive.

**Built with Electron + Vanilla TypeScript.** No frontend framework.

---

## Table of Contents

- [Features](#features)
- [How It Works](#how-it-works)
- [Architecture](#architecture)
- [Storage](#storage)
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
| **Notes** | Encrypted private notes with word count |
| **Job Tracker** | Track job applications — company, role, status, email, dates |
| **Authenticator** | TOTP code generator — secrets encrypted and synced via Google Drive |
| **Trash** | Soft-delete with 30-day auto-purge and one-click restore |
| **Generator** | CSPRNG password generator with configurable length, symbols, and auto-copy |
| **Settings** | Auto-lock, accent colors, sound effects with test buttons, PIN login, 2FA, password generator defaults — all persisted to Google Drive |

### UI Features

- **13 accent colors** — violet, blue, teal, cyan, green, lime, yellow, amber, orange, red, rose, pink, indigo
- **Sound system** — Web Audio API with per-event tone presets (chime, ding, soft, bright, click, tap, pop)
- **Glassmorphism theme** — deep black base with purple accent
- **Custom titlebar** — frameless Electron window with minimize/maximize/close buttons
- **Compact mode, animations toggle, and more**
- **PIN login** — skip Google OAuth on subsequent logins with a local PIN

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
                                    │ from local   │
                                    │ cache/Drive  │
                                    └──────────────┘
```

1. Sign in via Google OAuth — app opens a browser, you approve, and an auth code is returned to a local HTTP server (`127.0.0.1:42813`)
2. AES key is derived from `SHA-256("vault:" + googleId)`
3. Encrypted vault items are loaded from local cache (synced with Google Drive in background)
4. A 256-bit session token is generated and stored in a secure closure
5. If 2FA is enabled, a TOTP code is also required
6. Optionally, set up a PIN for quick subsequent logins without Google OAuth

### Encryption & Data Flow

```
Your device  ──AES-256──▶  Encrypted data  ──▶  Google Drive (per-item files)
     ▲                                                    │
     └──────────── Decrypt with your key ◀────────────────┘
```

- Passwords, notes, TOTP secrets, and 2FA secrets are encrypted **client-side** before being sent to Google Drive
- The server only ever sees ciphertext — it cannot read any sensitive data
- Each item is stored as a separate encrypted file in a `Vault/` folder in your Google Drive
- Full offline support via local cache — dirty queue retries sync when connectivity returns

### Session Security

- 256-bit random session token generated at login
- Every sensitive IPC call requires the token (stored in a closure, inaccessible from renderer DOM)
- Token is rotated on every auth event (login, 2FA verify, reauth)
- Token is cleared on logout/lock

---

## Architecture

### File Structure

| File | Role |
|---|---|
| `src/main.ts` | **Electron main process** — all backend logic (~1400 lines). IPC handlers, OAuth, crypto, Drive client, module registration |
| `src/modules/drive.ts` | **Google Drive storage client** — per-item encrypted file CRUD, local cache, debounce sync, ETag conflict resolution |
| `src/modules/cache.ts` | **Local file-based cache** — offline-first storage for all vault data |
| `src/modules/auth.ts` | **Session management** — token generation/validation, auth guards, 2FA rate limiter |
| `src/modules/crypto.ts` | **Encryption** — AES-256-CBC + HMAC-SHA256 encrypt-then-MAC, PIN key derivation |
| `src/modules/validation.ts` | **Input validation** — shared validators for all IPC handlers |
| `src/modules/jobs.ts` | **Job tracker CRUD** |
| `src/modules/totp.ts` | **TOTP secret management** |
| `src/modules/settings.ts` | **Settings load/save with validation** |
| `src/modules/logo.ts` | **Favicon fetching + caching** |
| `src/modules/pin.ts` | **PIN-based authentication** |
| `src/modules/accounts.ts` | **Saved accounts for quick PIN login** |
| `src/types/index.ts` | **Shared TypeScript interfaces** |
| `src/logger.ts` | **Structured logging** — per-level log files in `Logs/` directory |
| `preload.ts` | **Context bridge** — exposes `window.api` and session token management |
| `index.html` | **Renderer UI** — all screens and tab views |
| `app.css` | **Styles** — single stylesheet, all colors in `oklch()` color space |
| `app.ts` | **Renderer logic** — event handlers, DOM manipulation, state, sounds |

### Process Model

```
┌─────────────────────────────────────────────────┐
│                  Electron App                    │
│                                                  │
│  ┌──────────────┐     IPC      ┌──────────────┐ │
│  │   Renderer    │ ◀────────▶ │    Main       │ │
│  │  (app.ts +    │  context   │  (main.ts)    │ │
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
│                                │  ┌────────┐  │ │
│                                │  │ Drive  │  │ │
│                                │  │ Client │  │ │
│                                │  └────────┘  │ │
│                                └──────┬───────┘ │
│                                       │          │
└───────────────────────────────────────┼──────────┘
                                        │
                                        ▼
                                ┌──────────────┐
                                │ Google Drive  │
                                │ (Vault/)      │
                                └──────────────┘
                                        │
                                ┌───────▼───────┐
                                │  Local Cache   │
                                │ (offline)      │
                                └───────────────┘
```

---

## Storage

All user data is stored in the user's Google Drive inside a `Vault` folder. Each item is a separate encrypted file.

- **Folder**: `Vault/` (created automatically in Drive root)
- **Per-item files**: `vault_{type}_{uuid}` — each contains AES-256-CBC + HMAC encrypted JSON
- **Settings file**: `vault_settings` — JSON with UI preferences
- **2FA file**: `vault_2fa` — JSON with secret and enabled flag
- **Logos file**: `vault_logos` — JSON array of cached favicon data URLs
- **Local cache**: `%APPDATA%/Vault/Cache/vault_cache.json` (or platform equivalent) — full offline copy
- **PIN data**: `%APPDATA%/Vault/vault_user_key` — local only, never synced
- **Saved accounts**: `%APPDATA%/Vault/vault_accounts` — local only, never synced

**Sync**: Event-driven debounce (2s) with dirty queue retry on failure. ETag-based conflict resolution on startup.

---

## IPC Channels

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
| `logo:` | Yes | Favicon fetching & caching |
| `win:` | Yes | Window minimize/maximize/close |
| `pin:` | Mixed | PIN auth: `verify` is public; `setup`, `change`, `disable` require auth; `status` is public |
| `accounts:` | Mixed | Saved accounts: `list` and `touch` are public; `save` and `remove` require auth |

All handlers return `{ ok: boolean, ... }` pattern. Errors are caught and returned as `{ ok: false, error: string }`.

---

## Security

| Layer | Measure |
|---|---|
| **Encryption** | AES-256-CBC + HMAC-SHA256 encrypt-then-MAC — authenticated, with backward compat for legacy CryptoJS data |
| **Key derivation** | `SHA-256("vault:" + googleId)` — unique per user; separate encKey and macKey via `SHA-256(key)` / `SHA-256(key + "mac")` |
| **Auth** | Google OAuth 2.0 with CSRF `state`, origin validation, 5-minute state expiry, exact pathname matching |
| **Session** | 256-bit token in closure, timing-safe validation, rotated on every auth event, cleared on lock/logout |
| **PIN** | PBKDF2-SHA256 (600k iterations), local-only storage, rate limited (5 attempts / 15-min window) |
| **2FA** | TOTP-based with 5 attempts / 15-min sliding window, 15-min lockout |
| **CSP** | Restrictive: `script-src 'self'`, `frame-src 'none'`, `worker-src 'none'` |
| **XSS** | User data rendered via `createElement` / `textContent` only — no `innerHTML` for dynamic content |
| **Navigation** | `will-navigate` blocks non-file: URLs; `setWindowOpenHandler` denies child windows |
| **Input** | All IPC handlers validate type, length, and format at the boundary; errors sanitized |
| **Offline** | Full offline support via local cache; dirty queue retries sync when connectivity returns |

---

## Getting Started

### Prerequisites

- Node.js v18+
- A Google Cloud OAuth 2.0 client (configured with redirect URI `http://localhost:42813/oauth2callback`)
- Google Drive API enabled in your Google Cloud project

### Installation

```bash
git clone https://github.com/yassine808/vault-app.git
cd vault-app
npm install
```

### Configuration

Create a `.env` file in the project root:

```env
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
```

Optional:
```env
REDIRECT_URI=http://localhost:42813/oauth2callback
ADMIN_EMAIL=your-email@gmail.com
```

### Google Cloud Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Enable the **Google Drive API**
3. Create an **OAuth 2.0 Client ID** (Desktop application type)
4. Add `http://localhost:42813/oauth2callback` as an authorized redirect URI
5. In the **OAuth consent screen**, add your Google email as a **Test User** (required for unverified apps using Drive scopes)
6. Download the client credentials and add them to your `.env`

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
| Desktop framework | Electron 42 |
| Language | TypeScript (main), TypeScript (renderer) |
| Storage | Google Drive API (per-item encrypted files) |
| Local cache | File-based JSON cache in user data directory |
| Encryption | AES-256-CBC + HMAC-SHA256 encrypt-then-MAC (native `crypto`) |
| Authentication | Google OAuth 2.0 |
| TOTP | Speakeasy |
| Styling | Vanilla CSS (no framework) |
| Color space | `oklch()` |
| CSPRNG | `crypto.getRandomValues` (Fisher-Yates shuffle) |
| Sound | Web Audio API |
| Bundler | Vite (renderer), tsc (main) |

---

## Project Notes

- **No test suite** — there are no test files or test configuration
- **No frontend framework** — vanilla TypeScript throughout
- **Secrets in `.env`** — gitignored
- **Error logging** — writes to per-level files in `Logs/` directory
- **Password generator** — uses CSPRNG with Fisher-Yates shuffle, guarantees at least one character from each enabled class
- **PIN login** — local-only authentication that skips Google OAuth; data loads from local cache
- **Offline support** — full offline access via local cache; changes sync to Drive when connectivity returns
