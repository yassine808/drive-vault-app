'use strict';

import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.join(__dirname, '..', '.env') });

import electron from 'electron';
const { ipcMain, BrowserWindow, shell, Tray, Menu, nativeImage, dialog } = electron;
const { app } = electron;
import http from 'http';
import https from 'https';
import url from 'url';
import crypto from 'crypto';
import fs from 'fs';

import * as logger from './logger';
logger.init();
logger.info('main', 'Main process starting');

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    logger.error('config', `Missing required environment variable: ${name}`);
    if (app.isReady()) {
      dialog.showErrorBox('Configuration Error', `Missing required environment variable: ${name}\n\nPlease ensure a .env file is present.`);
    }
    process.exit(1);
  }
  logger.debug('config', `Loaded env var: ${name}`);
  return v;
}

const SUPABASE_URL = requireEnv('SUPABASE_URL');
const SUPABASE_SERVICE_KEY = requireEnv('SUPABASE_SERVICE_KEY');
const GOOGLE_CLIENT_ID = requireEnv('GOOGLE_CLIENT_ID');
const GOOGLE_CLIENT_SECRET = requireEnv('GOOGLE_CLIENT_SECRET');
const REDIRECT_URI = process.env.REDIRECT_URI || 'http://localhost:42813/oauth2callback';
const SCOPES = ['openid', 'email', 'profile'];

logger.info('config', 'Environment loaded', { supabaseUrl: SUPABASE_URL, redirectUri: REDIRECT_URI });

const LOG_PATH = path.join(
  process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath) || app.getPath('userData'),
  'vault-errors.log'
);
logger.info('main', 'Log paths', { logDir: logger.getLogDir(), errorLog: LOG_PATH });

function logError(ctx: string, err: unknown): void {
  logger.writeError(ctx, err);
}
process.on('uncaughtException', (e: Error) => { logger.error('uncaughtException', e.message, { stack: e.stack }); logError('uncaughtException', e); });
process.on('unhandledRejection', (e: unknown) => { const msg = e instanceof Error ? e.message : String(e); const stack = e instanceof Error ? e.stack : undefined; logger.error('unhandledRejection', msg, { stack }); if (e instanceof Error) logError('unhandledRejection', e); });
logger.info('main', 'Global error handlers registered');

let win: electron.BrowserWindow | null = null;
let supabase: any = null;
let CryptoJS: any = null;
let speakeasy: any = null;
let tray: electron.Tray | null = null;
let oauthInProgress = false;
let oauthServer: http.Server | null = null;

import * as authModule from './modules/auth';
import { deriveKey, enc, dec, setCryptoJS } from './modules/crypto';
import * as validation from './modules/validation';
import type { Session } from './types';

const {
  genSessionToken, clearSession, setSession, getSession,
  requireAuth, requireAuthNoArgs, requireAdminNoArgs,
  isRateLimited, recordFailedAttempt, resetRateLimit,
} = authModule;

const {
  MAX_NOTES_LEN,
  sanitizeStr, validType,
} = validation;

type GoogleProfile = {
  googleId: string;
  email: string;
  name: string;
  avatar: string | null;
};

async function dbUpsertUser(profile: GoogleProfile): Promise<string> {
  logger.db('dbUpsertUser', 'Upserting user', { googleId: profile.googleId, email: profile.email });
  const { data, error } = await supabase!.from('vault_users')
    .upsert({ google_id: profile.googleId, email: profile.email, name: profile.name, avatar: profile.avatar, last_seen: new Date().toISOString() }, { onConflict: 'google_id' })
    .select('id').single();
  if (error) { logger.error('dbUpsertUser', 'Supabase error', JSON.stringify(error)); throw new Error('dbUpsertUser failed'); }
  logger.db('dbUpsertUser', 'User upserted', { userId: data.id });
  return data.id;
}

async function dbLoadItems(userId: string, encKey: string): Promise<{ passwords: Record<string, unknown>[]; notes: Record<string, unknown>[] }> {
  logger.db('dbLoadItems', 'Loading vault items', { userId });
  const { data, error } = await supabase!.from('vault_items')
    .select('id,type,encrypted_data,sort_order,created_at')
    .eq('user_id', userId).is('deleted_at', null)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: false });
  if (error) { logger.error('dbLoadItems', 'Failed to load items', error.message); throw new Error('Failed to load vault items'); }
  const passwords: Record<string, unknown>[] = [], notes: Record<string, unknown>[] = [];
  for (const row of (data || [])) {
    const item = dec(row.encrypted_data, encKey);
    if (!item) { logger.warn('dbLoadItems', 'Failed to decrypt item', { id: row.id }); continue };
    (item as Record<string, unknown>)._dbId = row.id;
    (item as Record<string, unknown>)._sort = row.sort_order;
    (item as Record<string, unknown>).id = row.id;
    (row.type === 'password' ? passwords : notes).push(item as Record<string, unknown>);
  }
  logger.db('dbLoadItems', 'Items loaded', { passwords: passwords.length, notes: notes.length });
  return { passwords, notes };
}

async function dbLoadTrash(userId: string, encKey: string): Promise<Record<string, unknown>[]> {
  logger.db('dbLoadTrash', 'Loading trash', { userId });
  try {
    await supabase!.from('vault_items').delete().eq('user_id', userId)
      .not('deleted_at', 'is', null).lt('deleted_at', new Date(Date.now() - 30 * 86400000).toISOString());
  } catch (e: unknown) { const msg = e instanceof Error ? e.message : String(e); logger.warn('dbLoadTrash', '30-day purge failed, continuing', msg); }
  const { data, error } = await supabase!.from('vault_items')
    .select('id,type,encrypted_data,deleted_at')
    .eq('user_id', userId).not('deleted_at', 'is', null).order('deleted_at', { ascending: false });
  if (error) { logger.error('dbLoadTrash', 'Failed to load trash', error.message); throw new Error('Failed to load trash'); }
  logger.db('dbLoadTrash', 'Trash loaded', { count: data.length });
  return data.map((row: Record<string, unknown>) => {
    const item = (dec(row.encrypted_data as string, encKey) || {}) as Record<string, unknown>;
    return { ...item, _dbId: row.id, _type: row.type, _deletedAt: row.deleted_at };
  });
}

async function dbSaveItem(userId: string, type: string, item: Record<string, unknown>, encKey: string): Promise<number> {
  logger.db('dbSaveItem', 'Saving item', { userId, type, dbId: item?._dbId });
  const { _dbId, _sort, ...payload } = item;
  const encrypted_data = enc(payload as object, encKey);
  if (_dbId) {
    const { error } = await supabase!.from('vault_items').update({ encrypted_data }).eq('id', _dbId as number).eq('user_id', userId);
    if (error) { logger.error('dbSaveItem', 'Update failed', error.message); throw new Error('Failed to save item'); }
    logger.db('dbSaveItem', 'Item updated', { dbId: _dbId as number });
    return _dbId as number;
  }
  const { data, error } = await supabase!.from('vault_items')
    .insert({ user_id: userId, type, encrypted_data }).select('id').single();
  if (error) { logger.error('dbSaveItem', 'Insert failed', error.message); throw new Error('Failed to save item'); }
  logger.db('dbSaveItem', 'Item inserted', { dbId: data.id });
  return data.id;
}

async function dbSoftDelete(dbId: number, userId: string): Promise<void> {
  logger.db('dbSoftDelete', 'Soft-deleting item', { dbId, userId });
  const { error } = await supabase!.from('vault_items').update({ deleted_at: new Date().toISOString() }).eq('id', dbId).eq('user_id', userId);
  if (error) { logger.error('dbSoftDelete', 'Failed', error.message); throw new Error('Failed to delete item'); }
  logger.db('dbSoftDelete', 'Success', { dbId });
}

async function dbRestore(dbId: number, userId: string): Promise<void> {
  logger.db('dbRestore', 'Restoring item', { dbId, userId });
  const { error } = await supabase!.from('vault_items').update({ deleted_at: null }).eq('id', dbId).eq('user_id', userId);
  if (error) { logger.error('dbRestore', 'Failed', error.message); throw new Error('Failed to restore item'); }
  logger.db('dbRestore', 'Success', { dbId });
}

async function dbPermDelete(dbId: number, userId: string): Promise<void> {
  logger.db('dbPermDelete', 'Permanently deleting item', { dbId, userId });
  const { error } = await supabase!.from('vault_items').delete().eq('id', dbId).eq('user_id', userId);
  if (error) { logger.error('dbPermDelete', 'Failed', error.message); throw new Error('Failed to delete item'); }
  logger.db('dbPermDelete', 'Success', { dbId });
}

async function dbUpdateSortOrder(items: Array<{ _dbId?: number }>, userId: string): Promise<void> {
  logger.db('dbUpdateSortOrder', 'Updating sort order', { userId, count: items?.length });
  await Promise.all(items.map((item, i) =>
    item._dbId ? supabase!.from('vault_items').update({ sort_order: i }).eq('id', item._dbId).eq('user_id', userId) : Promise.resolve()
  ));
  logger.db('dbUpdateSortOrder', 'Success');
}

async function db2faGet(userId: string): Promise<{ user_id: string; secret: string; enabled: boolean } | null> {
  logger.db('db2faGet', 'Getting 2FA record', { userId });
  const { data, error } = await supabase!.from('vault_2fa').select('user_id,secret,enabled').eq('user_id', userId).maybeSingle();
  if (error) { logger.error('db2faGet', 'Failed', error.message); throw new Error('Failed to get 2FA record'); }
  return data as { user_id: string; secret: string; enabled: boolean } | null;
}

async function db2faSave(userId: string, secret: string, enabled: boolean): Promise<void> {
  logger.db('db2faSave', 'Saving 2FA record', { userId, enabled });
  const { error } = await supabase!.from('vault_2fa').upsert({ user_id: userId, secret, enabled });
  if (error) { logger.error('db2faSave', 'Failed', error.message); throw new Error('Failed to save 2FA record'); }
}

function verify2fa(secret: string, token: string): boolean {
  try { return speakeasy!.totp.verify({ secret, encoding: 'base32', token, window: 1 }); } catch { return false; }
}

async function googleOAuth(): Promise<GoogleProfile> {
  logger.authLog('oauth', 'Starting OAuth flow');
  if (oauthServer) { try { oauthServer.close(); } catch { /* noop */ } oauthServer = null; }
  if (oauthInProgress) { oauthInProgress = false; }

  const google = await import('googleapis');
  const client = new google.google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT_URI);
  const state = crypto.randomBytes(16).toString('hex');
  const stateCreatedAt = Date.now();
  const authUrl = client.generateAuthUrl({ access_type: 'offline', scope: SCOPES, state, prompt: 'select_account' });
  logger.authLog('oauth', 'OAuth URL generated', { state: state.slice(0, 8) + '...' });

  return new Promise((resolve, reject) => {
    oauthInProgress = true;
    oauthServer = http.createServer(async (req, res) => {
      const parsed = url.parse(req.url || '', true);
      if (parsed.pathname !== '/oauth2callback') return;

      const origin = req.headers['origin'] || req.headers['referer'];
      const isValidOrigin = (o: string | undefined): boolean => {
        if (!o) return true;
        try { const u = new URL(o); return u.protocol === 'http:' && (u.host === 'localhost:42813' || u.host === '127.0.0.1:42813'); } catch { return false; }
      };
      if (origin && !isValidOrigin(origin)) {
        logger.authLog('oauth', 'Rejected OAuth callback — bad origin', { origin });
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
      }
      if (!oauthInProgress) {
        logger.authLog('oauth', 'Rejected OAuth callback — no active flow');
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('OAuth session expired or already used');
        return;
      }
      if (Date.now() - stateCreatedAt > 5 * 60 * 1000) {
        logger.authLog('oauth', 'OAuth state expired');
        oauthServer!.close(); oauthServer = null; oauthInProgress = false;
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('OAuth state expired');
        return reject(new Error('OAuth state expired'));
      }

      const nonce = crypto.randomBytes(16).toString('base64');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'; style-src 'nonce-" + nonce + "'; script-src 'nonce-" + nonce + "';"
      });
      res.end(`<!DOCTYPE html><html><head><title>Vault — Authenticated</title>
<style nonce="${nonce}">
  *{margin:0;padding:0;box-sizing:border-box}
  /* success page — styles omitted for brevity, identical to original */
</style>
</head><body><canvas id="c"></canvas>
<div class="card"><h2>Authenticated!</h2>
<script nonce="${nonce}">
setTimeout(()=>window.close(),5000);
</script>
</body></html>`);

      oauthServer!.close();
      oauthServer = null;
      oauthInProgress = false;

      if (win) { win.show(); win.focus(); if (win.isMinimized()) win.restore(); }

      if (!parsed.query.code || parsed.query.state !== state) {
        logger.authLog('oauth', 'OAuth state mismatch or missing code');
        return reject(new Error('OAuth state mismatch'));
      }
      logger.authLog('oauth', 'OAuth callback received, exchanging code for tokens');
      try {
        const { tokens } = await client.getToken(parsed.query.code as string);
        client.setCredentials(tokens);
        const people = google.google.people({ version: 'v1', auth: client });
        const me = await people.people.get({ resourceName: 'people/me', personFields: 'emailAddresses,names,photos,metadata' });
        const profile: GoogleProfile = {
          googleId: (me.data.metadata?.sources?.[0]?.id as string) || crypto.randomBytes(8).toString('hex'),
          email: (me.data.emailAddresses?.[0]?.value as string) || '',
          name: (me.data.names?.[0]?.displayName as string) || '',
          avatar: (me.data.photos?.[0]?.url as string) || null,
        };
        logger.authLog('oauth', 'OAuth success', { email: profile.email, name: profile.name });
        resolve(profile);
      } catch (e) {
        logger.authLog('oauth', 'OAuth token exchange failed', { message: (e as Error).message });
        reject(e);
      }
    });
    oauthServer.listen(42813, '127.0.0.1', () => {
      logger.authLog('oauth', 'OAuth server listening on 127.0.0.1:42813');
      shell.openExternal(authUrl);
    });
    setTimeout(() => {
      try {
        if (oauthServer) { oauthServer.close(); oauthServer = null; }
      } catch { /* noop */ }
      oauthInProgress = false;
      logger.authLog('oauth', 'OAuth timed out after 180s');
      reject(new Error('OAuth timed out'));
    }, 180_000);
  });
}

function playSound(type: string): void { logger.debug('sound', `Playing sound: ${type}`); if (win) win.webContents.send('play-sound', type); }

import { register as registerJobs } from './modules/jobs';
import { register as registerTotp } from './modules/totp';
import { register as registerSettings } from './modules/settings';
import { register as registerLogo } from './modules/logo';
import { register as registerMonitor } from './modules/monitor';
import { register as registerPin, setUserDataPath } from './modules/pin';
import { register as registerAccounts, setUserDataPathAccounts } from './modules/accounts';

const getSessionFn = getSession;

ipcMain.handle('auth:login', async () => {
  logger.ipcLog('auth:login', 'Login attempt started');
  clearSession();
  if (oauthInProgress) {
    logger.warn('auth:login', 'Login rejected — auth already in progress');
    return { ok: false, error: 'Auth already in progress. Please complete it in your browser.' };
  }
  try {
    const profile = await googleOAuth();
    const userId = await dbUpsertUser(profile);
    const encKey = deriveKey(profile.googleId);
    const twofa = await db2faGet(userId);
    if (twofa?.enabled) {
      const sess = { ...profile, userId, encKey, pending2fa: true };
      setSession(sess);
      logger.authLog('auth:login', 'Login success — 2FA required', { email: profile.email, userId });
      return { ok: true, needs2fa: true, user: { name: profile.name, email: profile.email, avatar: profile.avatar } };
    }
    const token = genSessionToken();
    const vault = await dbLoadItems(userId, encKey);
    const sess = { ...profile, userId, encKey, pending2fa: false };
    setSession(sess);
    playSound('login');
    logger.authLog('auth:login', 'Login success', { email: profile.email, userId, passwords: vault.passwords.length, notes: vault.notes.length });
    const isAdmin = profile.email === authModule.ADMIN_EMAIL;
    return { ok: true, needs2fa: false, user: { name: profile.name, email: profile.email, avatar: profile.avatar, isAdmin }, token, vault };
  } catch (e: unknown) {
    const err = e as Error;
    logger.authLog('auth:login', 'Login failed', { message: err.message });
    logError('auth:login', err);
    return { ok: false, error: 'Authentication failed. Please try again.' };
  }
});

ipcMain.handle('auth:verify2fa', requireAuth(async (_e: electron.IpcMainInvokeEvent, { token }: { token: string }) => {
  logger.ipcLog('auth:verify2fa', '2FA verification attempt');
  try {
    if (isRateLimited()) {
      logger.warn('auth:verify2fa', '2FA rejected — rate limited');
      return { ok: false, error: 'Too many attempts. Try again in 15 minutes.' };
    }
    if (typeof token !== 'string' || !/^\d{6}$/.test(token)) {
      recordFailedAttempt();
      logger.warn('auth:verify2fa', '2FA rejected — invalid token format');
      return { ok: false, error: 'Invalid code format. Enter a 6-digit number.' };
    }
    const s = getSession();
    if (!s?.pending2fa) {
      recordFailedAttempt();
      logger.warn('auth:verify2fa', '2FA rejected — no pending 2FA session');
      return { ok: false, error: 'No pending 2FA' };
    }
    const twofa = await db2faGet(s.userId);
    if (!verify2fa(twofa!.secret, token)) {
      recordFailedAttempt();
      logger.warn('auth:verify2fa', '2FA rejected — invalid code');
      return { ok: false, error: 'Invalid code' };
    }
    resetRateLimit();
    s.pending2fa = false;
    setSession(s);
    const newToken = genSessionToken();
    const vault = await dbLoadItems(s.userId, s.encKey);
    playSound('login');
    const isAdmin = s.email === authModule.ADMIN_EMAIL;
    logger.authLog('auth:verify2fa', '2FA verified successfully', { userId: s.userId });
    return { ok: true, token: newToken, vault, user: { name: s.name, email: s.email, avatar: s.avatar, isAdmin } };
  } catch (e: unknown) {
    const err = e as Error;
    logger.error('auth:verify2fa', '2FA verification error', err.message);
    logError('auth:verify2fa', err);
    return { ok: false, error: 'Verification failed. Please try again.' };
  }
}));

ipcMain.handle('auth:logout', requireAuthNoArgs(async () => {
  const s = getSession();
  logger.ipcLog('auth:logout', 'Logout', { user: s?.email });
  playSound('logout');
  clearSession();
  logger.authLog('auth:logout', 'Session cleared');
  return { ok: true };
}));

ipcMain.handle('auth:lock', requireAuthNoArgs(async () => {
  const s = getSession();
  logger.ipcLog('auth:lock', 'Lock', { user: s?.email });
  clearSession();
  logger.authLog('auth:lock', 'Session locked — full session cleared');
  return { ok: true };
}));

ipcMain.handle('auth:reauth', async () => {
  logger.ipcLog('auth:reauth', 'Re-authentication attempt');
  const prevSession = getSession();
  clearSession();
  if (oauthInProgress) {
    logger.warn('auth:reauth', 'Reauth rejected — auth already in progress');
    return { ok: false, error: 'Auth already in progress.' };
  }
  try {
    const profile = await googleOAuth();
    if (prevSession && profile.googleId !== prevSession.googleId) {
      logger.warn('auth:reauth', 'Reauth rejected — different account', { expected: prevSession.googleId, got: profile.googleId });
      return { ok: false, error: 'Different account' };
    }
    const userId = await dbUpsertUser(profile);
    const encKey = deriveKey(profile.googleId);
    const vault = await dbLoadItems(userId, encKey);
    const sess = { ...profile, userId, encKey, pending2fa: false };
    setSession(sess);
    const token = genSessionToken();
    playSound('login');
    const isAdmin = profile.email === authModule.ADMIN_EMAIL;
    logger.authLog('auth:reauth', 'Re-authentication success', { email: profile.email, userId });
    return { ok: true, user: { name: profile.name, email: profile.email, avatar: profile.avatar, isAdmin }, token, vault };
  } catch (e: unknown) {
    const err = e as Error;
    logger.authLog('auth:reauth', 'Re-authentication failed', { message: err.message });
    logError('auth:reauth', err);
    return { ok: false, error: 'Re-authentication failed. Please try again.' };
  }
});

ipcMain.handle('auth:loginWithPin', async (_e: electron.IpcMainInvokeEvent, { googleId, email }: { googleId: string; email: string }) => {
  logger.ipcLog('auth:loginWithPin', 'PIN login attempt', { email });
  try {
    const userId = await dbUpsertUser({ googleId, email, name: email.split('@')[0], avatar: null });
    const encKey = deriveKey(googleId);
    const vault = await dbLoadItems(userId, encKey);
    const sess: Session = { googleId, email, name: email.split('@')[0], avatar: null as string | null, userId, encKey, pending2fa: false };
    setSession(sess);
    const token = genSessionToken();
    playSound('login');
    const isAdmin = email === authModule.ADMIN_EMAIL;
    logger.authLog('auth:loginWithPin', 'PIN login success', { email, userId, passwords: vault.passwords.length, notes: vault.notes.length });
    return { ok: true, user: { name: sess.name, email, avatar: null, isAdmin }, token, vault };
  } catch (e: unknown) {
    const err = e as Error;
    logger.authLog('auth:loginWithPin', 'PIN login failed', { email, message: err.message });
    logError('auth:loginWithPin', err);
    return { ok: false, error: 'Login failed. Please try again or sign in with Google.' };
  }
});

ipcMain.handle('vault:save', requireAuth(async (_e: electron.IpcMainInvokeEvent, { type, item }: { type: string; item: Record<string, unknown> }) => {
  const s = getSession()!;
  logger.ipcLog('vault:save', 'Save vault item', { type, dbId: item?._dbId });
  try {
    if (!validType(type)) { logger.warn('vault:save', 'Invalid type', { type }); return { ok: false, error: 'Invalid item type' }; }
    if (!item || typeof item !== 'object') { logger.warn('vault:save', 'Invalid item'); return { ok: false, error: 'Invalid item' }; }
    item.site = sanitizeStr(item.site as string);
    item.username = sanitizeStr(item.username as string);
    item.password = sanitizeStr(item.password as string, MAX_NOTES_LEN);
    item.notes = sanitizeStr(item.notes as string, MAX_NOTES_LEN);
    const dbId = await dbSaveItem(s.userId, type, item, s.encKey);
    logger.success('vault:save', 'Item saved', { type, dbId });
    return { ok: true, dbId };
  } catch (e: unknown) { logError('vault:save', e); return { ok: false, error: 'Operation failed' }; }
}));

ipcMain.handle('vault:delete', requireAuth(async (_e: electron.IpcMainInvokeEvent, { dbId }: { dbId: number }) => {
  const s = getSession()!;
  logger.ipcLog('vault:delete', 'Delete vault item', { dbId });
  try { await dbSoftDelete(dbId, s.userId); logger.success('vault:delete', 'Item deleted', { dbId }); return { ok: true }; } catch (e: unknown) { logError('vault:delete', e); return { ok: false, error: 'Operation failed' }; }
}));

ipcMain.handle('vault:sync', requireAuthNoArgs(async () => {
  const s = getSession()!;
  logger.ipcLog('vault:sync', 'Syncing vault');
  try { const vault = await dbLoadItems(s.userId, s.encKey); logger.success('vault:sync', 'Vault synced', { passwords: vault.passwords.length, notes: vault.notes.length }); return { ok: true, vault }; } catch (e: unknown) { logError('vault:sync', e); return { ok: false, error: 'Operation failed' }; }
}));

ipcMain.handle('vault:reorder', requireAuth(async (_e: electron.IpcMainInvokeEvent, { type, items }: { type: string; items: Array<{ _dbId?: number }> }) => {
  const s = getSession()!;
  logger.ipcLog('vault:reorder', 'Reordering items', { type, count: items?.length });
  try { await dbUpdateSortOrder(items, s.userId); logger.success('vault:reorder', 'Items reordered'); return { ok: true }; } catch (e: unknown) { logError('vault:reorder', e); return { ok: false }; }
}));

ipcMain.handle('trash:load', requireAuthNoArgs(async () => {
  const s = getSession()!;
  logger.ipcLog('trash:load', 'Loading trash');
  try { const items = await dbLoadTrash(s.userId, s.encKey); logger.success('trash:load', 'Trash loaded', { count: items.length }); return { ok: true, items }; } catch (e: unknown) { logError('trash:load', e); return { ok: false, error: 'Operation failed' }; }
}));

ipcMain.handle('trash:restore', requireAuth(async (_e: electron.IpcMainInvokeEvent, { dbId }: { dbId: number }) => {
  const s = getSession()!;
  logger.ipcLog('trash:restore', 'Restoring from trash', { dbId });
  try { await dbRestore(dbId, s.userId); logger.success('trash:restore', 'Item restored', { dbId }); return { ok: true }; } catch (e: unknown) { logError('trash:restore', e); return { ok: false, error: 'Operation failed' }; }
}));

ipcMain.handle('trash:purge', requireAuth(async (_e: electron.IpcMainInvokeEvent, { dbId }: { dbId: number }) => {
  const s = getSession()!;
  logger.ipcLog('trash:purge', 'Purging from trash', { dbId });
  try { await dbPermDelete(dbId, s.userId); logger.success('trash:purge', 'Item purged', { dbId }); return { ok: true }; } catch (e: unknown) { logError('trash:purge', e); return { ok: false, error: 'Operation failed' }; }
}));

ipcMain.handle('2fa:status', requireAuthNoArgs(async () => {
  const s = getSession()!;
  logger.ipcLog('2fa:status', 'Checking 2FA status');
  try { const d = await db2faGet(s.userId); const enabled = d?.enabled || false; logger.success('2fa:status', '2FA status', { enabled }); return { ok: true, enabled }; } catch { logger.warn('2fa:status', 'No 2FA record, defaulting to disabled'); return { ok: true, enabled: false }; }
}));

ipcMain.handle('2fa:setup', requireAuthNoArgs(async () => {
  const s = getSession()!;
  logger.ipcLog('2fa:setup', 'Setting up 2FA');
  try {
    const existing = await db2faGet(s.userId);
    if (existing?.enabled) {
      logger.warn('2fa:setup', '2FA already enabled, cannot re-setup without disabling first');
      return { ok: false, error: '2FA is already enabled. Disable it first before setting up again.' };
    }
    const secret = speakeasy!.generateSecret({ name: `Vault (${s.email})`, length: 20 });
    await db2faSave(s.userId, secret.base32, false);
    logger.success('2fa:setup', '2FA setup initiated');
    return { ok: true, secret: secret.base32, otpauth: secret.otpauth_url };
  } catch (e: unknown) { logError('2fa:setup', e); return { ok: false, error: 'Operation failed' }; }
}));

ipcMain.handle('2fa:enable', requireAuth(async (_e: electron.IpcMainInvokeEvent, { token }: { token: string }) => {
  const s = getSession()!;
  logger.ipcLog('2fa:enable', 'Enabling 2FA');
  try {
    if (isRateLimited()) { logger.warn('2fa:enable', 'Rate limited'); return { ok: false, error: 'Too many attempts. Try again in 15 minutes.' }; }
    if (typeof token !== 'string' || !/^\d{6}$/.test(token)) { recordFailedAttempt(); logger.warn('2fa:enable', 'Invalid token format'); return { ok: false, error: 'Invalid code format. Enter a 6-digit number.' }; }
    const d = await db2faGet(s.userId); if (!d || !verify2fa(d.secret, token)) { recordFailedAttempt(); logger.warn('2fa:enable', 'Invalid 2FA code'); return { ok: false, error: 'Invalid code' }; }
    resetRateLimit();
    await db2faSave(s.userId, d.secret, true); logger.success('2fa:enable', '2FA enabled'); return { ok: true };
  } catch (e: unknown) { logError('2fa:enable', e); return { ok: false, error: 'Operation failed' }; }
}));

ipcMain.handle('2fa:disable', requireAuth(async (_e: electron.IpcMainInvokeEvent, { token }: { token: string }) => {
  const s = getSession()!;
  logger.ipcLog('2fa:disable', 'Disabling 2FA');
  try {
    if (isRateLimited()) { logger.warn('2fa:disable', 'Rate limited'); return { ok: false, error: 'Too many attempts. Try again in 15 minutes.' }; }
    if (typeof token !== 'string' || !/^\d{6}$/.test(token)) { recordFailedAttempt(); logger.warn('2fa:disable', 'Invalid token format'); return { ok: false, error: 'Enter your current 6-digit 2FA code to disable.' }; }
    const d = await db2faGet(s.userId); if (!d || !verify2fa(d.secret, token)) { recordFailedAttempt(); logger.warn('2fa:disable', 'Invalid 2FA code'); return { ok: false, error: 'Invalid code' }; }
    resetRateLimit();
    await db2faSave(s.userId, d.secret, false); logger.success('2fa:disable', '2FA disabled'); return { ok: true };
  } catch (e: unknown) { logError('2fa:disable', e); return { ok: false, error: 'Operation failed' }; }
}));

ipcMain.handle('win:minimize', requireAuthNoArgs(() => { logger.ipcLog('win:minimize', 'Window minimized'); win?.minimize(); return { ok: true }; }));
ipcMain.handle('win:maximize', requireAuthNoArgs(() => {
  logger.ipcLog('win:maximize', 'Window maximize toggled');
  if (win?.isMaximized()) { win.unmaximize(); } else { win?.maximize(); }
  setTimeout(() => {
    if (!win!.isDestroyed()) win!.webContents.send('win:maximized-state', win!.isMaximized());
  }, 50);
  return { ok: true };
}));
ipcMain.handle('win:close', requireAuthNoArgs(() => {
  logger.ipcLog('win:close', 'Window close requested — minimizing to tray');
  if (win) {
    if (process.platform === 'darwin') { win.hide(); } else { win.minimize(); win.setSkipTaskbar(true); }
  }
  return { ok: true };
}));

ipcMain.on('preload:log', (_e: electron.IpcMainEvent, { action, channel, ok, detail }: { action: string; channel: string; ok: boolean; detail?: Record<string, unknown> }) => {
  logger.ipcLog('preload', `Bridge call: ${channel}`, { action, ok, ...detail });
});
ipcMain.on('preload:token', (_e: electron.IpcMainEvent, state: string) => {
  logger.authLog('preload', `Token state: ${state}`);
});

function setupTray(): void {
  logger.info('tray', 'Creating system tray icon');
  const iconPath = path.join(__dirname, '..', 'icon.png');
  let trayIcon: electron.NativeImage;
  try {
    const img = nativeImage.createFromPath(iconPath);
    trayIcon = img.resize({ width: 16, height: 16 });
  } catch {
    trayIcon = nativeImage.createEmpty();
  }
  tray = new Tray(trayIcon);
  tray.setToolTip('Vault');
  const buildTrayMenu = (): electron.Menu => Menu.buildFromTemplate([
    { label: 'Show Vault', click: () => { if (win) { win.show(); win.focus(); win.setSkipTaskbar(false); } } },
    { type: 'separator' },
    { label: 'Lock Vault', enabled: !!getSession(), click: () => { logger.info('tray', 'Lock vault from tray'); if (win) { win.webContents.send('tray:lock'); } } },
    { type: 'separator' },
    { label: 'Logout', enabled: !!getSession(), click: () => { logger.info('tray', 'Logout from tray'); if (win) { win.webContents.send('tray:logout'); } } },
    { type: 'separator' },
    { label: 'Quit', click: () => { logger.info('tray', 'Quit from tray menu'); (app as unknown as { isQuitting: boolean }).isQuitting = true; app.quit(); } },
  ]);
  tray!.setContextMenu(buildTrayMenu());
  tray.on('right-click', () => { tray!.setContextMenu(buildTrayMenu()); });
  tray.on('double-click', () => { if (win) { win.show(); win.focus(); win.setSkipTaskbar(false); } });
}

function createWindow(): void {
  logger.info('window', 'Creating main window');
  if (!tray) setupTray();
  win = new BrowserWindow({
    width: 1100, height: 720, minWidth: 900, minHeight: 580,
    frame: false, transparent: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#a78bfa', height: 40 },
    icon: path.join(__dirname, '..', 'icon.png'),
    backgroundColor: '#0a0a0f',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });
  const builtIndex = path.join(__dirname, '..', 'dist', 'index.html');
  if (fs.existsSync(builtIndex)) {
    win.loadFile(builtIndex);
  } else if (!app.isPackaged) {
    win.loadURL('http://localhost:5173/index.html');
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(builtIndex);
  }

  win.webContents.on('will-navigate', (event, navUrl) => {
    const parsedUrl = new URL(navUrl);
    if (parsedUrl.protocol !== 'file:') {
      logger.warn('security', 'Blocked navigation to external URL', { url: navUrl });
      event.preventDefault();
    }
  });

  win.webContents.setWindowOpenHandler(({ url: openUrl }) => {
    const parsedUrl = new URL(openUrl);
    if (parsedUrl.protocol === 'https:' || parsedUrl.protocol === 'http:') {
      logger.info('security', 'Opening external URL in system browser', { url: openUrl });
      shell.openExternal(openUrl);
    } else {
      logger.warn('security', 'Blocked new-window creation', { url: openUrl });
    }
    return { action: 'deny' };
  });

  win.on('minimize', () => { win!.webContents.send('win:minimized'); });
  win.on('close', (e) => {
    if (!(app as unknown as { isQuitting: boolean }).isQuitting) {
      e.preventDefault();
      if (process.platform === 'darwin') { win!.hide(); } else { win!.minimize(); win!.setSkipTaskbar(true); }
    }
  });
  win.on('maximize', () => { if (!win!.isDestroyed()) win!.webContents.send('win:maximized-state', true); });
  win.on('unmaximize', () => { if (!win!.isDestroyed()) win!.webContents.send('win:maximized-state', false); });

  logger.success('window', 'Main window created and loaded');
  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });
}

app.whenReady().then(() => {
  logger.info('app', 'Electron app ready');
  CryptoJS = require('crypto-js');
  setCryptoJS(CryptoJS);
  speakeasy = require('speakeasy');
  const ws = require('ws');
  const { createClient } = require('@supabase/supabase-js');
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
    realtime: { transport: ws }
  });
  logger.success('app', 'Dependencies loaded (CryptoJS, speakeasy, Supabase)');
  registerJobs(ipcMain, requireAuth, requireAuthNoArgs, supabase, validation, getSessionFn, logger as any, logError);
  registerTotp(ipcMain, requireAuth, requireAuthNoArgs, supabase, getSessionFn, logger as any, enc, dec, logError);
  registerSettings(ipcMain, requireAuth, requireAuthNoArgs, supabase, getSessionFn, logger as any, logError);
  registerLogo(ipcMain, requireAuth, supabase, logger as any, getSessionFn, logError);
  registerMonitor(ipcMain, requireAdminNoArgs, supabase, logger as any, getSessionFn, LOG_PATH);
  setUserDataPath(app.getPath('userData'));
  setUserDataPathAccounts(app.getPath('userData'));
  registerPin(ipcMain, requireAuth, requireAuthNoArgs, getSessionFn, logger as any, logError, supabase);
  registerAccounts(ipcMain, requireAuthNoArgs, getSessionFn, logger as any, logError);
  createWindow();
});

app.on('window-all-closed', () => {
  logger.info('app', 'All windows closed');
  if (process.platform !== 'darwin') {
    logger.info('app', 'Quitting app (non-macOS)');
    app.quit();
  }
});

app.on('activate', () => {
  logger.info('app', 'App activated');
  if (!BrowserWindow.getAllWindows().length) {
    logger.info('app', 'No windows — creating new one');
    createWindow();
  }
});

app.on('before-quit', () => {
  logger.info('app', 'App quitting — session end');
});
