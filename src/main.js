'use strict';

// Load .env before anything else
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path   = require('path');
const http   = require('http');
const url    = require('url');
const crypto = require('crypto');
const fs     = require('fs');

// ─── LOGGER (must be first — before config so we can log config errors) ───────
const logger = require('./logger');
logger.init();
logger.info('main', 'Main process starting');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    logger.error('config', `Missing required environment variable: ${name}`);
    if (app.isReady()) {
      const { dialog } = require('electron');
      dialog.showErrorBox('Configuration Error', `Missing required environment variable: ${name}\n\nPlease ensure a .env file is present.`);
    }
    process.exit(1);
  }
  logger.debug('config', `Loaded env var: ${name}`);
  return v;
}

const SUPABASE_URL         = requireEnv('SUPABASE_URL');
const SUPABASE_SERVICE_KEY = requireEnv('SUPABASE_SERVICE_KEY');
const GOOGLE_CLIENT_ID     = requireEnv('GOOGLE_CLIENT_ID');
const GOOGLE_CLIENT_SECRET = requireEnv('GOOGLE_CLIENT_SECRET');
const REDIRECT_URI         = process.env.REDIRECT_URI || 'http://localhost:42813/oauth2callback';
const SCOPES               = ['openid', 'email', 'profile'];

logger.info('config', 'Environment loaded', { supabaseUrl: SUPABASE_URL, redirectUri: REDIRECT_URI });

// ─── LOG PATH (legacy error log — kept for backward compat) ──────────────────
const LOG_PATH = path.join(
  process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath) || app.getPath('userData'),
  'vault-errors.log'
);
logger.info('main', 'Log paths', { logDir: logger.getLogDir(), errorLog: LOG_PATH });

// ─── LEGACY logError (routes through logger) ─────────────────────────────────
function logError(ctx, err) {
  logger.writeError(ctx, err);
}
process.on('uncaughtException',  e => { logger.error('uncaughtException', e.message, { stack: e.stack }); logError('uncaughtException', e); });
process.on('unhandledRejection', e => { logger.error('unhandledRejection', e?.message || String(e), { stack: e?.stack }); logError('unhandledRejection', e); });
logger.info('main', 'Global error handlers registered');

// ─── STATE ────────────────────────────────────────────────────────────────────
let win, supabase, CryptoJS, speakeasy;
let session = null;
let sessionToken = null;
let oauthInProgress = false;
let oauthServer = null;

// ─── SESSION TOKEN ────────────────────────────────────────────────────────────
function genSessionToken() {
  const t = crypto.randomBytes(32).toString('hex');
  logger.auth('session', 'Generated new session token');
  return t;
}
function validateToken(token) {
  const valid = token && token === sessionToken;
  if (!valid) logger.auth('session', 'Token validation failed');
  else logger.debug('session', 'Token validated successfully');
  return valid;
}

// ─── IPC AUTH WRAPPERS ───────────────────────────────────────────────────────
function requireAuth(fn) {
  return async (event, token, ...args) => {
    if (!validateToken(token)) {
      logger.warn('auth', 'requireAuth: rejected unauthenticated call');
      return { ok: false, error: 'Not authenticated' };
    }
    return fn(event, ...args);
  };
}
function requireAuthNoArgs(fn) {
  return async (event, token) => {
    if (!validateToken(token)) {
      logger.warn('auth', 'requireAuthNoArgs: rejected unauthenticated call');
      return { ok: false, error: 'Not authenticated' };
    }
    return fn(event);
  };
}

// ─── INPUT VALIDATION ─────────────────────────────────────────────────────────
const MAX_FIELD_LEN = 500;
const MAX_NOTES_LEN = 5000;
const VALID_ITEM_TYPES = ['password', 'note'];
function sanitizeStr(s, max=MAX_FIELD_LEN) { return String(s||'').trim().slice(0,max); }
function validType(t) { return VALID_ITEM_TYPES.includes(t); }
function validEmail(e) { return /^[^\s@]{1,128}@[^\s@]{1,256}\.[^\s@]{2,}$/.test(String(e||'')); }
function validTotpSecret(s) { return /^[A-Z2-7]{16,64}$/.test(String(s||'').replace(/\s/g,'')); }

// ─── 2FA RATE LIMITER ─────────────────────────────────────────────────────────
const rateLimit = {
  attempts: [],
  lockoutUntil: 0,
  MAX_ATTEMPTS: 5,
  WINDOW_MS: 15 * 60 * 1000,
  LOCKOUT_MS: 15 * 60 * 1000,
};
function isRateLimited() {
  const now = Date.now();
  if (now < rateLimit.lockoutUntil) {
    logger.warn('2fa', 'Rate limited — lockout active', { lockoutUntil: rateLimit.lockoutUntil });
    return true;
  }
  rateLimit.attempts = rateLimit.attempts.filter(t => now - t < rateLimit.WINDOW_MS);
  if (rateLimit.attempts.length >= rateLimit.MAX_ATTEMPTS) {
    logger.warn('2fa', 'Rate limited — too many attempts', { count: rateLimit.attempts.length });
    return true;
  }
  return false;
}
function recordFailedAttempt() {
  const now = Date.now();
  rateLimit.attempts.push(now);
  if (rateLimit.attempts.length >= rateLimit.MAX_ATTEMPTS) {
    rateLimit.lockoutUntil = now + rateLimit.LOCKOUT_MS;
    logger.warn('2fa', 'Lockout triggered', { attempts: rateLimit.attempts.length, lockoutMs: rateLimit.LOCKOUT_MS });
  }
}
function resetRateLimit() { rateLimit.attempts = []; rateLimit.lockoutUntil = 0; }

// ─── CRYPTO ───────────────────────────────────────────────────────────────────
function deriveKey(googleId) {
  // Must stay as SHA-256 truncated to 32 hex chars — this is what all existing
  // encrypted data was encrypted with. Changing this will make all data unreadable.
  return crypto.createHash('sha256').update('vault:' + googleId).digest('hex').slice(0, 32);
}
function enc(obj, key) { return CryptoJS.AES.encrypt(JSON.stringify(obj), key).toString(); }
function dec(str, key) { try { return JSON.parse(CryptoJS.AES.decrypt(str,key).toString(CryptoJS.enc.Utf8)); } catch { return null; } }

// ─── DB HELPERS ───────────────────────────────────────────────────────────────
async function dbUpsertUser({ googleId, email, name, avatar }) {
  logger.db('dbUpsertUser', 'Upserting user', { googleId, email });
  const { data, error } = await supabase.from('vault_users')
    .upsert({ google_id:googleId, email, name, avatar, last_seen:new Date().toISOString() },{ onConflict:'google_id' })
    .select('id').single();
  if (error) { logger.error('dbUpsertUser', 'Supabase error', JSON.stringify(error)); throw new Error('dbUpsertUser failed: ' + error.message + ' | code: ' + error.code + ' | details: ' + error.details + ' | hint: ' + error.hint); }
  logger.db('dbUpsertUser', 'User upserted', { userId: data.id });
  return data.id;
}

async function dbLoadItems(userId, encKey) {
  logger.db('dbLoadItems', 'Loading vault items', { userId });
  const { data, error } = await supabase.from('vault_items')
    .select('id,type,encrypted_data,sort_order,created_at')
    .eq('user_id', userId).is('deleted_at', null)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: false });
  if (error) { logger.error('dbLoadItems', 'Failed to load items', error.message); throw error; }
  const passwords=[], notes=[];
  for (const row of data) {
    const item = dec(row.encrypted_data, encKey);
    if (!item) continue;
    item._dbId = row.id; item._sort = row.sort_order;
    (row.type==='password' ? passwords : notes).push(item);
  }
  logger.db('dbLoadItems', 'Items loaded', { passwords: passwords.length, notes: notes.length });
  return { passwords, notes };
}

async function dbLoadTrash(userId, encKey) {
  logger.db('dbLoadTrash', 'Loading trash', { userId });
  await supabase.from('vault_items').delete().eq('user_id', userId)
    .not('deleted_at','is',null).lt('deleted_at', new Date(Date.now()-30*86400000).toISOString());
  const { data, error } = await supabase.from('vault_items')
    .select('id,type,encrypted_data,deleted_at')
    .eq('user_id', userId).not('deleted_at','is',null).order('deleted_at',{ascending:false});
  if (error) { logger.error('dbLoadTrash', 'Failed to load trash', error.message); throw error; }
  logger.db('dbLoadTrash', 'Trash loaded', { count: data.length });
  return data.map(row => {
    const item = dec(row.encrypted_data, encKey) || {};
    return { ...item, _dbId:row.id, _type:row.type, _deletedAt:row.deleted_at };
  });
}

async function dbSaveItem(userId, type, item, encKey) {
  logger.db('dbSaveItem', 'Saving item', { userId, type, dbId: item?._dbId });
  const { _dbId, _sort, ...payload } = item;
  const encrypted_data = enc(payload, encKey);
  if (_dbId) {
    const { error } = await supabase.from('vault_items').update({ encrypted_data }).eq('id',_dbId).eq('user_id',userId);
    if (error) { logger.error('dbSaveItem', 'Update failed', error.message); throw error; }
    logger.db('dbSaveItem', 'Item updated', { dbId: _dbId });
    return _dbId;
  }
  const { data, error } = await supabase.from('vault_items')
    .insert({ user_id:userId, type, encrypted_data }).select('id').single();
  if (error) { logger.error('dbSaveItem', 'Insert failed', error.message); throw error; }
  logger.db('dbSaveItem', 'Item inserted', { dbId: data.id });
  return data.id;
}

async function dbSoftDelete(dbId, userId) {
  logger.db('dbSoftDelete', 'Soft-deleting item', { dbId, userId });
  const { error } = await supabase.from('vault_items').update({ deleted_at:new Date().toISOString() }).eq('id',dbId).eq('user_id',userId);
  if (error) { logger.error('dbSoftDelete', 'Failed', error.message); throw error; }
  logger.db('dbSoftDelete', 'Success', { dbId });
}
async function dbRestore(dbId, userId) {
  logger.db('dbRestore', 'Restoring item', { dbId, userId });
  const { error } = await supabase.from('vault_items').update({ deleted_at:null }).eq('id',dbId).eq('user_id',userId);
  if (error) { logger.error('dbRestore', 'Failed', error.message); throw error; }
  logger.db('dbRestore', 'Success', { dbId });
}
async function dbPermDelete(dbId, userId) {
  logger.db('dbPermDelete', 'Permanently deleting item', { dbId, userId });
  const { error } = await supabase.from('vault_items').delete().eq('id',dbId).eq('user_id',userId);
  if (error) { logger.error('dbPermDelete', 'Failed', error.message); throw error; }
  logger.db('dbPermDelete', 'Success', { dbId });
}
async function dbUpdateSortOrder(items, userId) {
  logger.db('dbUpdateSortOrder', 'Updating sort order', { userId, count: items?.length });
  await Promise.all(items.map((item, i) =>
    item._dbId ? supabase.from('vault_items').update({ sort_order: i }).eq('id',item._dbId).eq('user_id',userId) : Promise.resolve()
  ));
  logger.db('dbUpdateSortOrder', 'Success');
}

// ── Logo ──────────────────────────────────────────────────────────────────────
async function fetchLogo(site) {
  logger.db('fetchLogo', 'Fetching logo', { site });
  try {
    let domain = site.replace(/^https?:\/\//,'').replace(/\/.*$/,'').toLowerCase();
    if (!domain.includes('.')) domain += '.com';
    const { data } = await supabase.from('vault_logos').select('url').eq('domain',domain).single();
    if (data) { logger.db('fetchLogo', 'Logo from cache', { domain, url: data.url }); return data.url; }
    const faviconUrl = `https://www.google.com/s2/favicons?sz=64&domain=${domain}`;
    await supabase.from('vault_logos').upsert({ domain, url:faviconUrl, cached_at:new Date().toISOString() });
    logger.db('fetchLogo', 'Logo fetched and cached', { domain, url: faviconUrl });
    return faviconUrl;
  } catch (e) { logger.warn('fetchLogo', 'Failed to fetch logo', { site, error: e?.message }); return null; }
}

// ── Jobs ──────────────────────────────────────────────────────────────────────
async function dbLoadJobs(userId) {
  logger.db('dbLoadJobs', 'Loading jobs', { userId });
  const { data, error } = await supabase.from('vault_jobs').select('*')
    .eq('user_id',userId).is('deleted_at',null)
    .order('sort_order',{ascending:true}).order('created_at',{ascending:false});
  if (error) { logger.error('dbLoadJobs', 'Failed', error.message); throw error; }
  logger.db('dbLoadJobs', 'Jobs loaded', { count: data.length });
  return data;
}
async function dbSaveJob(userId, job) {
  logger.db('dbSaveJob', 'Saving job', { userId, jobId: job?.id, company: job?.company });
  const { id, ...payload } = job;
  if (id) {
    const { error } = await supabase.from('vault_jobs')
      .update({ ...payload, updated_at:new Date().toISOString() }).eq('id',id).eq('user_id',userId);
    if (error) { logger.error('dbSaveJob', 'Update failed', error.message); throw error; }
    logger.db('dbSaveJob', 'Job updated', { jobId: id });
    return id;
  }
  const { data, error } = await supabase.from('vault_jobs')
    .insert({ user_id:userId, ...payload }).select('id').single();
  if (error) { logger.error('dbSaveJob', 'Insert failed', error.message); throw error; }
  logger.db('dbSaveJob', 'Job inserted', { jobId: data.id });
  return data.id;
}
async function dbDeleteJob(id, userId) {
  logger.db('dbDeleteJob', 'Soft-deleting job', { jobId: id, userId });
  const { error } = await supabase.from('vault_jobs')
    .update({ deleted_at: new Date().toISOString() }).eq('id',id).eq('user_id',userId);
  if (error) { logger.error('dbDeleteJob', 'Failed', error.message); throw error; }
  logger.db('dbDeleteJob', 'Success', { jobId: id });
}
async function dbRestoreJob(id, userId) {
  logger.db('dbRestoreJob', 'Restoring job', { jobId: id, userId });
  const { error } = await supabase.from('vault_jobs')
    .update({ deleted_at: null }).eq('id',id).eq('user_id',userId);
  if (error) { logger.error('dbRestoreJob', 'Failed', error.message); throw error; }
  logger.db('dbRestoreJob', 'Success', { jobId: id });
}
async function dbPermDeleteJob(id, userId) {
  logger.db('dbPermDeleteJob', 'Permanently deleting job', { jobId: id, userId });
  const { error } = await supabase.from('vault_jobs').delete().eq('id',id).eq('user_id',userId);
  if (error) { logger.error('dbPermDeleteJob', 'Failed', error.message); throw error; }
  logger.db('dbPermDeleteJob', 'Success', { jobId: id });
}
async function dbLoadJobTrash(userId) {
  logger.db('dbLoadJobTrash', 'Loading job trash', { userId });
  await supabase.from('vault_jobs').delete().eq('user_id',userId)
    .not('deleted_at','is',null).lt('deleted_at', new Date(Date.now()-30*86400000).toISOString());
  const { data, error } = await supabase.from('vault_jobs')
    .select('*').eq('user_id',userId).not('deleted_at','is',null).order('deleted_at',{ascending:false});
  if (error) { logger.error('dbLoadJobTrash', 'Failed', error.message); throw error; }
  logger.db('dbLoadJobTrash', 'Job trash loaded', { count: data.length });
  return data;
}
async function dbUpdateJobOrder(jobs, userId) {
  logger.db('dbUpdateJobOrder', 'Updating job order', { userId, count: jobs?.length });
  await Promise.all(jobs.map((j, i) =>
    j.id ? supabase.from('vault_jobs').update({ sort_order: i }).eq('id', j.id).eq('user_id', userId) : Promise.resolve()
  ));
  logger.db('dbUpdateJobOrder', 'Success');
}

// ── TOTP Vault ────────────────────────────────────────────────────────────────
async function dbLoadTotp(userId, encKey) {
  logger.db('dbLoadTotp', 'Loading TOTP items', { userId });
  const { data, error } = await supabase.from('vault_totp').select('*')
    .eq('user_id',userId).order('sort_order',{ascending:true});
  if (error) { logger.error('dbLoadTotp', 'Failed', error.message); throw error; }
  logger.db('dbLoadTotp', 'TOTP items loaded', { count: data.length });
  return data.map(row => ({
    id: row.id, name: row.name, issuer: row.issuer,
    secret: dec(row.secret, encKey) || '',
    icon: row.icon, sort_order: row.sort_order,
  }));
}
async function dbSaveTotp(userId, item, encKey) {
  logger.db('dbSaveTotp', 'Saving TOTP item', { userId, itemId: item?.id, name: item?.name });
  const { id, ...payload } = item;
  const encSecret = enc(item.secret, encKey);
  if (id) {
    const { error } = await supabase.from('vault_totp')
      .update({ name:payload.name, issuer:payload.issuer, secret:encSecret, icon:payload.icon })
      .eq('id',id).eq('user_id',userId);
    if (error) { logger.error('dbSaveTotp', 'Update failed', error.message); throw error; }
    logger.db('dbSaveTotp', 'TOTP item updated', { itemId: id });
    return id;
  }
  const { data, error } = await supabase.from('vault_totp')
    .insert({ user_id:userId, name:payload.name, issuer:payload.issuer, secret:encSecret, icon:payload.icon||'🔐' })
    .select('id').single();
  if (error) { logger.error('dbSaveTotp', 'Insert failed', error.message); throw error; }
  logger.db('dbSaveTotp', 'TOTP item inserted', { itemId: data.id });
  return data.id;
}
async function dbDeleteTotp(id, userId) {
  logger.db('dbDeleteTotp', 'Deleting TOTP item', { itemId: id, userId });
  const { error } = await supabase.from('vault_totp').delete().eq('id',id).eq('user_id',userId);
  if (error) { logger.error('dbDeleteTotp', 'Failed', error.message); throw error; }
  logger.db('dbDeleteTotp', 'Success', { itemId: id });
}

// ── 2FA ───────────────────────────────────────────────────────────────────────
async function db2faGet(userId) {
  logger.db('db2faGet', 'Getting 2FA record', { userId });
  const { data } = await supabase.from('vault_2fa').select('*').eq('user_id',userId).single();
  return data;
}
async function db2faSave(userId, secret, enabled) {
  logger.db('db2faSave', 'Saving 2FA record', { userId, enabled });
  await supabase.from('vault_2fa').upsert({ user_id:userId, secret, enabled });
}
function verify2fa(secret, token) {
  try { return speakeasy.totp.verify({ secret, encoding:'base32', token, window:1 }); } catch { return false; }
}

// ── Settings ──────────────────────────────────────────────────────────────────
async function dbLoadSettings(userId) {
  logger.db('dbLoadSettings', 'Loading settings', { userId });
  const { data } = await supabase.from('vault_settings').select('*').eq('user_id',userId).single();
  const result = data || { lock_timeout: 5, lock_action: 'lock' };
  logger.db('dbLoadSettings', 'Settings loaded', result);
  return result;
}
async function dbSaveSettings(userId, settings) {
  logger.db('dbSaveSettings', 'Saving settings', { userId, settings });
  await supabase.from('vault_settings').upsert({ user_id:userId, ...settings });
  logger.db('dbSaveSettings', 'Success');
}

// ── Monitor ───────────────────────────────────────────────────────────────────
async function dbGetStats(userId) {
  logger.db('dbGetStats', 'Getting stats', { userId });
  const [items, jobs, jobTrash, itemTrash] = await Promise.all([
    supabase.from('vault_items').select('id',{count:'exact'}).eq('user_id',userId).is('deleted_at',null),
    supabase.from('vault_jobs').select('id',{count:'exact'}).eq('user_id',userId).is('deleted_at',null),
    supabase.from('vault_jobs').select('id',{count:'exact'}).eq('user_id',userId).not('deleted_at','is',null),
    supabase.from('vault_items').select('id',{count:'exact'}).eq('user_id',userId).not('deleted_at','is',null),
  ]);
  let logSize = 0; try { logSize = fs.statSync(LOG_PATH).size; } catch {}
  let dbSizeBytes = 0;
  try {
    const { data } = await supabase.rpc('get_db_size').single();
    if (data) dbSizeBytes = data;
  } catch {}
  const stats = {
    items: items.count||0, jobs: jobs.count||0,
    trash: (itemTrash.count||0) + (jobTrash.count||0),
    logSize, dbSizeBytes,
  };
  logger.db('dbGetStats', 'Stats retrieved', stats);
  return stats;
}

// ── OAuth ─────────────────────────────────────────────────────────────────────
async function googleOAuth() {
  logger.auth('oauth', 'Starting OAuth flow');
  if (oauthServer) { try { oauthServer.close(); } catch {} oauthServer = null; }
  if (oauthInProgress) { oauthInProgress = false; }

  const { google } = require('googleapis');
  const client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT_URI);
  const state  = crypto.randomBytes(16).toString('hex');
  const stateCreatedAt = Date.now();
  const authUrl = client.generateAuthUrl({ access_type:'offline', scope:SCOPES, state, prompt:'select_account' });
  logger.auth('oauth', 'OAuth URL generated', { state: state.slice(0, 8) + '...' });

  return new Promise((resolve, reject) => {
    oauthInProgress = true;
    oauthServer = http.createServer(async (req, res) => {
      const parsed = url.parse(req.url, true);
      if (!parsed.pathname.startsWith('/oauth2callback')) return;

      const origin = req.headers['origin'] || req.headers['referer'];
      if (origin && !origin.startsWith('http://localhost:42813') && !origin.startsWith('http://127.0.0.1:42813')) {
        logger.warn('oauth', 'Rejected OAuth callback — bad origin', { origin });
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
      }
      if (!oauthInProgress) {
        logger.warn('oauth', 'Rejected OAuth callback — no active flow');
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('OAuth session expired or already used');
        return;
      }
      if (Date.now() - stateCreatedAt > 5 * 60 * 1000) {
        logger.warn('oauth', 'OAuth state expired');
        oauthServer.close(); oauthServer = null; oauthInProgress = false;
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('OAuth state expired');
        return reject(new Error('OAuth state expired'));
      }

      const nonce = crypto.randomBytes(16).toString('base64');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-" + nonce + "';"
      });
      res.end(`<!DOCTYPE html><html><head><title>Vault — Authenticated</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{height:100vh;overflow:hidden;background:#060612;display:flex;align-items:center;justify-content:center;font-family:'Segoe UI',sans-serif}
  canvas{position:fixed;inset:0;z-index:0}
  .card{position:relative;z-index:1;text-align:center;padding:44px 52px;
    background:rgba(20,17,14,.88);border:1px solid rgba(212,165,116,.2);
    border-radius:20px;backdrop-filter:blur(20px);animation:up .6s cubic-bezier(.22,1,.36,1)}
  @keyframes up{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:none}}
  .shield{width:72px;height:72px;background:rgba(212,165,116,.1);border:1px solid rgba(212,165,116,.25);
    border-radius:20px;display:flex;align-items:center;justify-content:center;margin:0 auto 18px;font-size:32px}
  h2{color:#d4a574;font-size:22px;font-weight:600;margin-bottom:10px}
  p{color:#64748b;font-size:13px;line-height:1.6}
  .bar{width:220px;height:3px;background:rgba(255,255,255,.08);border-radius:2px;margin:20px auto 0;overflow:hidden}
  .fill{height:100%;background:linear-gradient(90deg,#d4a574,#b8864a);border-radius:2px;animation:fill 5s linear forwards}
  @keyframes fill{from{width:0}to{width:100%}}
  .tick{color:#34d399;font-size:36px;margin-bottom:4px}
</style>
</head><body>
<canvas id="c"></canvas>
<div class="card">
  <div class="shield">🔐</div>
  <div class="tick">✓</div>
  <h2>Authenticated!</h2>
  <p>You're all set. Return to Vault.<br>This tab closes automatically in 5 seconds.</p>
  <div class="bar"><div class="fill"></div></div>
</div>
<script nonce="${nonce}">
const c=document.getElementById('c'),ctx=c.getContext('2d');
let W=c.width=innerWidth,H=c.height=innerHeight;
window.onresize=()=>{W=c.width=innerWidth;H=c.height=innerHeight};
const pts=[...Array(50)].map(()=>({x:Math.random()*W,y:Math.random()*H,vx:(Math.random()-.5)*.3,vy:(Math.random()-.5)*.3,hue:Math.random()*40+240}));
function draw(){
  ctx.clearRect(0,0,W,H);
  pts.forEach(p=>{
    p.x+=p.vx;p.y+=p.vy;
    if(p.x<0)p.x=W;if(p.x>W)p.x=0;if(p.y<0)p.y=H;if(p.y>H)p.y=0;
    pts.forEach(q=>{const d=Math.hypot(p.x-q.x,p.y-q.y);if(d<120){ctx.strokeStyle=\`hsla(\${p.hue},80%,70%,\${(1-d/120)*.15})\`;ctx.lineWidth=.5;ctx.beginPath();ctx.moveTo(p.x,p.y);ctx.lineTo(q.x,q.y);ctx.stroke();}});
    ctx.beginPath();ctx.arc(p.x,p.y,1.5,0,Math.PI*2);ctx.fillStyle=\`hsla(\${p.hue},80%,70%,.6)\`;ctx.fill();
  });
  requestAnimationFrame(draw);
}
draw();
setTimeout(()=>window.close(),5000);
</script></body></html>`);

      oauthServer.close();
      oauthServer = null;
      oauthInProgress = false;

      if (win) { win.show(); win.focus(); if (win.isMinimized()) win.restore(); }

      if (!parsed.query.code || parsed.query.state !== state) {
        logger.error('oauth', 'OAuth state mismatch or missing code');
        return reject(new Error('OAuth state mismatch'));
      }
      logger.auth('oauth', 'OAuth callback received, exchanging code for tokens');
      try {
        const { tokens } = await client.getToken(parsed.query.code);
        client.setCredentials(tokens);
        const people = google.people({ version:'v1', auth:client });
        const me = await people.people.get({ resourceName:'people/me', personFields:'emailAddresses,names,photos,metadata' });
        const profile = {
          googleId: me.data.metadata?.sources?.[0]?.id || crypto.randomBytes(8).toString('hex'),
          email:    me.data.emailAddresses?.[0]?.value || '',
          name:     me.data.names?.[0]?.displayName    || '',
          avatar:   me.data.photos?.[0]?.url           || null,
        };
        logger.auth('oauth', 'OAuth success', { email: profile.email, name: profile.name });
        resolve(profile);
      } catch (e) {
        logger.error('oauth', 'OAuth token exchange failed', { message: e.message, code: e.code });
        reject(e);
      }
    });
    oauthServer.listen(42813, '127.0.0.1', () => {
      logger.auth('oauth', 'OAuth server listening on 127.0.0.1:42813');
      shell.openExternal(authUrl);
    });
    setTimeout(() => {
      if (oauthServer) { oauthServer.close(); oauthServer=null; }
      oauthInProgress = false;
      logger.warn('oauth', 'OAuth timed out after 180s');
      reject(new Error('OAuth timed out'));
    }, 180_000);
  });
}

// ─── SOUNDS ───────────────────────────────────────────────────────────────────
function playSound(type) { logger.debug('sound', `Playing sound: ${type}`); if (win) win.webContents.send('play-sound', type); }

// ─── IPC ──────────────────────────────────────────────────────────────────────
ipcMain.handle('auth:login', async () => {
  logger.ipc('auth:login', 'Login attempt started');
  if (oauthInProgress) {
    logger.warn('auth:login', 'Login rejected — auth already in progress');
    return { ok: false, error: 'Auth already in progress. Please complete it in your browser.' };
  }
  try {
    const profile = await googleOAuth();
    const userId  = await dbUpsertUser(profile);
    const encKey  = deriveKey(profile.googleId);
    sessionToken = genSessionToken();
    const twofa   = await db2faGet(userId);
    if (twofa?.enabled) {
      session = { ...profile, userId, encKey, pending2fa:true };
      logger.auth('auth:login', 'Login success — 2FA required', { email: profile.email, userId });
      return { ok:true, needs2fa:true, user:{ name:profile.name, email:profile.email, avatar:profile.avatar }, token:sessionToken };
    }
    const vault = await dbLoadItems(userId, encKey);
    session = { ...profile, userId, encKey, pending2fa:false };
    playSound('login');
    logger.auth('auth:login', 'Login success', { email: profile.email, userId, passwords: vault.passwords.length, notes: vault.notes.length });
    return { ok:true, needs2fa:false, user:{ name:profile.name, email:profile.email, avatar:profile.avatar }, token:sessionToken, vault };
  } catch (e) {
    logger.error('auth:login', 'Login failed', { message: e.message, code: e.code });
    logError('auth:login', e);
    return { ok:false, error: 'Authentication failed. Please try again.' };
  }
});

ipcMain.handle('auth:verify2fa', async (_e, { token }) => {
  logger.ipc('auth:verify2fa', '2FA verification attempt');
  try {
    if (isRateLimited()) {
      logger.warn('auth:verify2fa', '2FA rejected — rate limited');
      return { ok:false, error:'Too many attempts. Try again in 15 minutes.' };
    }
    if (!session?.pending2fa) {
      logger.warn('auth:verify2fa', '2FA rejected — no pending 2FA session');
      return { ok:false, error:'No pending 2FA' };
    }
    const twofa = await db2faGet(session.userId);
    if (!verify2fa(twofa.secret, token)) {
      recordFailedAttempt();
      logger.warn('auth:verify2fa', '2FA rejected — invalid code');
      return { ok:false, error:'Invalid code' };
    }
    resetRateLimit();
    session.pending2fa = false;
    sessionToken = genSessionToken();
    const vault = await dbLoadItems(session.userId, session.encKey);
    playSound('login');
    logger.auth('auth:verify2fa', '2FA verified successfully', { userId: session.userId });
    return { ok:true, token:sessionToken, vault };
  } catch (e) {
    logger.error('auth:verify2fa', '2FA verification error', e.message);
    logError('auth:verify2fa', e);
    return { ok:false, error:'Verification failed. Please try again.' };
  }
});

ipcMain.handle('auth:logout', () => {
  logger.ipc('auth:logout', 'Logout', { user: session?.email });
  playSound('logout');
  session = null; sessionToken = null;
  logger.auth('auth:logout', 'Session cleared');
  return { ok:true };
});

ipcMain.handle('auth:lock', () => {
  logger.ipc('auth:lock', 'Lock', { user: session?.email });
  if (session) {
    session.encKey = null;
    session.googleId = session.googleId;
  }
  sessionToken = null;
  logger.auth('auth:lock', 'Session locked — encKey cleared');
  return { ok:true };
});

ipcMain.handle('auth:reauth', async () => {
  logger.ipc('auth:reauth', 'Re-authentication attempt');
  if (oauthInProgress) {
    logger.warn('auth:reauth', 'Reauth rejected — auth already in progress');
    return { ok:false, error:'Auth already in progress.' };
  }
  try {
    const profile = await googleOAuth();
    if (session && profile.googleId !== session.googleId) {
      logger.warn('auth:reauth', 'Reauth rejected — different account', { expected: session.googleId, got: profile.googleId });
      return { ok:false, error:'Different account' };
    }
    const userId = await dbUpsertUser(profile);
    const encKey = deriveKey(profile.googleId);
    const vault  = await dbLoadItems(userId, encKey);
    session = { ...profile, userId, encKey, pending2fa:false };
    sessionToken = genSessionToken();
    playSound('login');
    logger.auth('auth:reauth', 'Re-authentication success', { email: profile.email, userId });
    return { ok:true, user:{ name:profile.name, email:profile.email, avatar:profile.avatar }, token:sessionToken, vault };
  } catch (e) {
    logger.error('auth:reauth', 'Re-authentication failed', { message: e.message, code: e.code });
    logError('auth:reauth', e);
    return { ok:false, error:'Re-authentication failed. Please try again.' };
  }
});

// ─── SENSITIVE HANDLERS (token-validated) ─────────────────────────────────────
ipcMain.handle('vault:save', requireAuth(async (_e,{type,item}) => {
  logger.ipc('vault:save', 'Save vault item', { type, dbId: item?._dbId });
  try {
    if(!validType(type)){ logger.warn('vault:save', 'Invalid type', { type }); return{ok:false,error:'Invalid item type'}; }
    if(!item||typeof item!=='object'){ logger.warn('vault:save', 'Invalid item'); return{ok:false,error:'Invalid item'}; }
    item.site=sanitizeStr(item.site);item.username=sanitizeStr(item.username);item.password=sanitizeStr(item.password,MAX_NOTES_LEN);item.notes=sanitizeStr(item.notes,MAX_NOTES_LEN);
    const dbId = await dbSaveItem(session.userId,type,item,session.encKey);
    logger.success('vault:save', 'Item saved', { type, dbId });
    return {ok:true,dbId};
  } catch(e){ logError('vault:save',e);return{ok:false,error:e.message};}
}));

ipcMain.handle('vault:delete', requireAuth(async (_e,{dbId}) => {
  logger.ipc('vault:delete', 'Delete vault item', { dbId });
  try { await dbSoftDelete(dbId,session.userId); logger.success('vault:delete', 'Item deleted', { dbId }); return{ok:true}; } catch(e){ logError('vault:delete',e);return{ok:false,error:e.message};}
}));

ipcMain.handle('vault:sync', requireAuthNoArgs(async () => {
  logger.ipc('vault:sync', 'Syncing vault');
  try { const vault = await dbLoadItems(session.userId,session.encKey); logger.success('vault:sync', 'Vault synced', { passwords: vault.passwords.length, notes: vault.notes.length }); return {ok:true,vault}; } catch(e){ logError('vault:sync',e);return{ok:false,error:e.message};}
}));

ipcMain.handle('vault:reorder', requireAuth(async (_e,{type,items}) => {
  logger.ipc('vault:reorder', 'Reordering items', { type, count: items?.length });
  try { await dbUpdateSortOrder(items,session.userId); logger.success('vault:reorder', 'Items reordered'); return{ok:true}; } catch(e){ logError('vault:reorder',e);return{ok:false};}
}));

ipcMain.handle('trash:load', requireAuthNoArgs(async () => {
  logger.ipc('trash:load', 'Loading trash');
  try { const items = await dbLoadTrash(session.userId,session.encKey); logger.success('trash:load', 'Trash loaded', { count: items.length }); return {ok:true,items}; } catch(e){ logError('trash:load',e);return{ok:false,error:e.message};}
}));

ipcMain.handle('trash:restore', requireAuth(async (_e,{dbId}) => {
  logger.ipc('trash:restore', 'Restoring from trash', { dbId });
  try { await dbRestore(dbId,session.userId); logger.success('trash:restore', 'Item restored', { dbId }); return{ok:true}; } catch(e){ logError('trash:restore',e);return{ok:false,error:e.message};}
}));

ipcMain.handle('trash:purge', requireAuth(async (_e,{dbId}) => {
  logger.ipc('trash:purge', 'Purging from trash', { dbId });
  try { await dbPermDelete(dbId,session.userId); logger.success('trash:purge', 'Item purged', { dbId }); return{ok:true}; } catch(e){ logError('trash:purge',e);return{ok:false,error:e.message};}
}));

ipcMain.handle('logo:fetch', requireAuth(async (_e,{site}) => {
  logger.ipc('logo:fetch', 'Fetching logo', { site });
  try { const url = await fetchLogo(site); logger.success('logo:fetch', 'Logo fetched', { site, url }); return {ok:true,url}; } catch(e){ logError('logo:fetch',e);return{ok:false};}
}));

ipcMain.handle('jobs:load', requireAuthNoArgs(async () => {
  logger.ipc('jobs:load', 'Loading jobs');
  try { const jobs = await dbLoadJobs(session.userId); logger.success('jobs:load', 'Jobs loaded', { count: jobs.length }); return {ok:true,jobs}; } catch(e){ logError('jobs:load',e);return{ok:false,error:e.message};}
}));

ipcMain.handle('jobs:save', requireAuth(async (_e,{job}) => {
  logger.ipc('jobs:save', 'Saving job', { jobId: job?.id, company: job?.company });
  try {
    if(!job||typeof job!=='object'){ logger.warn('jobs:save', 'Invalid job data'); return{ok:false,error:'Invalid job data'}; }
    job.company=sanitizeStr(job.company);job.role=sanitizeStr(job.role);
    if(job.email&&!validEmail(job.email)){ logger.warn('jobs:save', 'Invalid email', { email: job.email }); return{ok:false,error:'Invalid email'}; }
    job.notes=sanitizeStr(job.notes,MAX_NOTES_LEN);
    const id = await dbSaveJob(session.userId,job);
    logger.success('jobs:save', 'Job saved', { jobId: id, company: job.company });
    return {ok:true,id};
  } catch(e){ logError('jobs:save',e);return{ok:false,error:e.message};}
}));

ipcMain.handle('jobs:delete', requireAuth(async (_e,{id}) => {
  logger.ipc('jobs:delete', 'Deleting job', { jobId: id });
  try { await dbDeleteJob(id,session.userId); logger.success('jobs:delete', 'Job deleted', { jobId: id }); return{ok:true}; } catch(e){ logError('jobs:delete',e);return{ok:false,error:e.message};}
}));

ipcMain.handle('jobs:reorder', requireAuth(async (_e,{jobs}) => {
  logger.ipc('jobs:reorder', 'Reordering jobs', { count: jobs?.length });
  try { await dbUpdateJobOrder(jobs,session.userId); logger.success('jobs:reorder', 'Jobs reordered'); return{ok:true}; } catch(e){ logError('jobs:reorder',e);return{ok:false};}
}));

ipcMain.handle('jobs:trash:load', requireAuthNoArgs(async () => {
  logger.ipc('jobs:trash:load', 'Loading job trash');
  try { const items = await dbLoadJobTrash(session.userId); logger.success('jobs:trash:load', 'Job trash loaded', { count: items.length }); return {ok:true,items}; } catch(e){ logError('jobs:trash:load',e);return{ok:false,error:e.message};}
}));

ipcMain.handle('jobs:trash:restore', requireAuth(async (_e,{id}) => {
  logger.ipc('jobs:trash:restore', 'Restoring job', { jobId: id });
  try { await dbRestoreJob(id,session.userId); logger.success('jobs:trash:restore', 'Job restored', { jobId: id }); return{ok:true}; } catch(e){ logError('jobs:trash:restore',e);return{ok:false,error:e.message};}
}));

ipcMain.handle('jobs:trash:purge', requireAuth(async (_e,{id}) => {
  logger.ipc('jobs:trash:purge', 'Purging job', { jobId: id });
  try { await dbPermDeleteJob(id,session.userId); logger.success('jobs:trash:purge', 'Job purged', { jobId: id }); return{ok:true}; } catch(e){ logError('jobs:trash:purge',e);return{ok:false,error:e.message};}
}));

ipcMain.handle('settings:load', requireAuthNoArgs(async () => {
  logger.ipc('settings:load', 'Loading settings');
  try { const settings = await dbLoadSettings(session.userId); logger.success('settings:load', 'Settings loaded', settings); return {ok:true,settings}; } catch(e){ logger.warn('settings:load', 'Using defaults'); return{ok:true,settings:{lock_timeout:5,lock_action:'lock'}};}
}));

ipcMain.handle('settings:save', requireAuth(async (_e,{settings}) => {
  logger.ipc('settings:save', 'Saving settings', settings);
  try {
    if(!settings||typeof settings!=='object'){ logger.warn('settings:save', 'Invalid settings'); return{ok:false,error:'Invalid settings'}; }
    const t=parseInt(settings.lock_timeout);if(isNaN(t)||t<0||t>120){ logger.warn('settings:save', 'Invalid timeout', { timeout: t }); return{ok:false,error:'Lock timeout must be 0-120 minutes'}; }
    if(!['lock','exit'].includes(settings.lock_action)){ logger.warn('settings:save', 'Invalid lock action', { action: settings.lock_action }); return{ok:false,error:'Invalid lock action'}; }
    await dbSaveSettings(session.userId,{lock_timeout:t,lock_action:settings.lock_action});
    logger.success('settings:save', 'Settings saved', { lock_timeout: t, lock_action: settings.lock_action });
    return{ok:true};
  } catch(e){ logError('settings:save',e);return{ok:false};}
}));

ipcMain.handle('totp:load', requireAuthNoArgs(async () => {
  logger.ipc('totp:load', 'Loading TOTP items');
  try { const items = await dbLoadTotp(session.userId,session.encKey); logger.success('totp:load', 'TOTP items loaded', { count: items.length }); return {ok:true,items}; } catch(e){ logError('totp:load',e);return{ok:false,error:e.message};}
}));

ipcMain.handle('totp:save', requireAuth(async (_e,{item}) => {
  logger.ipc('totp:save', 'Saving TOTP item', { itemId: item?.id, name: item?.name });
  try {
    if(!item||typeof item!=='object'){ logger.warn('totp:save', 'Invalid TOTP data'); return{ok:false,error:'Invalid TOTP data'}; }
    item.name=sanitizeStr(item.name);item.issuer=sanitizeStr(item.issuer);
    if(!validTotpSecret(item.secret)){ logger.warn('totp:save', 'Invalid TOTP secret'); return{ok:false,error:'Invalid TOTP secret (base32: A-Z, 2-7, 16+ chars)'}; }
    const id = await dbSaveTotp(session.userId,item,session.encKey);
    logger.success('totp:save', 'TOTP item saved', { itemId: id, name: item.name });
    return {ok:true,id};
  } catch(e){ logError('totp:save',e);return{ok:false,error:e.message};}
}));

ipcMain.handle('totp:delete', requireAuth(async (_e,{id}) => {
  logger.ipc('totp:delete', 'Deleting TOTP item', { itemId: id });
  try { await dbDeleteTotp(id,session.userId); logger.success('totp:delete', 'TOTP item deleted', { itemId: id }); return{ok:true}; } catch(e){ logError('totp:delete',e);return{ok:false,error:e.message};}
}));

ipcMain.handle('2fa:status', requireAuthNoArgs(async () => {
  logger.ipc('2fa:status', 'Checking 2FA status');
  try { const d=await db2faGet(session.userId);const enabled=d?.enabled||false; logger.success('2fa:status', '2FA status', { enabled }); return{ok:true,enabled}; } catch(e){ logger.warn('2fa:status', 'No 2FA record, defaulting to disabled'); return{ok:true,enabled:false};}
}));

ipcMain.handle('2fa:setup', requireAuthNoArgs(async () => {
  logger.ipc('2fa:setup', 'Setting up 2FA');
  try { const s=speakeasy.generateSecret({name:`Vault (${session.email})`,length:20});await db2faSave(session.userId,s.base32,false);logger.success('2fa:setup', '2FA setup initiated');return{ok:true,secret:s.base32,otpauth:s.otpauth_url}; } catch(e){ logError('2fa:setup',e);return{ok:false,error:e.message};}
}));

ipcMain.handle('2fa:enable', requireAuth(async (_e,{token}) => {
  logger.ipc('2fa:enable', 'Enabling 2FA');
  try { const d=await db2faGet(session.userId);if(!d||!verify2fa(d.secret,token)){ logger.warn('2fa:enable', 'Invalid 2FA code'); return{ok:false,error:'Invalid code'}; } await db2faSave(session.userId,d.secret,true); logger.success('2fa:enable', '2FA enabled'); return{ok:true}; } catch(e){ logError('2fa:enable',e);return{ok:false,error:e.message};}
}));

ipcMain.handle('2fa:disable', requireAuthNoArgs(async () => {
  logger.ipc('2fa:disable', 'Disabling 2FA');
  try { const d=await db2faGet(session.userId);if(d)await db2faSave(session.userId,d.secret,false); logger.success('2fa:disable', '2FA disabled'); return{ok:true}; } catch(e){ logError('2fa:disable',e);return{ok:false,error:e.message};}
}));

ipcMain.handle('monitor:stats', requireAuthNoArgs(async () => {
  logger.ipc('monitor:stats', 'Loading monitor stats');
  try { const stats=await dbGetStats(session.userId); logger.success('monitor:stats', 'Stats loaded', stats); return {ok:true,stats,logPath:LOG_PATH,logDir:logger.getLogDir()}; } catch(e){ logError('monitor:stats',e);return{ok:false,error:e.message};}
}));

ipcMain.handle('log:read', requireAuthNoArgs(async () => {
  logger.ipc('log:read', 'Reading log');
  try { const t=fs.existsSync(LOG_PATH)?fs.readFileSync(LOG_PATH,'utf8'):'(no errors logged)';return{ok:true,log:t.slice(-10000),logDir:logger.getLogDir()}; } catch(e){return{ok:true,log:'(could not read log)'};}
}));

ipcMain.handle('log:clear', requireAuthNoArgs(async () => {
  logger.ipc('log:clear', 'Clearing log');
  try { fs.writeFileSync(LOG_PATH,''); logger.clearAllLogs(); logger.success('log:clear', 'All logs cleared'); return{ok:true}; } catch(e){ logError('log:clear',e); return{ok:false};}
}));

ipcMain.on('win:minimize', () => { logger.ipc('win:minimize', 'Window minimized'); win?.minimize(); });
ipcMain.on('win:maximize', () => { logger.ipc('win:maximize', 'Window maximize toggled'); if(win?.isMaximized())win.unmaximize(); else win?.maximize(); });
ipcMain.on('win:close', () => { logger.ipc('win:close', 'Window close requested'); win?.close(); });

// ─── PRELOAD BRIDGE LOGGING ───────────────────────────────────────────────────
ipcMain.on('preload:log', (_e, { action, channel, ok, detail }) => {
  logger.ipc('preload', `Bridge call: ${channel}`, { action, ok, ...detail });
});
ipcMain.on('preload:token', (_e, state) => {
  logger.auth('preload', `Token state: ${state}`);
});

// ─── WINDOW ───────────────────────────────────────────────────────────────────
function createWindow() {
  logger.info('window', 'Creating main window');
  win = new BrowserWindow({
    width:1100, height:720, minWidth:900, minHeight:580,
    frame:false, transparent:true,
    icon: path.join(__dirname, '..', 'icon.png'),
    vibrancy:'under-window', visualEffectState:'active',
    backgroundColor:'#00000000',
    webPreferences:{ preload:path.join(__dirname, '..', 'preload.js'), contextIsolation:true, nodeIntegration:false, spellcheck:false },
  });
  win.loadFile(path.join(__dirname, '..', 'index.html'));
  logger.success('window', 'Main window created and loaded');
  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode:'detach' });
}

app.whenReady().then(() => {
  logger.info('app', 'Electron app ready');
  CryptoJS  = require('crypto-js');
  speakeasy = require('speakeasy');
  const ws = require('ws');
  const { createClient } = require('@supabase/supabase-js');
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
    realtime: { transport: ws }
  });
  logger.success('app', 'Dependencies loaded (CryptoJS, speakeasy, Supabase)');
  createWindow();
});

app.on('window-all-closed', () => {
  logger.info('app', 'All windows closed');
  if(process.platform!=='darwin') {
    logger.info('app', 'Quitting app (non-macOS)');
    app.quit();
  }
});

app.on('activate', () => {
  logger.info('app', 'App activated');
  if(!BrowserWindow.getAllWindows().length) {
    logger.info('app', 'No windows — creating new one');
    createWindow();
  }
});

app.on('before-quit', () => {
  logger.info('app', 'App quitting — session end');
});
