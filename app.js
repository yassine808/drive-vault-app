'use strict';

// ═══ STATE ════════════════════════════════════════════════════════════════════
const S = {
  user:null, passwords:[], notes:[], trash:[], jobs:[], totp:[], activeNote:null,
  jobSort:{ col:'', dir:1 }, jobFilter:'all',
  settings:{ lock_timeout:5, lock_action:'lock',
    lock_countdown:true, lock_on_minimize:false, compact:false, animations:true,
    accent:'violet', sounds:true, sound_login:true, sound_exit:true, sound_hover:false,
    sound_login_tone:'chime', sound_exit_tone:'chime', sound_hover_tone:'click',
  },
};

// ═══ LOGGER ═══════════════════════════════════════════════════════════════════
const RLOG_KEY = 'vault-renderer-log';
const RLOG_MAX = 2000;
function rlog(level, ctx, msg, data) {
  const entry = { ts: new Date().toISOString(), level, ctx, msg, data };
  try {
    const arr = JSON.parse(localStorage.getItem(RLOG_KEY) || '[]');
    arr.push(entry);
    if (arr.length > RLOG_MAX) arr.splice(0, arr.length - RLOG_MAX);
    localStorage.setItem(RLOG_KEY, JSON.stringify(arr));
  } catch {}
}
const logInfo = (ctx, msg, data) => rlog('INFO', ctx, msg, data);
const logOk   = (ctx, msg, data) => rlog('OK', ctx, msg, data);
const logWarn = (ctx, msg, data) => rlog('WARN', ctx, msg, data);
const logErr  = (ctx, msg, data) => rlog('ERROR', ctx, msg, data);
logInfo('app', 'Renderer initialized');

// ═══ UTILS ════════════════════════════════════════════════════════════════════
const uid  = () => Date.now().toString(36) + Math.random().toString(36).slice(2);
const wc   = t => { t=(t||'').trim(); return t?t.split(/\s+/).length:0; };
const days = d => Math.max(0,Math.ceil((30*86400000-(Date.now()-new Date(d)))/86400000));

function toast(msg,ms){if(ms===undefined)ms=S.settings.toast_duration||2400;logInfo('ui', 'Toast: ' + msg);const el=document.getElementById('toast');el.textContent=msg;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),ms);}
function show(id){document.getElementById(id).hidden=false;}
function hide(id){document.getElementById(id).hidden=true;}
function screen(s){['s-login','s-2fa','s-lock','s-app'].forEach(id=>document.getElementById(id).hidden=id!==s);}
function clearAllInputs(){document.querySelectorAll('input:not([type=checkbox]):not([type=range]),textarea').forEach(el=>{el.value='';});}

// ═══ SOUNDS ═══════════════════════════════════════════════════════════════════
const AudioCtx = window.AudioContext||window.webkitAudioContext; let actx;
function getACtx(){if(!actx)actx=new AudioCtx();return actx;}
function playTone(freq,type='sine',dur=0.15,vol=0.18,delay=0){
  try{const ctx=getACtx();const now=ctx.currentTime+delay;const osc=ctx.createOscillator();const gain=ctx.createGain();
  osc.type=type;osc.frequency.setValueAtTime(freq,now);gain.gain.setValueAtTime(0,now);
  gain.gain.linearRampToValueAtTime(vol,now+0.02);gain.gain.exponentialRampToValueAtTime(0.001,now+dur);
  osc.connect(gain);gain.connect(ctx.destination);osc.start(now);osc.stop(now+dur);}catch{}
}
const TONES = {
  chime:  { freqs:[523,659,784,1047],      type:'sine',     dur:0.2,  vol:0.15, gap:0.1  },
  ding:   { freqs:[880,1100],               type:'sine',     dur:0.18, vol:0.18, gap:0.08 },
  soft:   { freqs:[440,554],                type:'sine',     dur:0.25, vol:0.10, gap:0.12 },
  bright: { freqs:[660,880,1100,1320],      type:'triangle', dur:0.15, vol:0.16, gap:0.07 },
  click:  { freqs:[1200],                   type:'square',   dur:0.03, vol:0.06, gap:0    },
  tap:    { freqs:[800],                    type:'sine',     dur:0.04, vol:0.08, gap:0    },
  pop:    { freqs:[600,900],                type:'sine',     dur:0.06, vol:0.10, gap:0.03 },
};
function playToneSeq(toneName){
  const t = TONES[toneName] || TONES.chime;
  t.freqs.forEach((f,i)=>playTone(f, t.type, t.dur, t.vol, i*t.gap));
}
function playSound(type){
  if (window.__soundsEnabled === false) return;
  const s = S.settings;
  switch(type){
    case 'login':
      if (!s.sound_login) return;
      playToneSeq(s.sound_login_tone || 'chime');
      break;
    case 'logout': case 'lock':
      if (!s.sound_exit) return;
      if (s.sound_exit_tone && TONES[s.sound_exit_tone]) {
        const t = TONES[s.sound_exit_tone];
        t.freqs.slice().reverse().forEach((f,i)=>playTone(f, t.type, t.dur, t.vol*0.8, i*t.gap));
      } else {
        [784,659,523].forEach((f,i)=>playTone(f,'sine',0.18,0.12,i*0.09));
      }
      break;
    case 'hover':
      if (!s.sound_hover) return;
      playToneSeq(s.sound_hover_tone || 'click');
      break;
  }
}
function logDebug(ctx, msg) { /* noop */ }
api.onPlaySound(type=>playSound(type));
api.onTrayLock(()=>{ if(S.user){ logInfo('auth', 'Tray lock'); doLock(); hide('tab-monitor'); } });
api.onTrayLogout(()=>{ if(S.user){ logInfo('auth', 'Tray logout'); doLogout(); hide('tab-monitor'); } });

// ═══ SOUND TEST BUTTONS ════════════════════════════════════════════════════════
function testSound(soundType) {
  if (window.__soundsEnabled === false) return;
  const s = S.settings;
  switch(soundType) {
    case 'login':
      playToneSeq(s.sound_login_tone || 'chime');
      break;
    case 'exit':
      if (s.sound_exit_tone && TONES[s.sound_exit_tone]) {
        const t = TONES[s.sound_exit_tone];
        t.freqs.slice().reverse().forEach((f,i)=>playTone(f, t.type, t.dur, t.vol*0.8, i*t.gap));
      } else {
        [784,659,523].forEach((f,i)=>playTone(f,'sine',0.18,0.12,i*0.09));
      }
      break;
    case 'hover':
      playToneSeq(s.sound_hover_tone || 'click');
      break;
  }
}
document.getElementById('btn-test-login-sound').addEventListener('click', () => testSound('login'));
document.getElementById('btn-test-exit-sound').addEventListener('click', () => testSound('exit'));
document.getElementById('btn-test-hover-sound').addEventListener('click', () => testSound('hover'));

// ═══ WINDOWS SNAP ═════════════════════════════════════════════════════════════
document.getElementById('titlebar').addEventListener('dblclick',e=>{
  if(e.target.closest('.tb-right'))return;
  logInfo('ui', 'Titlebar double-clicked — maximize toggle');
  api.maximize();
});

// ═══ AMBIENT BACKGROUND ══════════════════════════════════════════════════════
(function initCanvas(){
  const canvas=document.getElementById('bg-canvas');
  const ctx=canvas.getContext('2d');
  let W,H;

  // Slow-drifting purple nebulae — visible glowing clouds
  const nebulae=[
    {x:.2,y:.3,r:.42,sx:.015,sy:.01,h:290,b:.20},    // bright purple (upper-left)
    {x:.75,y:.6,r:.48,sx:-.01,sy:.012,h:290,b:.18},  // bright purple (lower-right)
    {x:.5,y:.15,r:.35,sx:.008,sy:-.006,h:290,b:.14}, // purple (top-center)
    {x:.65,y:.8,r:.32,sx:-.005,sy:.008,h:270,b:.14}, // deep indigo (bottom)
    {x:.15,y:.7,r:.28,sx:.006,sy:.007,h:280,b:.12},  // mid purple (left)
    {x:.85,y:.25,r:.25,sx:-.007,sy:.005,h:300,b:.12}, // lavender (right)
  ];

  function resize(){W=canvas.width=window.innerWidth;H=canvas.height=window.innerHeight;}
  window.addEventListener('resize',resize);resize();

  let t=0;
  function draw(){
    t+=.004;
    ctx.clearRect(0,0,W,H);

    for(const n of nebulae){
      // Gentle figure-8 drift so shapes never feel static
      const cx=W*(n.x+Math.sin(t*n.sx*10)*.08);
      const cy=H*(n.y+Math.cos(t*n.sy*10)*.06);
      const rad=Math.min(W,H)*n.r;

      const grad=ctx.createRadialGradient(cx,cy,0,cx,cy,rad);
      const b=n.b||.06;
      if(n.h===290){
        grad.addColorStop(0,`oklch(0.75 0.26 290 / ${b})`);
        grad.addColorStop(.3,`oklch(0.68 0.24 290 / ${b*.5})`);
        grad.addColorStop(.6,`oklch(0.6 0.2 290 / ${b*.15})`);
        grad.addColorStop(1,'oklch(0.6 0.2 290 / 0)');
      }else if(n.h===300){
        grad.addColorStop(0,`oklch(0.75 0.24 300 / ${b})`);
        grad.addColorStop(.3,`oklch(0.68 0.22 300 / ${b*.45})`);
        grad.addColorStop(.6,`oklch(0.58 0.18 300 / ${b*.12})`);
        grad.addColorStop(1,'oklch(0.58 0.18 300 / 0)');
      }else{
        grad.addColorStop(0,`oklch(0.7 0.22 270 / ${b})`);
        grad.addColorStop(.3,`oklch(0.6 0.2 270 / ${b*.45})`);
        grad.addColorStop(.6,`oklch(0.52 0.16 270 / ${b*.12})`);
        grad.addColorStop(1,'oklch(0.52 0.16 270 / 0)');
      }
      ctx.fillStyle=grad;
      ctx.fillRect(0,0,W,H);
    }

    // Subtle vignette — edges fall off, center stays open
    const vg=ctx.createRadialGradient(W/2,H/2,Math.min(W,H)*.25,W/2,H/2,Math.max(W,H)*.7);
    vg.addColorStop(0,'oklch(0 0 0 / 0)');
    vg.addColorStop(1,'oklch(0 0 0 / 0.25)');
    ctx.fillStyle=vg;
    ctx.fillRect(0,0,W,H);

    requestAnimationFrame(draw);
  }
  draw();
})();

// ═══ CONFIRM ══════════════════════════════════════════════════════════════════
function confirm(opts){
  logInfo('ui', 'Confirm dialog shown', { title: opts.title });
  document.getElementById('confirm-title').textContent=opts.title||'Are you sure?';
  document.getElementById('confirm-msg').textContent=opts.msg||'';
  document.getElementById('confirm-icon').textContent=opts.icon||'🗑️';
  const okBtn=document.getElementById('confirm-ok');
  const newOk=okBtn.cloneNode(true);okBtn.parentNode.replaceChild(newOk,okBtn);
  newOk.textContent=opts.okLabel||'Delete';newOk.className=opts.okClass||'btn-danger';
  newOk.addEventListener('click',()=>{hide('confirm-overlay');logInfo('ui', 'Confirm dialog accepted', { title: opts.title });opts.onOk();});
  show('confirm-overlay');
}
document.getElementById('confirm-cancel').addEventListener('click',()=>{ hide('confirm-overlay'); logInfo('ui', 'Confirm dialog cancelled'); });
document.getElementById('confirm-overlay').addEventListener('click',e=>{if(e.target===document.getElementById('confirm-overlay')){ hide('confirm-overlay'); logInfo('ui', 'Confirm dialog dismissed (overlay click)'); }});

// ═══ AUTO-LOCK ════════════════════════════════════════════════════════════════
let LOCK_MS=5*60*1000;
let lockTimer,lockTick,lockDeadline;
function applyLockSettings(){
  const t=S.settings.lock_timeout;
  LOCK_MS=t>0?t*60*1000:Infinity;
  const row=document.getElementById('lock-row');
  const showCountdown = S.settings.lock_countdown !== false;
  if(row)row.hidden=(t===0 || !showCountdown);
  logInfo('settings', 'Lock settings applied', { timeout: t, lockMs: LOCK_MS });
}
function armLock(){
  clearTimeout(lockTimer);clearInterval(lockTick);
  if(S.settings.lock_timeout===0)return;
  lockDeadline=Date.now()+LOCK_MS;
  const row=document.getElementById('lock-row');
  if(row && S.settings.lock_countdown !== false)row.hidden=false;
  lockTick=setInterval(()=>{
    const rem=Math.max(0,lockDeadline-Date.now());
    const m=Math.floor(rem/60000),s=Math.floor((rem%60000)/1000);
    const el=document.getElementById('lock-label');
    if(el)el.textContent=`locks in ${m}:${String(s).padStart(2,'0')}`;
    if(rem<=0)clearInterval(lockTick);
  },1000);
  lockTimer=setTimeout(()=>{
    logInfo('auth', 'Auto-lock timer expired');
    playSound('lock');
    if(S.settings.lock_action==='exit'){ logInfo('auth', 'Lock action: exit'); api.close(); } else doLock();
  },LOCK_MS);
}
function disarmLock(){clearTimeout(lockTimer);clearInterval(lockTick);const row=document.getElementById('lock-row');if(row)row.hidden=true;}
function doLock(){
  logInfo('auth', 'Locking vault');
  disarmLock();
  // Clear all sensitive data from renderer memory before locking
  S.passwords=[];S.notes=[];S.totp=[];S.jobs=[];S.trash=[];S.activeNote=null;
  // Remove any password DOM elements that might retain plaintext in memory
  document.querySelectorAll('.pw-real').forEach(el=>{el.textContent='';el.remove();});
  api.lock();screen('s-lock');
  logInfo('auth', 'Sensitive data cleared from memory on lock');
}
['mousemove','keydown','mousedown','touchstart'].forEach(e=>document.addEventListener(e,()=>{if(S.user&&S.settings.lock_timeout>0)armLock();},{passive:true}));

document.getElementById('btn-unlock').addEventListener('click',async()=>{
  const btn=document.getElementById('btn-unlock');
  if(btn.disabled)return;
  logInfo('auth', 'Unlock button clicked');
  btn.textContent='Opening browser…';btn.disabled=true;
  const r=await api.reauth();
  if(r.ok){if(r.token)window.__vaultToken.set(r.token);S.user=r.user;loadVault(r.vault);screen('s-app');armLock();toast('Vault unlocked');logOk('auth', 'Vault unlocked via reauth', { email: S.user?.email });}
  else{btn.textContent='Unlock with Google';btn.disabled=false;toast('Unlock failed: '+r.error);logErr('auth', 'Unlock failed', r.error);}
});

// ═══ AUTH ═════════════════════════════════════════════════════════════════════
document.getElementById('btn-login').addEventListener('click',async()=>{
  const btn=document.getElementById('btn-login');
  if(btn.disabled)return;
  logInfo('auth', 'Login button clicked');
  btn.textContent='Opening browser…';btn.disabled=true;
  const r=await api.login();
  if(!r.ok){const err=document.getElementById('login-err');err.hidden=false;err.textContent=r.error;logErr('auth', 'Login failed', r.error);btn.textContent='Sign in with Google';btn.disabled=false;return;}
  if(r.needs2fa){S.user=r.user;screen('s-2fa');btn.textContent='Sign in with Google';btn.disabled=false;logInfo('auth', 'Login requires 2FA', { email: S.user?.email });return;}
  if(r.token)window.__vaultToken.set(r.token);
  S.user=r.user;loadVault(r.vault);await loadSettings();enterApp();
  logOk('auth', 'Login successful', { email: S.user?.email });
});
document.getElementById('btn-verify2fa').addEventListener('click',async()=>{
  const token=document.getElementById('twofa-code').value.trim();
  logInfo('auth', '2FA verify attempt');
  const r=await api.verify2fa(token);
  if(!r.ok){document.getElementById('twofa-err').hidden=false;document.getElementById('twofa-err').textContent=r.error;logWarn('auth', '2FA verify failed', r.error);return;}
  if(r.token)window.__vaultToken.set(r.token);
  loadVault(r.vault);await loadSettings();enterApp();
  logOk('auth', '2FA verified, login complete');
});
document.getElementById('twofa-code').addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('btn-verify2fa').click();});

async function doLogout(){
  logInfo('auth', 'Logout clicked', { user: S.user?.email });
  playSound('logout');await api.logout();
  S.user=null;S.passwords=[];S.notes=[];S.trash=[];S.jobs=[];S.totp=[];S.activeNote=null;
  disarmLock();clearAllInputs();screen('s-login');
  document.getElementById('btn-login').textContent='Sign in with Google';
  document.getElementById('btn-login').disabled=false;
  document.getElementById('login-err').hidden=true;
  logOk('auth', 'Logged out, state cleared');
}
document.getElementById('btn-logout').addEventListener('click',()=>doLogout());

function loadVault(v){S.passwords=v?.passwords||[];S.notes=v?.notes||[];logInfo('vault', 'Vault loaded into memory', { passwords: S.passwords.length, notes: S.notes.length });}
async function loadSettings(){
  const r=await api.settings.load();
  if(r.ok)S.settings={...S.settings,...r.settings};
  applyLockSettings();
  // Apply visual settings immediately so they persist across tab switches
  applyAccent(S.settings.accent || 'violet');
  document.body.classList.toggle('compact', !!S.settings.compact);
  document.body.style.setProperty('--transition', S.settings.animations ? '' : '0s');
  window.__soundsEnabled = S.settings.sounds !== false;
  logInfo('settings', 'Settings loaded', S.settings);
}
const ADMIN_EMAIL = 'ysmagri@gmail.com';
function isAdmin(){return S.user?.email === ADMIN_EMAIL;}
function enterApp(){
  logInfo('app', 'Entering app screen');
  screen('s-app');renderUserChip();
  // Show/hide admin-only nav items
  const showAdmin = isAdmin();
  document.querySelectorAll('.admin-only-nav').forEach(el=>el.hidden=!showAdmin);
  if(!showAdmin && document.querySelector('.nav-btn.active')?.dataset.tab==='monitor')switchTab('passwords');
  switchTab('passwords');armLock();
}
function renderUserChip(){
  const u=S.user;const init=(u.name||u.email||'?')[0].toUpperCase();
  const chip=document.getElementById('user-chip');chip.innerHTML='';
  if(u.avatar){
    const img=document.createElement('img');img.className='avatar';
    if(u.avatar.startsWith('https://')){img.src=u.avatar;}
    chip.appendChild(img);
  }else{
    const fb=document.createElement('div');fb.className='avatar-fb';fb.textContent=init;
    chip.appendChild(fb);
  }
  const info=document.createElement('div');
  const nm=document.createElement('div');nm.className='u-name';nm.textContent=u.name||'';
  const em=document.createElement('div');em.className='u-email';em.textContent=u.email||'';
  info.appendChild(nm);info.appendChild(em);
  chip.appendChild(info);
}

// ═══ TABS ══════════════════════════════════════════════════════════════════════
document.querySelectorAll('.nav-btn[data-tab]').forEach(btn=>btn.addEventListener('click',()=>switchTab(btn.dataset.tab)));
function switchTab(tab){
  // Admin guard: non-admins can't open the monitor tab
  if(tab==='monitor'&&!isAdmin()){logWarn('ui', 'Non-admin tried to open monitor tab');return;}
  logInfo('ui', 'Tab switched', { tab });
  document.querySelectorAll('.nav-btn[data-tab]').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));
  ['passwords','notes','jobs','totp','trash','monitor','settings'].forEach(t=>document.getElementById('tab-'+t).hidden=t!==tab);
  if(tab==='passwords')renderPasswords();
  if(tab==='notes')renderNotesList();
  if(tab==='trash')loadAndRenderTrash();
  if(tab==='jobs')loadAndRenderJobs();
  if(tab==='totp')loadAndRenderTotp();
  if(tab==='monitor')loadMonitor();
  if(tab==='settings')loadSettingsTab();
  updateCounts();
}
function updateCounts(){
  document.getElementById('cnt-pw').textContent=S.passwords.length;
  document.getElementById('cnt-notes').textContent=S.notes.length;
  document.getElementById('cnt-trash').textContent=S.trash.length;
  document.getElementById('cnt-jobs').textContent=S.jobs.length;
  document.getElementById('cnt-totp').textContent=S.totp.length;
}
document.getElementById('btn-sync').addEventListener('click',async()=>{
  logInfo('vault', 'Sync triggered');
  const btn=document.getElementById('btn-sync');
  btn.style.opacity='.5';btn.style.pointerEvents='none';
  const r=await api.sync();
  btn.style.opacity='';btn.style.pointerEvents='';
  if(r.ok){loadVault(r.vault);switchTab('passwords');toast('Synced ✓');logOk('vault', 'Sync successful');}
  else { toast('Sync error: '+r.error); logErr('vault', 'Sync failed', r.error); }
});

// ═══ PASSWORDS ════════════════════════════════════════════════════════════════
document.getElementById('btn-add-pw').addEventListener('click',()=>{ logInfo('password', 'Add password clicked'); openPwModal(); });
document.getElementById('pw-search').addEventListener('input',renderPasswords);

const logoCache={};
async function getLogo(site){
  if(!site)return null;
  if(logoCache[site]!==undefined)return logoCache[site];
  const r=await api.logoFetch(site);
  logoCache[site]=r.ok?r.url:null;
  return logoCache[site];
}

// HIBP breach check
const breachCache={};
async function checkBreach(password){
  try{
    const sha1=await crypto.subtle.digest('SHA-1',new TextEncoder().encode(password));
    const hex=Array.from(new Uint8Array(sha1)).map(b=>b.toString(16).padStart(2,'0')).join('').toUpperCase();
    const prefix=hex.slice(0,5),suffix=hex.slice(5);
    if(breachCache[prefix]!==undefined)return breachCache[prefix].includes(suffix);
    const res=await fetch(`https://api.pwnedpasswords.com/range/${prefix}`);
    const text=await res.text();
    breachCache[prefix]=text;
    return text.includes(suffix);
  }catch{return false;}
}

function renderPasswords(){
  const q=document.getElementById('pw-search').value.toLowerCase();
  const list=S.passwords.filter(p=>!q||p.site?.toLowerCase().includes(q)||p.username?.toLowerCase().includes(q));
  const wrap=document.getElementById('pw-list');
  wrap.querySelectorAll('.pw-row').forEach(e=>e.remove());
  document.getElementById('pw-empty').hidden=!!list.length;
  if(!list.length)return;

  list.forEach(pw=>{
    const row=document.createElement('div');row.className='pw-row';
    const initial=(pw.site||'?')[0].toUpperCase();

    const iconDiv=document.createElement('div');iconDiv.className='pw-icon';iconDiv.id='icon-'+(pw.id||'x');iconDiv.textContent=initial;row.appendChild(iconDiv);
    const infoDiv=document.createElement('div');infoDiv.className='pw-info';
    const siteDiv=document.createElement('div');siteDiv.className='pw-site';siteDiv.textContent=pw.site||'';infoDiv.appendChild(siteDiv);
    const userDiv=document.createElement('div');userDiv.className='pw-user';userDiv.textContent=pw.username||'';infoDiv.appendChild(userDiv);
    if(pw.notes){const noteDiv=document.createElement('div');noteDiv.className='pw-note';noteDiv.textContent=pw.notes;infoDiv.appendChild(noteDiv);}
    row.appendChild(infoDiv);
    const pwWrap=document.createElement('div');pwWrap.className='pw-pw-wrap';
    const hidSpan=document.createElement('span');hidSpan.className='pw-hidden';hidSpan.textContent='••••••••';pwWrap.appendChild(hidSpan);
    const revSpan=document.createElement('span');revSpan.className='pw-real';revSpan.hidden=true;revSpan.textContent=pw.password||'';pwWrap.appendChild(revSpan);
    const smWrap=document.createElement('div');smWrap.className='pw-inline-sm';smWrap.id='psm-'+pw.id;smWrap.hidden=true;
    const smBars=document.createElement('div');smBars.className='sm-bars sm-inline';for(let i=0;i<4;i++){const b=document.createElement('div');b.className='sm-bar';smBars.appendChild(b);}
    smWrap.appendChild(smBars);
    const smLbl=document.createElement('span');smLbl.className='sm-lbl psm-lbl';smLbl.textContent='—';smWrap.appendChild(smLbl);
    const breachBadge=document.createElement('span');breachBadge.className='breach-badge';breachBadge.id='breach-'+pw.id;breachBadge.hidden=true;breachBadge.textContent='⚠️ breached';smWrap.appendChild(breachBadge);
    pwWrap.appendChild(smWrap);
    const eyeBtn=document.createElement('button');eyeBtn.className='eye-inline';eyeBtn.title='Hold to show';
    eyeBtn.innerHTML='<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
    pwWrap.appendChild(eyeBtn);
    row.appendChild(pwWrap);
    const actsDiv=document.createElement('div');actsDiv.className='pw-acts';
    const copyBtn=document.createElement('button');copyBtn.className='icon-btn copy';copyBtn.title='Copy password';
    copyBtn.innerHTML='<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    actsDiv.appendChild(copyBtn);
    const editBtn=document.createElement('button');editBtn.className='icon-btn';editBtn.title='Edit';
    editBtn.innerHTML='<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
    actsDiv.appendChild(editBtn);
    const delBtn=document.createElement('button');delBtn.className='icon-btn del';delBtn.title='Move to trash';
    delBtn.innerHTML='<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';
    actsDiv.appendChild(delBtn);
    row.appendChild(actsDiv);
    getLogo(pw.site).then(url=>{
      const el=document.getElementById('icon-'+pw.id);
      if(el&&url){
        el.innerHTML='';
        const img=document.createElement('img');img.width=22;img.height=22;
        img.style.borderRadius='4px';img.style.objectFit='contain';
        if(url.startsWith('https://')){img.src=url;}
        img.addEventListener('error',()=>{img.remove();});
        el.appendChild(img);
      }
    });
    eyeBtn.addEventListener('mousedown',()=>{
      hidSpan.hidden=true;revSpan.hidden=false;
      smWrap.hidden=false;
      updateInlineSm(smWrap,pw.password||'');
      checkBreach(pw.password||'').then(breached=>{
        const b=document.getElementById('breach-'+pw.id);
        if(b)b.hidden=!breached;
      });
    });
    const hideEye=()=>{hidSpan.hidden=false;revSpan.hidden=true;smWrap.hidden=true;};
    eyeBtn.addEventListener('mouseup',hideEye);
    eyeBtn.addEventListener('mouseleave',hideEye);
    eyeBtn.addEventListener('touchstart',e=>{e.preventDefault();hidSpan.hidden=true;revSpan.hidden=false;smWrap.hidden=false;updateInlineSm(smWrap,pw.password||'');},{passive:false});
    eyeBtn.addEventListener('touchend',hideEye);

    copyBtn.onclick=()=>{
      navigator.clipboard.writeText(pw.password||'');
      toast('Password copied! (clipboard clears in 30s)');
      logInfo('password', 'Password copied to clipboard', { site: pw.site });
      // Auto-clear clipboard after 30 seconds to minimize exposure window
      setTimeout(()=>{navigator.clipboard.writeText('')?.catch?.(()=>{});logInfo('password', 'Clipboard auto-cleared');},30000);
    };
    editBtn.onclick=()=>{ logInfo('password', 'Edit password', { site: pw.site }); openPwModal(pw); };
    delBtn.onclick=()=>confirm({
      title:'Move to Trash?',msg:`"${pw.site}" will be moved to Trash and auto-deleted after 30 days.`,
      icon:'🗑️',okLabel:'Move to Trash',
      onOk:async()=>{
        logInfo('password', 'Moving to trash', { site: pw.site, dbId: pw._dbId });
        if(pw._dbId)await api.delete(pw._dbId);
        S.passwords=S.passwords.filter(p=>p.id!==pw.id);
        renderPasswords();updateCounts();toast('Moved to Trash');
        logOk('password', 'Moved to trash', { site: pw.site });
      }
    });
    wrap.appendChild(row);
  });
}

function updateInlineSm(wrap,pw){
  const{n,lbl,cls}=scoreP(pw);
  wrap.querySelectorAll('.sm-bar').forEach((b,i)=>{b.className='sm-bar'+(i<n?` l${n}`:'');});
  const l=wrap.querySelector('.psm-lbl');if(l){l.textContent=lbl;l.className='sm-lbl psm-lbl '+cls;}
}

let _pwEx=null;
function openPwModal(existing=null){
  _pwEx=existing;
  logInfo('password', existing ? 'Opening edit password modal' : 'Opening add password modal', { site: existing?.site });
  document.getElementById('modal-title').textContent=existing?'Edit password':'Add password';
  document.getElementById('f-site').value=existing?.site||'';
  document.getElementById('f-user').value=existing?.username||'';
  document.getElementById('f-pw').value=existing?.password||'';
  document.getElementById('f-pw').type='password';
  document.getElementById('f-notes').value=existing?.notes||'';
  updateSm('sm',existing?.password||'');
  const pwInp=document.getElementById('f-pw');
  const newInp=pwInp.cloneNode(true);pwInp.parentNode.replaceChild(newInp,pwInp);
  newInp.addEventListener('input',()=>updateSm('sm',newInp.value));
  show('modal-overlay');setTimeout(()=>document.getElementById('f-site').focus(),60);
}
document.getElementById('eye-btn').addEventListener('click',()=>{
  const f=document.getElementById('f-pw');f.type=f.type==='password'?'text':'password';
});
document.getElementById('use-gen-btn').addEventListener('click',()=>openGen(true));
document.getElementById('modal-ok').addEventListener('click',async()=>{
  const site=document.getElementById('f-site').value.trim();
  const username=document.getElementById('f-user').value.trim();
  const password=document.getElementById('f-pw').value;
  const notes=document.getElementById('f-notes').value.trim();
  if(!site||!password){toast('Site and password required');return;}
  const existing=_pwEx;hide('modal-overlay');
  if(existing){
    Object.assign(existing,{site,username,password,notes});
    const r=await api.save('password',existing);
    if(r.ok&&!existing._dbId)existing._dbId=r.dbId;
    toast('Updated');
    logOk('password', 'Password updated', { site });
  }else{
    const item={id:uid(),site,username,password,notes};
    const r=await api.save('password',item);
    if(r.ok)item._dbId=r.dbId;
    S.passwords.unshift(item);toast('Saved');
    logOk('password', 'Password created', { site });
  }
  renderPasswords();updateCounts();
});
document.getElementById('modal-cancel').addEventListener('click',()=>hide('modal-overlay'));
document.getElementById('modal-overlay').addEventListener('click',e=>{if(e.target===document.getElementById('modal-overlay'))hide('modal-overlay');});

// ═══ NOTES with drag reorder (vertical only) ═══════════════════════════════
document.getElementById('btn-add-note').addEventListener('click',async()=>{
  logInfo('note', 'New note created');
  const note={id:uid(),title:'Untitled',body:''};
  const r=await api.save('note',note);if(r.ok)note._dbId=r.dbId;
  S.notes.unshift(note);renderNotesList();updateCounts();openNote(note.id);
});

function renderNotesList(){
  const wrap=document.getElementById('notes-list');
  wrap.querySelectorAll('.note-chip').forEach(e=>e.remove());
  document.getElementById('notes-empty').hidden=!!S.notes.length;
  if(!S.notes.length)return;
  S.notes.forEach(n=>{
    const el=document.createElement('div');
    el.className='note-chip draggable'+(n.id===S.activeNote?' active':'');
    el.draggable=true;el.dataset.id=n.id;
    const dragHandle=document.createElement('span');dragHandle.className='drag-handle';dragHandle.textContent='⠿';el.appendChild(dragHandle);
    const chipBody=document.createElement('div');chipBody.className='note-chip-body';
    const ncTitle=document.createElement('div');ncTitle.className='nc-title';ncTitle.textContent=n.title||'Untitled';chipBody.appendChild(ncTitle);
    const ncPrev=document.createElement('div');ncPrev.className='nc-prev';ncPrev.textContent=n.body?.slice(0,55)||'Empty';chipBody.appendChild(ncPrev);
    chipBody.onclick=()=>openNote(n.id);
    el.appendChild(chipBody);
    addVerticalDrag(el,'notes-list',()=>api.reorder('note',S.notes));
    wrap.appendChild(el);
  });
}

function openNote(id){
  S.activeNote=id;const note=S.notes.find(n=>n.id===id);if(!note)return;
  logInfo('note', 'Note opened', { noteId: id, title: note.title });
  renderNotesList();
  const editor=document.getElementById('note-editor');
  editor.innerHTML='';
  const toolbar=document.createElement('div');toolbar.className='note-toolbar';
  const titleInp=document.createElement('input');titleInp.className='note-title-inp';titleInp.id='n-title';titleInp.value=note.title||'';titleInp.placeholder='Title';toolbar.appendChild(titleInp);
  const nDel=document.createElement('button');nDel.className='icon-btn del';nDel.id='n-del';
  nDel.innerHTML='<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';
  toolbar.appendChild(nDel);
  editor.appendChild(toolbar);
  const bodyArea=document.createElement('textarea');bodyArea.className='note-body';bodyArea.id='n-body';bodyArea.placeholder='Start writing…';bodyArea.value=note.body||'';editor.appendChild(bodyArea);
  const noteFoot=document.createElement('div');noteFoot.className='note-foot';
  const wcSpan=document.createElement('span');wcSpan.id='n-wc';wcSpan.textContent=wc(note.body)+' words';noteFoot.appendChild(wcSpan);
  const statusSpan=document.createElement('span');statusSpan.id='n-status';statusSpan.textContent='Saved';noteFoot.appendChild(statusSpan);
  editor.appendChild(noteFoot);
  let st;
  const autoSave=async()=>{
    note.title=document.getElementById('n-title').value;
    note.body=document.getElementById('n-body').value;
    document.getElementById('n-wc').textContent=wc(note.body)+' words';
    renderNotesList();document.getElementById('n-status').textContent='Saving…';
    const r=await api.save('note',note);if(r.ok&&!note._dbId)note._dbId=r.dbId;
    const s=document.getElementById('n-status');if(s)s.textContent='Saved';
    logOk('note', 'Note auto-saved', { noteId: id, title: note.title });
  };
  document.getElementById('n-title').addEventListener('input',()=>{clearTimeout(st);st=setTimeout(autoSave,700);});
  document.getElementById('n-body').addEventListener('input', ()=>{clearTimeout(st);st=setTimeout(autoSave,700);});
  document.getElementById('n-del').addEventListener('click',()=>confirm({
    title:'Move to Trash?',msg:`"${note.title||'Untitled'}" will be moved to Trash.`,icon:'🗑️',okLabel:'Move to Trash',
    onOk:async()=>{
      logInfo('note', 'Note moved to trash', { noteId: id, title: note.title });
      if(note._dbId)await api.delete(note._dbId);
      S.notes=S.notes.filter(n=>n.id!==id);S.activeNote=null;
      renderNotesList();updateCounts();
      document.getElementById('note-editor').innerHTML='<p class="note-placeholder">Select or create a note</p>';
      toast('Moved to Trash');
    }
  }));
}

// ═══ VERTICAL-ONLY DRAG ═══════════════════════════════════════════════════════
let dragSrc=null;
function addVerticalDrag(el,listId,onReorder){
  el.addEventListener('dragstart',e=>{
    dragSrc=el;
    e.dataTransfer.effectAllowed='move';
    e.dataTransfer.setData('text/plain','');
    setTimeout(()=>el.classList.add('dragging'),0);
  });
  el.addEventListener('dragend',()=>{el.classList.remove('dragging');dragSrc=null;});
  el.addEventListener('dragover',e=>{
    e.preventDefault();e.dataTransfer.dropEffect='move';
    if(dragSrc&&dragSrc!==el){
      const wrap=document.getElementById(listId);
      const items=[...wrap.querySelectorAll('.draggable')];
      const srcIdx=items.indexOf(dragSrc),tgtIdx=items.indexOf(el);
      if(srcIdx<tgtIdx)el.after(dragSrc);else el.before(dragSrc);
    }
  });
  el.addEventListener('drop',e=>{
    e.preventDefault();
    const wrap=document.getElementById(listId);
    const newOrder=[...wrap.querySelectorAll('.draggable')].map(e=>e.dataset.id);
    S.notes=newOrder.map(id=>S.notes.find(n=>n.id===id)).filter(Boolean);
    onReorder&&onReorder();
  });
}

// ═══ TRASH ════════════════════════════════════════════════════════════════════
async function loadAndRenderTrash(){
  logInfo('trash', 'Loading trash');
  const wrap=document.getElementById('trash-list');
  wrap.querySelectorAll('.trash-row').forEach(e=>e.remove());
  wrap.querySelector('.trash-loading')?.remove();
  const loading=document.createElement('div');loading.className='empty trash-loading';
  loading.innerHTML='<p style="color:var(--muted)">Loading…</p>';wrap.appendChild(loading);

  const [r1,r2]=await Promise.all([api.trashLoad(),api.jobsTrash.load()]);
  loading.remove();
  if (!r1.ok) logErr('trash', 'Failed to load vault trash', r1.error);
  if (!r2.ok) logErr('trash', 'Failed to load job trash', r2.error);
  const vaultItems=r1.ok?r1.items:[];
  const jobItems=(r2.ok?r2.items:[]).map(j=>({...j,_type:'job',_dbId:j.id,_deletedAt:j.deleted_at}));
  S.trash=[...vaultItems,...jobItems].sort((a,b)=>new Date(b._deletedAt)-new Date(a._deletedAt));
  updateCounts();
  document.getElementById('trash-empty').hidden=!!S.trash.length;
  logOk('trash', 'Trash loaded', { count: S.trash.length });
  if(!S.trash.length)return;

  S.trash.forEach(item=>{
    const isNote=item._type==='note';
    const isJob=item._type==='job';
    const label=isNote?(item.title||'Untitled note'):isJob?(item.company||'Unknown company'):(item.site||'Unknown site');
    const sub=isNote?(item.body?.slice(0,40)||''):isJob?(item.role||''):(item.username||'');
    const d=days(item._deletedAt);
    const icon=isNote?'📝':isJob?'💼':'🔑';
    const row=document.createElement('div');row.className='trash-row';
    const trashIcon=document.createElement('div');trashIcon.className='trash-icon';trashIcon.textContent=icon;row.appendChild(trashIcon);
    const pwInfo=document.createElement('div');pwInfo.className='pw-info';
    const pwSite=document.createElement('div');pwSite.className='pw-site';pwSite.textContent=label;pwInfo.appendChild(pwSite);
    const pwUser=document.createElement('div');pwUser.className='pw-user';pwUser.textContent=sub;pwInfo.appendChild(pwUser);
    row.appendChild(pwInfo);
    const trashDays=document.createElement('div');trashDays.className='trash-days';trashDays.textContent=d+'d left';row.appendChild(trashDays);
    const pwActs=document.createElement('div');pwActs.className='pw-acts';
    const restBtn=document.createElement('button');restBtn.className='icon-btn restore';restBtn.title='Restore';
    restBtn.innerHTML='<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4"/></svg>';
    pwActs.appendChild(restBtn);
    const delBtn=document.createElement('button');delBtn.className='icon-btn del';delBtn.title='Delete forever';
    delBtn.innerHTML='<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    pwActs.appendChild(delBtn);
    row.appendChild(pwActs);
    restBtn.onclick=()=>confirm({
      title:'Restore?',msg:`"${label}" will be restored.`,icon:'↩️',okLabel:'Restore',okClass:'btn-primary',
      onOk:async()=>{
        let ok=false;
        if(isJob){const res=await api.jobsTrash.restore(item._dbId);ok=res.ok;}
        else{const res=await api.trashRestore(item._dbId);ok=res.ok;
          if(ok){const restored={...item,id:item.id||uid(),_dbId:item._dbId};delete restored._type;delete restored._deletedAt;
            if(isNote)S.notes.unshift(restored);else S.passwords.unshift(restored);}}
        if(!ok){toast('Restore failed');logErr('trash', 'Restore failed', { label });return;}
        S.trash=S.trash.filter(t=>t._dbId!==item._dbId);
        loadAndRenderTrash();updateCounts();toast('Restored ✓');
        logOk('trash', 'Item restored', { label });
      }
    });
    delBtn.onclick=()=>confirm({
      title:'Delete permanently?',msg:`"${label}" will be gone forever.`,icon:'⚠️',okLabel:'Delete forever',
      onOk:async()=>{
        logInfo('trash', 'Permanently deleting', { label });
        if(isJob)await api.jobsTrash.purge(item._dbId);
        else await api.trashPurge(item._dbId);
        S.trash=S.trash.filter(t=>t._dbId!==item._dbId);
        row.remove();if(!S.trash.length)document.getElementById('trash-empty').hidden=false;
        updateCounts();toast('Permanently deleted');
        logOk('trash', 'Item purged', { label });
      }
    });
    wrap.appendChild(row);
  });
}
document.getElementById('btn-empty-trash').addEventListener('click',()=>{
  if(!S.trash.length){toast('Trash is already empty');return;}
  logInfo('trash', 'Empty trash clicked', { count: S.trash.length });
  confirm({title:'Empty Trash?',msg:`All ${S.trash.length} item(s) will be permanently deleted.`,icon:'⚠️',okLabel:'Empty Trash',
    onOk:async()=>{
      const vaultItems=S.trash.filter(t=>t._type!=='job');
      const jobItems=S.trash.filter(t=>t._type==='job');
      await Promise.all([
        ...vaultItems.map(t=>api.trashPurge(t._dbId)),
        ...jobItems.map(t=>api.jobsTrash.purge(t._dbId)),
      ]);
      S.trash=[];loadAndRenderTrash();updateCounts();toast('Trash emptied');
      logOk('trash', 'Trash emptied');
    }
  });
});

// ═══ JOBS — inline edit, sort, search, filter ═════════════════════════════════
let _jobEdit=null;
async function loadAndRenderJobs(){
  logInfo('jobs', 'Loading jobs');
  const r=await api.jobsLoad();if(!r.ok){ logErr('jobs', 'Failed to load jobs', r.error); return; }
  S.jobs=r.jobs;renderJobsTable();updateCounts();
  logOk('jobs', 'Jobs loaded', { count: S.jobs.length });
}

S.jobSort={col:'',dir:1};S.jobFilter='all';

document.getElementById('jobs-search').addEventListener('input',renderJobsTable);
document.querySelectorAll('.filter-pill').forEach(btn=>{
  btn.addEventListener('click',()=>{
    document.querySelectorAll('.filter-pill').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    S.jobFilter=btn.dataset.filter;
    logInfo('jobs', 'Filter changed', { filter: S.jobFilter });
    renderJobsTable();
  });
});
document.querySelectorAll('.sortable').forEach(th=>{
  th.addEventListener('click',()=>{
    if(S.jobSort.col===th.dataset.col)S.jobSort.dir*=-1;
    else{S.jobSort.col=th.dataset.col;S.jobSort.dir=1;}
    document.querySelectorAll('.sortable').forEach(h=>{
      h.querySelector('.sort-icon').textContent=h.dataset.col===S.jobSort.col?(S.jobSort.dir===1?'↑':'↓'):'⇅';
    });
    logInfo('jobs', 'Sort changed', { col: S.jobSort.col, dir: S.jobSort.dir });
    renderJobsTable();
  });
});

function getFilteredJobs(){
  const q=(document.getElementById('jobs-search')?.value||'').toLowerCase();
  let list=S.jobs.filter(j=>{
    if(S.jobFilter!=='all'&&j.status!==S.jobFilter)return false;
    if(!q)return true;
    return[j.company,j.role,j.email,j.notes,j.applied_at,j.status].some(v=>(v||'').toLowerCase().includes(q));
  });
  if(S.jobSort.col){
    list=[...list].sort((a,b)=>{
      const va=(a[S.jobSort.col]||'').toString().toLowerCase();
      const vb=(b[S.jobSort.col]||'').toString().toLowerCase();
      return va<vb?-S.jobSort.dir:va>vb?S.jobSort.dir:0;
    });
  }
  return list;
}

let _statusPopupJob=null;
const popup=document.getElementById('status-popup');
document.querySelectorAll('.status-pop-opt').forEach(btn=>{
  btn.addEventListener('click',async()=>{
    if(!_statusPopupJob)return;
    const newStatus=btn.dataset.val;
    logInfo('jobs', 'Status changed', { jobId: _statusPopupJob.id, company: _statusPopupJob.company, from: _statusPopupJob.status, to: newStatus });
    _statusPopupJob.status=newStatus;
    hide('status-popup');
    const r=await api.jobsSave(_statusPopupJob);
    if(!r.ok){toast('Save failed');logErr('jobs', 'Status save failed', r.error);}
    renderJobsTable();
  });
});
document.addEventListener('click',e=>{
  if(!e.target.closest('#status-popup')&&!e.target.closest('.job-status-cell'))hide('status-popup');
});

function renderJobsTable(){
  const tbody=document.getElementById('jobs-body');
  tbody.querySelectorAll('tr:not(#jobs-empty-row)').forEach(e=>e.remove());
  const list=getFilteredJobs();
  document.getElementById('jobs-empty-row').hidden=!!list.length;
  if(!S.jobs.length)return;

  const acc=S.jobs.filter(j=>j.status==='accepted').length;
  const wait=S.jobs.filter(j=>j.status==='wait').length;
  const rej=S.jobs.filter(j=>j.status==='rejected').length;
  const jobsStats=document.getElementById('jobs-stats');jobsStats.innerHTML='';
  const mkStat=function(cls,num,lbl){const d=document.createElement('div');d.className='job-stat '+cls;const s=document.createElement('span');s.textContent=num;d.appendChild(s);const l=document.createElement('small');l.textContent=lbl;d.appendChild(l);return d;};
  jobsStats.appendChild(mkStat('accepted',acc,'Accepted'));
  jobsStats.appendChild(mkStat('wait',wait,'Waiting'));
  jobsStats.appendChild(mkStat('rejected',rej,'Rejected'));
  jobsStats.appendChild(mkStat('total',S.jobs.length,'Total'));

  const stMap={accepted:{cls:'status-accepted',label:'✅ Accepted'},wait:{cls:'status-wait',label:'⏳ Waiting'},rejected:{cls:'status-rejected',label:'❌ Rejected'}};

  list.forEach(job=>{
    const tr=document.createElement('tr');
    tr.className='draggable';tr.draggable=true;tr.dataset.id=job.id;
    const st=stMap[job.status]||stMap.wait;

    const dragTd=document.createElement('td');dragTd.className='drag-handle-cell';dragTd.textContent='⠿';tr.appendChild(dragTd);
    const companyTd=document.createElement('td');companyTd.className='editable-cell';companyTd.dataset.field='company';const companyStrong=document.createElement('strong');companyStrong.textContent=job.company||'';companyTd.appendChild(companyStrong);tr.appendChild(companyTd);
    const roleTd=document.createElement('td');roleTd.className='editable-cell';roleTd.dataset.field='role';roleTd.textContent=job.role||'';tr.appendChild(roleTd);
    const emailTd=document.createElement('td');
    const emailWrap=document.createElement('div');emailWrap.style.cssText='display:flex;align-items:center;gap:5px';
    const emailLink=document.createElement('a');emailLink.className='job-email';emailLink.href='mailto:'+encodeURIComponent(job.email||'');emailLink.textContent=job.email||'';emailWrap.appendChild(emailLink);
    const copyEmailBtn=document.createElement('button');copyEmailBtn.className='icon-btn copy copy-email-btn';copyEmailBtn.title='Copy email';copyEmailBtn.style.cssText='width:22px;height:22px;flex-shrink:0';
    copyEmailBtn.innerHTML='<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    emailWrap.appendChild(copyEmailBtn);emailTd.appendChild(emailWrap);tr.appendChild(emailTd);
    const dateTd=document.createElement('td');dateTd.className='editable-cell';dateTd.dataset.field='applied_at';dateTd.textContent=job.applied_at||'—';tr.appendChild(dateTd);
    const statusTd=document.createElement('td');statusTd.className='job-status-cell';const statusSpan=document.createElement('span');statusSpan.className='job-status '+st.cls;statusSpan.textContent=st.label;statusTd.appendChild(statusSpan);tr.appendChild(statusTd);
    const delTd=document.createElement('td');
    const delJobBtn=document.createElement('button');delJobBtn.className='icon-btn del del-job-btn';delJobBtn.title='Delete';
    delJobBtn.innerHTML='<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>';
    delTd.appendChild(delJobBtn);tr.appendChild(delTd);

    tr.querySelector('.copy-email-btn').onclick=e=>{e.stopPropagation();navigator.clipboard.writeText(job.email||'');toast('Email copied!');logInfo('jobs', 'Email copied', { company: job.company });};

    tr.querySelectorAll('.editable-cell').forEach(td=>{
      td.addEventListener('dblclick',()=>{
        const field=td.dataset.field;
        const current=job[field]||'';
        logInfo('jobs', 'Inline edit started', { jobId: job.id, field, company: job.company });
        const inp=document.createElement('input');
        inp.type=field==='applied_at'?'date':'text';
        inp.value=current;
        inp.className='inline-cell-input';
        td.innerHTML='';td.appendChild(inp);
        inp.focus();inp.select();
        const save=async()=>{
          const val=inp.value.trim();
          job[field]=val;
          await api.jobsSave(job);
          renderJobsTable();
        };
        inp.addEventListener('blur',save);
        inp.addEventListener('keydown',e=>{if(e.key==='Enter')inp.blur();if(e.key==='Escape'){td.innerHTML='';if(field==='company'){const s=document.createElement('strong');s.textContent=job.company||'';td.appendChild(s);}else{td.textContent=job[field]||'';}}});
      });
    });

    tr.querySelector('.job-status-cell').addEventListener('click',e=>{
      e.stopPropagation();
      _statusPopupJob=job;
      const rect=e.currentTarget.getBoundingClientRect();
      popup.style.top=(rect.bottom+4)+'px';
      popup.style.left=rect.left+'px';
      show('status-popup');
    });

    tr.querySelector('.del-job-btn').onclick=()=>confirm({
      title:'Move to Trash?',msg:`"${job.company}" will be moved to Trash.`,icon:'🗑️',okLabel:'Move to Trash',
      onOk:async ()=>{
        logInfo('jobs', 'Job moved to trash', { jobId: job.id, company: job.company });
        const res=await api.jobsDelete(job.id);
        if(!res.ok){toast('Delete failed');logErr('jobs', 'Delete failed', { jobId: job.id });return;}
        S.jobs=S.jobs.filter(j=>j.id!==job.id);
        renderJobsTable();updateCounts();toast('Moved to Trash');
      }
    });

    tr.addEventListener('dragstart',e=>{
      dragSrc=tr;tr.classList.add('dragging');
      e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain','');
    });
    tr.addEventListener('dragend',()=>{tr.classList.remove('dragging');dragSrc=null;});
    tr.addEventListener('dragover',e=>{
      e.preventDefault();e.dataTransfer.dropEffect='move';
      if(dragSrc&&dragSrc!==tr&&dragSrc.tagName==='TR'){
        const rows=[...tbody.querySelectorAll('tr.draggable')];
        const si=rows.indexOf(dragSrc),ti=rows.indexOf(tr);
        if(si<ti)tr.after(dragSrc);else tr.before(dragSrc);
      }
    });
    tr.addEventListener('drop',e=>{
      e.preventDefault();
      const newOrder=[...tbody.querySelectorAll('tr.draggable')].map(r=>r.dataset.id);
      S.jobs=newOrder.map(id=>S.jobs.find(j=>j.id===id)).filter(Boolean);
      api.jobsReorder(S.jobs);
    });
    tbody.appendChild(tr);
  });
}

function openJobModal(existing=null){
  _jobEdit=existing;
  logInfo('jobs', existing ? 'Edit job modal opened' : 'Add job modal opened', { company: existing?.company });
  document.getElementById('job-modal-title').textContent=existing?'Edit application':'Add application';
  document.getElementById('j-company').value=existing?.company||'';
  document.getElementById('j-role').value=existing?.role||'';
  document.getElementById('j-email').value=existing?.email||'';
  document.getElementById('j-date').value=existing?.applied_at||new Date().toISOString().slice(0,10);
  document.getElementById('j-notes').value=existing?.notes||'';
  const status=existing?.status||'wait';
  document.querySelectorAll('.status-pick').forEach(b=>b.classList.toggle('active',b.dataset.val===status));
  show('job-overlay');setTimeout(()=>document.getElementById('j-company').focus(),60);
}
document.querySelectorAll('.status-pick').forEach(btn=>btn.addEventListener('click',()=>{
  document.querySelectorAll('.status-pick').forEach(b=>b.classList.remove('active'));btn.classList.add('active');
}));
document.getElementById('btn-add-job').addEventListener('click',()=>openJobModal());
document.getElementById('job-ok').addEventListener('click',async()=>{
  const company=document.getElementById('j-company').value.trim();
  const role=document.getElementById('j-role').value.trim();
  if(!company){toast('Company name required');return;}
  const status=document.querySelector('.status-pick.active')?.dataset.val||'wait';
  const job={id:_jobEdit?.id,company,role,
    email:document.getElementById('j-email').value.trim(),
    applied_at:document.getElementById('j-date').value,
    notes:document.getElementById('j-notes').value.trim(),status};
  hide('job-overlay');
  const r=await api.jobsSave(job);
  if(r.ok){
    if(_jobEdit)Object.assign(_jobEdit,job);
    else{job.id=r.id;S.jobs.unshift(job);}
    renderJobsTable();updateCounts();toast(_jobEdit?'Updated':'Saved');
    logOk('jobs', _jobEdit?'Job updated':'Job created', { company, status });
  }else { toast('Save failed: '+r.error); logErr('jobs', 'Job save failed', { company, error: r.error }); }
});
document.getElementById('job-cancel').addEventListener('click',()=>hide('job-overlay'));
document.getElementById('job-overlay').addEventListener('click',e=>{if(e.target===document.getElementById('job-overlay'))hide('job-overlay');});

// ═══ TOTP VAULT ════════════════════════════════════════════════════════════════
let totpTimers=[];
async function loadAndRenderTotp(){
  logInfo('totp', 'Loading TOTP accounts');
  totpTimers.forEach(t=>clearInterval(t));totpTimers=[];
  const r=await api.totpLoad();if(!r.ok){toast('Could not load accounts');logErr('totp', 'Failed to load', r.error);return;}
  S.totp=r.items;renderTotpGrid();updateCounts();
  logOk('totp', 'TOTP accounts loaded', { count: S.totp.length });
}
function renderTotpGrid(){
  const grid=document.getElementById('totp-grid');
  grid.querySelectorAll('.totp-card').forEach(e=>e.remove());
  document.getElementById('totp-empty').hidden=!!S.totp.length;
  if(!S.totp.length)return;
  S.totp.forEach(item=>{
    const card=document.createElement('div');card.className='totp-card';
    const codeId='totp-code-'+item.id,progId='totp-prog-'+item.id;
    const header=document.createElement('div');header.className='totp-header';
    const totpIcon=document.createElement('span');totpIcon.className='totp-icon';totpIcon.textContent=item.icon||'🔐';header.appendChild(totpIcon);
    const totpInfo=document.createElement('div');totpInfo.className='totp-info';
    const totpName=document.createElement('div');totpName.className='totp-name';totpName.textContent=item.name||'';totpInfo.appendChild(totpName);
    const totpIssuer=document.createElement('div');totpIssuer.className='totp-issuer';totpIssuer.textContent=item.issuer||'';totpInfo.appendChild(totpIssuer);
    header.appendChild(totpInfo);
    const totpDel=document.createElement('button');totpDel.className='icon-btn del totp-del';totpDel.title='Remove';
    totpDel.innerHTML='<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    header.appendChild(totpDel);
    card.appendChild(header);
    const totpCode=document.createElement('div');totpCode.className='totp-code';totpCode.id=codeId;totpCode.textContent='——';card.appendChild(totpCode);
    const totpFoot=document.createElement('div');totpFoot.className='totp-foot';
    const barWrap=document.createElement('div');barWrap.className='totp-bar-wrap';
    const bar=document.createElement('div');bar.className='totp-bar';bar.id=progId;barWrap.appendChild(bar);
    totpFoot.appendChild(barWrap);
    const totpCopy=document.createElement('button');totpCopy.className='icon-btn copy totp-copy';totpCopy.title='Copy';
    totpCopy.innerHTML='<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    totpFoot.appendChild(totpCopy);
    card.appendChild(totpFoot);
    card.querySelector('.totp-del').onclick=()=>confirm({
      title:'Remove account?',msg:`"${item.name}" will be removed.`,icon:'🗑️',okLabel:'Remove',
      onOk:async()=>{logInfo('totp', 'TOTP account removed', { name: item.name });await api.totpDelete(item.id);S.totp=S.totp.filter(t=>t.id!==item.id);renderTotpGrid();updateCounts();toast('Removed');}
    });
    card.querySelector('.totp-copy').onclick=()=>{
      const code=document.getElementById(codeId).textContent.replace(/s/g,'');
      if(code&&code!=='——'){
        navigator.clipboard.writeText(code);
        toast('Code copied! (clipboard clears in 30s)');
        logInfo('totp', 'TOTP code copied', { name: item.name });
        setTimeout(()=>{navigator.clipboard.writeText('')?.catch?.(()=>{});},30000);
      }
    };
    grid.appendChild(card);
    function updateCode(){
      const epoch=Math.floor(Date.now()/1000);
      const remaining=(30-(epoch%30))/30;
      const prog=document.getElementById(progId);
      if(prog)prog.style.width=(remaining*100)+'%';
      computeTotpAsync(item.secret,item.id);
    }
    updateCode();
    totpTimers.push(setInterval(updateCode,1000));
  });
}
function base32Decode(b32){
  const alpha='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';let bits='',res=[];
  for(const c of b32.toUpperCase().replace(/=+$/,'')){const v=alpha.indexOf(c);if(v===-1)continue;bits+=v.toString(2).padStart(5,'0');}
  for(let i=0;i+8<=bits.length;i+=8)res.push(parseInt(bits.slice(i,i+8),2));
  return new Uint8Array(res);
}
async function computeTotpAsync(secret,id){
  try{
    const key=base32Decode(secret);
    const T=Math.floor(Date.now()/30000);
    const msg=new DataView(new ArrayBuffer(8));msg.setUint32(4,T,false);
    const ck=await crypto.subtle.importKey('raw',key,{name:'HMAC',hash:'SHA-1'},false,['sign']);
    const hmac=new Uint8Array(await crypto.subtle.sign('HMAC',ck,msg.buffer));
    const off=hmac[19]&0xf;
    const code=((hmac[off]&0x7f)<<24|(hmac[off+1]&0xff)<<16|(hmac[off+2]&0xff)<<8|(hmac[off+3]&0xff))%1000000;
    const str=String(code).padStart(6,'0');
    const el=document.getElementById(`totp-code-${id}`);
    if(el)el.textContent=str.slice(0,3)+' '+str.slice(3);
  }catch{}
}

let _totpEdit=null;
document.getElementById('btn-add-totp').addEventListener('click',()=>{
  _totpEdit=null;
  ['t-name','t-issuer','t-secret','t-icon'].forEach(id=>document.getElementById(id).value='');
  logInfo('totp', 'Add TOTP account modal opened');
  show('totp-overlay');setTimeout(()=>document.getElementById('t-name').focus(),60);
});
document.getElementById('totp-ok').addEventListener('click',async()=>{
  const name=document.getElementById('t-name').value.trim();
  const secret=document.getElementById('t-secret').value.trim().replace(/\s/g,'').toUpperCase();
  if(!name||!secret){toast('Name and secret key required');return;}
  const item={id:_totpEdit?.id,name,issuer:document.getElementById('t-issuer').value.trim(),secret,icon:document.getElementById('t-icon').value||'🔐'};
  hide('totp-overlay');
  const r=await api.totpSave(item);
  if(r.ok){if(_totpEdit)Object.assign(_totpEdit,item);else{item.id=r.id;S.totp.unshift(item);}
    renderTotpGrid();updateCounts();toast('Saved');
    logOk('totp', _totpEdit?'TOTP account updated':'TOTP account created', { name });}
  else { toast('Save failed: '+r.error); logErr('totp', 'TOTP save failed', { name, error: r.error }); }
});
document.getElementById('totp-cancel').addEventListener('click',()=>hide('totp-overlay'));
document.getElementById('totp-overlay').addEventListener('click',e=>{if(e.target===document.getElementById('totp-overlay'))hide('totp-overlay');});

// ═══ MONITOR with circle gauges ═══════════════════════════════════════════════
async function loadMonitor(){
  logInfo('monitor', 'Loading monitor data');
  const [sr,lr]=await Promise.all([api.monitor.stats(),api.monitor.readLog()]);
  if(sr.ok){
    const st=sr.stats;
    const fmt=n=>n>=1048576?(n/1048576).toFixed(1)+' MB':n>=1024?(n/1024).toFixed(1)+' KB':n+' B';
    const DB_LIMIT=500*1024*1024;
    const dbPct=st.dbSizeBytes?Math.min(100,Math.round(st.dbSizeBytes/DB_LIMIT*100)):0;
    const logPct=Math.min(100,Math.round(st.logSize/(5*1024*1024)*100));

    const circlesWrap=document.getElementById('monitor-circles');circlesWrap.innerHTML='';
    const cw1=document.createElement('div');cw1.className='mon-circle-wrap';
    cw1.innerHTML=makeCircleSvg(dbPct,'var(--accent)');
    const lbl1=document.createElement('div');lbl1.className='mon-circle-label';lbl1.textContent=fmt(st.dbSizeBytes||0);cw1.appendChild(lbl1);
    const sub1a=document.createElement('div');sub1a.className='mon-circle-sub';sub1a.textContent='Database used';cw1.appendChild(sub1a);
    const sub1b=document.createElement('div');sub1b.className='mon-circle-sub';sub1b.style.cssText='font-size:10px;margin-top:2px';sub1b.textContent=dbPct+'% of 500 MB';cw1.appendChild(sub1b);
    circlesWrap.appendChild(cw1);
    const cw2=document.createElement('div');cw2.className='mon-circle-wrap';
    cw2.innerHTML=makeCircleSvg(logPct,'#f87171');
    const lbl2=document.createElement('div');lbl2.className='mon-circle-label';lbl2.textContent=fmt(st.logSize);cw2.appendChild(lbl2);
    const sub2=document.createElement('div');sub2.className='mon-circle-sub';sub2.textContent='Log file';cw2.appendChild(sub2);
    circlesWrap.appendChild(cw2);

    const gridWrap=document.getElementById('monitor-grid');gridWrap.innerHTML='';
    const mkCard=function(num,lbl,wide){const c=document.createElement('div');c.className='mon-card'+(wide?' mon-wide':'');const n=document.createElement('div');n.className='mon-num';n.textContent=num;c.appendChild(n);const l=document.createElement('div');l.className='mon-lbl';l.textContent=lbl;c.appendChild(l);return c;};
    gridWrap.appendChild(mkCard(st.items,'Vault items'));
    gridWrap.appendChild(mkCard(st.trash,'In trash'));
    gridWrap.appendChild(mkCard(st.jobs,'Job apps'));
    const supCard=document.createElement('div');supCard.className='mon-card mon-wide';
    const supNum=document.createElement('div');supNum.className='mon-num';supNum.style.cssText='font-size:12px;font-family:var(--mono)';supNum.textContent='Supabase';supCard.appendChild(supNum);
    const supLbl=document.createElement('div');supLbl.className='mon-lbl';supLbl.textContent='Supabase · Encrypted storage';supCard.appendChild(supLbl);
    gridWrap.appendChild(supCard);
    logOk('monitor', 'Monitor data loaded', { items: st.items, jobs: st.jobs, trash: st.trash });
  } else {
    logErr('monitor', 'Failed to load stats', sr.error);
  }
  if(lr.ok){const el=document.getElementById('log-view');el.textContent=lr.log||'(no errors logged)';el.scrollTop=el.scrollHeight;}

  // Load admin dashboard if user is admin
  if(isAdmin()){
    document.getElementById('admin-dashboard').hidden=false;
    loadAdminDashboard();
  } else {
    document.getElementById('admin-dashboard').hidden=true;
  }
}

async function loadAdminDashboard(){
  logInfo('admin', 'Loading admin dashboard');
  const [usersRes, statsRes] = await Promise.all([api.admin.users(), api.admin.stats()]);

  if(statsRes.ok){
    const st=statsRes.stats;
    document.getElementById('admin-total-users').textContent=st.totalUsers;
    document.getElementById('admin-total-items').textContent=st.totalItems;
    document.getElementById('admin-total-jobs').textContent=st.totalJobs;
    document.getElementById('admin-total-totp').textContent=st.totalTotp;
  }

  const listEl=document.getElementById('admin-users-list');listEl.innerHTML='';
  if(usersRes.ok && usersRes.users.length){
    usersRes.users.forEach(u=>{
      const row=document.createElement('div');row.className='admin-user-row';
      const init=(u.name||u.email||'?')[0].toUpperCase();
      if(u.avatar&&u.avatar.startsWith('https://')){const img=document.createElement('img');img.className='admin-user-avatar';img.src=u.avatar;row.appendChild(img);}
      else{const fb=document.createElement('div');fb.className='admin-user-avatar admin-user-avatar-fb';fb.textContent=init;row.appendChild(fb);}
      const info=document.createElement('div');info.className='admin-user-info';
      const nm=document.createElement('div');nm.className='admin-user-name';nm.textContent=u.name||'—';
      const em=document.createElement('div');em.className='admin-user-email';em.textContent=u.email||'—';
      const joined=u.created_at?new Date(u.created_at).toLocaleDateString('en-US',{year:'numeric',month:'short',day:'numeric'}):'—';
      const lastLogin=u.last_seen?new Date(u.last_seen).toLocaleDateString('en-US',{year:'numeric',month:'short',day:'numeric'}):'never';
      const meta=document.createElement('div');meta.className='admin-user-meta';meta.textContent='Joined '+joined+' · Last login '+lastLogin;
      info.appendChild(nm);info.appendChild(em);info.appendChild(meta);
      row.appendChild(info);
      if(u.email===ADMIN_EMAIL){
        const badge=document.createElement('span');badge.className='admin-user-badge badge-admin';badge.textContent='admin';row.appendChild(badge);
      }
      listEl.appendChild(row);
    });
  } else {
    const noUsers=document.createElement('div');noUsers.className='admin-no-users';noUsers.textContent='No users found';listEl.appendChild(noUsers);
  }
  logOk('admin', 'Admin dashboard loaded');
}

function makeCircleSvg(pct,color){
  // Sanitize inputs to prevent SVG injection
  const safePct = Math.max(0, Math.min(100, parseInt(pct) || 0));
  const safeColor = String(color).replace(/[<>"'&]/g, '');
  const r=44,circ=2*Math.PI*r;
  const dash=circ*(safePct/100);
  return `<svg class="mon-circle-svg" viewBox="0 0 100 100">
    <circle cx="50" cy="50" r="${r}" fill="none" stroke="rgba(255,255,255,.07)" stroke-width="8"/>
    <circle cx="50" cy="50" r="${r}" fill="none" stroke="${safeColor}" stroke-width="8"
      stroke-dasharray="${dash.toFixed(1)} ${circ.toFixed(1)}"
      stroke-dashoffset="${(circ/4).toFixed(1)}" stroke-linecap="round"/>
    <text x="50" y="54" text-anchor="middle" fill="${safeColor}" font-size="16" font-weight="600" font-family="var(--mono)">${safePct}%</text>
  </svg>`;
}

document.getElementById('btn-refresh-monitor').addEventListener('click',()=>{ logInfo('monitor', 'Refresh clicked'); loadMonitor(); });
document.getElementById('btn-clear-log').addEventListener('click',async()=>{
  logInfo('monitor', 'Clear log clicked');
  await api.monitor.clearLog();document.getElementById('log-view').textContent='(log cleared)';toast('Log cleared');
  logOk('monitor', 'Log cleared');
});

// ═══ SETTINGS ══════════════════════════════════════════════════════════════════
const DEFAULT_SETTINGS = {
  lock_timeout: 5, lock_action: 'lock',
  lock_countdown: true, lock_on_minimize: false,
  compact: false, animations: true, accent: 'violet',
  gen_length: 20, gen_symbols: true, gen_numbers: true, gen_ambiguous: false, gen_copy: true,
  sounds: true, toast_duration: 2400,
  sound_login: true, sound_exit: true, sound_hover: false,
  sound_login_tone: 'chime', sound_exit_tone: 'chime', sound_hover_tone: 'click',
};

const ACCENT_MAP = {
  violet:  'oklch(0.65 0.22 290)',
  blue:    'oklch(0.62 0.20 250)',
  teal:    'oklch(0.62 0.18 190)',
  green:   'oklch(0.65 0.20 145)',
  orange:  'oklch(0.68 0.20 55)',
  rose:    'oklch(0.62 0.22 15)',
  red:     'oklch(0.62 0.22 25)',
  pink:    'oklch(0.65 0.20 350)',
  yellow:  'oklch(0.78 0.16 95)',
  amber:   'oklch(0.72 0.18 70)',
  cyan:    'oklch(0.65 0.16 210)',
  indigo:  'oklch(0.58 0.20 270)',
  lime:    'oklch(0.72 0.20 130)',
};
function applyAccent(name) {
  const c = ACCENT_MAP[name] || ACCENT_MAP.violet;
  document.documentElement.style.setProperty('--accent', c);
  document.documentElement.style.setProperty('--accent-dim', c.replace(')', ' / 0.1)').replace('oklch(', 'oklch('));
  document.documentElement.style.setProperty('--accent-glow', c.replace(')', ' / 0.15)').replace('oklch(', 'oklch('));
  document.documentElement.style.setProperty('--accent-strong', c.replace(/0\.\d+/, m => String(Math.min(1, parseFloat(m) + 0.08))));
  document.documentElement.style.setProperty('--accent-glass', c.replace(')', ' / 0.18)').replace('oklch(', 'oklch('));
  document.querySelectorAll('.accent-swatch').forEach(s => s.classList.toggle('active', s.dataset.accent === name));
}

function applySetting(key, value) {
  S.settings[key] = value;
  if (key === 'lock_timeout' || key === 'lock_action' || key === 'lock_countdown') {
    applyLockSettings();
    armLock();
  }
  if (key === 'compact') document.body.classList.toggle('compact', !!value);
  if (key === 'animations') document.body.style.setProperty('--transition', value ? '' : '0s');
  if (key === 'accent') applyAccent(value);
  if (key === 'sounds') window.__soundsEnabled = !!value;
  __saveSettings();
}
let __saveTimer = null;
function __saveSettings() {
  clearTimeout(__saveTimer);
  __saveTimer = setTimeout(async () => {
    try { await api.settings.save(S.settings); } catch {}
  }, 400);
}

async function loadSettingsTab(){
  logInfo('settings', 'Loading settings tab');
  const r = await api.settings.load();
  if (r.ok) S.settings = { ...DEFAULT_SETTINGS, ...r.settings };
  // Ensure defaults for any new keys not in DB
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    if (S.settings[k] === undefined) S.settings[k] = v;
  }

  // Bind all controls
  const bind = (id, key, type) => {
    const el = document.getElementById(id);
    if (!el) return;
    // Set initial value
    if (type === 'toggle') el.checked = !!S.settings[key];
    else el.value = S.settings[key] ?? '';
    // Listen for changes
    el.addEventListener('change', () => {
      let val;
      if (type === 'toggle') val = el.checked;
      else if (type === 'number') val = parseInt(el.value) || 0;
      else val = el.value;
      applySetting(key, val);
      toast('Setting updated', 1200);
    });
  };

  bind('s-lock-timeout', 'lock_timeout', 'number');
  bind('s-lock-action', 'lock_action', 'select');
  bind('s-lock-countdown', 'lock_countdown', 'toggle');
  bind('s-lock-minimize', 'lock_on_minimize', 'toggle');
  bind('s-compact', 'compact', 'toggle');
  bind('s-animations', 'animations', 'toggle');
  bind('s-gen-length', 'gen_length', 'number');
  bind('s-gen-symbols', 'gen_symbols', 'toggle');
  bind('s-gen-numbers', 'gen_numbers', 'toggle');
  bind('s-gen-ambiguous', 'gen_ambiguous', 'toggle');
  bind('s-gen-copy', 'gen_copy', 'toggle');
  bind('s-sounds', 'sounds', 'toggle');
  bind('s-sound-login', 'sound_login', 'toggle');
  bind('s-sound-exit', 'sound_exit', 'toggle');
  bind('s-sound-hover', 'sound_hover', 'toggle');
  bind('s-sound-login-tone', 'sound_login_tone', 'select');
  bind('s-sound-exit-tone', 'sound_exit_tone', 'select');
  bind('s-sound-hover-tone', 'sound_hover_tone', 'select');
  bind('s-toast-duration', 'toast_duration', 'select');

  // Accent swatches
  document.querySelectorAll('.accent-swatch').forEach(s => {
    s.classList.toggle('active', s.dataset.accent === S.settings.accent);
    s.addEventListener('click', () => applySetting('accent', s.dataset.accent));
  });

  // Apply current visual settings immediately (without re-saving to DB)
  document.body.classList.toggle('compact', !!S.settings.compact);
  document.body.style.setProperty('--transition', S.settings.animations ? '' : '0s');
  applyAccent(S.settings.accent);
  window.__soundsEnabled = !!S.settings.sounds;

  // 2FA status
  const r2 = await api.twofa.status();
  document.getElementById('s-2fa-status').textContent = r2.enabled ? '✅ Enabled' : '❌ Disabled';
  logOk('settings', 'Settings tab loaded', { ...S.settings, twofa: r2.enabled });
}

// Lock-on-minimize handler
api.onMinimize(() => {
  if (S.settings.lock_on_minimize && S.user) doLock();
});

document.getElementById('s-btn-2fa').addEventListener('click', () => {
  hide('tab-settings');
  document.getElementById('btn-2fa').click();
});

// ═══ STRENGTH ══════════════════════════════════════════════════════════════════
function scoreP(pw){
  if(!pw)return{n:0,lbl:'—',cls:''};
  let s=0;
  if(pw.length>=8)s++;if(pw.length>=14)s++;
  if(/[A-Z]/.test(pw)&&/[a-z]/.test(pw))s++;
  if(/[0-9]/.test(pw))s++;if(/[^A-Za-z0-9]/.test(pw))s++;
  const n=Math.min(4,Math.ceil(s*4/5));
  return{n,lbl:['','weak','fair','good','strong'][n]||'—',cls:['','sl-w','sl-f','sl-g','sl-s'][n]||''};
}
function updateSm(wrapId,pw){
  const wrap=document.getElementById(wrapId);if(!wrap)return;
  const{n,lbl,cls}=scoreP(pw);
  wrap.querySelectorAll('.sm-bar').forEach((b,i)=>{b.className='sm-bar'+(i<n?` l${n}`:'');});
  const l=wrap.querySelector('.sm-lbl');if(l){l.textContent=lbl;l.className='sm-lbl '+cls;}
}

// ═══ GENERATOR ════════════════════════════════════════════════════════════════
const LOWER='abcdefghijklmnopqrstuvwxyz',UPPER='ABCDEFGHIJKLMNOPQRSTUVWXYZ',NUMS='0123456789',SYMS='!@#$%^&*()_+-=[]{}|;:,.<>?';
function doGenerate(){
  const len=parseInt(document.getElementById('gen-len').value);
  const classes=[LOWER];
  if(document.getElementById('go-upper').checked)classes.push(UPPER);
  if(document.getElementById('go-nums').checked)classes.push(NUMS);
  if(document.getElementById('go-syms').checked)classes.push(SYMS);
  const allCs=classes.join('');
  const arr=new Uint32Array(len);crypto.getRandomValues(arr);
  const guaranteed=classes.map((cs,i)=>cs[arr[i]%cs.length]);
  const rest=Array.from(arr).slice(classes.length).map(n=>allCs[n%allCs.length]);
  let pw=[...guaranteed,...rest];
  for(let i=pw.length-1;i>0;i--){const j=arr[i<arr.length?i:i%arr.length]%(i+1);[pw[i],pw[j]]=[pw[j],pw[i]];}
  const pwStr=pw.join('');
  document.getElementById('gen-out').textContent=pwStr;
  const{n,lbl,cls}=scoreP(pwStr);
  document.querySelectorAll('#gen-strength-row .bar').forEach((b,i)=>b.className='bar'+(i<n?` g${n}`:''));
  const l=document.getElementById('gen-slabel');if(l){l.textContent=lbl;l.className='slabel '+cls.replace('sl-','s');}
  if (S.settings.gen_copy) {
    try {
      navigator.clipboard.writeText(pwStr);
      // Auto-clear generator clipboard after 30s
      setTimeout(()=>{navigator.clipboard.writeText('')?.catch?.(()=>{});},30000);
    } catch {} }
  logInfo('generator', 'Password generated', { length: len, strength: lbl });
  return pwStr;
}
document.getElementById('gen-len').addEventListener('input',function(){
  document.getElementById('gen-len-val').textContent=this.value;
  if(document.getElementById('gen-out').textContent!=='—')doGenerate();
});
function openGen(fillMode=false){
  logInfo('generator', 'Generator opened', { fillMode });
  document.getElementById('gen-len').value = S.settings.gen_length || 20;
  document.getElementById('gen-len-val').textContent = S.settings.gen_length || 20;
  document.getElementById('go-syms').checked = !!S.settings.gen_symbols;
  document.getElementById('go-nums').checked = !!S.settings.gen_numbers;
  show('gen-overlay');
  const useBtn=document.getElementById('gen-use');
  const newUse=useBtn.cloneNode(true);useBtn.parentNode.replaceChild(newUse,useBtn);
  newUse.hidden=!fillMode;
  newUse.addEventListener('click',()=>{
    const pw=document.getElementById('gen-out').textContent;
    if(!pw||pw==='—'){toast('Generate first');return;}
    const f=document.getElementById('f-pw');if(f){f.value=pw;f.type='text';updateSm('sm',pw);}
    closeGen();
  });
  doGenerate();
}
function closeGen(){hide('gen-overlay');}
['go-upper','go-nums','go-syms'].forEach(id=>{
  document.getElementById(id).addEventListener('change',()=>{
    if(document.getElementById('gen-overlay').hidden) return;
    doGenerate();
    if(id==='go-syms') S.settings.gen_symbols=document.getElementById(id).checked;
    if(id==='go-nums') S.settings.gen_numbers=document.getElementById(id).checked;
    __saveSettings();
  });
});
document.getElementById('btn-gen').addEventListener('click',()=>openGen(false));
document.getElementById('gen-close').addEventListener('click',closeGen);
document.getElementById('gen-generate').addEventListener('click',doGenerate);
document.getElementById('gen-copy').addEventListener('click',()=>{
  const pw=document.getElementById('gen-out').textContent;
  if(pw&&pw!=='—'){navigator.clipboard.writeText(pw);toast('Copied!');logInfo('generator', 'Password copied to clipboard');}
});
document.querySelector('#gen-overlay .modal').addEventListener('click',e=>e.stopPropagation());
document.getElementById('gen-overlay').addEventListener('click',closeGen);

// ═══ 2FA SETTINGS MODAL ════════════════════════════════════════════════════════
document.getElementById('btn-2fa').addEventListener('click',async()=>{
  logInfo('2fa', '2FA settings opened');
  const r=await api.twofa.status();
  const body=document.getElementById('twofa-modal-body');
  const okBtn=document.getElementById('twofa-ok');const disBtn=document.getElementById('twofa-disable');
  if(r.enabled){
    document.getElementById('twofa-modal-title').textContent='2FA is enabled';
   body.innerHTML='';const disMsg=document.createElement('p');disMsg.className='sub';disMsg.style.cssText='margin:12px 0';disMsg.textContent='Two-factor authentication is active.';body.appendChild(disMsg);body.appendChild(document.createElement('br'));const disMsg2=document.createElement('span');disMsg2.textContent='Disable it below.';body.appendChild(disMsg2);
    okBtn.hidden=true;disBtn.hidden=false;
    logInfo('2fa', '2FA is currently enabled');
  }else{
    document.getElementById('twofa-modal-title').textContent='Enable 2FA';
    body.innerHTML='';
    const scanMsg=document.createElement('p');scanMsg.className='sub';scanMsg.style.cssText='margin-bottom:14px';scanMsg.textContent='Scan this QR code with your authenticator app, then enter the 6-digit code to confirm.';body.appendChild(scanMsg);body.appendChild(document.createElement('br'));
    body.appendChild(document.createElement('br'));
    const qrWrap=document.createElement('div');qrWrap.id='qr-wrap';qrWrap.style.cssText='display:flex;justify-content:center;margin:12px 0';const qrLoading=document.createElement('p');qrLoading.style.color='var(--muted)';qrLoading.textContent='Loading…';qrWrap.appendChild(qrLoading);body.appendChild(qrWrap);
    const secretText=document.createElement('p');secretText.className='sub';secretText.style.cssText='margin-bottom:10px;font-size:11px;font-family:var(--mono)';secretText.id='2fa-secret-text';secretText.textContent='Loading…';body.appendChild(secretText);
    const setupCode=document.createElement('input');setupCode.className='fi twofa-input';setupCode.id='twofa-setup-code';setupCode.placeholder='000000';setupCode.maxLength=6;setupCode.inputMode='numeric';setupCode.style.cssText='text-align:center;font-size:20px;letter-spacing:.3em;font-family:var(--mono);margin-top:6px';body.appendChild(setupCode);
    const setupErr=document.createElement('p');setupErr.className='err';setupErr.id='twofa-setup-err';setupErr.hidden=true;body.appendChild(setupErr);
    okBtn.hidden=false;disBtn.hidden=true;
    const sr=await api.twofa.setup();
    if(sr.ok){
      document.getElementById('2fa-secret-text').textContent=sr.secret;
      const qrUrl=`https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(sr.otpauth)}`;
      const qrEl=document.getElementById('qr-wrap');qrEl.innerHTML='';
        const qrImg=document.createElement('img');qrImg.width=160;qrImg.height=160;
        qrImg.style.borderRadius='8px';qrImg.style.background='#fff';qrImg.style.padding='6px';
        qrImg.src=qrUrl;qrEl.appendChild(qrImg);
      logOk('2fa', '2FA setup initiated');
    } else {
      logErr('2fa', '2FA setup failed', sr.error);
    }
    const newOk=okBtn.cloneNode(true);okBtn.parentNode.replaceChild(newOk,okBtn);
    newOk.hidden=false;
    newOk.addEventListener('click',async()=>{
      const token=document.getElementById('twofa-setup-code')?.value.trim();
      const er=await api.twofa.enable(token);
      if(!er.ok){const el=document.getElementById('twofa-setup-err');el.hidden=false;el.textContent=er.error;logWarn('2fa', '2FA enable failed', er.error);return;}
      hide('twofa-overlay');toast('2FA enabled ✓');
      logOk('2fa', '2FA enabled');
    });
  }
  const newDis=disBtn.cloneNode(true);disBtn.parentNode.replaceChild(newDis,disBtn);
  newDis.hidden=!r.enabled;
  newDis.addEventListener('click',async()=>{
    // Prompt for TOTP code before disabling
    const code = prompt('Enter your current 6-digit 2FA code to confirm disabling:');
    if (!code || !/^\d{6}$/.test(code)) { toast('Invalid code format'); return; }
    logInfo('2fa', '2FA disable clicked');
    const res = await api.twofa.disable(code);
    if (!res.ok) { toast(res.error || 'Failed to disable 2FA'); return; }
    hide('twofa-overlay');toast('2FA disabled');logOk('2fa', '2FA disabled');
  });
  show('twofa-overlay');
});
document.getElementById('twofa-cancel').addEventListener('click',()=>hide('twofa-overlay'));
document.getElementById('twofa-overlay').addEventListener('click',e=>{if(e.target===document.getElementById('twofa-overlay'))hide('twofa-overlay');});

// ═══ KEYBOARD ═══════════════════════════════════════════════════════════
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){
    logInfo('ui', 'Escape pressed — closing overlays');
    ['modal-overlay','gen-overlay','confirm-overlay','twofa-overlay','job-overlay','totp-overlay','status-popup'].forEach(id=>hide(id));
  }
});

// ═══ HOVER SOUNDS ══════════════════════════════════════════════════════════════
let __hoverTimer = null;
document.addEventListener('mouseover', e => {
  if (!S.settings.sound_hover || window.__soundsEnabled === false) return;
  const t = e.target.closest('.nav-btn, .accent-swatch, .wb, .btn-primary, .btn-ghost, .icon-btn, .filter-pill, .job-stat');
  if (!t) return;
  clearTimeout(__hoverTimer);
  __hoverTimer = setTimeout(() => playSound('hover'), 20);
});

screen('s-login');
logInfo('app', 'App initialized, showing login screen');
