'use strict';

// Load .env before anything else
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage } = require('electron');
const path   = require('path');
const http   = require('http');
const https  = require('https');
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
let win, supabase, CryptoJS, speakeasy, tray;
let oauthInProgress = false;
let oauthServer = null;

// ─── MODULES ──────────────────────────────────────────────────────────────────
const authModule   = require('./modules/auth');
const cryptoModule = require('./modules/crypto');
const validation   = require('./modules/validation');

const {
  genSessionToken, validateToken, clearSession, setSession, getSession,
  requireAuth, requireAuthNoArgs, requireAdminNoArgs,
  isRateLimited, recordFailedAttempt, resetRateLimit,
} = authModule;

const { deriveKey, enc, dec, setCryptoJS } = cryptoModule;

const {
  MAX_FIELD_LEN, MAX_NOTES_LEN, VALID_ITEM_TYPES,
  sanitizeStr, validType, validEmail, validTotpSecret,
} = validation;

// ─── DB HELPERS (vault items / trash) ─────────────────────────────────────────
async function dbUpsertUser({ googleId, email, name, avatar }) {
  logger.db('dbUpsertUser', 'Upserting user', { googleId, email });
  const { data, error } = await supabase.from('vault_users')
    .upsert({ google_id:googleId, email, name, avatar, last_seen:new Date().toISOString() },{ onConflict:'google_id' })
    .select('id').single();
  if (error) { logger.error('dbUpsertUser', 'Supabase error', JSON.stringify(error)); throw new Error('dbUpsertUser failed'); }
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
  if (error) { logger.error('dbLoadItems', 'Failed to load items', error.message); throw new Error('Failed to load vault items'); }
  const passwords=[], notes=[];
  for (const row of data) {
    const item = dec(row.encrypted_data, encKey);
    if (!item) { logger.warn('dbLoadItems', 'Failed to decrypt item', { id: row.id }); continue; }
    item._dbId = row.id; item._sort = row.sort_order; item.id = row.id;
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
  if (error) { logger.error('dbLoadTrash', 'Failed to load trash', error.message); throw new Error('Failed to load trash'); }
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
    if (error) { logger.error('dbSaveItem', 'Update failed', error.message); throw new Error('Failed to save item'); }
    logger.db('dbSaveItem', 'Item updated', { dbId: _dbId });
    return _dbId;
  }
  const { data, error } = await supabase.from('vault_items')
    .insert({ user_id:userId, type, encrypted_data }).select('id').single();
  if (error) { logger.error('dbSaveItem', 'Insert failed', error.message); throw new Error('Failed to save item'); }
  logger.db('dbSaveItem', 'Item inserted', { dbId: data.id });
  return data.id;
}

async function dbSoftDelete(dbId, userId) {
  logger.db('dbSoftDelete', 'Soft-deleting item', { dbId, userId });
  const { error } = await supabase.from('vault_items').update({ deleted_at:new Date().toISOString() }).eq('id',dbId).eq('user_id',userId);
  if (error) { logger.error('dbSoftDelete', 'Failed', error.message); throw new Error('Failed to delete item'); }
  logger.db('dbSoftDelete', 'Success', { dbId });
}
async function dbRestore(dbId, userId) {
  logger.db('dbRestore', 'Restoring item', { dbId, userId });
  const { error } = await supabase.from('vault_items').update({ deleted_at:null }).eq('id',dbId).eq('user_id',userId);
  if (error) { logger.error('dbRestore', 'Failed', error.message); throw new Error('Failed to restore item'); }
  logger.db('dbRestore', 'Success', { dbId });
}
async function dbPermDelete(dbId, userId) {
  logger.db('dbPermDelete', 'Permanently deleting item', { dbId, userId });
  const { error } = await supabase.from('vault_items').delete().eq('id',dbId).eq('user_id',userId);
  if (error) { logger.error('dbPermDelete', 'Failed', error.message); throw new Error('Failed to delete item'); }
  logger.db('dbPermDelete', 'Success', { dbId });
}
async function dbUpdateSortOrder(items, userId) {
  logger.db('dbUpdateSortOrder', 'Updating sort order', { userId, count: items?.length });
  await Promise.all(items.map((item, i) =>
    item._dbId ? supabase.from('vault_items').update({ sort_order: i }).eq('id',item._dbId).eq('user_id',userId) : Promise.resolve()
  ));
  logger.db('dbUpdateSortOrder', 'Success');
}

// ─── 2FA DB HELPERS ───────────────────────────────────────────────────────────
async function db2faGet(userId) {
  logger.db('db2faGet', 'Getting 2FA record', { userId });
  const { data } = await supabase.from('vault_2fa').select('user_id,secret,enabled').eq('user_id',userId).single();
  return data;
}
async function db2faSave(userId, secret, enabled) {
  logger.db('db2faSave', 'Saving 2FA record', { userId, enabled });
  await supabase.from('vault_2fa').upsert({ user_id:userId, secret, enabled });
}
function verify2fa(secret, token) {
  try { return speakeasy.totp.verify({ secret, encoding:'base32', token, window:1 }); } catch { return false; }
}

// ─── OAUTH ─────────────────────────────────────────────────────────────────────
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
      if (parsed.pathname !== '/oauth2callback') return;

      const origin = req.headers['origin'] || req.headers['referer'];
      const isValidOrigin = (o) => { try { const u = new URL(o); return u.protocol === 'http:' && (u.host === 'localhost:42813' || u.host === '127.0.0.1:42813'); } catch { return false; } };
      if (origin && !isValidOrigin(origin)) {
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
        'Content-Security-Policy': "default-src 'none'; style-src 'nonce-" + nonce + "'; script-src 'nonce-" + nonce + "';"
      });
      res.end(`<!DOCTYPE html><html><head><title>Vault — Authenticated</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  :root{
    --bg:oklch(0.14 0.012 280);--bg-surface:oklch(0.17 0.014 280);
    --accent:oklch(0.65 0.22 290);--accent-dim:oklch(0.65 0.22 290 / 0.12);
    --accent-glow:oklch(0.65 0.22 290 / 0.15);--accent-border:oklch(0.55 0.08 290 / 0.2);
    --green:oklch(0.78 0.12 145);--green-dim:oklch(0.78 0.12 145 / 0.12);
    --txt:oklch(0.92 0.006 280);--txt-sec:oklch(0.68 0.008 280);--txt-muted:oklch(0.52 0.006 280);
    --font:'Outfit',-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
    --mono:'JetBrains Mono','Fira Code',ui-monospace,monospace;
  }
  body{height:100vh;overflow:hidden;background:var(--bg);display:flex;align-items:center;justify-content:center;font-family:var(--font);color:var(--txt);-webkit-font-smoothing:antialiased}
  canvas{position:fixed;inset:0;z-index:0;pointer-events:none}
  .card{
    position:relative;z-index:1;text-align:center;padding:52px 60px;min-width:380px;
    background:oklch(0.17 0.014 280 / 0.75);
    border:1px solid var(--accent-border);
    border-radius:20px;
    backdrop-filter:blur(24px) saturate(1.2);
    -webkit-backdrop-filter:blur(24px) saturate(1.2);
    box-shadow:0 8px 40px oklch(0 0 0 / 0.5),0 0 80px var(--accent-glow),inset 0 1px 0 oklch(0.65 0.22 290 / 0.06);
    animation:up .6s cubic-bezier(.22,1,.36,1)
  }
  @keyframes up{from{opacity:0;transform:translateY(24px) scale(0.97)}to{opacity:1;transform:none}}
  .logo{
    width:64px;height:64px;border-radius:18px;margin:0 auto 20px;
    background:var(--accent-dim);border:1px solid var(--accent-border);
    display:flex;align-items:center;justify-content:center;
    box-shadow:0 0 30px var(--accent-glow);
  }
  .logo svg{width:28px;height:28px}
  .icon-ring{
    width:44px;height:44px;border-radius:50%;margin:0 auto 16px;
    background:var(--green-dim);border:1px solid oklch(0.78 0.12 145 / 0.2);
    display:flex;align-items:center;justify-content:center;
    box-shadow:0 0 20px oklch(0.78 0.12 145 / 0.1);
    animation:pop .4s .2s cubic-bezier(.22,1,.36,1) both
  }
  @keyframes pop{from{opacity:0;transform:scale(0.5)}to{opacity:1;transform:scale(1)}}
  .icon-ring svg{width:20px;height:20px;stroke:var(--green);fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
  h2{font-size:20px;font-weight:600;margin-bottom:8px;color:var(--txt)}
  p{color:var(--txt-sec);font-size:13px;line-height:1.6}
  .sub{color:var(--txt-muted);font-size:11px;margin-top:2px;font-family:var(--mono)}
  .divider{height:1px;background:var(--accent-border);margin:24px 0}
  .progress{width:100%;height:3px;background:oklch(0.21 0.016 280);border-radius:2px;overflow:hidden}
  .progress-fill{height:100%;background:linear-gradient(90deg,var(--accent),oklch(0.72 0.24 290));border-radius:2px;box-shadow:0 0 8px var(--accent-glow);animation:fill 4.5s linear forwards}
  @keyframes fill{from{width:0}to{width:100%}}
  .glow-orbs{position:fixed;inset:0;pointer-events:none;z-index:0;overflow:hidden}
  .orb{position:absolute;border-radius:50%;filter:blur(80px);opacity:.12}
  .orb-a{width:400px;height:400px;background:var(--accent);top:-120px;right:-100px}
  .orb-b{width:300px;height:300px;background:oklch(0.65 0.18 260);bottom:-80px;left:-80px}
</style>
</head><body>
<div class="glow-orbs"><div class="orb orb-a"></div><div class="orb orb-b"></div></div>
<canvas id="c"></canvas>
<div class="card">
  <div class="logo">
    <svg viewBox="0 0 24 24" fill="none">
      <path d="M12 2L4 6v6c0 5.25 3.5 10.15 8 11.35C16.5 22.15 20 17.25 20 12V6l-8-4z" fill="var(--accent)"/>
      <path d="M9 12l2 2 4-4" stroke="var(--bg)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  </div>
  <div class="icon-ring">
    <svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
  </div>
  <h2>Authenticated!</h2>
  <p>You&rsquo;re all set &mdash; return to Vault.</p>
  <p class="sub">closing tab&hellip;</p>
  <div class="divider"></div>
  <div class="progress"><div class="progress-fill"></div></div>
</div>
<script nonce="${nonce}">
const c=document.getElementById('c'),ctx=c.getContext('2d');
let W=c.width=innerWidth,H=c.height=innerHeight;
window.onresize=()=>{W=c.width=innerWidth;H=c.height=innerHeight};
const pts=[...Array(60)].map(()=>({x:Math.random()*W,y:Math.random()*H,vx:(Math.random()-.5)*.25,vy:(Math.random()-.5)*.25,h:Math.random()*30+270,s:70+Math.random()*20}));
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
      try {
        if (oauthServer) { oauthServer.close(); oauthServer = null; }
      } catch {}
      oauthInProgress = false;
      logger.warn('oauth', 'OAuth timed out after 180s');
      reject(new Error('OAuth timed out'));
    }, 180_000);
  });
}

// ─── SOUNDS ───────────────────────────────────────────────────────────────────
function playSound(type) { logger.debug('sound', `Playing sound: ${type}`); if (win) win.webContents.send('play-sound', type); }

// ─── REGISTER MODULE IPC HANDLERS ─────────────────────────────────────────────
const jobsModule    = require('./modules/jobs');
const totpModule    = require('./modules/totp');
const settingsModule = require('./modules/settings');
const logoModule    = require('./modules/logo');
const monitorModule = require('./modules/monitor');

const getSessionFn = getSession;

// Module IPC handlers are registered inside app.whenReady() below,
// after supabase is initialized. This avoids passing undefined supabase
// as a parameter (JavaScript passes primitives by value, not reference).

// ─── AUTH IPC HANDLERS ────────────────────────────────────────────────────────
ipcMain.handle('auth:login', async () => {
  logger.ipc('auth:login', 'Login attempt started');
  clearSession();
  if (oauthInProgress) {
    logger.warn('auth:login', 'Login rejected — auth already in progress');
    return { ok: false, error: 'Auth already in progress. Please complete it in your browser.' };
  }
  try {
    const profile = await googleOAuth();
    const userId  = await dbUpsertUser(profile);
    const encKey  = deriveKey(profile.googleId);
    const twofa   = await db2faGet(userId);
    if (twofa?.enabled) {
      const sess = { ...profile, userId, encKey, pending2fa:true };
      setSession(sess);
      logger.auth('auth:login', 'Login success — 2FA required', { email: profile.email, userId });
      return { ok:true, needs2fa:true, user:{ name:profile.name, email:profile.email, avatar:profile.avatar } };
    }
    const token = genSessionToken();
    const vault = await dbLoadItems(userId, encKey);
    const sess = { ...profile, userId, encKey, pending2fa:false };
    setSession(sess);
    playSound('login');
    logger.auth('auth:login', 'Login success', { email: profile.email, userId, passwords: vault.passwords.length, notes: vault.notes.length });
    return { ok:true, needs2fa:false, user:{ name:profile.name, email:profile.email, avatar:profile.avatar }, token, vault };
  } catch (e) {
    logger.error('auth:login', 'Login failed', { message: e.message, code: e.code });
    logError('auth:login', e);
    return { ok:false, error: 'Authentication failed. Please try again.' };
  }
});

ipcMain.handle('auth:verify2fa', requireAuth(async (_e, { token }) => {
  logger.ipc('auth:verify2fa', '2FA verification attempt');
  try {
    if (isRateLimited()) {
      logger.warn('auth:verify2fa', '2FA rejected — rate limited');
      return { ok:false, error:'Too many attempts. Try again in 15 minutes.' };
    }
    if (typeof token !== 'string' || !/^\d{6}$/.test(token)) {
      recordFailedAttempt();
      logger.warn('auth:verify2fa', '2FA rejected — invalid token format');
      return { ok:false, error:'Invalid code format. Enter a 6-digit number.' };
    }
    const s = getSession();
    if (!s?.pending2fa) {
      recordFailedAttempt();
      logger.warn('auth:verify2fa', '2FA rejected — no pending 2FA session');
      return { ok:false, error:'No pending 2FA' };
    }
    const twofa = await db2faGet(s.userId);
    if (!verify2fa(twofa.secret, token)) {
      recordFailedAttempt();
      logger.warn('auth:verify2fa', '2FA rejected — invalid code');
      return { ok:false, error:'Invalid code' };
    }
    resetRateLimit();
    s.pending2fa = false;
    setSession(s);
    const newToken = genSessionToken();
    const vault = await dbLoadItems(s.userId, s.encKey);
    playSound('login');
    logger.auth('auth:verify2fa', '2FA verified successfully', { userId: s.userId });
    return { ok:true, token:newToken, vault };
  } catch (e) {
    logger.error('auth:verify2fa', '2FA verification error', e.message);
    logError('auth:verify2fa', e);
    return { ok:false, error:'Verification failed. Please try again.' };
  }
}));

ipcMain.handle('auth:logout', requireAuthNoArgs(() => {
  const s = getSession();
  logger.ipc('auth:logout', 'Logout', { user: s?.email });
  playSound('logout');
  clearSession();
  logger.auth('auth:logout', 'Session cleared');
  return { ok:true };
}));

ipcMain.handle('auth:lock', requireAuthNoArgs(() => {
  const s = getSession();
  logger.ipc('auth:lock', 'Lock', { user: s?.email });
  clearSession();
  logger.auth('auth:lock', 'Session locked — full session cleared');
  return { ok:true };
}));

ipcMain.handle('auth:reauth', async () => {
  logger.ipc('auth:reauth', 'Re-authentication attempt');
  const prevSession = getSession();
  clearSession();
  if (oauthInProgress) {
    logger.warn('auth:reauth', 'Reauth rejected — auth already in progress');
    return { ok:false, error:'Auth already in progress.' };
  }
  try {
    const profile = await googleOAuth();
    if (prevSession && profile.googleId !== prevSession.googleId) {
      logger.warn('auth:reauth', 'Reauth rejected — different account', { expected: prevSession.googleId, got: profile.googleId });
      return { ok:false, error:'Different account' };
    }
    const userId = await dbUpsertUser(profile);
    const encKey = deriveKey(profile.googleId);
    const vault  = await dbLoadItems(userId, encKey);
    const sess = { ...profile, userId, encKey, pending2fa:false };
    setSession(sess);
    const token = genSessionToken();
    playSound('login');
    logger.auth('auth:reauth', 'Re-authentication success', { email: profile.email, userId });
    return { ok:true, user:{ name:profile.name, email:profile.email, avatar:profile.avatar }, token, vault };
  } catch (e) {
    logger.error('auth:reauth', 'Re-authentication failed', { message: e.message, code: e.code });
    logError('auth:reauth', e);
    return { ok:false, error:'Re-authentication failed. Please try again.' };
  }
});

// ─── VAULT / TRASH IPC HANDLERS ───────────────────────────────────────────────
ipcMain.handle('vault:save', requireAuth(async (_e,{type,item}) => {
  const s = getSession();
  logger.ipc('vault:save', 'Save vault item', { type, dbId: item?._dbId });
  try {
    if(!validType(type)){ logger.warn('vault:save', 'Invalid type', { type }); return{ok:false,error:'Invalid item type'}; }
    if(!item||typeof item!=='object'){ logger.warn('vault:save', 'Invalid item'); return{ok:false,error:'Invalid item'}; }
    item.site=sanitizeStr(item.site);item.username=sanitizeStr(item.username);item.password=sanitizeStr(item.password,MAX_NOTES_LEN);item.notes=sanitizeStr(item.notes,MAX_NOTES_LEN);
    const dbId = await dbSaveItem(s.userId,type,item,s.encKey);
    logger.success('vault:save', 'Item saved', { type, dbId });
    return {ok:true,dbId};
  } catch(e){ logError('vault:save',e);return{ok:false,error:'Operation failed'};}
}));

ipcMain.handle('vault:delete', requireAuth(async (_e,{dbId}) => {
  const s = getSession();
  logger.ipc('vault:delete', 'Delete vault item', { dbId });
  try { await dbSoftDelete(dbId,s.userId); logger.success('vault:delete', 'Item deleted', { dbId }); return{ok:true}; } catch(e){ logError('vault:delete',e);return{ok:false,error:'Operation failed'};}
}));

ipcMain.handle('vault:sync', requireAuthNoArgs(async () => {
  const s = getSession();
  logger.ipc('vault:sync', 'Syncing vault');
  try { const vault = await dbLoadItems(s.userId,s.encKey); logger.success('vault:sync', 'Vault synced', { passwords: vault.passwords.length, notes: vault.notes.length }); return {ok:true,vault}; } catch(e){ logError('vault:sync',e);return{ok:false,error:'Operation failed'};}
}));

ipcMain.handle('vault:reorder', requireAuth(async (_e,{type,items}) => {
  const s = getSession();
  logger.ipc('vault:reorder', 'Reordering items', { type, count: items?.length });
  try { await dbUpdateSortOrder(items,s.userId); logger.success('vault:reorder', 'Items reordered'); return{ok:true}; } catch(e){ logError('vault:reorder',e);return{ok:false};}
}));

ipcMain.handle('trash:load', requireAuthNoArgs(async () => {
  const s = getSession();
  logger.ipc('trash:load', 'Loading trash');
  try { const items = await dbLoadTrash(s.userId,s.encKey); logger.success('trash:load', 'Trash loaded', { count: items.length }); return {ok:true,items}; } catch(e){ logError('trash:load',e);return{ok:false,error:'Operation failed'};}
}));

ipcMain.handle('trash:restore', requireAuth(async (_e,{dbId}) => {
  const s = getSession();
  logger.ipc('trash:restore', 'Restoring from trash', { dbId });
  try { await dbRestore(dbId,s.userId); logger.success('trash:restore', 'Item restored', { dbId }); return{ok:true}; } catch(e){ logError('trash:restore',e);return{ok:false,error:'Operation failed'};}
}));

ipcMain.handle('trash:purge', requireAuth(async (_e,{dbId}) => {
  const s = getSession();
  logger.ipc('trash:purge', 'Purging from trash', { dbId });
  try { await dbPermDelete(dbId,s.userId); logger.success('trash:purge', 'Item purged', { dbId }); return{ok:true}; } catch(e){ logError('trash:purge',e);return{ok:false,error:'Operation failed'};}
}));

// ─── 2FA IPC HANDLERS ─────────────────────────────────────────────────────────
ipcMain.handle('2fa:status', requireAuthNoArgs(async () => {
  const s = getSession();
  logger.ipc('2fa:status', 'Checking 2FA status');
  try { const d=await db2faGet(s.userId);const enabled=d?.enabled||false; logger.success('2fa:status', '2FA status', { enabled }); return{ok:true,enabled}; } catch(e){ logger.warn('2fa:status', 'No 2FA record, defaulting to disabled'); return{ok:true,enabled:false};}
}));

ipcMain.handle('2fa:setup', requireAuthNoArgs(async () => {
  const s = getSession();
  logger.ipc('2fa:setup', 'Setting up 2FA');
  try { const secret=speakeasy.generateSecret({name:`Vault (${s.email})`,length:20});await db2faSave(s.userId,secret.base32,false);logger.success('2fa:setup', '2FA setup initiated');return{ok:true,secret:secret.base32,otpauth:secret.otpauth_url}; } catch(e){ logError('2fa:setup',e);return{ok:false,error:'Operation failed'};}
}));

ipcMain.handle('2fa:enable', requireAuth(async (_e,{token}) => {
  const s = getSession();
  logger.ipc('2fa:enable', 'Enabling 2FA');
  try {
    if (isRateLimited()) { logger.warn('2fa:enable', 'Rate limited'); return { ok: false, error: 'Too many attempts. Try again in 15 minutes.' }; }
    if (typeof token !== 'string' || !/^\d{6}$/.test(token)) { recordFailedAttempt(); logger.warn('2fa:enable', 'Invalid token format'); return{ok:false,error:'Invalid code format. Enter a 6-digit number.'}; }
    const d=await db2faGet(s.userId);if(!d||!verify2fa(d.secret,token)){ recordFailedAttempt(); logger.warn('2fa:enable', 'Invalid 2FA code'); return{ok:false,error:'Invalid code'}; }
    resetRateLimit();
    await db2faSave(s.userId,d.secret,true); logger.success('2fa:enable', '2FA enabled'); return{ok:true};
  } catch(e){ logError('2fa:enable',e);return{ok:false,error:'Operation failed'};}
}));

ipcMain.handle('2fa:disable', requireAuth(async (_e, { token }) => {
  const s = getSession();
  logger.ipc('2fa:disable', 'Disabling 2FA');
  try {
    if (isRateLimited()) { logger.warn('2fa:disable', 'Rate limited'); return { ok: false, error: 'Too many attempts. Try again in 15 minutes.' }; }
    if (typeof token !== 'string' || !/^\d{6}$/.test(token)) { recordFailedAttempt(); logger.warn('2fa:disable', 'Invalid token format'); return { ok: false, error: 'Enter your current 6-digit 2FA code to disable.' }; }
    const d = await db2faGet(s.userId);
    if (!d || !verify2fa(d.secret, token)) { recordFailedAttempt(); logger.warn('2fa:disable', 'Invalid 2FA code'); return { ok: false, error: 'Invalid code' }; }
    resetRateLimit();
    await db2faSave(s.userId, d.secret, false);
    logger.success('2fa:disable', '2FA disabled');
    return { ok: true };
  } catch (e) { logError('2fa:disable', e); return { ok: false, error: 'Operation failed' }; }
}));

// ─── WINDOW CONTROL IPC ───────────────────────────────────────────────────────
ipcMain.handle('win:minimize', requireAuthNoArgs(() => { logger.ipc('win:minimize', 'Window minimized'); win?.minimize(); return { ok: true }; }));
ipcMain.handle('win:maximize', requireAuthNoArgs(() => {
  logger.ipc('win:maximize', 'Window maximize toggled');
  if(win?.isMaximized()){ win.unmaximize(); }
  else { win?.maximize(); }
  setTimeout(() => {
    if(!win.isDestroyed()) win.webContents.send('win:maximized-state', win.isMaximized());
  }, 50);
  return { ok: true };
}));
ipcMain.handle('win:close', requireAuthNoArgs(() => {
  logger.ipc('win:close', 'Window close requested — minimizing to tray');
  if(win){
    if(process.platform==='darwin'){ win.hide(); }else{ win.minimize(); win.setSkipTaskbar(true); }
  }
  return { ok: true };
}));

// ─── PRELOAD BRIDGE LOGGING ───────────────────────────────────────────────────
ipcMain.on('preload:log', (_e, { action, channel, ok, detail }) => {
  logger.ipc('preload', `Bridge call: ${channel}`, { action, ok, ...detail });
});
ipcMain.on('preload:token', (_e, state) => {
  logger.auth('preload', `Token state: ${state}`);
});

// ─── WINDOW ───────────────────────────────────────────────────────────────────

function setupTray(){
  logger.info('tray', 'Creating system tray icon');
  const iconPath = path.join(__dirname, '..', 'icon.png');
  let trayIcon;
  try {
    const img = nativeImage.createFromPath(iconPath);
    trayIcon = img.resize({ width:16, height:16 });
  } catch(e){
    trayIcon = nativeImage.createEmpty();
  }
  tray = new Tray(trayIcon);
  tray.setToolTip('Vault');
  const buildTrayMenu = () => Menu.buildFromTemplate([
    { label: 'Show Vault', click: () => { if(win){ win.show(); win.focus(); win.setSkipTaskbar(false); } } },
    { type: 'separator' },
    { label: 'Lock Vault', enabled: !!getSession(), click: () => {
      logger.info('tray', 'Lock vault from tray');
      if(win){ win.webContents.send('tray:lock'); }
    }},
    { type: 'separator' },
    { label: 'Logout', enabled: !!getSession(), click: () => {
      logger.info('tray', 'Logout from tray');
      if(win){ win.webContents.send('tray:logout'); }
    }},
    { type: 'separator' },
    { label: 'Quit', click: () => { logger.info('tray', 'Quit from tray menu'); app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(buildTrayMenu());
  tray.on('right-click', () => { tray.setContextMenu(buildTrayMenu()); });
  tray.on('double-click', () => { if(win){ win.show(); win.focus(); win.setSkipTaskbar(false); } });
}

function createWindow() {
  logger.info('window', 'Creating main window');
  if(!tray) setupTray();
  win = new BrowserWindow({
    width:1100, height:720, minWidth:900, minHeight:580,
    frame:false, transparent:false,
    titleBarStyle:'hidden',
    titleBarOverlay:{ color:'#00000000', symbolColor:'#a78bfa', height:40 },
    icon: path.join(__dirname, '..', 'icon.png'),
    backgroundColor:'#0a0a0f',
    webPreferences:{ preload:path.join(__dirname, '..', 'preload.js'), contextIsolation:true, nodeIntegration:false, spellcheck:false },
  });
  win.loadFile(path.join(__dirname, '..', 'index.html'));

  win.webContents.on('will-navigate', (event, url) => {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== 'file:') {
      logger.warn('security', 'Blocked navigation to external URL', { url });
      event.preventDefault();
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol === 'https:' || parsedUrl.protocol === 'http:') {
      logger.info('security', 'Opening external URL in system browser', { url });
      shell.openExternal(url);
    } else {
      logger.warn('security', 'Blocked new-window creation', { url });
    }
    return { action: 'deny' };
  });

  win.on('minimize', () => { win.webContents.send('win:minimized'); });
  win.on('close', (e) => {
    if(!app.isQuitting){
      e.preventDefault();
      if(process.platform==='darwin'){ win.hide(); }else{ win.minimize(); win.setSkipTaskbar(true); }
    }
  });
  win.on('maximize', () => { if(!win.isDestroyed()) win.webContents.send('win:maximized-state', true); });
  win.on('unmaximize', () => { if(!win.isDestroyed()) win.webContents.send('win:maximized-state', false); });

  logger.success('window', 'Main window created and loaded');
  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode:'detach' });
}

app.whenReady().then(() => {
  logger.info('app', 'Electron app ready');
  CryptoJS  = require('crypto-js');
  setCryptoJS(CryptoJS);
  speakeasy = require('speakeasy');
  const ws = require('ws');
  const { createClient } = require('@supabase/supabase-js');
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
    realtime: { transport: ws }
  });
  logger.success('app', 'Dependencies loaded (CryptoJS, speakeasy, Supabase)');
  jobsModule.register(ipcMain, requireAuth, requireAuthNoArgs, supabase, validation, getSessionFn, logger, logError);
  totpModule.register(ipcMain, requireAuth, requireAuthNoArgs, supabase, getSessionFn, logger, enc, dec, logError);
  settingsModule.register(ipcMain, requireAuth, requireAuthNoArgs, supabase, getSessionFn, logger, logError);
  logoModule.register(ipcMain, requireAuth, supabase, logger, getSessionFn, logError);
  monitorModule.register(ipcMain, requireAdminNoArgs, supabase, logger, getSessionFn, LOG_PATH);
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
