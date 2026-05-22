'use strict';

// ═══ STATE ════════════════════════════════════════════════════════════════════
const S = {
  user:null, passwords:[], notes:[], trash:[], jobs:[], totp:[], activeNote:null,
  jobSort:{ col:'', dir:1 }, jobFilter:'all',
  settings:{ lock_timeout:5, lock_action:'lock' },
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
  const prefix = `[${entry.ts}] [${level}] [${ctx}]`;
  if (level === 'ERROR') console.error(prefix, msg, data || '');
  else if (level === 'WARN') console.warn(prefix, msg, data || '');
  else console.log(prefix, msg, data || '');
}
const logInfo = (ctx, msg, data) => rlog('INFO', ctx, msg, data);
const logOk   = (ctx, msg, data) => rlog('OK', ctx, msg, data);
const logWarn = (ctx, msg, data) => rlog('WARN', ctx, msg, data);
const logErr  = (ctx, msg, data) => rlog('ERROR', ctx, msg, data);
logInfo('app', 'Renderer initialized');

// ═══ UTILS ════════════════════════════════════════════════════════════════════
const uid  = () => Date.now().toString(36) + Math.random().toString(36).slice(2);
const esc  = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const wc   = t => { t=(t||'').trim(); return t?t.split(/\s+/).length:0; };
const days = d => Math.max(0,Math.ceil((30*86400000-(Date.now()-new Date(d)))/86400000));

function toast(msg,ms=2400){logInfo('ui', 'Toast: ' + msg);const el=document.getElementById('toast');el.textContent=msg;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),ms);}
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
function playSound(type){
  logDebug('sound', 'playSound: ' + type);
  switch(type){
    case 'login': [523,659,784,1047].forEach((f,i)=>playTone(f,'sine',0.2,0.15,i*0.1));break;
    case 'logout':[784,659,523].forEach((f,i)=>playTone(f,'sine',0.18,0.12,i*0.09));break;
    case 'lock': playTone(440,'sine',0.12,0.1,0);playTone(330,'sine',0.12,0.08,0.1);break;
  }
}
function logDebug(ctx, msg) { console.log(`[DEBUG] [${ctx}] ${msg}`); }
api.onPlaySound(type=>playSound(type));

// ═══ WINDOWS SNAP ═════════════════════════════════════════════════════════════
document.getElementById('titlebar').addEventListener('dblclick',e=>{
  if(e.target.closest('.tb-right'))return;
  logInfo('ui', 'Titlebar double-clicked — maximize toggle');
  api.maximize();
});

// ═══ CANVAS ANIMATION ════════════════════════════════════════════════════════
(function initCanvas(){
  const canvas=document.getElementById('bg-canvas');
  const ctx=canvas.getContext('2d');
  let W,H,mouse={x:-9999,y:-9999};
  const particles=[];

  function resize(){W=canvas.width=window.innerWidth;H=canvas.height=window.innerHeight;}
  window.addEventListener('resize',resize);resize();

  for(let i=0;i<55;i++) particles.push({
    x:Math.random()*1200,y:Math.random()*800,
    vx:(Math.random()-.5)*.08,vy:(Math.random()-.5)*.08,
    r:Math.random()*1.2+.3,
    alpha:Math.random()*.25+.05,
  });

  window.addEventListener('mousemove',e=>{mouse.x=e.clientX;mouse.y=e.clientY;});

  function draw(){
    ctx.clearRect(0,0,W,H);
    for(let i=0;i<particles.length;i++){
      const p=particles[i];
      const dx=p.x-mouse.x,dy=p.y-mouse.y,dist=Math.sqrt(dx*dx+dy*dy);
      if(dist<120&&dist>0){p.vx+=dx/dist*.02;p.vy+=dy/dist*.02;}
      p.vx*=.98;p.vy*=.98;
      const spd=Math.sqrt(p.vx*p.vx+p.vy*p.vy);
      if(spd<.03&&spd>0){const f=.03/spd;p.vx*=f;p.vy*=f;}
      p.x+=p.vx;p.y+=p.vy;
      if(p.x<0)p.x=W;if(p.x>W)p.x=0;if(p.y<0)p.y=H;if(p.y>H)p.y=0;
      for(let j=i+1;j<particles.length;j++){
        const q=particles[j];const ex=p.x-q.x,ey=p.y-q.y,d=Math.sqrt(ex*ex+ey*ey);
        if(d<130){
          const alpha=(1-d/130)*.08;
          ctx.beginPath();
          ctx.strokeStyle=`rgba(167,139,250,${alpha})`;
          ctx.lineWidth=.5;
          ctx.moveTo(p.x,p.y);ctx.lineTo(q.x,q.y);
          ctx.stroke();
        }
      }
      ctx.beginPath();
      ctx.arc(p.x,p.y,p.r,0,Math.PI*2);
      ctx.fillStyle=`rgba(167,139,250,${p.alpha})`;
      ctx.fill();
    }
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
  if(row)row.hidden=(t===0);
  logInfo('settings', 'Lock settings applied', { timeout: t, lockMs: LOCK_MS });
}
function armLock(){
  clearTimeout(lockTimer);clearInterval(lockTick);
  if(S.settings.lock_timeout===0)return;
  lockDeadline=Date.now()+LOCK_MS;
  const row=document.getElementById('lock-row');if(row)row.hidden=false;
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
function doLock(){logInfo('auth', 'Locking vault'); disarmLock();api.lock();screen('s-lock');}
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

document.getElementById('btn-logout').addEventListener('click',async()=>{
  logInfo('auth', 'Logout clicked', { user: S.user?.email });
  playSound('logout');await api.logout();
  S.user=null;S.passwords=[];S.notes=[];S.trash=[];S.jobs=[];S.totp=[];S.activeNote=null;
  disarmLock();clearAllInputs();screen('s-login');
  document.getElementById('btn-login').textContent='Sign in with Google';
  document.getElementById('btn-login').disabled=false;
  document.getElementById('login-err').hidden=true;
  logOk('auth', 'Logged out, state cleared');
});

function loadVault(v){S.passwords=v?.passwords||[];S.notes=v?.notes||[];logInfo('vault', 'Vault loaded into memory', { passwords: S.passwords.length, notes: S.notes.length });}
async function loadSettings(){
  const r=await api.settings.load();
  if(r.ok)S.settings={...S.settings,...r.settings};
  applyLockSettings();
  logInfo('settings', 'Settings loaded', S.settings);
}
function enterApp(){logInfo('app', 'Entering app screen'); screen('s-app');renderUserChip();switchTab('passwords');armLock();}
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
    row.innerHTML=`
      <div class="pw-icon" id="icon-${pw.id||'x'}">${initial}</div>
      <div class="pw-info">
        <div class="pw-site">${esc(pw.site||'')}</div>
        <div class="pw-user">${esc(pw.username||'')}</div>
        ${pw.notes?`<div class="pw-note">${esc(pw.notes)}</div>`:''}
      </div>
      <div class="pw-pw-wrap">
        <span class="pw-hidden">••••••••</span>
        <span class="pw-real" hidden>${esc(pw.password||'')}</span>
        <div class="pw-inline-sm" id="psm-${pw.id}" hidden>
          <div class="sm-bars sm-inline"><div class="sm-bar"></div><div class="sm-bar"></div><div class="sm-bar"></div><div class="sm-bar"></div></div>
          <span class="sm-lbl psm-lbl">—</span>
          <span class="breach-badge" id="breach-${pw.id}" hidden>⚠️ breached</span>
        </div>
        <button class="eye-inline" title="Hold to show">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
      </div>
      <div class="pw-acts">
        <button class="icon-btn copy" title="Copy password">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        </button>
        <button class="icon-btn" title="Edit">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="icon-btn del" title="Move to trash">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
        </button>
      </div>`;
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
    const eyeBtn=row.querySelector('.eye-inline');
    const hidSpan=row.querySelector('.pw-hidden');
    const revSpan=row.querySelector('.pw-real');
    const smWrap=document.getElementById('psm-'+pw.id);
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

    const [copyBtn,editBtn,delBtn]=row.querySelectorAll('.pw-acts .icon-btn');
    copyBtn.onclick=()=>{navigator.clipboard.writeText(pw.password||'');toast('Password copied!');logInfo('password', 'Password copied to clipboard', { site: pw.site });};
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
    el.innerHTML=`<span class="drag-handle">⠿</span>
      <div class="note-chip-body"><div class="nc-title">${esc(n.title||'Untitled')}</div><div class="nc-prev">${esc(n.body?.slice(0,55)||'Empty')}</div></div>`;
    el.querySelector('.note-chip-body').onclick=()=>openNote(n.id);
    addVerticalDrag(el,'notes-list',()=>api.reorder('note',S.notes));
    wrap.appendChild(el);
  });
}

function openNote(id){
  S.activeNote=id;const note=S.notes.find(n=>n.id===id);if(!note)return;
  logInfo('note', 'Note opened', { noteId: id, title: note.title });
  renderNotesList();
  const editor=document.getElementById('note-editor');
  editor.innerHTML=`
    <div class="note-toolbar">
      <input class="note-title-inp" id="n-title" value="${esc(note.title||'')}" placeholder="Title" />
      <button class="icon-btn del" id="n-del">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
      </button>
    </div>
    <textarea class="note-body" id="n-body" placeholder="Start writing…">${esc(note.body||'')}</textarea>
    <div class="note-foot"><span id="n-wc">${wc(note.body)} words</span><span id="n-status">Saved</span></div>`;
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
    row.innerHTML=`<div class="trash-icon">${icon}</div>
      <div class="pw-info"><div class="pw-site">${esc(label)}</div><div class="pw-user">${esc(sub)}</div></div>
      <div class="trash-days">${d}d left</div>
      <div class="pw-acts">
        <button class="icon-btn restore" title="Restore">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4"/></svg>
        </button>
        <button class="icon-btn del" title="Delete forever">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>`;
    const [restBtn,delBtn]=row.querySelectorAll('.icon-btn');
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
  document.getElementById('jobs-stats').innerHTML=`
    <div class="job-stat accepted"><span>${acc}</span><small>Accepted</small></div>
    <div class="job-stat wait"><span>${wait}</span><small>Waiting</small></div>
    <div class="job-stat rejected"><span>${rej}</span><small>Rejected</small></div>
    <div class="job-stat total"><span>${S.jobs.length}</span><small>Total</small></div>`;

  const stMap={accepted:{cls:'status-accepted',label:'✅ Accepted'},wait:{cls:'status-wait',label:'⏳ Waiting'},rejected:{cls:'status-rejected',label:'❌ Rejected'}};

  list.forEach(job=>{
    const tr=document.createElement('tr');
    tr.className='draggable';tr.draggable=true;tr.dataset.id=job.id;
    const st=stMap[job.status]||stMap.wait;
    tr.innerHTML=`
      <td class="drag-handle-cell">⠿</td>
      <td class="editable-cell" data-field="company"><strong>${esc(job.company)}</strong></td>
      <td class="editable-cell" data-field="role">${esc(job.role)}</td>
      <td>
        <div style="display:flex;align-items:center;gap:5px">
          <a class="job-email" href="mailto:${esc(job.email)}">${esc(job.email)}</a>
          <button class="icon-btn copy copy-email-btn" title="Copy email" style="width:22px;height:22px;flex-shrink:0">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          </button>
        </div>
      </td>
      <td class="editable-cell" data-field="applied_at">${job.applied_at||'—'}</td>
      <td class="job-status-cell"><span class="job-status ${st.cls}">${st.label}</span></td>
      <td>
        <button class="icon-btn del del-job-btn" title="Delete">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
        </button>
      </td>`;

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
        inp.addEventListener('keydown',e=>{if(e.key==='Enter')inp.blur();if(e.key==='Escape'){td.innerHTML=field==='company'?`<strong>${esc(job.company)}</strong>`:esc(job[field]||'');};});
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
    const codeId=`totp-code-${item.id}`,progId=`totp-prog-${item.id}`;
    card.innerHTML=`
      <div class="totp-header">
        <span class="totp-icon">${item.icon||'🔐'}</span>
        <div class="totp-info"><div class="totp-name">${esc(item.name)}</div><div class="totp-issuer">${esc(item.issuer||'')}</div></div>
        <button class="icon-btn del totp-del" title="Remove"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
      <div class="totp-code" id="${codeId}">——</div>
      <div class="totp-foot">
        <div class="totp-bar-wrap"><div class="totp-bar" id="${progId}"></div></div>
        <button class="icon-btn copy totp-copy" title="Copy"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
      </div>`;
    card.querySelector('.totp-del').onclick=()=>confirm({
      title:'Remove account?',msg:`"${item.name}" will be removed.`,icon:'🗑️',okLabel:'Remove',
      onOk:async()=>{logInfo('totp', 'TOTP account removed', { name: item.name });await api.totpDelete(item.id);S.totp=S.totp.filter(t=>t.id!==item.id);renderTotpGrid();updateCounts();toast('Removed');}
    });
    card.querySelector('.totp-copy').onclick=()=>{
      const code=document.getElementById(codeId).textContent.replace(/\s/g,'');
      if(code&&code!=='——'){navigator.clipboard.writeText(code);toast('Code copied!');logInfo('totp', 'TOTP code copied', { name: item.name });}
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

    document.getElementById('monitor-circles').innerHTML=`
      <div class="mon-circle-wrap">
        ${makeCircleSvg(dbPct,'var(--accent)')}
        <div class="mon-circle-label">${fmt(st.dbSizeBytes||0)}</div>
        <div class="mon-circle-sub">Database used</div>
        <div class="mon-circle-sub" style="font-size:10px;margin-top:2px">${dbPct}% of 500 MB</div>
      </div>
      <div class="mon-circle-wrap">
        ${makeCircleSvg(logPct,'#f87171')}
        <div class="mon-circle-label">${fmt(st.logSize)}</div>
        <div class="mon-circle-sub">Log file</div>
      </div>`;

    document.getElementById('monitor-grid').innerHTML=`
      <div class="mon-card"><div class="mon-num">${st.items}</div><div class="mon-lbl">Vault items</div></div>
      <div class="mon-card"><div class="mon-num">${st.trash}</div><div class="mon-lbl">In trash</div></div>
      <div class="mon-card"><div class="mon-num">${st.jobs}</div><div class="mon-lbl">Job apps</div></div>
      <div class="mon-card mon-wide"><div class="mon-num" style="font-size:12px;font-family:var(--mono)">Supabase</div><div class="mon-lbl">EU West (Ireland) · Log: ${esc(sr.logPath||'')}</div></div>`;
    logOk('monitor', 'Monitor data loaded', { items: st.items, jobs: st.jobs, trash: st.trash });
  } else {
    logErr('monitor', 'Failed to load stats', sr.error);
  }
  if(lr.ok){const el=document.getElementById('log-view');el.textContent=lr.log||'(no errors logged)';el.scrollTop=el.height;}
}

function makeCircleSvg(pct,color){
  const r=44,circ=2*Math.PI*r;
  const dash=circ*(pct/100);
  return `<svg class="mon-circle-svg" viewBox="0 0 100 100">
    <circle cx="50" cy="50" r="${r}" fill="none" stroke="rgba(255,255,255,.07)" stroke-width="8"/>
    <circle cx="50" cy="50" r="${r}" fill="none" stroke="${color}" stroke-width="8"
      stroke-dasharray="${dash.toFixed(1)} ${circ.toFixed(1)}"
      stroke-dashoffset="${(circ/4).toFixed(1)}" stroke-linecap="round"/>
    <text x="50" y="54" text-anchor="middle" fill="${color}" font-size="16" font-weight="600" font-family="var(--mono)">${pct}%</text>
  </svg>`;
}

document.getElementById('btn-refresh-monitor').addEventListener('click',()=>{ logInfo('monitor', 'Refresh clicked'); loadMonitor(); });
document.getElementById('btn-clear-log').addEventListener('click',async()=>{
  logInfo('monitor', 'Clear log clicked');
  await api.monitor.clearLog();document.getElementById('log-view').textContent='(log cleared)';toast('Log cleared');
  logOk('monitor', 'Log cleared');
});

// ═══ SETTINGS ══════════════════════════════════════════════════════════════════
async function loadSettingsTab(){
  logInfo('settings', 'Loading settings tab');
  const r=await api.settings.load();
  if(r.ok)S.settings={...S.settings,...r.settings};
  document.getElementById('s-lock-timeout').value=S.settings.lock_timeout??5;
  document.getElementById('s-lock-action').value=S.settings.lock_action||'lock';
  const r2=await api.twofa.status();
  document.getElementById('s-2fa-status').textContent=r2.enabled?'✅ Enabled':'❌ Disabled';
  logOk('settings', 'Settings tab loaded', { ...S.settings, twofa: r2.enabled });
}
document.getElementById('btn-save-settings').addEventListener('click',async()=>{
  const timeout=parseInt(document.getElementById('s-lock-timeout').value)||0;
  const action=document.getElementById('s-lock-action').value;
  S.settings.lock_timeout=Math.max(0,Math.min(120,timeout));
  S.settings.lock_action=action;
  applyLockSettings();armLock();
  await api.settings.save(S.settings);
  toast('Settings saved ✓');
  logOk('settings', 'Settings saved', { lock_timeout: S.settings.lock_timeout, lock_action: S.settings.lock_action });
});
document.getElementById('btn-reset-settings').addEventListener('click',async()=>{
  logInfo('settings', 'Reset to defaults clicked');
  S.settings={lock_timeout:5,lock_action:'lock'};
  document.getElementById('s-lock-timeout').value=5;
  document.getElementById('s-lock-action').value='lock';
  applyLockSettings();armLock();
  await api.settings.save(S.settings);
  toast('Reset to defaults');
  logOk('settings', 'Settings reset to defaults');
});
document.getElementById('s-btn-2fa').addEventListener('click',()=>{
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
  logInfo('generator', 'Password generated', { length: len, strength: lbl });
  return pwStr;
}
document.getElementById('gen-len').addEventListener('input',function(){
  document.getElementById('gen-len-val').textContent=this.value;
  if(document.getElementById('gen-out').textContent!=='—')doGenerate();
});
function openGen(fillMode=false){
  logInfo('generator', 'Generator opened', { fillMode });
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
    body.innerHTML=`<p class="sub" style="margin:12px 0">Two-factor authentication is active.<br>Disable it below.</p>`;
    okBtn.hidden=true;disBtn.hidden=false;
    logInfo('2fa', '2FA is currently enabled');
  }else{
    document.getElementById('twofa-modal-title').textContent='Enable 2FA';
    body.innerHTML=`<p class="sub" style="margin-bottom:14px">Scan this QR code with your authenticator app,<br>then enter the 6-digit code to confirm.</p>
      <div id="qr-wrap" style="display:flex;justify-content:center;margin:12px 0"><p style="color:var(--muted)">Loading…</p></div>
      <p class="sub" style="margin-bottom:10px;font-size:11px;font-family:var(--mono)" id="2fa-secret-text">Loading…</p>
      <input class="fi twofa-input" id="twofa-setup-code" placeholder="000000" maxlength="6" inputmode="numeric" style="text-align:center;font-size:20px;letter-spacing:.3em;font-family:var(--mono);margin-top:6px" />
      <p class="err" id="twofa-setup-err" hidden></p>`;
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
  newDis.addEventListener('click',async()=>{logInfo('2fa', '2FA disable clicked');await api.twofa.disable();hide('twofa-overlay');toast('2FA disabled');logOk('2fa', '2FA disabled');});
  show('twofa-overlay');
});
document.getElementById('twofa-cancel').addEventListener('click',()=>hide('twofa-overlay'));
document.getElementById('twofa-overlay').addEventListener('click',e=>{if(e.target===document.getElementById('twofa-overlay'))hide('twofa-overlay');});

// ═══ TITLEBAR + KEYBOARD ══════════════════════════════════════════════════════
document.getElementById('wb-min').addEventListener('click',()=>{ logInfo('ui', 'Minimize clicked'); api.minimize(); });
document.getElementById('wb-max').addEventListener('click',()=>{ logInfo('ui', 'Maximize clicked'); api.maximize(); });
document.getElementById('wb-close').addEventListener('click',()=>{ logInfo('ui', 'Close clicked'); api.close(); });
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){
    logInfo('ui', 'Escape pressed — closing overlays');
    ['modal-overlay','gen-overlay','confirm-overlay','twofa-overlay','job-overlay','totp-overlay','status-popup'].forEach(id=>hide(id));
  }
});

screen('s-login');
logInfo('app', 'App initialized, showing login screen');
