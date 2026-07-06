<div align="center">

# 🔐 Vault

**Encrypted password & notes vault — AES-256 client-side encryption, Google Drive sync, PIN login.**

[![Version](https://img.shields.io/badge/version-3.0.0-blue.svg?style=flat-square)](https://github.com/yassine808/drive-vault-app/releases)
[![Electron](https://img.shields.io/badge/Electron-42.2.0-47848f.svg?style=flat-square&logo=electron)](https://www.electronjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-3178c6.svg?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg?style=flat-square)](https://github.com/yassine808/drive-vault-app/releases)

_Secure storage for passwords, notes, job applications, and TOTP authenticator secrets._

</div>

---

## Overview

Vault is an **Electron desktop app** for secure local storage of sensitive data. Everything is encrypted client-side (AES-256-CBC + HMAC-SHA256) before it ever touches Google Drive, so the server only ever sees ciphertext. Sign in with Google OAuth 2.0 (with optional TOTP 2FA), or skip straight past OAuth on later launches with a local PIN.

| Property           | Detail                                                           |
| ------------------ | ----------------------------------------------------------------- |
| **Encryption**      | AES-256-CBC + HMAC-SHA256 (encrypt-then-MAC), per-item files      |
| **Key derivation**  | PBKDF2-SHA256, 600k iterations, per-account salt                  |
| **Storage**         | Google Drive (one encrypted file per item) + local offline cache  |
| **Auth**            | Google OAuth 2.0 + optional TOTP 2FA + optional PIN quick-login   |
| **Platform**        | Windows (NSIS/Portable), macOS (DMG), Linux (AppImage)            |
| **Stack**           | TypeScript throughout, no frontend framework, Vite/esbuild bundling |

For module-by-module internals, IPC channel reference, and file layout, see [`CLAUDE.md`](./CLAUDE.md). This document focuses on **how the app actually behaves end-to-end**, from cold launch to lock/logout and back.

---

## Full Lifecycle

The diagram below traces one continuous path through the app: cold start → authentication (PIN or Google) → Drive initialization & conflict resolution → the active session's CRUD/sync loop → locking or logging out and looping back to the start.

```mermaid
flowchart TD
    Start([App launches]) --> CheckPin{"pin:status"}
    CheckPin -- "PIN enabled" --> PinScreen[Show PIN screen<br/>apply allowAlpha to input]
    CheckPin -- "no PIN set up" --> LoginScreen[Show Google sign-in screen]

    subgraph AUTH["Authentication"]
        direction TB
        PinScreen --> PickAccount[Pick a saved account, or none]
        PickAccount --> EnterPin[Enter PIN]
        EnterPin --> PinVerify{"pin:verify"}
        PinVerify -- wrong --> EnterPin
        PinVerify -- "5 wrong attempts / 15 min" --> Lockout["15-minute lockout"]
        Lockout --> EnterPin
        PinVerify -- correct --> LoginWithPin["auth:loginWithPin(verifyId)"]
        PinScreen -. "Sign in with Google instead" .-> LoginScreen

        LoginScreen --> OAuth[Google OAuth 2.0 popup]
        OAuth --> TwoFACheck{"2FA enabled?"}
        TwoFACheck -- yes --> TwoFA[Enter TOTP code]
        TwoFA --> TwoFAVerify{"2fa:verify"}
        TwoFAVerify -- wrong --> TwoFA
        TwoFAVerify -- correct --> SessionCreate
        TwoFACheck -- no --> SessionCreate[Create session token]
        LoginWithPin --> SessionCreate
    end

    SessionCreate --> RehydrateOAuth[Rehydrate OAuth client from encrypted refresh token]
    RehydrateOAuth --> DriveInit[DriveClient.init]
    DriveInit --> EnsureFolders[Ensure Vault folder + subfolders on Drive]
    EnsureFolders --> Snapshot["Snapshot previously-synced etags"]
    Snapshot --> BuildIndex["buildFileIdCache: list Drive files, refresh etags"]
    BuildIndex --> Resolve["resolveConflicts: diff current vs snapshot"]
    Resolve -- "missing locally" --> Download[Download file, add to cache]
    Resolve -- "changed on Drive, no local edit pending" --> Download
    Resolve -- "local edit still unsynced" --> KeepLocal[Keep local version]
    Resolve -- "unchanged" --> KeepLocal
    Download --> LoadVault[Decrypt items, load vault into memory]
    KeepLocal --> LoadVault
    LoadVault --> AppReady([Enter app])

    subgraph SESSION["Active session"]
        direction TB
        AppReady --> UserAction{"User action"}

        UserAction -- "add / edit item" --> SaveItem[Update local cache]
        UserAction -- "delete item" --> SoftDelete["Soft-delete: mark deletedAt (moves to Trash)"]
        UserAction -- "permanently delete from Trash" --> PermDelete["permDelete: remove from cache + queue Drive file deletion"]
        SaveItem --> DirtyQueue[Push to dirty queue<br/>persisted to disk cache]
        SoftDelete --> DirtyQueue
        PermDelete --> DirtyQueue
        DirtyQueue --> IconSpin["Sidebar sync icon spins (withSyncSpin)"]
        IconSpin --> Debounce["2s debounce"]
        Debounce --> SyncToDrive["syncToDrive: flush dirty queue"]

        UserAction -- "click Sync Now button" --> ManualSync["api.vaultSync()"]
        ManualSync --> IconSpin

        SyncToDrive -- success --> ClearDirty[Remove item from dirty queue]
        SyncToDrive -- "network / API error" --> Retry{"retryCount < 3?"}
        Retry -- yes --> DirtyQueue
        Retry -- "no, or app was offline" --> StayQueued["Item stays in dirty queue on disk,<br/>retried next launch or Sync Now"]
        ClearDirty --> IconStop[Icon stops spinning]
        StayQueued --> IconStop

        UserAction -- "enable / change / disable PIN in Settings" --> PinMgmt{"pin:setup / pin:change / pin:disable"}
        PinMgmt --> UpdateMeta["Update vault_pin_meta + reset rate limiter"]
        UpdateMeta --> UserAction

        UserAction -- "idle timeout / manual lock" --> Lock[doLock: wipe sensitive data from memory]
        UserAction -- "logout" --> Logout[doLogout: clear session + memory]
    end

    Lock --> PostLockCheck{"pin_login_enabled?"}
    PostLockCheck -- yes --> PinScreen
    PostLockCheck -- no --> GoogleUnlock[Show Google unlock screen]

    Logout --> PostLogoutCheck{"pin_login_enabled?"}
    PostLogoutCheck -- yes --> PinScreen
    PostLogoutCheck -- no --> LoginScreen
```

### Reading the flow

**Cold start.** The renderer never assumes it knows anything before `pin:status` answers — that single call decides both which screen to show and, now, whether the PIN input should accept letters (`allowAlpha`), since real session settings don't exist yet at this point.

**Authentication.** Both paths converge on a session token. PIN login never lets a token or Google ID pass through the renderer in cleartext — `pin:verify` hands back a short-lived `verifyId` that only `auth:loginWithPin` can redeem. Five wrong PIN attempts in 15 minutes trigger a 15-minute lockout, tracked on disk so it survives an app restart.

**Drive init & conflict resolution.** This is the step that keeps the local cache honest. A snapshot of each file's last-known `modifiedTime` is taken *before* the live index refresh overwrites it, so the app can tell "unchanged" apart from "edited elsewhere since we last synced" — the latter triggers a re-download that replaces the stale local copy, unless that item still has an unsynced local edit sitting in the dirty queue (local wins in that case).

**Active session.** Every mutation — add, edit, soft-delete (to Trash), or permanent delete — goes local-first (instant UI, offline-safe), gets queued, and is flushed to Drive on a 2-second debounce or an immediate manual "Sync now". The sidebar sync icon spins for the whole in-flight window, whether that's one save or several queued at once. Failed syncs retry up to 3 times; if the app is offline or retries are exhausted, the item simply stays in the on-disk dirty queue and is picked up again on the next launch or manual sync — nothing is silently lost. Enabling, changing, or disabling the PIN from Settings updates `vault_pin_meta` and resets the rate limiter, then returns straight back into the session.

**Locking / logging out.** Both funnel back to the same fork at the top of the diagram: if PIN login is enabled you land back on the PIN screen, otherwise back on the appropriate Google screen — closing the loop.

---

## Setup & Installation

### Prerequisites

| Requirement           | Version | Purpose                               |
| ---------------------- | ------- | -------------------------------------- |
| Node.js                | ≥ 18    | Runtime                                |
| npm                    | ≥ 9     | Package manager                        |
| Google Cloud Project   | —       | OAuth credentials + Drive API enabled  |

### Environment variables

Create a `.env` file in the project root:

```env
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
REDIRECT_URI=http://localhost:42813/oauth2callback  # optional, defaults to this value
```

> **⚠️ Required:** `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` must be set. The app exits with an error dialog if either is missing.

### Google Cloud setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Enable **Google Drive API** (APIs & Services → Library → search "Google Drive API")
4. Create **OAuth 2.0 Credentials** (APIs & Services → Credentials → Create OAuth Client ID)
5. Application type: **Web application**
6. Add authorized redirect URI: `http://localhost:42813/oauth2callback`
7. Copy the Client ID and Client Secret into `.env`

### Install & run

```bash
# Install dependencies
npm install

# Type-check (no emit)
npm run typecheck

# Development mode (Vite dev server + tsx main + DevTools detached)
npm run dev

# Production build (Vite build + tsc compile)
npm run build:all

# Run production build
npm start
```

No test suite, linter, or formatter is currently configured.

---

## Build Targets

| Platform | Command               | Output                                                  |
| -------- | ---------------------- | -------------------------------------------------------- |
| Windows  | `npm run build:win`    | `dist/Vault Setup {version}.exe` (NSIS) + portable `.exe` |
| macOS    | `npm run build:mac`    | `dist/Vault-{version}.dmg`                                |
| Linux    | `npm run build:linux`  | `dist/Vault-{version}.AppImage`                           |

---

For architecture details, the full IPC channel reference, module map, and type definitions, see [`CLAUDE.md`](./CLAUDE.md).
