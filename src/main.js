'use strict';

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path   = require('path');
const http   = require('http');
const url    = require('url');
const crypto = require('crypto');
const fs     = require('fs');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const SUPABASE_URL         = 'https://ltqqqsaodxjqwsyzxurf.supabase.co';
const SUPABASE_SERVICE_KEY = 'REDACTED_SUPABASE_SERVICE_KEY';
const GOOGLE_CLIENT_ID     = '621412630191-n52i57ouvdvao99oh75ln06448q4rkos.apps.googleusercontent.com';
const GOOGLE_CLIENT_SECRET = 'REDACTED_GOOGLE_CLIENT_SECRET';
const REDIRECT_URI         = 'http://localhost:42813/oauth2callback';
const SCOPES               = ['openid', 'email', 'profile'];

// Log file: next to the app executable
const LOG_PATH = path.join(
  process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath) || app.getPath('userData'),
  'vault-errors.log'
);

// ─── LOGGING ─────────────────────────────────────────────────────────────────
function logError(ctx, err) {
  const line = `[${new Date().toISOString()}] [${ctx}] ${err?.message||err}\n${err?.stack||''}\n---\n`;
  try { fs.appendFileSync(LOG_PATH, line); } catch {}
  console.error(line);
}
process.on('uncaughtException',  e => logError('uncaughtException', e));
process.on('unhandledRejection', e => logError('unhandledRejection', e));

// ─── STATE ────────────────────────────────────────────────────────────────────
let win, supabase, CryptoJS, speakeasy;
let session = null;
// Track whether an OAuth flow is currently running so we don't double-open
let oauthInProgress = false;
let oauthServer = null;

// ─── CRYPTO ───────────────────────────────────────────────────────────────────
function deriveKey(googleId) { return crypto.createHash('sha256').update('vault:'+googleId).digest('hex').slice(0,32); }
function enc(obj, key) { return CryptoJS.AES.encrypt(JSON.stringify(obj), key).toString(); }
function dec(str, key) { try { return JSON.parse(CryptoJS.AES.decrypt(str,key).toString(CryptoJS.enc.Utf8)); } catch { return null; } }

// ─── DB HELPERS ───────────────────────────────────────────────────────────────
async function dbUpsertUser({ googleId, email, name, avatar }) {
  const { data, error } = await supabase.from('vault_users')
    .upsert({ google_id:googleId, email, name, avatar, last_seen:new Date().toISOString() },{ onConflict:'google_id' })
    .select('id').single();
  if (error) throw error;
  return data.id;
}

async function dbLoadItems(userId, encKey) {
  const { data, error } = await supabase.from('vault_items')
    .select('id,type,encrypted_data,sort_order,created_at')
    .eq('user_id', userId).is('deleted_at', null)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: false });
  if (error) throw error;
  const passwords=[], notes=[];
  for (const row of data) {
    const item = dec(row.encrypted_data, encKey);
    if (!item) continue;
    item._dbId = row.id; item._sort = row.sort_order;
    (row.type==='password' ? passwords : notes).push(item);
  }
  return { passwords, notes };
}

async function dbLoadTrash(userId, encKey) {
  await supabase.from('vault_items').delete().eq('user_id', userId)
    .not('deleted_at','is',null).lt('deleted_at', new Date(Date.now()-30*86400000).toISOString());
  const { data, error } = await supabase.from('vault_items')
    .select('id,type,encrypted_data,deleted_at')
    .eq('user_id', userId).not('deleted_at','is',null).order('deleted_at',{ascending:false});
  if (error) throw error;
  return data.map(row => {
    const item = dec(row.encrypted_data, encKey) || {};
    return { ...item, _dbId:row.id, _type:row.type, _deletedAt:row.deleted_at };
  });
}

async function dbSaveItem(userId, type, item, encKey) {
  const { _dbId, _sort, ...payload } = item;
  const encrypted_data = enc(payload, encKey);
  if (_dbId) {
    const { error } = await supabase.from('vault_items').update({ encrypted_data }).eq('id',_dbId).eq('user_id',userId);
    if (error) throw error; return _dbId;
  }
  const { data, error } = await supabase.from('vault_items')
    .insert({ user_id:userId, type, encrypted_data }).select('id').single();
  if (error) throw error; return data.id;
}

async function dbSoftDelete(dbId, userId) {
  const { error } = await supabase.from('vault_items').update({ deleted_at:new Date().toISOString() }).eq('id',dbId).eq('user_id',userId);
  if (error) throw error;
}
async function dbRestore(dbId, userId) {
  const { error } = await supabase.from('vault_items').update({ deleted_at:null }).eq('id',dbId).eq('user_id',userId);
  if (error) throw error;
}
async function dbPermDelete(dbId, userId) {
  const { error } = await supabase.from('vault_items').delete().eq('id',dbId).eq('user_id',userId);
  if (error) throw error;
}
async function dbUpdateSortOrder(items, userId) {
  // Batch update sort_order for reordering
  await Promise.all(items.map((item, i) =>
    item._dbId ? supabase.from('vault_items').update({ sort_order: i }).eq('id',item._dbId).eq('user_id',userId) : Promise.resolve()
  ));
}

// ── Logo ──────────────────────────────────────────────────────────────────────
async function fetchLogo(site) {
  try {
    let domain = site.replace(/^https?:\/\//,'').replace(/\/.*$/,'').toLowerCase();
    if (!domain.includes('.')) domain += '.com';
    const { data } = await supabase.from('vault_logos').select('url').eq('domain',domain).single();
    if (data) return data.url;
    const faviconUrl = `https://www.google.com/s2/favicons?sz=64&domain=${domain}`;
    await supabase.from('vault_logos').upsert({ domain, url:faviconUrl, cached_at:new Date().toISOString() });
    return faviconUrl;
  } catch { return null; }
}

// ── Jobs ──────────────────────────────────────────────────────────────────────
async function dbLoadJobs(userId) {
  const { data, error } = await supabase.from('vault_jobs').select('*')
    .eq('user_id',userId).order('sort_order',{ascending:true}).order('created_at',{ascending:false});
  if (error) throw error; return data;
}
async function dbSaveJob(userId, job) {
  const { id, ...payload } = job;
  if (id) {
    const { error } = await supabase.from('vault_jobs')
      .update({ ...payload, updated_at:new Date().toISOString() }).eq('id',id).eq('user_id',userId);
    if (error) throw error; return id;
  }
  const { data, error } = await supabase.from('vault_jobs')
    .insert({ user_id:userId, ...payload }).select('id').single();
  if (error) throw error; return data.id;
}
async function dbDeleteJob(id, userId) {
  // Soft-delete: move to trash (same as vault_items pattern)
  const { error } = await supabase.from('vault_jobs')
    .update({ deleted_at: new Date().toISOString() }).eq('id',id).eq('user_id',userId);
  if (error) throw error;
}
async function dbRestoreJob(id, userId) {
  const { error } = await supabase.from('vault_jobs')
    .update({ deleted_at: null }).eq('id',id).eq('user_id',userId);
  if (error) throw error;
}
async function dbPermDeleteJob(id, userId) {
  const { error } = await supabase.from('vault_jobs').delete().eq('id',id).eq('user_id',userId);
  if (error) throw error;
}
async function dbLoadJobTrash(userId) {
  // Auto-purge 30-day-old deleted jobs
  await supabase.from('vault_jobs').delete().eq('user_id',userId)
    .not('deleted_at','is',null).lt('deleted_at', new Date(Date.now()-30*86400000).toISOString());
  const { data, error } = await supabase.from('vault_jobs')
    .select('*').eq('user_id',userId).not('deleted_at','is',null).order('deleted_at',{ascending:false});
  if (error) throw error;
  return data;
}
async function dbLoadJobs(userId) {
  const { data, error } = await supabase.from('vault_jobs').select('*')
    .eq('user_id',userId).is('deleted_at',null)
    .order('sort_order',{ascending:true}).order('created_at',{ascending:false});
  if (error) throw error; return data;
}
  await Promise.all(jobs.map((j,i) =>
    j.id ? supabase.from('vault_jobs').update({ sort_order:i }).eq('id',j.id).eq('user_id',userId) : Promise.resolve()
  ));
}

// ── TOTP Vault ────────────────────────────────────────────────────────────────
async function dbLoadTotp(userId, encKey) {
  const { data, error } = await supabase.from('vault_totp').select('*')
    .eq('user_id',userId).order('sort_order',{ascending:true});
  if (error) throw error;
  return data.map(row => ({
    id: row.id, name: row.name, issuer: row.issuer,
    secret: dec(row.secret, encKey) || '', // decrypt the secret
    icon: row.icon, sort_order: row.sort_order,
  }));
}
async function dbSaveTotp(userId, item, encKey) {
  const { id, ...payload } = item;
  const encSecret = enc(item.secret, encKey);
  if (id) {
    const { error } = await supabase.from('vault_totp')
      .update({ name:payload.name, issuer:payload.issuer, secret:encSecret, icon:payload.icon })
      .eq('id',id).eq('user_id',userId);
    if (error) throw error; return id;
  }
  const { data, error } = await supabase.from('vault_totp')
    .insert({ user_id:userId, name:payload.name, issuer:payload.issuer, secret:encSecret, icon:payload.icon||'🔐' })
    .select('id').single();
  if (error) throw error; return data.id;
}
async function dbDeleteTotp(id, userId) {
  const { error } = await supabase.from('vault_totp').delete().eq('id',id).eq('user_id',userId);
  if (error) throw error;
}

// ── 2FA ───────────────────────────────────────────────────────────────────────
async function db2faGet(userId) { const { data } = await supabase.from('vault_2fa').select('*').eq('user_id',userId).single(); return data; }
async function db2faSave(userId, secret, enabled) { await supabase.from('vault_2fa').upsert({ user_id:userId, secret, enabled }); }
function verify2fa(secret, token) { try { return speakeasy.totp.verify({ secret, encoding:'base32', token, window:1 }); } catch { return false; } }

// ── Settings ──────────────────────────────────────────────────────────────────
async function dbLoadSettings(userId) {
  const { data } = await supabase.from('vault_settings').select('*').eq('user_id',userId).single();
  return data || { lock_timeout: 5, lock_action: 'lock' };
}
async function dbSaveSettings(userId, settings) {
  await supabase.from('vault_settings').upsert({ user_id:userId, ...settings });
}

// ── Monitor ───────────────────────────────────────────────────────────────────
async function dbGetStats(userId) {
  const [items, jobs, jobTrash, itemTrash] = await Promise.all([
    supabase.from('vault_items').select('id',{count:'exact'}).eq('user_id',userId).is('deleted_at',null),
    supabase.from('vault_jobs').select('id',{count:'exact'}).eq('user_id',userId).is('deleted_at',null),
    supabase.from('vault_jobs').select('id',{count:'exact'}).eq('user_id',userId).not('deleted_at','is',null),
    supabase.from('vault_items').select('id',{count:'exact'}).eq('user_id',userId).not('deleted_at','is',null),
  ]);
  let logSize = 0; try { logSize = fs.statSync(LOG_PATH).size; } catch {}

  // Get DB size via pg_database_size
  let dbSizeBytes = 0;
  try {
    const { data } = await supabase.rpc('get_db_size').single();
    if (data) dbSizeBytes = data;
  } catch {}

  return {
    items:      items.count||0,
    jobs:       jobs.count||0,
    trash:      (itemTrash.count||0) + (jobTrash.count||0),
    logSize,
    dbSizeBytes,
  };
}

// ── OAuth ─────────────────────────────────────────────────────────────────────
async function googleOAuth() {
  // Kill any existing OAuth server before starting a new one
  if (oauthServer) { try { oauthServer.close(); } catch {} oauthServer = null; }
  if (oauthInProgress) { oauthInProgress = false; }

  const { google } = require('googleapis');
  const client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT_URI);
  const state  = crypto.randomBytes(16).toString('hex');
  const authUrl = client.generateAuthUrl({ access_type:'offline', scope:SCOPES, state, prompt:'select_account' });

  return new Promise((resolve, reject) => {
    oauthInProgress = true;
    oauthServer = http.createServer(async (req, res) => {
      const parsed = url.parse(req.url, true);
      if (!parsed.pathname.startsWith('/oauth2callback')) return;

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><head><title>Vault — Authenticated</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{height:100vh;overflow:hidden;background:#060612;display:flex;align-items:center;justify-content:center;font-family:'Segoe UI',sans-serif}
  canvas{position:fixed;inset:0;z-index:0}
  .card{position:relative;z-index:1;text-align:center;padding:44px 52px;
    background:rgba(10,10,28,.85);border:1px solid rgba(167,139,250,.25);
    border-radius:20px;backdrop-filter:blur(20px);animation:up .6s cubic-bezier(.22,1,.36,1)}
  @keyframes up{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:none}}
  .shield{width:72px;height:72px;background:rgba(167,139,250,.12);border:1px solid rgba(167,139,250,.3);
    border-radius:20px;display:flex;align-items:center;justify-content:center;margin:0 auto 18px;font-size:32px}
  h2{color:#a78bfa;font-size:22px;font-weight:600;margin-bottom:10px}
  p{color:#64748b;font-size:13px;line-height:1.6}
  .bar{width:220px;height:3px;background:rgba(255,255,255,.08);border-radius:2px;margin:20px auto 0;overflow:hidden}
  .fill{height:100%;background:linear-gradient(90deg,#a78bfa,#6d28d9);border-radius:2px;animation:fill 5s linear forwards}
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
<script>
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

      // Bring app window back to front
      if (win) { win.show(); win.focus(); if (win.isMinimized()) win.restore(); }

      if (!parsed.query.code || parsed.query.state !== state)
        return reject(new Error('OAuth state mismatch'));
      try {
        const { tokens } = await client.getToken(parsed.query.code);
        client.setCredentials(tokens);
        const people = google.people({ version:'v1', auth:client });
        const me = await people.people.get({ resourceName:'people/me', personFields:'emailAddresses,names,photos,metadata' });
        resolve({
          googleId: me.data.metadata?.sources?.[0]?.id || crypto.randomBytes(8).toString('hex'),
          email:    me.data.emailAddresses?.[0]?.value || '',
          name:     me.data.names?.[0]?.displayName    || '',
          avatar:   me.data.photos?.[0]?.url           || null,
        });
      } catch (e) { reject(e); }
    });
    oauthServer.listen(42813, '127.0.0.1', () => shell.openExternal(authUrl));
    setTimeout(() => {
      if (oauthServer) { oauthServer.close(); oauthServer=null; }
      oauthInProgress = false;
      reject(new Error('OAuth timed out'));
    }, 180_000);
  });
}

// ─── SOUNDS ───────────────────────────────────────────────────────────────────
// We send events to renderer to play sounds (Web Audio API)
function playSound(type) { if (win) win.webContents.send('play-sound', type); }

// ─── IPC ──────────────────────────────────────────────────────────────────────
ipcMain.handle('auth:login', async () => {
  if (oauthInProgress) return { ok: false, error: 'Auth already in progress. Please complete it in your browser.' };
  try {
    const profile = await googleOAuth();
    const encKey  = deriveKey(profile.googleId);
    const userId  = await dbUpsertUser(profile);
    const twofa   = await db2faGet(userId);
    if (twofa?.enabled) {
      session = { ...profile, userId, encKey, pending2fa:true };
      return { ok:true, needs2fa:true, user:{ name:profile.name, email:profile.email, avatar:profile.avatar } };
    }
    const vault = await dbLoadItems(userId, encKey);
    session = { ...profile, userId, encKey, pending2fa:false };
    playSound('login');
    return { ok:true, needs2fa:false, user:{ name:profile.name, email:profile.email, avatar:profile.avatar }, vault };
  } catch (e) { logError('auth:login', e); return { ok:false, error:e.message }; }
});

ipcMain.handle('auth:verify2fa', async (_e, { token }) => {
  try {
    if (!session?.pending2fa) return { ok:false, error:'No pending 2FA' };
    const twofa = await db2faGet(session.userId);
    if (!verify2fa(twofa.secret, token)) return { ok:false, error:'Invalid code' };
    session.pending2fa = false;
    const vault = await dbLoadItems(session.userId, session.encKey);
    playSound('login');
    return { ok:true, vault };
  } catch (e) { logError('auth:verify2fa', e); return { ok:false, error:e.message }; }
});

ipcMain.handle('auth:logout', () => {
  playSound('logout'); session=null; return { ok:true };
});

ipcMain.handle('auth:reauth', async () => {
  if (oauthInProgress) return { ok:false, error:'Auth already in progress.' };
  try {
    const profile = await googleOAuth();
    if (session && profile.googleId !== session.googleId) return { ok:false, error:'Different account' };
    const encKey = deriveKey(profile.googleId);
    const userId = await dbUpsertUser(profile);
    const vault  = await dbLoadItems(userId, encKey);
    session = { ...profile, userId, encKey, pending2fa:false };
    playSound('login');
    return { ok:true, user:{ name:profile.name, email:profile.email, avatar:profile.avatar }, vault };
  } catch (e) { logError('auth:reauth', e); return { ok:false, error:e.message }; }
});

ipcMain.handle('vault:save',   async (_e,{type,item}) => { try { return {ok:true,dbId:await dbSaveItem(session.userId,type,item,session.encKey)}; } catch(e){logError('vault:save',e);return{ok:false,error:e.message};} });
ipcMain.handle('vault:delete', async (_e,{dbId})      => { try { await dbSoftDelete(dbId,session.userId);return{ok:true}; } catch(e){logError('vault:delete',e);return{ok:false,error:e.message};} });
ipcMain.handle('vault:sync',   async ()               => { try { return {ok:true,vault:await dbLoadItems(session.userId,session.encKey)}; } catch(e){logError('vault:sync',e);return{ok:false,error:e.message};} });
ipcMain.handle('vault:reorder',async (_e,{type,items})=> { try { await dbUpdateSortOrder(items,session.userId);return{ok:true}; } catch(e){logError('vault:reorder',e);return{ok:false};} });

ipcMain.handle('trash:load',    async ()          => { try { return {ok:true,items:await dbLoadTrash(session.userId,session.encKey)}; } catch(e){logError('trash:load',e);return{ok:false,error:e.message};} });
ipcMain.handle('trash:restore', async (_e,{dbId}) => { try { await dbRestore(dbId,session.userId);return{ok:true}; } catch(e){logError('trash:restore',e);return{ok:false,error:e.message};} });
ipcMain.handle('trash:purge',   async (_e,{dbId}) => { try { await dbPermDelete(dbId,session.userId);return{ok:true}; } catch(e){logError('trash:purge',e);return{ok:false,error:e.message};} });

ipcMain.handle('logo:fetch',    async (_e,{site}) => { try { return {ok:true,url:await fetchLogo(site)}; } catch(e){return{ok:false};} });

ipcMain.handle('jobs:load',   async ()        => { try { return {ok:true,jobs:await dbLoadJobs(session.userId)}; } catch(e){logError('jobs:load',e);return{ok:false,error:e.message};} });
ipcMain.handle('jobs:save',   async (_e,{job})=> { try { return {ok:true,id:await dbSaveJob(session.userId,job)}; } catch(e){logError('jobs:save',e);return{ok:false,error:e.message};} });
ipcMain.handle('jobs:delete', async (_e,{id}) => { try { await dbDeleteJob(id,session.userId);return{ok:true}; } catch(e){logError('jobs:delete',e);return{ok:false,error:e.message};} });
ipcMain.handle('jobs:reorder',async (_e,{jobs})=> { try { await dbUpdateJobOrder(jobs,session.userId);return{ok:true}; } catch(e){logError('jobs:reorder',e);return{ok:false};} });
ipcMain.handle('jobs:trash:load',   async ()          => { try { return {ok:true,items:await dbLoadJobTrash(session.userId)}; } catch(e){logError('jobs:trash:load',e);return{ok:false,error:e.message};} });
ipcMain.handle('jobs:trash:restore',async (_e,{id})   => { try { await dbRestoreJob(id,session.userId);return{ok:true}; } catch(e){logError('jobs:trash:restore',e);return{ok:false,error:e.message};} });
ipcMain.handle('jobs:trash:purge',  async (_e,{id})   => { try { await dbPermDeleteJob(id,session.userId);return{ok:true}; } catch(e){logError('jobs:trash:purge',e);return{ok:false,error:e.message};} });

ipcMain.handle('settings:load', async () => { try { return {ok:true,settings:await dbLoadSettings(session.userId)}; } catch(e){return{ok:true,settings:{lock_timeout:5,lock_action:'lock'}};} });
ipcMain.handle('settings:save', async (_e,{settings}) => { try { await dbSaveSettings(session.userId,settings);return{ok:true}; } catch(e){logError('settings:save',e);return{ok:false};} });

ipcMain.handle('totp:load',   async ()          => { try { return {ok:true,items:await dbLoadTotp(session.userId,session.encKey)}; } catch(e){logError('totp:load',e);return{ok:false,error:e.message};} });
ipcMain.handle('totp:save',   async (_e,{item}) => { try { return {ok:true,id:await dbSaveTotp(session.userId,item,session.encKey)}; } catch(e){logError('totp:save',e);return{ok:false,error:e.message};} });
ipcMain.handle('totp:delete', async (_e,{id})   => { try { await dbDeleteTotp(id,session.userId);return{ok:true}; } catch(e){logError('totp:delete',e);return{ok:false,error:e.message};} });

ipcMain.handle('2fa:status',  async ()           => { try { const d=await db2faGet(session.userId);return{ok:true,enabled:d?.enabled||false}; } catch(e){return{ok:true,enabled:false};} });
ipcMain.handle('2fa:setup',   async ()           => { try { const s=speakeasy.generateSecret({name:`Vault (${session.email})`,length:20});await db2faSave(session.userId,s.base32,false);return{ok:true,secret:s.base32,otpauth:s.otpauth_url}; } catch(e){logError('2fa:setup',e);return{ok:false,error:e.message};} });
ipcMain.handle('2fa:enable',  async (_e,{token})=> { try { const d=await db2faGet(session.userId);if(!d||!verify2fa(d.secret,token))return{ok:false,error:'Invalid code'};await db2faSave(session.userId,d.secret,true);return{ok:true}; } catch(e){logError('2fa:enable',e);return{ok:false,error:e.message};} });
ipcMain.handle('2fa:disable', async ()           => { try { const d=await db2faGet(session.userId);if(d)await db2faSave(session.userId,d.secret,false);return{ok:true}; } catch(e){logError('2fa:disable',e);return{ok:false,error:e.message};} });

ipcMain.handle('monitor:stats', async ()   => { try { return {ok:true,stats:await dbGetStats(session.userId),logPath:LOG_PATH}; } catch(e){logError('monitor:stats',e);return{ok:false,error:e.message};} });
ipcMain.handle('log:read',      async ()   => { try { const t=fs.existsSync(LOG_PATH)?fs.readFileSync(LOG_PATH,'utf8'):'(no errors logged)';return{ok:true,log:t.slice(-10000)}; } catch(e){return{ok:true,log:'(could not read log)'};} });
ipcMain.handle('log:clear',     async ()   => { try { fs.writeFileSync(LOG_PATH,'');return{ok:true}; } catch(e){return{ok:false};} });

ipcMain.on('win:minimize', () => win?.minimize());
ipcMain.on('win:maximize', () => { if(win?.isMaximized())win.unmaximize(); else win?.maximize(); });
ipcMain.on('win:close',    () => win?.close());

// ─── WINDOW ───────────────────────────────────────────────────────────────────
function createWindow() {
  win = new BrowserWindow({
    width:1100, height:720, minWidth:900, minHeight:580,
    frame:false, transparent:true,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    vibrancy:'under-window', visualEffectState:'active',
    backgroundColor:'#00000000',
    webPreferences:{ preload:path.join(__dirname,'preload.js'), contextIsolation:true, nodeIntegration:false, spellcheck:false },
  });
  win.loadFile(path.join(__dirname,'index.html'));
  // Windows snap — handle double-click on titlebar via frontend
  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode:'detach' });
}

app.whenReady().then(() => {
  CryptoJS  = require('crypto-js');
  speakeasy = require('speakeasy');
  const { createClient } = require('@supabase/supabase-js');
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth:{ persistSession:false } });
  createWindow();
});
app.on('window-all-closed', () => { if(process.platform!=='darwin')app.quit(); });
app.on('activate', () => { if(!BrowserWindow.getAllWindows().length)createWindow(); });
