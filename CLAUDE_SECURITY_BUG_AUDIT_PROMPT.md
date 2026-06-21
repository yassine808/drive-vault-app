# Vault App - Security & Bug Fix Comprehensive Audit Prompt for Claude

> **Instructions for Claude:** This is a complete security and bug audit for the Vault app (yassine808/vault-app). Please analyze all identified issues and provide fixes with code patches. Latest commit: `22c4677d25b49bbd1109550869d9cf614bce2906`

---

## Current Architecture Overview

- **Frontend:** Electron desktop app (TypeScript + React/Vue)
- **Backend:** Electron main process
- **Storage:** Google Drive (encrypted items) + Local cache (offline support)
- **Auth:** Google OAuth 2.0 + PIN-based quick login + 2FA (TOTP)
- **Encryption:** AES-256-CBC with HMAC-SHA256
- **Sync:** Two-way folder sync with Drive, drag-and-drop support, per-file status tracking

---

## Security Vulnerabilities Found

### 1. **CRITICAL: Weak Encryption Key Derivation** (SEVERITY: CRITICAL)
**File:** `src/modules/crypto.ts:20-22`  
**Current Code:**
```typescript
function deriveKey(googleId: string): string {
  return crypto.createHash('sha256').update('vault:' + googleId).digest('hex').slice(0, 32);
}
```

**Issues:**
- Uses only SHA256 (not PBKDF2 or Argon2)
- No per-account salt
- GoogleID is not secret (used in OAuth)
- Single operation with no key stretching — instant computation
- If one user's database is stolen, attacker can derive keys for all accounts

**Fix Required:**
- Implement PBKDF2 with min 310,000 iterations for key derivation
- Generate and store per-account salt on first login
- Update function signature: `deriveKey(googleId: string, userSalt?: string)`
- Migrate existing accounts on next login by computing new keys with salt
- Store salt in unencrypted user metadata (not sensitive)

**Migration Path:**
```typescript
// On login, detect if user has old-format key (no salt)
// If so, generate salt, recompute key, update all encrypted data
if (userSalt === undefined) {
  userSalt = crypto.randomBytes(32).toString('hex');
  // Re-encrypt all vault items with new key
  // Save userSalt to settings
}
```

---

### 2. **HIGH: OAuth State Parameter Race Condition** (SEVERITY: HIGH)
**File:** `src/main.ts:243-303`  
**Current Flow:**
- Line 243: Check `parsed.pathname !== '/oauth2callback'`
- Line 259: Check `!oauthInProgress`
- Line 265: Check `Date.now() - stateCreatedAt > 5 * 60 * 1000`
- Line 300: Check `!parsed.query.code || parsed.query.state !== state`

**Issues:**
- State validation happens AFTER expiration check
- State is not consumed/invalidated after successful validation
- Multiple simultaneous OAuth flows could succeed
- Race condition window allows callback replay

**Fix Required:**
- Move state parameter validation (`code` + `state`) to line 259 (immediately after `oauthInProgress` check)
- Consume state immediately: `state = null` after first successful validation
- Add nonce validation to prevent CSRF

**Code Change:**
```typescript
// Line 259-271: Reorder checks
if (!oauthInProgress) {
  logger.authLog('oauth', 'Rejected OAuth callback — no active flow');
  res.writeHead(400, { 'Content-Type': 'text/plain' });
  res.end('OAuth session expired or already used');
  return;
}

// MOVE state validation here (before expiration check)
if (!parsed.query.code || parsed.query.state !== state) {
  logger.authLog('oauth', 'OAuth state mismatch or missing code');
  oauthInProgress = false;  // Immediately stop accepting callbacks
  res.writeHead(400, { 'Content-Type': 'text/plain' });
  res.end('OAuth state mismatch');
  return reject(new Error('OAuth state mismatch'));
}

// Then check expiration
if (Date.now() - stateCreatedAt > 5 * 60 * 1000) {
  logger.authLog('oauth', 'OAuth state expired');
  oauthServer!.close(); oauthServer = null; oauthInProgress = false;
  res.writeHead(400, { 'Content-Type': 'text/plain' });
  res.end('OAuth state expired');
  return reject(new Error('OAuth state expired'));
}

// Consume the state
state = null;  // ← CRITICAL: Prevent replay attacks
oauthInProgress = false;
```

---

### 3. **HIGH: PIN Timing Attack - Information Leakage** (SEVERITY: HIGH)
**File:** `src/modules/pin.ts:240-259`  
**Current Code:**
```typescript
const payload = dec(fileData.data, pinKey) as { pinHash: string; userKey: { googleId: string; email: string } } | null;
if (!payload || typeof payload.pinHash !== 'string' || !payload.userKey...) {
  recordFailedAttempt();
  logger.authLog('pin:verify', 'PIN verification failed — decryption or validation failed');
  return { ok: false, error: 'Invalid PIN' };  // ← EARLY RETURN LEAKS INFO
}

const computedHash = crypto.pbkdf2Sync(pin, salt, 600000, 32, 'sha256').toString('hex');
const computedBuf = Buffer.from(computedHash, 'hex');
const storedBuf = Buffer.from(payload.pinHash, 'hex');
if (computedBuf.length !== storedBuf.length || !crypto.timingSafeEqual(computedBuf, storedBuf)) {
  recordFailedAttempt();
  return { ok: false, error: 'Invalid PIN' };
}
```

**Issues:**
- Early return on decryption failure reveals whether decryption succeeded
- Attacker can time requests to distinguish "wrong PIN" from "decryption failed"
- Reduces effective PIN entropy (4-12 digits)
- Allows timing-based PIN brute force with fewer attempts

**Fix Required:**
- Perform hash computation even if decryption fails (use dummy hash)
- Always execute timing-safe comparison before any early returns
- Only validate payload structure AFTER successful hash comparison

**Code Change:**
```typescript
const payload = dec(fileData.data, pinKey) as { pinHash: string; userKey: { googleId: string; email: string } } | null;

// Compute expected hash regardless of decryption success
const computedHash = crypto.pbkdf2Sync(pin, salt, 600000, 32, 'sha256').toString('hex');
const computedBuf = Buffer.from(computedHash, 'hex');

// Use safe default if payload is null (still 32 bytes for timing safety)
const storedBuf = payload?.pinHash 
  ? Buffer.from(payload.pinHash, 'hex') 
  : Buffer.alloc(32);  // ← Same length, timing-safe

// Timing-safe comparison FIRST (no early returns before this)
const hashMatch = crypto.timingSafeEqual(computedBuf, storedBuf);

// ONLY NOW validate payload structure
const payloadValid = payload 
  && typeof payload.pinHash === 'string' 
  && payload.userKey 
  && typeof payload.userKey.googleId === 'string' 
  && payload.userKey.googleId.length > 0
  && typeof payload.userKey.email === 'string';

// Single failure path
if (!hashMatch || !payloadValid) {
  recordFailedAttempt();
  logger.authLog('pin:verify', 'PIN verification failed');
  logger.warn('pin:verify', 'Incorrect PIN attempt');
  return { ok: false, error: 'Invalid PIN' };
}
```

---

### 4. **HIGH: Sync Module Path Traversal Vulnerability** (SEVERITY: HIGH)
**File:** `src/modules/sync.ts:535-549, 637-657, 745-774`  
**Current Code:**
```typescript
addFolder(localPath: string, driveFolderName: string): SyncFolder {
  const config = loadConfig();
  const folder: SyncFolder = {
    id: crypto.randomUUID(),
    localPath: path.resolve(localPath),  // ← No validation
    // ...
  };
}

// In sync:folders:add handler
const resolved = path.resolve(localPath);
const forbidden = ['/Windows', '/Program Files', '/System', 'C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)'];
if (forbidden.some(f => resolved.startsWith(f))) {  // ← Incomplete check
  return { ok: false, error: 'Cannot sync system directories' };
}
```

**Issues:**
- Path traversal not fully prevented (e.g., `C:\Windows\..\..\Users\secret` bypasses check)
- Can sync sensitive system directories via symlinks
- No validation that path is within user's home directory
- No check for restricted paths on macOS (`/System`, `/Library`) or Linux (`/etc`, `/var`)
- `path.resolve()` normalizes `..` but doesn't validate parent paths

**Fix Required:**
- Use `fs.realpathSync()` to resolve symlinks and canonicalize paths
- Whitelist allowed base directories (home, Documents, Desktop, Downloads)
- Blacklist sensitive paths comprehensively across all platforms
- Check that resolved path is within allowed base

**Code Change:**
```typescript
function validateSyncPath(inputPath: string): { ok: boolean; error?: string; realPath?: string } {
  try {
    // Resolve symlinks and normalize
    const realPath = fs.realpathSync(inputPath);
    
    // Check exists and is directory
    const stat = fs.statSync(realPath);
    if (!stat.isDirectory()) {
      return { ok: false, error: 'Path must be a directory' };
    }
    
    // Whitelist: only home directory and common user folders
    const homeDir = os.homedir();
    if (!realPath.startsWith(homeDir)) {
      return { ok: false, error: 'Can only sync folders within your home directory' };
    }
    
    // Blacklist: sensitive system paths (cross-platform)
    const forbidden = process.platform === 'win32'
      ? [
          'C:\\Windows',
          'C:\\Program Files',
          'C:\\Program Files (x86)',
          'C:\\ProgramData',
          'C:\\$Recycle.Bin',
          path.join(homeDir, 'AppData\\Roaming\\Microsoft'),
          path.join(homeDir, 'AppData\\Local\\Temp'),
        ]
      : [
          '/System',
          '/Library',
          '/etc',
          '/var',
          '/usr/bin',
          '/usr/local/bin',
          path.join(homeDir, '.ssh'),
          path.join(homeDir, '.gnupg'),
          path.join(homeDir, '.aws'),
        ];
    
    if (forbidden.some(f => realPath.startsWith(path.resolve(f)))) {
      return { ok: false, error: 'Cannot sync restricted system directories' };
    }
    
    return { ok: true, realPath };
  } catch (e) {
    return { ok: false, error: 'Invalid path or access denied' };
  }
}

// Update sync:folders:add handler
ipcMain.handle('sync:folders:add', requireAuth(async (_e, { localPath, driveFolderName }) => {
  const validation = validateSyncPath(localPath);
  if (!validation.ok) {
    return { ok: false, error: validation.error };
  }
  const folder = engine.addFolder(validation.realPath!, driveFolderName || path.basename(validation.realPath!));
  return { ok: true, folder };
}));
```

---

### 5. **HIGH: Missing Input Validation on Sync Folder Names** (SEVERITY: HIGH)
**File:** `src/modules/sync.ts:58-60`  
**Current Code:**
```typescript
function sanitizeDriveFolderName(name: string): string {
  return name.replace(/[\/\\<>:|"?*\x00-\x1f]/g, '_').slice(0, 64);
}
```

**Issues:**
- Only sanitizes forbidden characters
- No length check on input (could be gigabytes of string)
- Doesn't prevent directory traversal in folder names
- `driveFolderName` parameter comes directly from IPC without type validation
- No check for reserved names (`CON`, `PRN`, `AUX`, `NUL` on Windows)

**Fix Required:**
- Validate input type strictly
- Add length limit (e.g., 128 chars)
- Prevent reserved names
- Use proper encoding for Drive API

**Code Change:**
```typescript
const RESERVED_NAMES_WINDOWS = ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT1'];

function sanitizeDriveFolderName(name: string): string {
  if (typeof name !== 'string') {
    throw new Error('Folder name must be a string');
  }
  
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error('Folder name cannot be empty');
  }
  if (trimmed.length > 128) {
    throw new Error('Folder name cannot exceed 128 characters');
  }
  
  // Check for reserved names (Windows)
  const baseName = trimmed.split('.')[0].toUpperCase();
  if (RESERVED_NAMES_WINDOWS.includes(baseName)) {
    throw new Error(`"${trimmed}" is a reserved folder name`);
  }
  
  // Remove dangerous characters
  let sanitized = trimmed.replace(/[\/\\<>:|"?*\x00-\x1f]/g, '_');
  
  // Prevent directory traversal
  sanitized = sanitized.replace(/\.{2,}/g, '_'); // Replace .. with _
  
  return sanitized;
}

// Update handler with validation
ipcMain.handle('sync:folders:add', requireAuth(async (_e, { localPath, driveFolderName }) => {
  try {
    const sanitized = sanitizeDriveFolderName(driveFolderName || path.basename(localPath));
    // ... rest of handler
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Invalid folder name' };
  }
}));
```

---

### 6. **MEDIUM: Sync Drive Operations Without Rate Limiting** (SEVERITY: MEDIUM)
**File:** `src/modules/sync.ts:251-469`  
**Issues:**
- No rate limiting on Drive API calls (could hit quota limits)
- `syncFolder()` can be called repeatedly without backoff
- No exponential backoff on API errors
- Drive API quota not tracked or managed
- Large file uploads/downloads not resumable

**Fix Required:**
- Add request debouncing/throttling
- Implement exponential backoff for API errors (3 retries, 1s/2s/4s delays)
- Track and respect Drive API quota
- Add file size validation (e.g., max 100MB per file)

---

### 7. **MEDIUM: Session Token Timing Attack** (SEVERITY: MEDIUM)
**File:** `src/modules/auth.ts:26-42`  
**Current Code:**
```typescript
function validateToken(token: string): boolean {
  if (!_sessionToken) return false;
  if (typeof token !== 'string' || token.length !== 64) return false;
  try {
    const a = Buffer.from(token, 'hex');
    const b = Buffer.from(_sessionToken, 'hex');
    if (a.length !== b.length) return false;  // ← Length check is non-constant time
    if (!crypto.timingSafeEqual(a, b)) return false;
    // ...
  } catch {
    return false;
  }
}
```

**Issue:**
- Length check happens before timing-safe equal
- Leaks that buffer lengths differ in non-constant time

**Fix:**
```typescript
function validateToken(token: string): boolean {
  if (!_sessionToken) return false;
  if (typeof token !== 'string' || token.length !== 64) return false;
  try {
    const a = token.length === 64 ? Buffer.from(token, 'hex') : Buffer.alloc(32);
    const b = Buffer.from(_sessionToken, 'hex');
    // Timing-safe comparison regardless of length
    const match = crypto.timingSafeEqual(a, b);
    if (!match) return false;
    if (Date.now() - _sessionTokenCreated > SESSION_TOKEN_MAX_AGE) {
      _sessionToken = null;
      return false;
    }
    return true;
  } catch {
    return false;
  }
}
```

---

### 8. **MEDIUM: Hardcoded Admin Email** (SEVERITY: MEDIUM)
**File:** `src/modules/auth.ts:5`  
**Current Code:**
```typescript
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'ysmagri@gmail.com';
```

**Issues:**
- Fallback email is hardcoded
- If deployed without env var, default admin email grants full access
- Should fail-fast if not configured

**Fix:**
```typescript
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
if (!ADMIN_EMAIL) {
  throw new Error('ADMIN_EMAIL environment variable must be set in production');
}
```

---

### 9. **MEDIUM: Drive Settings Encoding Mismatch** (SEVERITY: MEDIUM)
**File:** `src/modules/drive.ts:647-650, 649`  
**Current Code:**
```typescript
async saveSettings(settings: Record<string, unknown>): Promise<void> {
  this.cache.settings = settings;
  const content = Buffer.from(JSON.stringify(settings, null, 2), 'utf8').toString('base64');
  
  if (!this.drive) {
    cache.saveCache(this.cache);
    return;
  }
  
  const fileId = this.fileIdCache.get(SETTINGS_FILE_NAME);
  if (fileId) {
    await this.drive.files.update({
      fileId,
      media: { mimeType: 'application/json', body: content },  // ← body is base64, but not handled on read
    });
```

**Issue:**
- Settings saved as base64-encoded JSON
- When read (line 639), decoded as UTF-8 directly without base64 decode
- Breaks settings persistence

**Fix:**
```typescript
async saveSettings(settings: Record<string, unknown>): Promise<void> {
  this.cache.settings = settings;
  // DON'T encode to base64 — send JSON directly
  const content = JSON.stringify(settings, null, 2);
  
  if (!this.drive) {
    cache.saveCache(this.cache);
    return;
  }
  
  const fileId = this.fileIdCache.get(SETTINGS_FILE_NAME);
  if (fileId) {
    await this.drive.files.update({
      fileId,
      media: { mimeType: 'application/json', body: content },
    });
  } else {
    const subfolderId = await this.ensureSubfolder(SUBFOLDERS.settings);
    const created = await this.drive.files.create({
      requestBody: {
        name: SETTINGS_FILE_NAME,
        parents: [subfolderId],
        mimeType: 'application/json',
      },
      media: { mimeType: 'application/json', body: content },
      fields: 'id',
    });
    if (created.data.id) {
      this.fileIdCache.set(SETTINGS_FILE_NAME, created.data.id);
    }
  }
  cache.saveCache(this.cache);
}
```

---

### 10. **MEDIUM: PIN Rate Limiting Only In-Memory** (SEVERITY: MEDIUM)
**File:** `src/modules/pin.ts:59-89`  
**Issues:**
- Rate limit state reset on app restart
- Attacker can restart app to bypass rate limiting
- 4-digit PIN (10,000 attempts max) is feasible with app restarts

**Fix Required:**
- Persist rate limit state to disk
- Load on startup
- Use persistent lockout across app restarts

---

### 11. **MEDIUM: No Content-Length Validation on Sync File Downloads** (SEVERITY: MEDIUM)
**File:** `src/modules/sync.ts:508-514`  
**Current Code:**
```typescript
private async downloadFile(fileId: string, localPath: string): Promise<void> {
  const drive = (this.drive as any).drive;
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
  const dir = path.dirname(localPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(localPath, Buffer.from(res.data as ArrayBuffer));  // ← No size check
}
```

**Issues:**
- No file size validation before download
- Could download gigabytes of data unexpectedly
- No temp file handling — partial writes on failure

**Fix:**
```typescript
private async downloadFile(fileId: string, localPath: string): Promise<void> {
  const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB limit
  
  const drive = (this.drive as any).drive;
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
  
  const data = Buffer.from(res.data as ArrayBuffer);
  if (data.length > MAX_FILE_SIZE) {
    throw new Error(`File size ${data.length} exceeds maximum ${MAX_FILE_SIZE}`);
  }
  
  const dir = path.dirname(localPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  
  // Write to temp file first
  const tempPath = `${localPath}.tmp`;
  fs.writeFileSync(tempPath, data);
  
  // Atomic rename
  fs.renameSync(tempPath, localPath);
}
```

---

### 12. **MEDIUM: Incomplete Error Handling in Sync Conflict Resolution** (SEVERITY: MEDIUM)
**File:** `src/modules/sync.ts:326-382`  
**Issues:**
- Errors in conflict resolution don't prevent continuing
- Could lead to data loss if rename fails
- No atomicity guarantees

---

### 13. **LOW-MEDIUM: Preload Token Stored in Global Scope** (SEVERITY: LOW-MEDIUM)
**File:** `preload.ts:3-12`  
**Issue:**
- Session token in global scope vulnerable to XSS
- Though contextIsolation=true reduces risk

---

## Bugs (Non-Security)

### BUG 1: OAuth Direct Redirect (Line 289, 326)
**File:** `src/main.ts:289, 326`  
**Issue:** OAuth flow opens Google auth directly instead of showing intermediate page.  
**Status:** Already fixed in latest commit ✅

### BUG 2: Avatar Query Parameter Stripping
**Status:** Already fixed in latest commit ✅

### BUG 3: Modal Blur Implementation
**Status:** Already fixed in latest commit ✅

---

## Summary of Fixes Required

| # | Severity | Issue | File | Priority |
|---|----------|-------|------|----------|
| 1 | CRITICAL | Weak key derivation | crypto.ts | FIX FIRST |
| 2 | HIGH | OAuth state race condition | main.ts | FIX FIRST |
| 3 | HIGH | PIN timing attack | pin.ts | FIX SECOND |
| 4 | HIGH | Path traversal in sync | sync.ts | FIX SECOND |
| 5 | HIGH | Sync folder name validation | sync.ts | FIX SECOND |
| 6 | MEDIUM | No sync rate limiting | sync.ts | FIX THIRD |
| 7 | MEDIUM | Token timing attack | auth.ts | FIX THIRD |
| 8 | MEDIUM | Hardcoded admin email | auth.ts | FIX THIRD |
| 9 | MEDIUM | Settings encoding bug | drive.ts | FIX THIRD |
| 10 | MEDIUM | In-memory rate limit | pin.ts | FIX THIRD |
| 11 | MEDIUM | No file size validation | sync.ts | FIX THIRD |
| 12 | MEDIUM | Sync conflict errors | sync.ts | FIX THIRD |
| 13 | LOW-MEDIUM | Preload token exposure | preload.ts | NICE-TO-FIX |

---

## Instructions for Claude

Please:

1. **Acknowledge all 13 issues** — confirm you've identified them
2. **Provide complete code patches** for each fix (not just snippets)
3. **Maintain backward compatibility** where possible (especially data migrations)
4. **Add comprehensive error handling** and logging
5. **Update type definitions** if needed (`src/types/index.ts`, `preload.ts`)
6. **Test data migration paths** (e.g., upgrading key derivation on login)
7. **Create git patches or branch recommendations** for implementation order

**Implementation Order:**
1. Issues #1-2 (CRITICAL + HIGH)
2. Issues #3-5 (HIGH)
3. Issues #6-12 (MEDIUM)
4. Issue #13 (LOW-MEDIUM)

Please provide complete, production-ready code patches that can be applied directly to the repository.
