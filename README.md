# 🔐 Vault

A desktop app for storing passwords, notes, job applications, and TOTP codes — all encrypted on your device before being saved to the cloud.

**Built with Electron + Supabase + AES-256 encryption.**

---

## What It Does

- **Passwords** — Save login credentials, encrypted with AES-256 before leaving your device
- **Notes** — Encrypted private notes with word count
- **Job Tracker** — Track job applications with status, company, email, and dates
- **Authenticator** — TOTP code generator, encrypted and synced across devices
- **Trash** — Soft-delete with 30-day auto-purge and one-click restore
- **Password Generator** — Generates strong passwords using your system's random number generator
- **Monitor** — View database stats and app logs
- **Settings** — Auto-lock, accent colors, sound effects, 2FA, and more

---

## How It Works

### Authentication

You sign in with Google OAuth. The app opens a browser window, you approve access, and the app receives a token. No password to remember.

If you enable 2FA, you'll also enter a code from your authenticator app after signing in.

### Encryption

Your encryption key is derived from your Google account ID using SHA-256. Passwords, notes, and TOTP secrets are encrypted with AES-256 on your device before being sent to Supabase.

The server only ever sees encrypted data — it cannot read your passwords or notes.

### Data Flow

```
Your device  ──AES-256──▶  Encrypted data  ──▶  Supabase (PostgreSQL)
     ▲                                                        │
     └──────────── Decrypt with your key ◀────────────────────┘
```

### Session Security

After login, the app generates a random 256-bit session token. Every sensitive request to the main process includes this token. The token is stored in a secure closure (inaccessible from web page JavaScript) and is rotated on every login.

---

## Getting Started

### 1. Prerequisites

- Node.js v16+
- A Supabase project with the required tables
- A Google Cloud OAuth 2.0 client

### 2. Install

```bash
git clone https://github.com/yassine808/vault-app.git
cd vault-app
npm install
```

### 3. Configure

Copy `.env.example` to `.env` and fill in your credentials:

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
```

### 4. Run

```bash
npm start        # Production
npm run dev      # Development (with DevTools)
```

### 5. Build

```bash
npm run build:win    # Windows installer
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
| Auth | Google OAuth 2.0 |
| TOTP | Speakeasy |
| Styling | Vanilla CSS (no framework) |
| Frontend | Vanilla JavaScript (no framework) |

---

## Security

- All sensitive data encrypted client-side with AES-256
- Session tokens required for every sensitive operation
- OAuth hardened with CSRF protection, state validation, and origin checks
- 2FA rate limiting (5 attempts per 15 minutes)
- Content Security Policy blocks inline scripts and unauthorized connections
- User data rendered safely to prevent XSS

---

## Notes

- No test suite yet
- Plain JavaScript — no TypeScript, no frontend framework
- `.env` file contains secrets and is gitignored
- Errors are logged to `Logs/error.log` and viewable in the Monitor tab
