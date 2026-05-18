<div align="center">

# 🔐 Vault

**Your encrypted personal vault — built with Electron.**

[![Electron](https://img.shields.io/badge/Electron-28.x-47848F?logo=electron&logoColor=white)](https://electronjs.org/)
[![Supabase](https://img.shields.io/badge/Supabase-2.x-3ECF8E?logo=supabase&logoColor=white)](https://supabase.com/)
[![CryptoJS](https://img.shields.io/badge/AES-256-orange?logo=lock&logoColor=white)](https://cryptojs.gitbook.io/)
[![Platform](https://img/badge.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)](/)
[![License](https://img.shields.io/badge/License-Private-blue)]()

*Passwords · Notes · Job Tracker · TOTP Authenticator*

</div>

---

## ✨ Features

| Tab | Description |
|---|---|
| 🔑 **Passwords** | AES-encrypted password storage with strength meter & breach checking (HIBP) |
| 📝 **Notes** | Encrypted private notes with word count & auto-save |
| 💼 **Job Tracker** | Track applications with status, email, dates & inline editing |
| 🔐 **Authenticator** | TOTP code generator — encrypted & synced across devices |
| 🗑️ **Trash** | Soft-delete with 30-day auto-purge & one-click restore |
| ⚡ **Generator** | CSPRNG password generator with guaranteed character class inclusion |
| 📊 **Monitor** | Database stats, log viewer & storage gauges |
| ⚙️ **Settings** | Auto-lock timeout & action, 2FA management |

---

## 🏗️ Architecture

Vault uses a **deliberately minimal** architecture — no frontend framework, no build step, no TypeScript. Every file has a single, clear responsibility.

```
vault-app/
├── src/
│   └── main.js          # Electron main process (IPC, auth, crypto, Supabase)
├── preload.js           # Context bridge — secure IPC token injection
├── index.html          # All screens & UI components (single-file)
├── app.js              # All renderer logic (state, events, DOM)
├── app.css             # Single stylesheet (Outfit + JetBrains Mono fonts)
├── package.json        # Dependencies & build scripts
├── .env                # Secrets (gitignored — see .env.example)
├── .env.example        # Environment variable template
├── icon.ico            # Windows icon
└── icon.png            # macOS / Linux icon
```

### How It Works

```
┌─────────────┐     IPC (token-authenticated)     ┌──────────────────┐
│   Renderer   │ ◄──────────────────────────────► │   Main Process   │
│  (app.js)    │                                   │  (src/main.js)   │
│  (index.html)│                                   │                  │
└──────┬───────┘                                   └────────┬─────────┘
       │                                                    │
       │  preload.js (contextBridge)                        │
       │  ├─ Stores session token in closure                │
       │  ├─ Auto-prepends token to all IPC calls           │
       │  └─ Exposes window.api & window.__vaultToken       │
       │                                                    │
       ▼                                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        Data Flow                                    │
│                                                                     │
│  Google OAuth ──► derive AES key (SHA-256) ──► encrypt/decrypt     │
│       │                                          │                  │
│       ▼                                          ▼                  │
│  Supabase ◄──── AES-encrypted payloads ──────► Supabase             │
│  (PostgreSQL)    (client-side only)            (at-rest encrypted)  │
└─────────────────────────────────────────────────────────────────────┘
```

### Authentication Flow

```
User clicks "Sign in with Google"
        │
        ▼
Local OAuth server starts on 127.0.0.1:42813
        │
        ▼
Browser opens Google OAuth (state token + CSRF protection)
        │
        ▼
Callback validated (origin check · state match · 5-min expiry · single-use)
        │
        ▼
AES key derived from SHA-256("vault:" + googleId)
        │
        ├── 2FA enabled? → Prompt for TOTP code → verify → rotate token
        │
        ▼
Session token generated (256-bit crypto random) → returned to renderer
        │
        ▼
Vault data loaded & decrypted → app unlocked
```

### Data Model

| Table | Purpose | Encrypted? |
|---|---|---|
| `vault_users` | Google profile, last seen | No |
| `vault_items` | Passwords & notes | ✅ AES-256 |
| `vault_jobs` | Job applications | No (plaintext columns) |
| `vault_totp` | TOTP account secrets | ✅ AES-256 |
| `vault_2fa` | User's own 2FA settings | No |
| `vault_settings` | Lock timeout & action | No |
| `vault_logos` | Favicon cache | No |

---

## 🛡️ Security Hardening

A comprehensive security audit was performed. Every layer of the application was hardened against common attack vectors.

| # | Category | What Changed | File(s) |
|---|---|---|---|
| 1 | **Secrets Management** | All hardcoded credentials (Supabase URL, service key, Google OAuth ID/secret) moved to `.env` file loaded via `dotenv`. App refuses to start if any are missing. | `src/main.js` |
| 2 | **CSP Hardening** | Content-Security-Policy tightened: `script-src` restricted to `'self'` (no `unsafe-inline`), `img-src` limited to favicon/QR domains, `connect-src` scoped to Supabase/HIBP APIs, added `object-src 'none'` and `base-uri 'self'`. | `index.html` |
| 3 | **OAuth CSRF Protection** | OAuth callback hardened with: `Origin` header validation (must be `localhost:42813`), single-use `state` parameter (consumed once), 5-minute state expiration, nonce-based CSP on the callback HTML page. | `src/main.js` |
| 4 | **2FA Rate Limiting** | Brute-force protection on `auth:verify2fa`: 5 attempts per 15-minute sliding window, 15-minute lockout on exceeded attempts, automatic reset on success. | `src/main.js` |
| 5 | **Session Token Auth** | All 28 sensitive IPC handlers wrapped with `requireAuth()` / `requireAuthNoArgs()`. Each handler validates a cryptographically random session token before executing any logic. | `src/main.js` |
| 6 | **Token Lifecycle** | Tokens generated via `crypto.randomBytes(32)` on login, 2FA verification, and re-auth. Token cleared on logout. Token rotated on every 2FA success. | `src/main.js`, `preload.js`, `app.js` |
| 7 | **Preload Token Bridge** | Preload script stores token in a closure variable (inaccessible to renderer DOM). `window.__vaultToken` exposes `set()`/`clear()` methods. All sensitive IPC calls auto-inject the token. | `preload.js` |
| 8 | **XSS Prevention** | Three XSS vectors fixed: avatar image URL now validates `https://` prefix before rendering; favicon images use `createElement` with `addEventListener('error')` instead of `innerHTML` with inline `onerror`; QR code image built via `createElement` instead of `innerHTML`. | `app.js` |
| 9 | **Password Generator** | Generator now guarantees at least one character from each enabled class (uppercase, lowercase, numbers, symbols). Result is Fisher-Yates shuffled using CSPRNG (`crypto.getRandomValues`) to prevent positional bias. | `app.js` |
| 10 | **Input Validation** | All IPC handlers validate input at the boundary: item type must be `password`/`note` (500 char limit), emails validated via regex, TOTP secrets validated as base32 (A-Z, 2-7, 16+ chars), settings ranges enforced (timeout 0–120 min, action must be `lock`/`exit`), notes capped at 5000 chars, all string fields sanitized and length-limited. | `src/main.js` |

### Security Before & After

```
BEFORE                              AFTER
─────────────                       ─────────────
❌ Secrets in source code     →     ✅ Secrets in .env (gitignored)
❌ script-src 'unsafe-inline' →     ✅ script-src 'self' only
❌ No OAuth state validation  →     ✅ Origin check + state + expiry + nonce
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

### Installation

**1. Clone the repository**
```bash
git clone https://github.com/yassine808/vault-app.git
cd vault-app
```

**2. Install dependencies**
```bash
npm install
```

**3. Configure environment variables**

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
```

> **⚠️ Never commit `.env` to git.** It is already in `.gitignore`.

**4. Run the app**
```bash
npm start          # Production mode
npm run dev        # Development mode (DevTools detached)
```

**5. Build for distribution**
```bash
npm run build:win    # Windows NSIS installer
npm run build:mac    # macOS package
npm run build:linux  # Linux AppImage
```

---

## ⌨️ Keyboard Shortcuts

| Key | Action |
|---|---|
| `Escape` | Close any open modal or popup |

---

## 📦 Dependencies

| Package | Purpose |
|---|---|
| `electron` | Desktop app framework |
| `@supabase/supabase-js` | PostgreSQL database client |
| `crypto-js` | AES-256 encryption/decryption |
| `speakeasy` | TOTP generation & verification |
| `googleapis` | Google OAuth 2.0 |
| `dotenv` | Environment variable management |
| `ws` | WebSocket transport for Supabase realtime |

---

## 📋 Notes

- **No test suite** — tests have not been implemented yet
- **No TypeScript** — plain JavaScript throughout
- **No frontend framework** — vanilla JS with DOM manipulation
- **Client-side encryption** — all sensitive data is AES-encrypted before leaving the device
- **Service role key** — the app uses Supabase's service role key; queries are scoped by `user_id` at the application level
- **Error logging** — errors are written to `vault-errors.log` next to the executable, viewable from the Monitor tab

---

<div align="center">

**Built with 🔒 by Yassine**

*Vault — Your data, your key, your control.*

</div>
