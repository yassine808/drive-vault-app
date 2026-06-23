# 🔐 Vault

A desktop app for secure storage of passwords, notes, job applications, and TOTP authenticator secrets — all AES-256 encrypted on-device. Data lives in your Google Drive.

**Built with Electron + TypeScript.** No frontend framework.

## Features

- **Passwords** — encrypted credentials with auto-copy
- **Notes** — encrypted private notes
- **Job Tracker** — track applications (company, role, status, dates)
- **Authenticator** — TOTP code generator, secrets synced via Drive
- **Trash** — soft-delete with 30-day auto-purge and restore
- **Generator** — CSPRNG password generator with configurable rules
- **Settings** — auto-lock, 13 accent colors, sounds, PIN login, 2FA

## How It Works

1. Sign in via Google OAuth 2.0 (local HTTP server on `127.0.0.1:42813`)
2. AES key derived from `SHA-256("vault:" + googleId)`
3. All data encrypted client-side (AES-256-CBC + HMAC-SHA256) before storage
4. Per-item encrypted files stored in a `Vault/` folder in your Google Drive
5. Full offline support via local cache; changes sync when connectivity returns
6. Optional PIN login skips Google OAuth on subsequent sessions

## Architecture

| File                        | Role                                                                 |
| --------------------------- | -------------------------------------------------------------------- |
| `src/main.ts`               | Electron main process — entry point, IPC, OAuth, module registration |
| `src/modules/drive.ts`      | Google Drive storage client                                          |
| `src/modules/cache.ts`      | Local offline cache                                                  |
| `src/modules/crypto.ts`     | AES-256-CBC + HMAC-SHA256 encryption                                 |
| `src/modules/auth.ts`       | Session tokens, auth guards, 2FA rate limiting                       |
| `src/modules/pin.ts`        | PIN-based authentication (local-only)                                |
| `src/modules/validation.ts` | Shared input validators                                              |
| `src/modules/jobs.ts`       | Job tracker CRUD                                                     |
| `src/modules/totp.ts`       | TOTP secret management (encrypted)                                   |
| `src/modules/settings.ts`   | Settings persistence                                                 |
| `src/modules/logo.ts`       | Favicon fetching + caching                                           |
| `src/modules/accounts.ts`   | Saved accounts for quick PIN login                                   |
| `src/types/index.ts`        | Shared TypeScript interfaces                                         |
| `src/logger.ts`             | Structured per-level logging                                         |
| `preload.ts`                | Context bridge with session token in closure                         |
| `index.html`                | Renderer UI                                                          |
| `app.css`                   | Stylesheet (`oklch()` color space, glassmorphism)                    |
| `app.ts`                    | Renderer logic                                                       |

## Getting Started

### Prerequisites

- Node.js v18+
- A Google Cloud OAuth 2.0 client with Drive API enabled

### Setup

```bash
git clone https://github.com/yassine808/vault-app.git
cd vault-app
npm install
```

Create a `.env` file:

```env
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
```

In Google Cloud Console:

1. Enable the **Google Drive API**
2. Create an **OAuth 2.0 Client ID** (Desktop application)
3. Add `http://localhost:42813/oauth2callback` as a redirect URI
4. Add your email as a **Test User** on the OAuth consent screen

### Commands

```bash
npm start          # Production
npm run dev        # Development (DevTools detached)
npm run typecheck  # TypeScript check
npm run build:all  # Vite build + tsc
npm run build:win  # Windows installer (NSIS)
npm run build:mac  # macOS package
npm run build:linux # Linux AppImage
```

## Security

- **Encryption**: AES-256-CBC + HMAC-SHA256 encrypt-then-MAC
- **Auth**: Google OAuth 2.0 with CSRF state, origin validation, 5-min expiry
- **Session**: 256-bit token in closure, timing-safe validation, rotated on every auth event
- **PIN**: PBKDF2-SHA256 (600k iterations), local-only, rate limited (5 attempts / 15 min)
- **2FA**: TOTP with sliding-window rate limiting
- **CSP**: `script-src 'self'`, `frame-src 'none'`, `worker-src 'none'`
- **XSS**: No `innerHTML` for dynamic content — `textContent` only

## Tech Stack

Electron 42 · TypeScript · Google Drive API · Vite (renderer) · tsc (main) · Speakeasy (TOTP) · Web Audio API · Vanilla CSS (`oklch()`)
