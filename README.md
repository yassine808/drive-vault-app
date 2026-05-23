<div align="center">

# 🔐 Vault

**Your encrypted personal vault — built with Electron.**

[![Electron](https://img.shields.io/badge/Electron-28.x-47848F?logo=electron&logoColor=white)](https://electronjs.org/)
[![Supabase](https://img.shields.io/badge/Supabase-2.x-3ECF8E?logo=supabase&logoColor=white)](https://supabase.com/)
[![CryptoJS](https://img.shields.io/badge/AES-256-orange?logo=lock&logoColor=white)](https://cryptojs.gitbook.io/)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)](/)
[![License](https://img.shields.io/badge/License-Private-blue)](/)

*Passwords · Notes · Job Tracker · TOTP Authenticator*

</div>

---

## Table of Contents

- [Features](#-features)
- [Screenshots](#-screenshots)
- [Architecture](#-architecture)
- [Authentication Flow](#-authentication-flow)
- [Data Model](#-data-model)
- [Security](#-security)
- [Getting Started](#-getting-started)
- [Project Structure](#-project-structure)
- [Dependencies](#-dependencies)
- [Keyboard Shortcuts](#-keyboard-shortcuts)
- [Building for Distribution](#-building-for-distribution)
- [Notes](#-notes)

---

## ✨ Features

| Tab | Description |
|---|---|
| 🔑 **Passwords** | AES-encrypted storage with strength meter & breach checking (HIBP) |
| 📝 **Notes** | Encrypted private notes with word count & auto-save |
| 💼 **Job Tracker** | Track applications with status, email, dates & inline editing |
| 🔐 **Authenticator** | TOTP code generator — encrypted & synced across devices |
| 🗑️ **Trash** | Soft-delete with 30-day auto-purge & one-click restore |
| ⚡ **Generator** | CSPRNG password generator with guaranteed character class inclusion |
| 📊 **Monitor** | Database stats, log viewer & storage gauges |
| ⚙️ **Settings** | Auto-lock timeout, lock action, 2FA management |

---

## 📸 Screenshots

> Run `npm start` to see the app in action. The UI features a deep black base with purple accents, glassmorphism panels, and a custom floating-point animation background.

---

## 🏗️ Architecture

Vault uses a **deliberately minimal** architecture — no frontend framework, no build step, no TypeScript. Every file has a single, clear responsibility.

### File Layout

```
vault-app/
├── src/
│   ├── main.js          # Electron main process (IPC, auth, crypto, Supabase)
│   └── logger.js        # Structured logging system (per-level log files)
├── preload.js           # Context bridge — secure IPC token injection
├── index.html           # All screens & UI components (single file)
├── app.js               # All renderer logic (state, events, DOM)
├── app.css              # Single stylesheet (Black + Purple theme)
├── package.json         # Dependencies & build scripts
├── .env                 # Secrets (gitignored — see .env.example)
├── .env.example         # Environment variable template
├── CLAUDE.md            # Project guide for AI assistants
├── Logs/                # Runtime log files (auto-created)
│   ├── info.log
│   ├── warn.log
│   └── error.log
└── assets/              # App icons
    ├── icon.ico         # Windows
    └── icon.png         # macOS / Linux
```

### Communication Flow

```
┌──────────────┐      IPC (token-authenticated)      ┌──────────────────┐
│   Renderer    │ ◄────────────────────────────────► │   Main Process   │
│  (app.js)     │                                     │  (src/main.js)   │
│  (index.html) │                                     │  (logger.js)     │
└──────┬────────┘                                     └────────┬─────────┘
       │                                                       │
       │  preload.js (contextBridge)                           │
       │  ├─ Stores session token in closure                  │
       │  ├─ Auto-prepends token to all sensitive IPC calls   │
       │  └─ Exposes window.api & window.__vaultToken         │
       │                                                       │
       ▼                                                       ▼
┌──────────────────────────────────────────────────────────────────────┐
│                          Data Flow                                   │
│                                                                      │
│  Google OAuth ──► derive AES key (SHA-256) ──► encrypt / decrypt    │
│       │                                           │                  │
│       ▼                                           ▼                  │
│  Supabase ◄──── AES-encrypted payloads ──────► Supabase              │
│  (PostgreSQL)    (client-side only)            (at-rest encrypted)   │
└──────────────────────────────────────────────────────────────────────┘
```

### Encryption Strategy

- **Key derivation:** `SHA-256("vault:" + googleId)` — unique per user, deterministic
- **Algorithm:** CryptoJS AES-256 (symmetric)
- **Scope:** Only sensitive data is encrypted — passwords, notes, and TOTP secrets
- **Non-encrypted data:** Job applications and settings (stored as plaintext columns)

---

## 🔑 Authentication Flow

```
User clicks "Sign in with Google"
        │
        ▼
Local OAuth server starts on 127.0.0.1:42813
        │
        ▼
System browser opens Google OAuth consent screen
(state token + CSRF nonce included)
        │
        ▼
Callback received — validated with:
  ✓ Origin header must be localhost:42813
  ✓ State parameter must match (single-use, 5-min expiry)
  ✓ Nonce matches CSP header
        │
        ▼
AES key derived: SHA-256("vault:" + googleId)
        │
        ├── 2FA enabled? → Prompt for TOTP code → verify → rotate token
        │
        ▼
Session token generated (256-bit from crypto.randomBytes)
        │
        ▼
Vault data loaded & decrypted → app unlocked
```

---

## 🗄️ Data Model

| Table | Purpose | Encrypted? | Key Fields |
|---|---|---|---|
| `vault_users` | Google profile, last seen | No | `google_id`, `email`, `name`, `avatar_url` |
| `vault_items` | Passwords & notes | ✅ AES-256 | `type`, `encrypted_data`, `sort_order`, `deleted_at` |
| `vault_jobs` | Job applications | No | `company`, `role`, `status`, `email`, `applied_at` |
| `vault_totp` | TOTP account secrets | ✅ AES-256 | `name`, `issuer`, `secret`, `icon` |
| `vault_2fa` | User's own 2FA settings | No | `secret`, `enabled` |
| `vault_settings` | App preferences | No | `lock_timeout`, `lock_action` |
| `vault_logos` | Favicon cache | No | `domain`, `url`, `cached_at` |

### Soft Deletes

Items and jobs use `deleted_at` timestamps instead of hard deletion. The app auto-purges records older than 30 days. A Trash tab allows restoration before purge.

---

## 🛡️ Security

A comprehensive security audit hardened every layer of the application against common attack vectors.

### Security Checklist

| Layer | Protection | Implementation |
|---|---|---|
| **Secrets** | Credentials in `.env`, not source | `dotenv` + `requireEnv()` — app exits if missing |
| **CSP** | No `unsafe-inline`, scoped origins | `<meta>` tag in `index.html` |
| **OAuth** | CSRF & replay protection | Origin validation + single-use state + nonce |
| **2FA** | Brute-force prevention | 5 attempts / 15-min window, lockout on exceed |
| **IPC** | Session token authentication | All 28 sensitive handlers wrapped with `requireAuth()` |
| **Tokens** | Cryptographic randomness + rotation | `crypto.randomBytes(32)`, rotated on every auth event |
| **Preload** | Token inaccessible from DOM | Closure variable + exposed `set()`/`clear()` only |
| **XSS** | Safe rendering of user data | `createElement` + `https://` URL validation |
| **Generator** | Unbiased output | Fisher-YATES shuffle via `crypto.getRandomValues` |
| **Input** | Boundary validation | Type, length, regex, range checks on all handlers |

### Before & After

```
BEFORE                              AFTER
─────────────                       ─────────────
❌ Secrets in source code     →     ✅ Secrets in .env (gitignored)
❌ script-src 'unsafe-inline' →     ✅ script-src 'self' only
❌ No OAuth state validation  →     ✅ Origin + state + expiry + nonce
❌ Unlimited 2FA attempts      →     ✅ Rate limited (5/15min, lockout)
❌ No IPC authentication       →     ✅ Session tokens on all 28 handlers
❌ Tokens never rotated        →     ✅ Rotation on every auth event
❌ innerHTML with user data   →     ✅ createElement + URL validation
❌ Generator could miss class  →     ✅ Guaranteed class inclusion + shuffle
❌ No input validation         →     ✅ Type, length, regex, range checks
```

---

## 🚀 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) v16 or higher
- npm (comes with Node.js)
- A [Supabase](https://supabase.com/) project with the required tables
- A [Google Cloud](https://console.cloud.google.com/) OAuth 2.0 client

### Step 1 — Clone

```bash
git clone https://github.com/yassine808/vault-app.git
cd vault-app
```

### Step 2 — Install Dependencies

```bash
npm install
```

### Step 3 — Configure Environment

Copy the example file and fill in your credentials:

```bash
cp .env.example .env
```

Edit `.env` with your values:

```env
# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key

# Google OAuth
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret

# Optional — defaults to http://localhost:42813/oauth2callback
# REDIRECT_URI=http://localhost:42813/oauth2callback
```

> **⚠️ Never commit `.env` to git.** It is already in `.gitignore`.

### Step 4 — Run

```bash
npm start          # Production mode
npm run dev        # Development mode (DevTools detached)
```

On first login, Vault will guide you through Google OAuth and optionally let you set up TOTP-based 2FA.

---

## 📁 Project Structure

| File | Purpose | Lines |
|---|---|---|
| `src/main.js` | Main process — IPC handlers, OAuth, crypto, Supabase queries | ~560 |
| `src/logger.js` | Structured logging (per-level files in `Logs/` directory) | ~80 |
| `preload.js` | Context bridge — session token storage & IPC wrapping | ~150 |
| `index.html` | All screens, modals, tab views | ~600 |
| `app.js` | Renderer logic — state management, DOM, event handlers | ~1200 |
| `app.css` | Black + Purple theme with glassmorphism | ~1100 |

Total: **~3,700 lines of plain JavaScript** — no framework, no build step.

---

## 📦 Dependencies

| Package | Purpose | Installed Version |
|---|---|---|
| `electron` | Desktop app framework | ^28.0.0 |
| `@supabase/supabase-js` | PostgreSQL database client | ^2.43.0 |
| `crypto-js` | AES-256 encryption/decryption | ^4.2.0 |
| `speakeasy` | TOTP generation & verification | ^2.0.0 |
| `googleapis` | Google OAuth 2.0 | ^140.0.0 |
| `dotenv` | Environment variable management | ^17.4.2 |
| `uuid` | Unique ID generation | ^9.0.0 |
| `ws` | WebSocket transport for Supabase realtime | ^8.20.0 |
| `electron-builder` | Installer packaging (dev) | ^24.0.0 |

---

## ⌨️ Keyboard Shortcuts

| Key | Action |
|---|---|
| `Escape` | Close any open modal or popup |

---

## 📦 Building for Distribution

```bash
npm run build:win    # Windows NSIS installer
npm run build:mac    # macOS package
npm run build:linux  # Linux AppImage
```

Output goes to the `dist/` directory.

---

## 📋 Notes

- **No test suite** — tests have not been implemented yet
- **No TypeScript** — plain JavaScript throughout
- **No frontend framework** — vanilla JS with DOM manipulation
- **Client-side encryption** — all sensitive data is AES-encrypted before leaving the device
- **Service role key** — the app uses Supabase's service role key; queries are scoped by `user_id` at the application level (not RLS)
- **Error logging** — errors are written to `vault-errors.log` next to the executable and to `Logs/error.log`; viewable from the Monitor tab
- **Supabase tables required** — see the Data Model section above; run the appropriate `CREATE TABLE` statements in your Supabase project before first use
- **Single-file renderer** — all UI lives in `index.html` and `app.js` for simplicity; no bundler needed

---

<div align="center">

**Built with 🔒 by Yassine**

*Vault — Your data, your key, your control.*

</div>
