/// <reference types="vite/client" />
import type { PreloadApi } from './src/types/renderer.d.ts';
import type { VaultItem, Job, TotpItem, Settings, UserProfile, VaultData, LogEntry, ConfirmOpts } from './src/types';

// ── Global declarations from preload bridge ──
declare global {
  interface Window {
    api: PreloadApi;
    __vaultToken: { set(t: string): void; clear(): void; };
    __soundsEnabled: boolean;
  }
}
declare const api: PreloadApi;

// ── Extended settings for renderer (includes sound tone settings not in shared type) ──
interface AppSettings extends Settings {
  sound_login_tone: string;
  sound_exit_tone: string;
  sound_hover_tone: string;
}

interface AppState {
  user: (UserProfile & { isAdmin?: boolean }) | null | undefined;
  passwords: VaultItem[];
  notes: VaultItem[];
  trash: Array<(VaultItem & { _type: string; _deletedAt: string }) | (Job & { _type: string; _deletedAt: string })>;
  jobs: Job[];
  totp: TotpItem[];
  activeNote: string | null | undefined;
  jobSort: { col: string; dir: number };
  jobFilter: string;
  settings: AppSettings;
}

interface ToneConfig {
  freqs: number[];
  type: OscillatorType;
  dur: number;
  vol: number;
  gap: number;
}

// ═══ STATE ════════════════════════════════════════════════════════════════════
const S: AppState = {
  user: null, passwords: [], notes: [], trash: [], jobs: [], totp: [], activeNote: null,
  jobSort: { col: '', dir: 1 }, jobFilter: 'all',
  settings: {
    lock_timeout: 5, lock_action: 'lock',
    lock_countdown: true, lock_on_minimize: false, compact: false, animations: true,
    accent: 'violet', sounds: true, sound_login: true, sound_exit: true, sound_hover: false,
    sound_login_tone: 'chime', sound_exit_tone: 'chime', sound_hover_tone: 'click',
    gen_length: 20, gen_symbols: true, gen_numbers: true, gen_ambiguous: false, gen_copy: true,
    toast_duration: 2400,
    pin_login_enabled: false, pin_allow_alpha: false,
  },
};

// ═══ LOGGER ═══════════════════════════════════════════════════════════════════
const RLOG_KEY = 'vault-renderer-log';
const RLOG_MAX = 2000;
function rlog(level: string, ctx: string, msg: string, data?: unknown): void {
  const entry = { ts: new Date().toISOString(), level, ctx, msg, data };
  try {
    const arr: typeof entry[] = JSON.parse(localStorage.getItem(RLOG_KEY) || '[]');
    arr.push(entry);
    if (arr.length > RLOG_MAX) arr.splice(0, arr.length - RLOG_MAX);
    localStorage.setItem(RLOG_KEY, JSON.stringify(arr));
  } catch { /* noop */ }
}
const logInfo = (ctx: string, msg: string, data?: unknown): void => rlog('INFO', ctx, msg, data);
const logOk   = (ctx: string, msg: string, data?: unknown): void => rlog('OK', ctx, msg, data);
const logWarn = (ctx: string, msg: string, data?: unknown): void => rlog('WARN', ctx, msg, data);
const logErr  = (ctx: string, msg: string, data?: unknown): void => rlog('ERROR', ctx, msg, data);
logInfo('app', 'Renderer initialized');

// ═══ UTILS ════════════════════════════════════════════════════════════════════
const uid  = (): string => Date.now().toString(36) + Math.random().toString(36).slice(2);
const wc   = (t: unknown): number => { const s = String(t || '').trim(); return s ? s.split(/\s+/).length : 0; };
const days = (d: string): number => Math.max(0, Math.ceil((30 * 86400000 - (Date.now() - new Date(d).getTime())) / 86400000));

function escapeHtml(t: unknown): string { const d = document.createElement('div'); d.textContent = String(t); return d.innerHTML; }
function formatLockTimer(ms: number): string {
  const totalSec = Math.ceil(ms / 1000);
  if (totalSec <= 0) return '0s';
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const totalHr = Math.floor(totalMin / 60);
  const h = totalHr % 24;
  const dd = Math.floor(totalHr / 24);
  if (dd > 0) return `${dd}d ${h}h`;
  if (totalHr > 0) return `${totalHr}h ${String(m).padStart(2, '0')}min`;
  if (totalMin > 0) return `${totalMin}min ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}
function toast(msg: string, ms?: number): void {
  if (ms === undefined) ms = S.settings.toast_duration || 2400;
  logInfo('ui', 'Toast: ' + msg);
  const el = document.getElementById('toast') as HTMLElement;
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), ms);
}
function show(id: string): void { (document.getElementById(id) as HTMLElement).hidden = false; }
function hide(id: string): void { (document.getElementById(id) as HTMLElement).hidden = true; }
function screen(s: string): void {
  ['s-login', 's-2fa', 's-lock', 's-pin', 's-app'].forEach((id: string) => {
    const el = document.getElementById(id);
    if (el) el.hidden = id !== s;
  });
}
function clearAllInputs(): void {
  document.querySelectorAll('input:not([type=checkbox]):not([type=range]),textarea').forEach((el) => {
    (el as HTMLInputElement | HTMLTextAreaElement).value = '';
  });
}

// ═══ SOUNDS ═══════════════════════════════════════════════════════════════════
const AudioCtx: typeof AudioContext = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
let actx: AudioContext | null = null;
function getACtx(): AudioContext { if (!actx) actx = new AudioCtx(); return actx; }
function playTone(freq: number, type: OscillatorType = 'sine', dur: number = 0.15, vol: number = 0.18, delay: number = 0): void {
  try {
    const ctx = getACtx(); const now = ctx.currentTime + delay;
    const osc = ctx.createOscillator(); const gain = ctx.createGain();
    osc.type = type; osc.frequency.setValueAtTime(freq, now); gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(vol, now + 0.02); gain.gain.exponentialRampToValueAtTime(0.001, now + dur);
    osc.connect(gain); gain.connect(ctx.destination); osc.start(now); osc.stop(now + dur);
  } catch { /* noop */ }
}
const TONES: Record<string, ToneConfig> = {
  chime:  { freqs: [523, 659, 784, 1047],      type: 'sine',     dur: 0.2,  vol: 0.15, gap: 0.1  },
  ding:   { freqs: [880, 1100],                  type: 'sine',     dur: 0.18, vol: 0.18, gap: 0.08 },
  soft:   { freqs: [440, 554],                   type: 'sine',     dur: 0.25, vol: 0.10, gap: 0.12 },
  bright: { freqs: [660, 880, 1100, 1320],      type: 'triangle', dur: 0.15, vol: 0.16, gap: 0.07 },
  click:  { freqs: [1200],                       type: 'square',   dur: 0.03, vol: 0.06, gap: 0    },
  tap:    { freqs: [800],                        type: 'sine',     dur: 0.04, vol: 0.08, gap: 0    },
  pop:    { freqs: [600, 900],                   type: 'sine',     dur: 0.06, vol: 0.10, gap: 0.03 },
};
function playToneSeq(toneName: string): void {
  const t = TONES[toneName] || TONES.chime;
  t.freqs.forEach((f: number, i: number) => playTone(f, t.type, t.dur, t.vol, i * t.gap));
}
function playSound(type: string): void {
  if (window.__soundsEnabled === false) return;
  const s = S.settings;
  switch (type) {
    case 'login':
      if (!s.sound_login) return;
      playToneSeq(s.sound_login_tone || 'chime');
      break;
    case 'logout': case 'lock':
      if (!s.sound_exit) return;
      if (s.sound_exit_tone && TONES[s.sound_exit_tone]) {
        const t = TONES[s.sound_exit_tone];
        t.freqs.slice().reverse().forEach((f: number, i: number) => playTone(f, t.type, t.dur, t.vol * 0.8, i * t.gap));
      } else {
        [784, 659, 523].forEach((f: number, i: number) => playTone(f, 'sine', 0.18, 0.12, i * 0.09));
      }
      break;
    case 'hover':
      if (!s.sound_hover) return;
      playToneSeq(s.sound_hover_tone || 'click');
      break;
  }
}
api.onPlaySound((type: string) => playSound(type));
api.onTrayLock(() => { if (S.user) { logInfo('auth', 'Tray lock'); doLock(); hide('tab-monitor'); } });
api.onTrayLogout(() => { if (S.user) { logInfo('auth', 'Tray logout'); doLogout(); hide('tab-monitor'); } });

// ═══ SOUND TEST BUTTONS ════════════════════════════════════════════════════════
function testSound(soundType: string): void {
  if (window.__soundsEnabled === false) return;
  const s = S.settings;
  switch (soundType) {
    case 'login':
      playToneSeq(s.sound_login_tone || 'chime');
      break;
    case 'exit':
      if (s.sound_exit_tone && TONES[s.sound_exit_tone]) {
        const t = TONES[s.sound_exit_tone];
        t.freqs.slice().reverse().forEach((f: number, i: number) => playTone(f, t.type, t.dur, t.vol * 0.8, i * t.gap));
      } else {
        [784, 659, 523].forEach((f: number, i: number) => playTone(f, 'sine', 0.18, 0.12, i * 0.09));
      }
      break;
    case 'hover':
      playToneSeq(s.sound_hover_tone || 'click');
      break;
  }
}
(document.getElementById('btn-test-login-sound') as HTMLButtonElement).addEventListener('click', () => testSound('login'));
(document.getElementById('btn-test-exit-sound') as HTMLButtonElement).addEventListener('click', () => testSound('exit'));
(document.getElementById('btn-test-hover-sound') as HTMLButtonElement).addEventListener('click', () => testSound('hover'));

// ═══ WINDOWS SNAP ═════════════════════════════════════════════════════════════
(document.getElementById('titlebar') as HTMLElement).addEventListener('dblclick', (e: MouseEvent) => {
  if ((e.target as HTMLElement).closest('.tb-right')) return;
  logInfo('ui', 'Titlebar double-clicked — maximize toggle');
  api.maximize();
});

// ═══ CONFIRM ══════════════════════════════════════════════════════════════════
function confirm(opts: ConfirmOpts): void {
  logInfo('ui', 'Confirm dialog shown', { title: opts.title });
  (document.getElementById('confirm-title') as HTMLElement).textContent = opts.title || 'Are you sure?';
  (document.getElementById('confirm-msg') as HTMLElement).textContent = opts.msg || '';
  (document.getElementById('confirm-icon') as HTMLElement).textContent = opts.icon || '🗑️';
  const okBtn = document.getElementById('confirm-ok') as HTMLButtonElement;
  const newOk = okBtn.cloneNode(true) as HTMLButtonElement;
  okBtn.parentNode!.replaceChild(newOk, okBtn);
  newOk.textContent = opts.okLabel || 'Delete'; newOk.className = opts.okClass || 'btn-danger';
  newOk.addEventListener('click', () => { hide('confirm-overlay'); logInfo('ui', 'Confirm dialog accepted', { title: opts.title }); opts.onOk(); });
  show('confirm-overlay');
}
(document.getElementById('confirm-cancel') as HTMLButtonElement).addEventListener('click', () => { hide('confirm-overlay'); logInfo('ui', 'Confirm dialog cancelled'); });
(document.getElementById('confirm-overlay') as HTMLElement).addEventListener('click', (e: MouseEvent) => {
  if (e.target === (document.getElementById('confirm-overlay') as HTMLElement)) { hide('confirm-overlay'); logInfo('ui', 'Confirm dialog dismissed (overlay click)'); }
});

// ═══ AUTO-LOCK ════════════════════════════════════════════════════════════════
let LOCK_MS: number = 5 * 60 * 1000;
let lockTimer: ReturnType<typeof setTimeout> | undefined;
let lockTick: ReturnType<typeof setInterval> | undefined;
let lockDeadline: number = 0;
function applyLockSettings(): void {
  const t = S.settings.lock_timeout;
  LOCK_MS = t > 0 ? t * 60 * 1000 : Infinity;
  const row = document.getElementById('lock-row') as HTMLElement;
  const showCountdown = S.settings.lock_countdown !== false;
  if (row) row.hidden = (t === 0 || !showCountdown);
  logInfo('settings', 'Lock settings applied', { timeout: t, lockMs: LOCK_MS });
}
function armLock(): void {
  clearTimeout(lockTimer); clearInterval(lockTick);
  if (S.settings.lock_timeout === 0) return;
  lockDeadline = Date.now() + LOCK_MS;
  const row = document.getElementById('lock-row') as HTMLElement;
  if (row && S.settings.lock_countdown !== false) row.hidden = false;
  lockTick = setInterval(() => {
    const rem = Math.max(0, lockDeadline - Date.now());
    const el = document.getElementById('lock-label') as HTMLElement;
    if (el) el.textContent = `locks in ${formatLockTimer(rem)}`;
    if (rem <= 0) clearInterval(lockTick);
  }, 1000);
  lockTimer = setTimeout(() => {
    logInfo('auth', 'Auto-lock timer expired');
    playSound('lock');
    if (S.settings.lock_action === 'exit') { logInfo('auth', 'Lock action: exit'); api.close(); } else doLock();
  }, LOCK_MS);
}
function disarmLock(): void {
  clearTimeout(lockTimer); clearInterval(lockTick);
  const row = document.getElementById('lock-row') as HTMLElement;
  if (row) row.hidden = true;
}
let _lockInProgress = false;
function doLock(): void {
  if (_lockInProgress) return;
  _lockInProgress = true;
  logInfo('auth', 'Locking vault');
  disarmLock();
  S.passwords = []; S.notes = []; S.totp = []; S.jobs = []; S.trash = []; S.activeNote = null;
  document.querySelectorAll('.pw-real').forEach((el) => { (el as HTMLElement).textContent = ''; el.remove(); });
  api.lock().catch(() => { /* noop */ });
  if (S.settings.pin_login_enabled) {
    screen('s-pin');
    logInfo('auth', 'Locked — showing PIN entry screen');
  } else {
    screen('s-lock');
    logInfo('auth', 'Locked — showing Google unlock screen');
  }
  logInfo('auth', 'Sensitive data cleared from memory on lock');
  setTimeout(() => { _lockInProgress = false; }, 2000);
}
['mousemove', 'keydown', 'mousedown', 'touchstart'].forEach((ev) => document.addEventListener(ev, () => {
  if (S.user && S.settings.lock_timeout > 0) armLock();
}, { passive: true }));

(document.getElementById('btn-unlock') as HTMLButtonElement).addEventListener('click', async () => {
  const btn = document.getElementById('btn-unlock') as HTMLButtonElement;
  if (btn.disabled) return;
  logInfo('auth', 'Unlock button clicked');
  btn.textContent = 'Opening browser…'; btn.disabled = true;
  const r = await api.reauth();
  if (r.ok) {
    if (r.token) window.__vaultToken.set(r.token);
    S.user = r.user; loadVault(r.vault); screen('s-app'); armLock();
    toast('Vault unlocked'); logOk('auth', 'Vault unlocked via reauth', { email: S.user?.email });
  } else {
    btn.textContent = 'Unlock with Google'; btn.disabled = false;
    toast('Unlock failed: ' + r.error); logErr('auth', 'Unlock failed', r.error);
  }
});

// ═══ AUTH ═════════════════════════════════════════════════════════════════════
(document.getElementById('btn-login') as HTMLButtonElement).addEventListener('click', async () => {
  const btn = document.getElementById('btn-login') as HTMLButtonElement;
  if (btn.disabled) return;
  logInfo('auth', 'Login button clicked');
  btn.textContent = 'Opening browser…'; btn.disabled = true;
  const r = await api.login();
  if (!r.ok) {
    const err = document.getElementById('login-err') as HTMLElement;
    err.hidden = false; err.textContent = r.error ?? "";
    logErr('auth', 'Login failed', r.error);
    btn.textContent = 'Sign in with Google'; btn.disabled = false; return;
  }
  if (r.needs2fa) {
    S.user = r.user; screen('s-2fa');
    btn.textContent = 'Sign in with Google'; btn.disabled = false;
    logInfo('auth', 'Login requires 2FA', { email: S.user?.email }); return;
  }
  if (r.token) window.__vaultToken.set(r.token);
  S.user = r.user; loadVault(r.vault); await loadSettings(); enterApp();
  logOk('auth', 'Login successful', { email: S.user?.email });
});
(document.getElementById('btn-verify2fa') as HTMLButtonElement).addEventListener('click', async () => {
  const token = (document.getElementById('twofa-code') as HTMLInputElement).value.trim();
  logInfo('auth', '2FA verify attempt');
  const r = await api.verify2fa(token);
  if (!r.ok) {
    (document.getElementById('twofa-err') as HTMLElement).hidden = false;
    (document.getElementById('twofa-err') as HTMLElement).textContent = r.error ?? "";
    logWarn('auth', '2FA verify failed', r.error); return;
  }
  if (r.token) window.__vaultToken.set(r.token);
  S.user = r.user; loadVault(r.vault); await loadSettings(); enterApp();
  logOk('auth', '2FA verified, login complete');
});
(document.getElementById('twofa-code') as HTMLInputElement).addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter') (document.getElementById('btn-verify2fa') as HTMLButtonElement).click();
});

// ═══ PIN UNLOCK ═══════════════════════════════════════════════════════════════
let _selectedAccount: { googleId: string; email: string; name: string; avatar: string | null } | null = null;

function showPinAccounts() {
  _selectedAccount = null;
  hide('pin-selected-account');
  show('pin-user-label');
  show('pin-accounts');
  (document.getElementById('pin-code') as HTMLInputElement).value = '';
  (document.getElementById('pin-err') as HTMLElement).hidden = true;
}

function selectPinAccount(account: { googleId: string; email: string; name: string; avatar: string | null }) {
  _selectedAccount = account;
  hide('pin-accounts');
  hide('pin-user-label');
  show('pin-selected-account');

  const avatarEl = document.getElementById('pin-selected-avatar') as HTMLElement;
  avatarEl.innerHTML = '';
  avatarEl.className = '';
  if (account.avatar && account.avatar.startsWith('https://')) {
    const img = document.createElement('img');
    img.className = 'pin-selected-avatar';
    img.src = account.avatar;
    img.addEventListener('error', () => { img.remove(); avatarEl.className = 'pin-selected-avatar-fb'; avatarEl.textContent = (account.name || '?')[0].toUpperCase(); });
    avatarEl.appendChild(img);
  } else {
    avatarEl.className = 'pin-selected-avatar-fb';
    avatarEl.textContent = (account.name || account.email || '?')[0].toUpperCase();
  }

  (document.getElementById('pin-selected-name') as HTMLElement).textContent = account.name || account.email;
  (document.getElementById('pin-selected-email') as HTMLElement).textContent = account.email;
  (document.getElementById('pin-code') as HTMLInputElement).value = '';
  (document.getElementById('pin-err') as HTMLElement).hidden = true;
  setTimeout(() => (document.getElementById('pin-code') as HTMLInputElement).focus(), 60);
}

async function loadPinAccounts() {
  try {
    const r = await api.accounts.list();
    if (!r.ok || !r.accounts.length) {
      showPinAccounts();
      return;
    }
    const list = document.getElementById('pin-accounts-list') as HTMLElement;
    list.innerHTML = '';
    for (const acct of r.accounts) {
      const item = document.createElement('div');
      item.className = 'pin-account-item';
      const init = (acct.name || acct.email || '?')[0].toUpperCase();
      if (acct.avatar && acct.avatar.startsWith('https://')) {
        const img = document.createElement('img');
        img.className = 'pin-account-avatar';
        img.src = acct.avatar;
        img.addEventListener('error', () => {
          img.remove();
          const fb = document.createElement('div');
          fb.className = 'pin-account-avatar-fb';
          fb.textContent = init;
          item.insertBefore(fb, item.firstChild);
        });
        item.appendChild(img);
      } else {
        const fb = document.createElement('div');
        fb.className = 'pin-account-avatar-fb';
        fb.textContent = init;
        item.appendChild(fb);
      }
      const nameEl = document.createElement('div');
      nameEl.className = 'pin-account-name';
      nameEl.textContent = acct.name || acct.email;
      item.appendChild(nameEl);
      const emailEl = document.createElement('div');
      emailEl.className = 'pin-account-email';
      emailEl.textContent = acct.email;
      item.appendChild(emailEl);
      item.addEventListener('click', () => selectPinAccount(acct));
      list.appendChild(item);
    }
    const accountsWrap = document.getElementById('pin-accounts') as HTMLElement;
    accountsWrap.hidden = false;
  } catch { /* noop */ }
}

(document.getElementById('btn-pin-unlock') as HTMLButtonElement).addEventListener('click', async () => {
  const pin = (document.getElementById('pin-code') as HTMLInputElement).value;
  logInfo('auth', 'PIN unlock attempt');
  const r = await api.pin.verify(pin);
  if (!r.ok) {
    (document.getElementById('pin-err') as HTMLElement).hidden = false;
    (document.getElementById('pin-err') as HTMLElement).textContent = r.error ?? 'Incorrect PIN';
    logWarn('auth', 'PIN verify failed', r.error);
    return;
  }
  logOk('auth', 'PIN verified, completing login', { email: r.email });
  // Update lastUsed for the account
  if (r.googleId) {
    api.accounts.touch(r.googleId).catch(() => {});
  }
  const r2 = await api.loginWithPin(r.googleId!, r.email!);
  if (!r2.ok) {
    (document.getElementById('pin-err') as HTMLElement).hidden = false;
    (document.getElementById('pin-err') as HTMLElement).textContent = r2.error ?? 'Login failed';
    logErr('auth', 'PIN login failed', r2.error);
    return;
  }
  if (r2.token) window.__vaultToken.set(r2.token);
  S.user = r2.user; loadVault(r2.vault); await loadSettings(); enterApp();
  logOk('auth', 'PIN login successful', { email: S.user?.email });
});
(document.getElementById('pin-code') as HTMLInputElement).addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter') (document.getElementById('btn-pin-unlock') as HTMLButtonElement).click();
});
(document.getElementById('btn-pin-google') as HTMLButtonElement).addEventListener('click', () => {
  logInfo('auth', 'Switching to Google OAuth from PIN screen');
  clearAllInputs();
  (document.getElementById('pin-err') as HTMLElement).hidden = true;
  screen('s-login');
});
const _pinBackBtn = document.getElementById('pin-account-back') as HTMLButtonElement;
if (_pinBackBtn) _pinBackBtn.addEventListener('click', () => {
  showPinAccounts();
  loadPinAccounts();
});

async function doLogout(): Promise<void> {
  logInfo('auth', 'Logout clicked', { user: S.user?.email });
  playSound('logout'); await api.logout();
  S.user = null; S.passwords = []; S.notes = []; S.trash = []; S.jobs = []; S.totp = []; S.activeNote = null;
  Object.keys(_tabCache).forEach((k) => delete _tabCache[k]);
  disarmLock(); clearAllInputs();
  if (S.settings.pin_login_enabled) {
    screen('s-pin');
    logOk('auth', 'Logged out, showing PIN entry screen');
  } else {
    screen('s-login');
    (document.getElementById('btn-login') as HTMLButtonElement).textContent = 'Sign in with Google';
    (document.getElementById('btn-login') as HTMLButtonElement).disabled = false;
    (document.getElementById('login-err') as HTMLElement).hidden = true;
    logOk('auth', 'Logged out, state cleared');
  }
}
(document.getElementById('btn-logout') as HTMLButtonElement).addEventListener('click', () => doLogout());

function loadVault(v: VaultData | null | undefined): void {
  S.passwords = v?.passwords || []; S.notes = v?.notes || [];
  logInfo('vault', 'Vault loaded into memory', { passwords: S.passwords.length, notes: S.notes.length });
}
async function loadSettings(): Promise<void> {
  const r = await api.settings.load();
  if (r.ok) S.settings = { ...S.settings, ...r.settings } as AppSettings;
  applyLockSettings();
  applyAccent(S.settings.accent || 'violet');
  document.body.classList.toggle('compact', !!S.settings.compact);
  document.body.style.setProperty('--transition', S.settings.animations ? '' : '0s');
  window.__soundsEnabled = S.settings.sounds !== false;
  // Show PIN indicator in sidebar when PIN login is enabled
  const pinIndicator = document.getElementById('pin-indicator') as HTMLElement;
  if (pinIndicator) pinIndicator.hidden = !S.settings.pin_login_enabled;
  logInfo('settings', 'settings loaded', S.settings);
}
function isAdmin(): boolean { return S.user?.isAdmin === true; }
function enterApp(): void {
  logInfo('app', 'Entering app screen');
  screen('s-app'); renderUserChip();
  const showAdmin = isAdmin();
  document.querySelectorAll('.admin-only-nav').forEach((el) => { (el as HTMLElement).hidden = !showAdmin; });
  if (!showAdmin && (document.querySelector('.nav-btn.active') as HTMLElement)?.dataset.tab === 'monitor') switchTab('passwords');
  switchTab('passwords'); armLock();
  // Save account for quick PIN login
  api.accounts.save().catch(() => {});
}
function renderUserChip(): void {
  const u = S.user!; const init = (u.name || u.email || '?')[0].toUpperCase();
  const chip = document.getElementById('user-chip') as HTMLElement; chip.innerHTML = '';
  if (u.avatar) {
    const img = document.createElement('img'); img.className = 'avatar';
    if (u.avatar.startsWith('https://') && (u.avatar.includes('googleusercontent.com') || u.avatar.includes('google.com'))) img.src = u.avatar;
    chip.appendChild(img);
  } else {
    const fb = document.createElement('div'); fb.className = 'avatar-fb'; fb.textContent = init;
    chip.appendChild(fb);
  }
  const info = document.createElement('div');
  const nm = document.createElement('div'); nm.className = 'u-name'; nm.textContent = u.name || '';
  const em = document.createElement('div'); em.className = 'u-email'; em.textContent = u.email || '';
  info.appendChild(nm); info.appendChild(em);
  chip.appendChild(info);
}

// ═══ TABS ══════════════════════════════════════════════════════════════════════
const _tabCache: Record<string, boolean> = {};
let _monitorRefreshTimer: ReturnType<typeof setTimeout> | null = null;
document.querySelectorAll('.nav-btn[data-tab]').forEach((btn) => {
  const b = btn as HTMLElement;
  b.addEventListener('click', () => switchTab(b.dataset.tab!));
});
function switchTab(tab: string): void {
  if (tab === 'monitor' && !isAdmin()) { logWarn('ui', 'Non-admin tried to open monitor tab'); return; }
  logInfo('ui', 'Tab switched', { tab });
  if (tab !== 'monitor') { clearTimeout(_monitorRefreshTimer!); }
  document.querySelectorAll('.nav-btn[data-tab]').forEach((b) => {
    const el = b as HTMLElement; el.classList.toggle('active', el.dataset.tab === tab);
  });
  ['passwords', 'notes', 'jobs', 'totp', 'trash', 'monitor', 'settings'].forEach((t) => {
    (document.getElementById('tab-' + t) as HTMLElement).hidden = t !== tab;
  });
  if (tab === 'passwords') renderPasswords();
  if (tab === 'notes') renderNotesList();
  if (tab === 'trash') { if (!_tabCache.trash) { loadAndRenderTrash(); _tabCache.trash = true; } }
  if (tab === 'jobs') { if (!_tabCache.jobs) { loadAndRenderJobs(); _tabCache.jobs = true; } }
  if (tab === 'totp') { if (!_tabCache.totp) { loadAndRenderTotp(); _tabCache.totp = true; } }
  if (tab === 'monitor') loadMonitor();
  if (tab === 'settings') { if (!_tabCache.settings) { loadSettingsTab(); _tabCache.settings = true; } }
  updateCounts();
}
function updateCounts(): void {
  (document.getElementById('cnt-pw') as HTMLElement).textContent = String(S.passwords.length);
  (document.getElementById('cnt-notes') as HTMLElement).textContent = String(S.notes.length);
  (document.getElementById('cnt-trash') as HTMLElement).textContent = String(S.trash.length);
  (document.getElementById('cnt-jobs') as HTMLElement).textContent = String(S.jobs.length);
  (document.getElementById('cnt-totp') as HTMLElement).textContent = String(S.totp.length);
}
(document.getElementById('btn-sync') as HTMLButtonElement).addEventListener('click', async () => {
  logInfo('vault', 'Sync triggered');
  const btn = document.getElementById('btn-sync') as HTMLButtonElement;
  btn.style.opacity = '.5'; btn.style.pointerEvents = 'none';
  const r = await api.sync();
  btn.style.opacity = ''; btn.style.pointerEvents = '';
  if (r.ok) { loadVault(r.vault); switchTab('passwords'); toast('Synced ✓'); logOk('vault', 'Sync successful'); }
  else { toast('Sync error: ' + r.error); logErr('vault', 'Sync failed', r.error); }
});

// ═══ PASSWORDS ════════════════════════════════════════════════════════════════
(document.getElementById('btn-add-pw') as HTMLButtonElement).addEventListener('click', () => { logInfo('password', 'Add password clicked'); openPwModal(); });
(document.getElementById('pw-search') as HTMLInputElement).addEventListener('input', renderPasswords);

async function getLogo(site: string): Promise<string | null> {
  if (!site) return null;
  try {
    const r = await api.logoFetch(site);
    return r?.ok ? r.url ?? null : null;
  } catch { return null; }
}

// HIBP breach check
const breachCache: Record<string, string> = {};
async function checkBreach(password: string): Promise<boolean> {
  try {
    const sha1 = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(password));
    const hex = Array.from(new Uint8Array(sha1)).map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    const prefix = hex.slice(0, 5), suffix = hex.slice(5);
    if (breachCache[prefix] !== undefined) return breachCache[prefix].includes(suffix);
    const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`);
    const text = await res.text();
    breachCache[prefix] = text;
    return text.includes(suffix);
  } catch { return false; }
}

function renderPasswords(): void {
  const q = (document.getElementById('pw-search') as HTMLInputElement).value.toLowerCase();
  const list = S.passwords.filter((p) => !q || p.site?.toLowerCase().includes(q) || p.username?.toLowerCase().includes(q));
  const wrap = document.getElementById('pw-list') as HTMLElement;
  wrap.querySelectorAll('.pw-row').forEach((e) => (e as HTMLElement).remove());
  (document.getElementById('pw-empty') as HTMLElement).hidden = !!list.length;
  if (!list.length) return;

  list.forEach((pw) => {
    const row = document.createElement('div'); row.className = 'pw-row';
    const initial = (pw.site || '?')[0].toUpperCase();

    const iconId = 'icon-' + pw.id;
    const iconDiv = document.createElement('div'); iconDiv.className = 'pw-icon'; iconDiv.id = iconId; iconDiv.textContent = initial; row.appendChild(iconDiv);
    const infoDiv = document.createElement('div'); infoDiv.className = 'pw-info';
    const siteDiv = document.createElement('div'); siteDiv.className = 'pw-site'; siteDiv.textContent = pw.site || ''; infoDiv.appendChild(siteDiv);
    const userDiv = document.createElement('div'); userDiv.className = 'pw-user'; userDiv.textContent = pw.username || ''; infoDiv.appendChild(userDiv);
    if (pw.notes) { const noteDiv = document.createElement('div'); noteDiv.className = 'pw-note'; noteDiv.textContent = pw.notes; infoDiv.appendChild(noteDiv); }
    row.appendChild(infoDiv);
    const pwWrap = document.createElement('div'); pwWrap.className = 'pw-pw-wrap';
    const hidSpan = document.createElement('span'); hidSpan.className = 'pw-hidden'; hidSpan.textContent = '••••••••'; pwWrap.appendChild(hidSpan);
    const revSpan = document.createElement('span'); revSpan.className = 'pw-real'; revSpan.hidden = true; revSpan.textContent = pw.password || ''; pwWrap.appendChild(revSpan);
    const smWrap = document.createElement('div'); smWrap.className = 'pw-inline-sm'; smWrap.id = 'psm-' + pw.id; smWrap.hidden = true;
    const smBars = document.createElement('div'); smBars.className = 'sm-bars sm-inline';
    for (let i = 0; i < 4; i++) { const b = document.createElement('div'); b.className = 'sm-bar'; smBars.appendChild(b); }
    smWrap.appendChild(smBars);
    const smLbl = document.createElement('span'); smLbl.className = 'sm-lbl psm-lbl'; smLbl.textContent = '—'; smWrap.appendChild(smLbl);
    const breachBadge = document.createElement('span'); breachBadge.className = 'breach-badge'; breachBadge.id = 'breach-' + pw.id; breachBadge.hidden = true; breachBadge.textContent = '⚠️ breached';
    row.appendChild(breachBadge);
    pwWrap.appendChild(smWrap);
    const eyeBtn = document.createElement('button'); eyeBtn.className = 'eye-inline'; eyeBtn.title = 'Hold to show';
    eyeBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
    pwWrap.appendChild(eyeBtn);
    row.appendChild(pwWrap);
    const actsDiv = document.createElement('div'); actsDiv.className = 'pw-acts';
    const copyBtn = document.createElement('button'); copyBtn.className = 'icon-btn copy'; copyBtn.title = 'Copy password';
    copyBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    actsDiv.appendChild(copyBtn);
    const editBtn = document.createElement('button'); editBtn.className = 'icon-btn'; editBtn.title = 'Edit';
    editBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
    actsDiv.appendChild(editBtn);
    const delBtn = document.createElement('button'); delBtn.className = 'icon-btn del'; delBtn.title = 'Move to trash';
    delBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';
    actsDiv.appendChild(delBtn);
    row.appendChild(actsDiv);
    getLogo(pw.site ?? '').then((url) => {
      if (!url) return;
      const el = document.getElementById(iconId) as HTMLElement;
      if (!el) return;
      el.innerHTML = '';
      const img = document.createElement('img');
      img.width = 22; img.height = 22;
      img.style.borderRadius = '4px'; img.style.objectFit = 'contain'; img.style.display = 'block';
      img.src = url;
      img.addEventListener('error', () => {
        // Fallback to initial letter on error
        el.innerHTML = '';
        el.textContent = initial;
      });
      el.appendChild(img);
    });
    checkBreach(pw.password || '').then((breached) => {
      const b = document.getElementById('breach-' + pw.id) as HTMLElement;
      if (b) b.hidden = !breached;
    });
    eyeBtn.addEventListener('mousedown', () => {
      hidSpan.hidden = true; revSpan.hidden = false; smWrap.hidden = false;
      updateInlineSm(smWrap, pw.password || '');
    });
    const hideEye = (): void => { hidSpan.hidden = false; revSpan.hidden = true; smWrap.hidden = true; };
    eyeBtn.addEventListener('mouseup', hideEye);
    eyeBtn.addEventListener('mouseleave', hideEye);
    eyeBtn.addEventListener('touchstart', (e: TouchEvent) => {
      e.preventDefault(); hidSpan.hidden = true; revSpan.hidden = false; smWrap.hidden = false; updateInlineSm(smWrap, pw.password || '');
    }, { passive: false });
    eyeBtn.addEventListener('touchend', hideEye);

    copyBtn.onclick = () => {
      navigator.clipboard.writeText(pw.password || '');
      toast('Password copied! (clipboard clears in 30s)');
      logInfo('password', 'Password copied to clipboard', { site: pw.site });
      setTimeout(() => { navigator.clipboard.writeText('')?.catch?.(() => {}); logInfo('password', 'Clipboard auto-cleared'); }, 30000);
    };
    editBtn.onclick = () => { logInfo('password', 'Edit password', { site: pw.site }); openPwModal(pw); };
    delBtn.onclick = () => confirm({
      title: 'Move to Trash?', msg: `"${pw.site}" will be moved to Trash and auto-deleted after 30 days.`,
      icon: '🗑️', okLabel: 'Move to Trash',
      onOk: async () => {
        logInfo('password', 'Moving to trash', { site: pw.site, dbId: pw._dbId });
        if (pw._dbId) await api.delete(pw._dbId);
        S.passwords = S.passwords.filter((p) => p.id !== pw.id);
        renderPasswords(); updateCounts(); toast('Moved to Trash');
        logOk('password', 'Moved to trash', { site: pw.site });
      }
    });
    wrap.appendChild(row);
  });
}

function updateInlineSm(wrap: HTMLElement, pw: string): void {
  const { n, lbl, cls } = scoreP(pw);
  wrap.querySelectorAll('.sm-bar').forEach((b, i) => { b.className = 'sm-bar' + (i < n ? ` l${n}` : ''); });
  const l = wrap.querySelector('.psm-lbl'); if (l) { l.textContent = lbl; l.className = 'sm-lbl psm-lbl ' + cls; }
}

let _pwEx: VaultItem | null = null;
function openPwModal(existing: VaultItem | null = null): void {
  _pwEx = existing;
  logInfo('password', existing ? 'Opening edit password modal' : 'Opening add password modal', { site: existing?.site });
  (document.getElementById('modal-title') as HTMLElement).textContent = existing ? 'Edit password' : 'Add password';
  (document.getElementById('f-site') as HTMLInputElement).value = existing?.site || '';
  (document.getElementById('f-user') as HTMLInputElement).value = existing?.username || '';
  (document.getElementById('f-pw') as HTMLInputElement).value = existing?.password || '';
  (document.getElementById('f-pw') as HTMLInputElement).type = 'password';
  (document.getElementById('f-notes') as HTMLTextAreaElement).value = existing?.notes || '';
  updateSm('sm', existing?.password || '');
  const pwInp = document.getElementById('f-pw') as HTMLInputElement;
  const newInp = pwInp.cloneNode(true) as HTMLInputElement; pwInp.parentNode!.replaceChild(newInp, pwInp);
  newInp.value = existing?.password || ''; newInp.type = 'password';
  newInp.addEventListener('input', () => updateSm('sm', newInp.value));
  show('modal-overlay'); setTimeout(() => (document.getElementById('f-site') as HTMLInputElement).focus(), 60);
}
(document.getElementById('eye-btn') as HTMLButtonElement).addEventListener('click', () => {
  const f = document.getElementById('f-pw') as HTMLInputElement; f.type = f.type === 'password' ? 'text' : 'password';
});
(document.getElementById('use-gen-btn') as HTMLButtonElement).addEventListener('click', () => openGen(true));
(document.getElementById('modal-ok') as HTMLButtonElement).addEventListener('click', async () => {
  const site = (document.getElementById('f-site') as HTMLInputElement).value.trim();
  const username = (document.getElementById('f-user') as HTMLInputElement).value.trim();
  const password = (document.getElementById('f-pw') as HTMLInputElement).value;
  const notes = (document.getElementById('f-notes') as HTMLTextAreaElement).value.trim();
  if (!site || !password) { toast('Site and password required'); return; }
  const existing = _pwEx; hide('modal-overlay');
  if (existing) {
    Object.assign(existing, { site, username, password, notes });
    const r = await api.save('password', existing);
    if (r.ok && !existing._dbId) existing._dbId = r.dbId;
    toast('Updated'); logOk('password', 'Password updated', { site });
  } else {
    const item: VaultItem = { id: uid(), site, username, password, notes };
    const r = await api.save('password', item);
    if (r.ok) item._dbId = r.dbId;
    S.passwords.unshift(item); toast('Saved'); logOk('password', 'Password created', { site });
  }
  renderPasswords(); updateCounts();
});
(document.getElementById('modal-cancel') as HTMLButtonElement).addEventListener('click', () => hide('modal-overlay'));
(document.getElementById('modal-overlay') as HTMLElement).addEventListener('click', (e: MouseEvent) => {
  if (e.target === (document.getElementById('modal-overlay') as HTMLElement)) hide('modal-overlay');
});

// ═══ NOTES with drag reorder (vertical only) ═══════════════════════════════
(document.getElementById('btn-add-note') as HTMLButtonElement).addEventListener('click', async () => {
  logInfo('note', 'New note created');
  const note: VaultItem = { id: uid(), title: 'Untitled', body: '' };
  const r = await api.save('note', note); if (r.ok) note._dbId = r.dbId;
  S.notes.unshift(note); renderNotesList(); updateCounts(); openNote(note.id as string);
});

function renderNotesList(): void {
  const wrap = document.getElementById('notes-list') as HTMLElement;
  wrap.querySelectorAll('.note-chip').forEach((e) => (e as HTMLElement).remove());
  (document.getElementById('notes-empty') as HTMLElement).hidden = !!S.notes.length;
  if (!S.notes.length) return;
  S.notes.forEach((n) => {
    const el = document.createElement('div');
    el.className = 'note-chip draggable' + (String(n.id) === S.activeNote ? ' active' : '');
    el.draggable = true; el.dataset.id = String(n.id);
    const dragHandle = document.createElement('span'); dragHandle.className = 'drag-handle'; dragHandle.textContent = '⠿'; el.appendChild(dragHandle);
    const chipBody = document.createElement('div'); chipBody.className = 'note-chip-body';
    const ncTitle = document.createElement('div'); ncTitle.className = 'nc-title'; ncTitle.textContent = n.title || 'Untitled'; chipBody.appendChild(ncTitle);
    const ncPrev = document.createElement('div'); ncPrev.className = 'nc-prev'; ncPrev.textContent = n.body?.slice(0, 55) || 'Empty'; chipBody.appendChild(ncPrev);
    chipBody.onclick = () => openNote(String(n.id));
    el.appendChild(chipBody);
    addVerticalDrag(el, 'notes-list', () => api.reorder('note', S.notes));
    wrap.appendChild(el);
  });
}

function openNote(id: string): void {
  S.activeNote = id;
  const note = S.notes.find((n) => String(n.id) === id) as VaultItem | undefined;
  if (!note) return;
  logInfo('note', 'Note opened', { noteId: id, title: note.title });
  renderNotesList();
  const editor = document.getElementById('note-editor') as HTMLElement;
  editor.innerHTML = '';
  const toolbar = document.createElement('div'); toolbar.className = 'note-toolbar';
  const titleInp = document.createElement('input'); titleInp.className = 'note-title-inp'; titleInp.id = 'n-title'; titleInp.value = note.title || ''; titleInp.placeholder = 'Title'; toolbar.appendChild(titleInp);
  const nDel = document.createElement('button'); nDel.className = 'icon-btn del'; nDel.id = 'n-del';
  nDel.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';
  toolbar.appendChild(nDel);
  editor.appendChild(toolbar);
  const bodyArea = document.createElement('textarea'); bodyArea.className = 'note-body'; bodyArea.id = 'n-body'; bodyArea.placeholder = 'Start writing…'; bodyArea.value = note.body || ''; editor.appendChild(bodyArea);
  const noteFoot = document.createElement('div'); noteFoot.className = 'note-foot';
  const wcSpan = document.createElement('span'); wcSpan.id = 'n-wc'; wcSpan.textContent = wc(note.body) + ' words'; noteFoot.appendChild(wcSpan);
  const statusSpan = document.createElement('span'); statusSpan.id = 'n-status'; statusSpan.textContent = 'Saved'; noteFoot.appendChild(statusSpan);
  editor.appendChild(noteFoot);
  let st: ReturnType<typeof setTimeout> | undefined;
  const autoSave = async (): Promise<void> => {
    note.title = (document.getElementById('n-title') as HTMLInputElement).value;
    note.body = (document.getElementById('n-body') as HTMLTextAreaElement).value;
    (document.getElementById('n-wc') as HTMLElement).textContent = wc(note.body) + ' words';
    renderNotesList();
    (document.getElementById('n-status') as HTMLElement).textContent = 'Saving…';
    const r = await api.save('note', note); if (r.ok && !note._dbId) note._dbId = r.dbId;
    const s = document.getElementById('n-status') as HTMLElement; if (s) s.textContent = 'Saved';
    logOk('note', 'Note auto-saved', { noteId: id, title: note.title });
  };
  (document.getElementById('n-title') as HTMLInputElement).addEventListener('input', () => { clearTimeout(st); st = setTimeout(autoSave, 700); });
  (document.getElementById('n-body') as HTMLTextAreaElement).addEventListener('input', () => { clearTimeout(st); st = setTimeout(autoSave, 700); });
  (document.getElementById('n-del') as HTMLButtonElement).addEventListener('click', () => confirm({
    title: 'Move to Trash?', msg: `"${note.title || 'Untitled'}" will be moved to Trash.`, icon: '🗑️', okLabel: 'Move to Trash',
    onOk: async () => {
      logInfo('note', 'Note moved to trash', { noteId: id, title: note.title });
      if (note._dbId) await api.delete(note._dbId);
      S.notes = S.notes.filter((n) => n.id !== id); S.activeNote = null;
      renderNotesList(); updateCounts();
      (document.getElementById('note-editor') as HTMLElement).innerHTML = '<p class="note-placeholder">Select or create a note</p>';
      toast('Moved to Trash');
    }
  }));
}

// ═══ VERTICAL-ONLY DRAG ═══════════════════════════════════════════════════════
let dragSrc: HTMLElement | null = null;
function addVerticalDrag(el: HTMLElement, listId: string, onReorder: () => void): void {
  el.addEventListener('dragstart', (e: DragEvent) => {
    dragSrc = el;
    e.dataTransfer!.effectAllowed = 'move';
    e.dataTransfer!.setData('text/plain', '');
    setTimeout(() => el.classList.add('dragging'), 0);
  });
  el.addEventListener('dragend', () => { el.classList.remove('dragging'); dragSrc = null; });
  el.addEventListener('dragover', (e: DragEvent) => {
    e.preventDefault(); e.dataTransfer!.dropEffect = 'move';
    if (dragSrc && dragSrc !== el) {
      const wrap = document.getElementById(listId)!;
      const items = [...wrap.querySelectorAll('.draggable')] as HTMLElement[];
      const srcIdx = items.indexOf(dragSrc), tgtIdx = items.indexOf(el);
      if (srcIdx < tgtIdx) el.after(dragSrc); else el.before(dragSrc);
    }
  });
  el.addEventListener('drop', (e: DragEvent) => {
    e.preventDefault();
    const wrap = document.getElementById(listId)!;
    const newOrder = [...wrap.querySelectorAll('.draggable')].map((e) => (e as HTMLElement).dataset.id);
    S.notes = newOrder.map((id) => S.notes.find((n) => n.id === id)).filter(Boolean) as VaultItem[];
    onReorder();
  });
}

// ═══ TRASH ════════════════════════════════════════════════════════════════════
async function loadAndRenderTrash(): Promise<void> {
  logInfo('trash', 'Loading trash');
  const wrap = document.getElementById('trash-list') as HTMLElement;
  wrap.querySelectorAll('.trash-row').forEach((e) => (e as HTMLElement).remove());
  (wrap.querySelector('.trash-loading') as HTMLElement)?.remove();
  const loading = document.createElement('div'); loading.className = 'empty trash-loading';
  loading.innerHTML = '<p style="color:var(--muted)">Loading…</p>'; wrap.appendChild(loading);

  const [r1, r2] = await Promise.all([api.trashLoad(), api.jobsTrash.load()]);
  loading.remove();
  if (!r1.ok) { logErr('trash', 'Failed to load vault trash', r1.error); toast('Failed to load some trash items'); }
  if (!r2.ok) { logErr('trash', 'Failed to load job trash', r2.error); toast('Failed to load job trash'); }
  const vaultItems: (VaultItem & { _type: string; _deletedAt: string })[] = r1.ok ? (r1.items as (VaultItem & { _type: string; _deletedAt: string })[]) : [];
  const jobItems: (Job & { _type: string; _deletedAt: string })[] = (r2.ok ? r2.items : []).map((j: Job) => ({ ...j, _type: 'job', _dbId: j.id, _deletedAt: j.deleted_at! }));
  S.trash = [...vaultItems, ...jobItems].sort((a, b) => new Date(b._deletedAt).getTime() - new Date(a._deletedAt).getTime());
  updateCounts();
  (document.getElementById('trash-empty') as HTMLElement).hidden = !!S.trash.length;
  logOk('trash', 'Trash loaded', { count: S.trash.length });
  if (!S.trash.length) return;

  S.trash.forEach((item) => {
    const isNote = item._type === 'note';
    const isJob = item._type === 'job';
    const jobItem = item as unknown as Job;
    const vaultItem = item as unknown as VaultItem;
    const label = isNote ? (vaultItem.title || 'Untitled note') : isJob ? (jobItem.company || 'Unknown company') : (vaultItem.site || 'Unknown site');
    const sub = isNote ? (vaultItem.body?.slice(0, 40) || '') : isJob ? (jobItem.role || '') : (vaultItem.username || '');
    const d = days(item._deletedAt);
    const icon = isNote ? '📝' : isJob ? '💼' : '🔑';
    const row = document.createElement('div'); row.className = 'trash-row';
    const trashIcon = document.createElement('div'); trashIcon.className = 'trash-icon'; trashIcon.textContent = icon; row.appendChild(trashIcon);
    const pwInfo = document.createElement('div'); pwInfo.className = 'pw-info';
    const pwSite = document.createElement('div'); pwSite.className = 'pw-site'; pwSite.textContent = label; pwInfo.appendChild(pwSite);
    const pwUser = document.createElement('div'); pwUser.className = 'pw-user'; pwUser.textContent = sub; pwInfo.appendChild(pwUser);
    row.appendChild(pwInfo);
    const trashDays = document.createElement('div'); trashDays.className = 'trash-days'; trashDays.textContent = d + 'd left'; row.appendChild(trashDays);
    const pwActs = document.createElement('div'); pwActs.className = 'pw-acts';
    const restBtn = document.createElement('button'); restBtn.className = 'icon-btn restore'; restBtn.title = 'Restore';
    restBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4"/></svg>';
    pwActs.appendChild(restBtn);
    const delBtn = document.createElement('button'); delBtn.className = 'icon-btn del'; delBtn.title = 'Delete forever';
    delBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    pwActs.appendChild(delBtn);
    row.appendChild(pwActs);
    restBtn.onclick = () => confirm({
      title: 'Restore?', msg: `"${label}" will be restored.`, icon: '↩️', okLabel: 'Restore', okClass: 'btn-primary',
      onOk: async () => {
        let ok = false;
        if (isJob) { const res = await api.jobsTrash.restore(jobItem.id!); ok = res.ok; }
        else { const res = await api.trashRestore(vaultItem._dbId!); ok = res.ok; }
        if (!ok) { toast('Restore failed'); logErr('trash', 'Restore failed', { label }); return; }
        const itemDbId = (item as unknown as VaultItem)._dbId;
        S.trash = S.trash.filter((t) => (t as unknown as VaultItem)._dbId !== itemDbId);
        loadAndRenderTrash(); updateCounts(); toast('Restored ✓');
        logOk('trash', 'Item restored', { label });
      }
    });
    delBtn.onclick = () => confirm({
      title: 'Delete permanently?', msg: `"${label}" will be gone forever.`, icon: '⚠️', okLabel: 'Delete forever',
      onOk: async () => {
        logInfo('trash', 'Permanently deleting', { label });
        if (isJob) await api.jobsTrash.purge(jobItem.id!);
        else await api.trashPurge(vaultItem._dbId!);
        S.trash = S.trash.filter((t) => {
          const tId = t._type === 'job' ? (t as unknown as Job).id : (t as unknown as VaultItem)._dbId;
          const itemId = isJob ? jobItem.id : vaultItem._dbId;
          return tId !== itemId;
        });
        row.remove(); if (!S.trash.length) (document.getElementById('trash-empty') as HTMLElement).hidden = false;
        updateCounts(); toast('Permanently deleted');
        logOk('trash', 'Item purged', { label });
      }
    });
    wrap.appendChild(row);
  });
}
(document.getElementById('btn-empty-trash') as HTMLButtonElement).addEventListener('click', () => {
  if (!S.trash.length) { toast('Trash is already empty'); return; }
  logInfo('trash', 'Empty trash clicked', { count: S.trash.length });
  confirm({
    title: 'Empty Trash?', msg: `All ${S.trash.length} item(s) will be permanently deleted.`, icon: '⚠️', okLabel: 'Empty Trash',
    onOk: async () => {
      const vaultItems = S.trash.filter((t) => t._type !== 'job');
      const jobItems = S.trash.filter((t) => t._type === 'job');
      await Promise.all([
        ...vaultItems.map((t) => api.trashPurge((t as unknown as VaultItem)._dbId!)),
        ...jobItems.map((t) => api.jobsTrash.purge((t as unknown as Job).id!)),
      ]);
      S.trash = []; loadAndRenderTrash(); updateCounts(); toast('Trash emptied');
      logOk('trash', 'Trash emptied');
    }
  });
});

// ═══ JOBS — inline edit, sort, search, filter ═════════════════════════════════
let _jobEdit: Job | null = null;
async function loadAndRenderJobs(): Promise<void> {
  logInfo('jobs', 'Loading jobs');
  const r = await api.jobsLoad(); if (!r.ok) { logErr('jobs', 'Failed to load jobs', r.error); return; }
  S.jobs = r.jobs; renderJobsTable(); updateCounts();
  logOk('jobs', 'Jobs loaded', { count: S.jobs.length });
}

function getFilteredJobs(): Job[] {
  const q = (document.getElementById('jobs-search') as HTMLInputElement)?.value.toLowerCase() || '';
  let list = S.jobs.filter((j) => {
    if (S.jobFilter !== 'all' && j.status !== S.jobFilter) return false;
    if (!q) return true;
    return [j.company, j.role, j.email, j.notes, j.applied_at, j.status].some((v) => (v || '').toLowerCase().includes(q));
  });
  if (S.jobSort.col) {
    list = [...list].sort((a, b) => {
      const va = (a[S.jobSort.col as keyof Job] || '').toString().toLowerCase();
      const vb = (b[S.jobSort.col as keyof Job] || '').toString().toLowerCase();
      return va < vb ? -S.jobSort.dir : va > vb ? S.jobSort.dir : 0;
    });
  }
  return list;
}

let _statusPopupJob: Job | null = null;
const popup = document.getElementById('status-popup') as HTMLDivElement;
document.querySelectorAll('.status-pop-opt').forEach((btn) => {
  btn.addEventListener('click', async () => {
    if (!_statusPopupJob) return;
    const newStatus = (btn as HTMLElement).dataset.val as Job['status'];
    logInfo('jobs', 'Status changed', { jobId: _statusPopupJob.id, company: _statusPopupJob.company, from: _statusPopupJob.status, to: newStatus });
    _statusPopupJob.status = newStatus;
    hide('status-popup');
    const r = await api.jobsSave({ job: _statusPopupJob });
    if (!r.ok) { toast('Save failed'); logErr('jobs', 'Status save failed', r.error); }
    renderJobsTable();
  });
});
document.addEventListener('click', (e: MouseEvent) => {
  if (!(e.target as HTMLElement).closest('#status-popup') && !(e.target as HTMLElement).closest('.job-status-cell')) hide('status-popup');
});

function renderJobsTable(): void {
  const tbody = document.getElementById('jobs-body') as HTMLTableSectionElement;
  tbody.querySelectorAll('tr:not(#jobs-empty-row)').forEach((e) => (e as HTMLElement).remove());
  const list = getFilteredJobs();
  (document.getElementById('jobs-empty-row') as HTMLElement).hidden = !!list.length;
  if (!S.jobs.length) return;

  const acc = S.jobs.filter((j) => j.status === 'accepted').length;
  const wait = S.jobs.filter((j) => j.status === 'wait').length;
  const rej = S.jobs.filter((j) => j.status === 'rejected').length;
  const jobsStats = document.getElementById('jobs-stats') as HTMLElement; jobsStats.innerHTML = '';
  const mkStat = (cls: string, num: number, lbl: string): HTMLElement => {
    const d = document.createElement('div'); d.className = 'job-stat ' + cls;
    const s = document.createElement('span'); s.textContent = String(num); d.appendChild(s);
    const l = document.createElement('small'); l.textContent = lbl; d.appendChild(l);
    return d;
  };
  jobsStats.appendChild(mkStat('accepted', acc, 'Accepted'));
  jobsStats.appendChild(mkStat('wait', wait, 'Waiting'));
  jobsStats.appendChild(mkStat('rejected', rej, 'Rejected'));
  jobsStats.appendChild(mkStat('total', S.jobs.length, 'Total'));

  const stMap: Record<string, { cls: string; label: string }> = {
    accepted: { cls: 'status-accepted', label: '✅ Accepted' },
    wait:     { cls: 'status-wait',     label: '⏳ Waiting' },
    rejected: { cls: 'status-rejected', label: '❌ Rejected' },
  };

  list.forEach((job) => {
    const tr = document.createElement('tr');
    tr.className = 'draggable'; tr.draggable = true; tr.dataset.id = String(job.id);
    const st = stMap[job.status] || stMap.wait;

    const dragTd = document.createElement('td'); dragTd.className = 'drag-handle-cell'; dragTd.textContent = '⠿'; tr.appendChild(dragTd);
    const companyTd = document.createElement('td'); companyTd.className = 'editable-cell'; companyTd.dataset.field = 'company';
    const companyStrong = document.createElement('strong'); companyStrong.textContent = job.company || ''; companyTd.appendChild(companyStrong); tr.appendChild(companyTd);
    const roleTd = document.createElement('td'); roleTd.className = 'editable-cell'; roleTd.dataset.field = 'role'; roleTd.textContent = job.role || ''; tr.appendChild(roleTd);
    const emailTd = document.createElement('td');
    const emailWrap = document.createElement('div'); emailWrap.style.cssText = 'display:flex;align-items:center;gap:5px';
    const emailLink = document.createElement('a'); emailLink.className = 'job-email'; emailLink.href = 'mailto:' + encodeURIComponent(job.email || ''); emailLink.textContent = job.email || ''; emailWrap.appendChild(emailLink);
    const copyEmailBtn = document.createElement('button'); copyEmailBtn.className = 'icon-btn copy copy-email-btn'; copyEmailBtn.title = 'Copy email'; copyEmailBtn.style.cssText = 'width:22px;height:22px;flex-shrink:0';
    copyEmailBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    emailWrap.appendChild(copyEmailBtn); emailTd.appendChild(emailWrap); tr.appendChild(emailTd);
    const dateTd = document.createElement('td'); dateTd.className = 'editable-cell'; dateTd.dataset.field = 'applied_at'; dateTd.textContent = job.applied_at || '—'; tr.appendChild(dateTd);
    const statusTd = document.createElement('td'); statusTd.className = 'job-status-cell';
    const statusSpan = document.createElement('span'); statusSpan.className = 'job-status ' + st.cls; statusSpan.textContent = st.label; statusTd.appendChild(statusSpan); tr.appendChild(statusTd);
    const delTd = document.createElement('td');
    const delJobBtn = document.createElement('button'); delJobBtn.className = 'icon-btn del del-job-btn'; delJobBtn.title = 'Delete';
    delJobBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>';
    delTd.appendChild(delJobBtn); tr.appendChild(delTd);

    (tr.querySelector('.copy-email-btn') as HTMLButtonElement).onclick = (e: MouseEvent) => {
      e.stopPropagation(); navigator.clipboard.writeText(job.email || ''); toast('Email copied!'); logInfo('jobs', 'Email copied', { company: job.company });
    };

    tr.querySelectorAll('.editable-cell').forEach((td) => {
      td.addEventListener('dblclick', () => {
        const field = (td as HTMLElement).dataset.field as keyof Job;
        const current = job[field] || '';
        logInfo('jobs', 'Inline edit started', { jobId: job.id, field, company: job.company });
        const inp = document.createElement('input');
        inp.type = field === 'applied_at' ? 'date' : 'text';
        inp.value = String(current);
        inp.className = 'inline-cell-input';
        td.innerHTML = ''; td.appendChild(inp);
        inp.focus(); inp.select();
        const save = async (): Promise<void> => {
          const val = inp.value.trim();
          (job as unknown as Record<string, unknown>)[field] = val;
          await api.jobsSave({ job: job as unknown as Record<string, unknown> });
          renderJobsTable();
        };
        inp.addEventListener('blur', save);
        inp.addEventListener('keydown', (e: KeyboardEvent) => {
          if (e.key === 'Enter') inp.blur();
          if (e.key === 'Escape') {
            td.innerHTML = '';
            if (field === 'company') { const s = document.createElement('strong'); s.textContent = job.company || ''; td.appendChild(s); }
            else { td.textContent = String(current); }
          }
        });
      });
    });

    (tr.querySelector('.job-status-cell') as HTMLElement).addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      _statusPopupJob = job;
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      popup.style.top = (rect.bottom + 4) + 'px';
      popup.style.left = rect.left + 'px';
      show('status-popup');
    });

    (tr.querySelector('.del-job-btn') as HTMLButtonElement).onclick = () => confirm({
      title: 'Move to Trash?', msg: `"${job.company}" will be moved to Trash.`, icon: '🗑️', okLabel: 'Move to Trash',
      onOk: async () => {
        logInfo('jobs', 'Job moved to trash', { jobId: job.id, company: job.company });
        const res = await api.jobsDelete(job.id!);
        if (!res.ok) { toast('Delete failed'); logErr('jobs', 'Delete failed', { jobId: job.id }); return; }
        S.jobs = S.jobs.filter((j) => j.id !== job.id);
        renderJobsTable(); updateCounts(); toast('Moved to Trash');
      }
    });

    tr.addEventListener('dragstart', (e: DragEvent) => {
      dragSrc = tr; tr.classList.add('dragging');
      e.dataTransfer!.effectAllowed = 'move'; e.dataTransfer!.setData('text/plain', '');
    });
    tr.addEventListener('dragend', () => { tr.classList.remove('dragging'); dragSrc = null; });
    tr.addEventListener('dragover', (e: DragEvent) => {
      e.preventDefault(); e.dataTransfer!.dropEffect = 'move';
      if (dragSrc && dragSrc !== tr && dragSrc.tagName === 'TR') {
        const rows = [...tbody.querySelectorAll('tr.draggable')] as HTMLElement[];
        const si = rows.indexOf(dragSrc), ti = rows.indexOf(tr);
        if (si < ti) tr.after(dragSrc); else tr.before(dragSrc);
      }
    });
    tr.addEventListener('drop', (e: DragEvent) => {
      e.preventDefault();
      const newOrder = [...tbody.querySelectorAll('tr.draggable')].map((r) => (r as HTMLElement).dataset.id);
      S.jobs = newOrder.map((id) => S.jobs.find((j) => String(j.id) === id)).filter(Boolean) as Job[];
      api.jobsReorder(S.jobs);
    });
    tbody.appendChild(tr);
  });
}

function openJobModal(existing: Job | null = null): void {
  _jobEdit = existing;
  logInfo('jobs', existing ? 'Edit job modal opened' : 'Add job modal opened', { company: existing?.company });
  (document.getElementById('job-modal-title') as HTMLElement).textContent = existing ? 'Edit application' : 'Add application';
  (document.getElementById('j-company') as HTMLInputElement).value = existing?.company || '';
  (document.getElementById('j-role') as HTMLInputElement).value = existing?.role || '';
  (document.getElementById('j-email') as HTMLInputElement).value = existing?.email || '';
  (document.getElementById('j-date') as HTMLInputElement).value = existing?.applied_at || new Date().toISOString().slice(0, 10);
  (document.getElementById('j-notes') as HTMLTextAreaElement).value = existing?.notes || '';
  const status = existing?.status || 'wait';
  document.querySelectorAll('.status-pick').forEach((b) => { (b as HTMLElement).classList.toggle('active', (b as HTMLElement).dataset.val === status); });
  show('job-overlay'); setTimeout(() => (document.getElementById('j-company') as HTMLInputElement).focus(), 60);
}
document.querySelectorAll('.status-pick').forEach((btn) => {
  btn.addEventListener('click', () => { document.querySelectorAll('.status-pick').forEach((b) => (b as HTMLElement).classList.remove('active')); (btn as HTMLElement).classList.add('active'); });
});
(document.getElementById('btn-add-job') as HTMLButtonElement).addEventListener('click', () => openJobModal());
(document.getElementById('job-ok') as HTMLButtonElement).addEventListener('click', async () => {
  const company = (document.getElementById('j-company') as HTMLInputElement).value.trim();
  const role = (document.getElementById('j-role') as HTMLInputElement).value.trim();
  if (!company) { toast('Company name required'); return; }
  const status = ((document.querySelector('.status-pick.active') as HTMLElement)?.dataset.val || 'wait') as Job['status'];
  const job: Job = {
    id: _jobEdit?.id, company, role,
    email: (document.getElementById('j-email') as HTMLInputElement).value.trim(),
    applied_at: (document.getElementById('j-date') as HTMLInputElement).value,
    notes: (document.getElementById('j-notes') as HTMLTextAreaElement).value.trim(), status,
  };
  hide('job-overlay');
  const r = await api.jobsSave(job as unknown as Record<string, unknown>);
  if (r.ok) {
    if (_jobEdit) Object.assign(_jobEdit, job);
    else { job.id = r.id; S.jobs.unshift(job); }
    renderJobsTable(); updateCounts(); toast(_jobEdit ? 'Updated' : 'Saved');
    logOk('jobs', _jobEdit ? 'Job updated' : 'Job created', { company, status });
  } else { toast('Save failed: ' + r.error); logErr('jobs', 'Job save failed', { company, error: r.error }); }
});
(document.getElementById('job-cancel') as HTMLButtonElement).addEventListener('click', () => hide('job-overlay'));
(document.getElementById('job-overlay') as HTMLElement).addEventListener('click', (e: MouseEvent) => {
  if (e.target === (document.getElementById('job-overlay') as HTMLElement)) hide('job-overlay');
});

// ═══ TOTP VAULT ════════════════════════════════════════════════════════════════
let totpTimers: Array<ReturnType<typeof setInterval>> = [];
async function loadAndRenderTotp(): Promise<void> {
  logInfo('totp', 'Loading TOTP accounts');
  totpTimers.forEach((t) => clearInterval(t)); totpTimers = [];
  const r = await api.totpLoad(); if (!r.ok) { toast('Could not load accounts'); logErr('totp', 'Failed to load', r.error); return; }
  S.totp = r.items; renderTotpGrid(); updateCounts();
  logOk('totp', 'TOTP accounts loaded', { count: S.totp.length });
}
function renderTotpGrid(): void {
  const grid = document.getElementById('totp-grid') as HTMLElement;
  grid.querySelectorAll('.totp-card').forEach((e) => (e as HTMLElement).remove());
  (document.getElementById('totp-empty') as HTMLElement).hidden = !!S.totp.length;
  if (!S.totp.length) return;
  S.totp.forEach((item) => {
    const card = document.createElement('div'); card.className = 'totp-card';
    const codeId = 'totp-code-' + item.id;
    const progId = 'totp-prog-' + item.id;
    const header = document.createElement('div'); header.className = 'totp-header';
    const totpIcon = document.createElement('span'); totpIcon.className = 'totp-icon'; totpIcon.textContent = item.icon || '🔐'; header.appendChild(totpIcon);
    const totpInfo = document.createElement('div'); totpInfo.className = 'totp-info';
    const totpName = document.createElement('div'); totpName.className = 'totp-name'; totpName.textContent = item.name || ''; totpInfo.appendChild(totpName);
    const totpIssuer = document.createElement('div'); totpIssuer.className = 'totp-issuer'; totpIssuer.textContent = item.issuer || ''; totpInfo.appendChild(totpIssuer);
    header.appendChild(totpInfo);
    const totpDel = document.createElement('button'); totpDel.className = 'icon-btn del totp-del'; totpDel.title = 'Remove';
    totpDel.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    header.appendChild(totpDel);
    card.appendChild(header);
    const totpCode = document.createElement('div'); totpCode.className = 'totp-code'; totpCode.id = codeId; totpCode.textContent = '——'; card.appendChild(totpCode);
    const totpFoot = document.createElement('div'); totpFoot.className = 'totp-foot';
    const barWrap = document.createElement('div'); barWrap.className = 'totp-bar-wrap';
    const bar = document.createElement('div'); bar.className = 'totp-bar'; bar.id = progId; barWrap.appendChild(bar);
    totpFoot.appendChild(barWrap);
    const totpCopy = document.createElement('button'); totpCopy.className = 'icon-btn copy totp-copy'; totpCopy.title = 'Copy';
    totpCopy.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    totpFoot.appendChild(totpCopy);
    card.appendChild(totpFoot);
    (card.querySelector('.totp-del') as HTMLButtonElement).onclick = () => confirm({
      title: 'Remove account?', msg: `"${item.name}" will be removed.`, icon: '🗑️', okLabel: 'Remove',
      onOk: async () => { logInfo('totp', 'TOTP account removed', { name: item.name }); await api.totpDelete(item.id!); S.totp = S.totp.filter((t) => t.id !== item.id); renderTotpGrid(); updateCounts(); toast('Removed'); }
    });
    (card.querySelector('.totp-copy') as HTMLButtonElement).onclick = () => {
      const code = (document.getElementById(codeId) as HTMLElement).textContent!.replace(/\s/g, '');
      if (code && code !== '——') {
        navigator.clipboard.writeText(code);
        toast('Code copied! (clipboard clears in 30s)');
        logInfo('totp', 'TOTP code copied', { name: item.name });
        setTimeout(() => { navigator.clipboard.writeText(''); logInfo('app', 'Clipboard auto-cleared'); }, 30000);
      }
    };
    grid.appendChild(card);
    const updateCode = (): void => {
      const epoch = Math.floor(Date.now() / 1000);
      const remaining = (30 - (epoch % 30)) / 30;
      const prog = document.getElementById(progId) as HTMLElement;
      if (prog) prog.style.width = (remaining * 100) + '%';
      computeTotpAsync(item.secret, item.id);
    };
    updateCode();
    totpTimers.push(setInterval(updateCode, 1000));
  });
}
function base32Decode(b32: string): Uint8Array {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = '', res: number[] = [];
  for (const c of b32.toUpperCase().replace(/=+$/, '')) { const v = alpha.indexOf(c); if (v === -1) continue; bits += v.toString(2).padStart(5, '0'); }
  for (let i = 0; i + 8 <= bits.length; i += 8) res.push(parseInt(bits.slice(i, i + 8), 2));
  return new Uint8Array(res);
}
async function computeTotpAsync(secret: string, id: number | undefined): Promise<void> {
  try {
    const key = base32Decode(secret);
    const T = Math.floor(Date.now() / 30000);
    const msg = new DataView(new ArrayBuffer(8)); msg.setUint32(4, T, false);
    const ck = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    const hmac = new Uint8Array(await crypto.subtle.sign('HMAC', ck, msg.buffer) as ArrayBuffer);
    const off = hmac[19] & 0xf;
    const code = (((hmac[off] & 0x7f) << 24) | ((hmac[off + 1] & 0xff) << 16) | ((hmac[off + 2] & 0xff) << 8) | (hmac[off + 3] & 0xff)) % 1000000;
    const str = String(code).padStart(6, '0');
    const el = document.getElementById(`totp-code-${id}`) as HTMLElement;
    if (el) el.textContent = str.slice(0, 3) + ' ' + str.slice(3);
  } catch { /* noop */ }
}

let _totpEdit: TotpItem | null = null;
(document.getElementById('btn-add-totp') as HTMLButtonElement).addEventListener('click', () => {
  _totpEdit = null;
  (document.getElementById('t-name') as HTMLInputElement).value = '';
  (document.getElementById('t-issuer') as HTMLInputElement).value = '';
  (document.getElementById('t-secret') as HTMLInputElement).value = '';
  (document.getElementById('t-icon') as HTMLInputElement).value = '';
  logInfo('totp', 'Add TOTP account modal opened');
  show('totp-overlay'); setTimeout(() => (document.getElementById('t-name') as HTMLInputElement).focus(), 60);
});
(document.getElementById('totp-ok') as HTMLButtonElement).addEventListener('click', async () => {
  const name = (document.getElementById('t-name') as HTMLInputElement).value.trim();
  const secret = (document.getElementById('t-secret') as HTMLInputElement).value.trim().replace(/\s/g, '').toUpperCase();
  if (!name || !secret) { toast('Name and secret key required'); return; }
  const item: TotpItem = {
    id: _totpEdit?.id, name,
    issuer: (document.getElementById('t-issuer') as HTMLInputElement).value.trim(),
    secret, icon: (document.getElementById('t-icon') as HTMLInputElement).value || '🔐',
  };
  hide('totp-overlay');
  const r = await api.totpSave(item as unknown as Record<string, unknown>);
  if (r.ok) {
    if (_totpEdit) Object.assign(_totpEdit, item); else { item.id = r.id; S.totp.unshift(item); }
    renderTotpGrid(); updateCounts(); toast('Saved');
    logOk('totp', _totpEdit ? 'TOTP account updated' : 'TOTP account created', { name });
  } else { toast('Save failed: ' + r.error); logErr('totp', 'TOTP save failed', { name, error: r.error }); }
});
(document.getElementById('totp-cancel') as HTMLButtonElement).addEventListener('click', () => hide('totp-overlay'));
(document.getElementById('totp-overlay') as HTMLElement).addEventListener('click', (e: MouseEvent) => {
  if (e.target === (document.getElementById('totp-overlay') as HTMLElement)) hide('totp-overlay');
});

// ═══ MONITOR with circle gauges ═══════════════════════════════════════════════
const _monitorEntries: import('./src/types').LogEntry[] = [];
let _monitorFilter = 'all';

function fmtSize(n: number): string {
  return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B';
}

function renderLogEntries(): void {
  const el = document.getElementById('log-view') as HTMLElement;
  const filtered = _monitorFilter === 'all' ? _monitorEntries : _monitorEntries.filter((e) => e.level.toLowerCase() === _monitorFilter);
  if (!filtered.length) { el.innerHTML = '<span class="log-empty">(no entries)</span>'; return; }
  el.innerHTML = filtered.map((e) => {
    const cls = 'log-level-' + (e.level || '').toLowerCase();
    return `<div class="log-entry ${cls}"><span class="log-ts">${escapeHtml(e.ts || '')}</span> <span class="log-ctx">[${escapeHtml(e.ctx || '')}]</span> <span class="log-msg">${escapeHtml(e.text)}</span></div>`;
  }).join('');
  el.scrollTop = el.scrollHeight;
}

async function loadMonitor(): Promise<void> {
  logInfo('monitor', 'Loading monitor data');
  const [sr, lr] = await Promise.all([api.monitor.stats(), api.monitor.readLog()]);
  if (sr.ok) {
    const st = sr.stats;
    const DB_LIMIT = 500 * 1024 * 1024;
    const dbPct = st.dbSizeBytes ? Math.min(100, Math.round(st.dbSizeBytes / DB_LIMIT * 100)) : 0;
    const logPct = Math.min(100, Math.round(st.logSize / (5 * 1024 * 1024) * 100));

    (document.getElementById('dash-storage') as HTMLElement).textContent = fmtSize(st.dbSizeBytes || 0);
    (document.getElementById('dash-storage-pct') as HTMLElement).textContent = dbPct + '% of 500 MB';

    const circlesWrap = document.getElementById('monitor-circles') as HTMLElement; circlesWrap.innerHTML = '';
    const cw1 = document.createElement('div'); cw1.className = 'mon-circle-wrap';
    cw1.innerHTML = makeCircleSvg(dbPct, 'var(--accent)');
    const lbl1 = document.createElement('div'); lbl1.className = 'mon-circle-label'; lbl1.textContent = fmtSize(st.dbSizeBytes || 0); cw1.appendChild(lbl1);
    const sub1a = document.createElement('div'); sub1a.className = 'mon-circle-sub'; sub1a.textContent = 'Database used'; cw1.appendChild(sub1a);
    const sub1b = document.createElement('div'); sub1b.className = 'mon-circle-sub'; sub1b.style.cssText = 'font-size:10px;margin-top:2px'; sub1b.textContent = dbPct + '% of 500 MB'; cw1.appendChild(sub1b);
    circlesWrap.appendChild(cw1);
    const cw2 = document.createElement('div'); cw2.className = 'mon-circle-wrap';
    cw2.innerHTML = makeCircleSvg(logPct, '#f87171');
    const lbl2 = document.createElement('div'); lbl2.className = 'mon-circle-label'; lbl2.textContent = fmtSize(st.logSize); cw2.appendChild(lbl2);
    const sub2 = document.createElement('div'); sub2.className = 'mon-circle-sub'; sub2.textContent = 'Log file'; cw2.appendChild(sub2);
    circlesWrap.appendChild(cw2);

    const actEl = document.getElementById('dash-activity') as HTMLElement; actEl.innerHTML = '';
    const recentEntries = (lr.ok ? lr.entries : []).filter((e: LogEntry) => e.level === 'AUTH' || e.level === 'ERROR' || e.level === 'WARN').slice(-8).reverse();
    if (!recentEntries.length) {
      actEl.innerHTML = '<div class="dash-activity-empty">No recent activity</div>';
    } else {
      recentEntries.forEach((e: LogEntry) => {
        const row = document.createElement('div'); row.className = 'dash-activity-entry';
        const ts = document.createElement('span'); ts.className = 'dash-activity-time'; ts.textContent = e.ts ? e.ts.replace('T', ' ').replace(/\.\d{3}Z$/, '') : ''; row.appendChild(ts);
        const ctx = document.createElement('span'); ctx.className = 'dash-activity-ctx'; ctx.textContent = '[' + (e.ctx || e.level) + ']'; row.appendChild(ctx);
        const msg = document.createElement('span'); msg.className = 'dash-activity-msg'; msg.textContent = e.text; row.appendChild(msg);
        actEl.appendChild(row);
      });
    }

    const gridWrap = document.getElementById('monitor-grid') as HTMLElement; gridWrap.innerHTML = '';
    const mkCard = (num: number, lbl: string, wide?: boolean): HTMLElement => {
      const c = document.createElement('div'); c.className = 'mon-card' + (wide ? ' mon-wide' : '');
      const n = document.createElement('div'); n.className = 'mon-num'; n.textContent = String(num); c.appendChild(n);
      const l = document.createElement('div'); l.className = 'mon-lbl'; l.textContent = lbl; c.appendChild(l);
      return c;
    };
    gridWrap.appendChild(mkCard(st.items, 'Vault items'));
    gridWrap.appendChild(mkCard(st.trash, 'In trash'));
    gridWrap.appendChild(mkCard(st.jobs, 'Job apps'));
    const supCard = document.createElement('div'); supCard.className = 'mon-card mon-wide';
    const supNum = document.createElement('div'); supNum.className = 'mon-num'; supNum.style.cssText = 'font-size:12px;font-family:var(--mono)'; supNum.textContent = 'Supabase'; supCard.appendChild(supNum);
    const supLbl = document.createElement('div'); supLbl.className = 'mon-lbl'; supLbl.textContent = 'Supabase · Encrypted storage'; supCard.appendChild(supLbl);
    gridWrap.appendChild(supCard);
    logOk('monitor', 'Monitor data loaded', { items: st.items, jobs: st.jobs, trash: st.trash });
  } else { logErr('monitor', 'Failed to load stats', sr.error); }

  if (lr.ok) { _monitorEntries.length = 0; _monitorEntries.push(...lr.entries); renderLogEntries(); }

  const refEl = document.getElementById('monitor-last-refresh') as HTMLElement;
  if (refEl) refEl.textContent = 'Updated ' + new Date().toLocaleTimeString();

  if (isAdmin()) { (document.getElementById('admin-dashboard') as HTMLElement).hidden = false; loadAdminDashboard(); }
  else { (document.getElementById('admin-dashboard') as HTMLElement).hidden = true; }
}

async function loadAdminDashboard(): Promise<void> {
  logInfo('admin', 'Loading admin dashboard');
  const [usersRes, statsRes] = await Promise.all([api.admin.users(), api.admin.stats()]);

  if (statsRes.ok) {
    const st = statsRes.stats;
    (document.getElementById('admin-total-users') as HTMLElement).textContent = String(st.totalUsers);
    (document.getElementById('admin-total-items') as HTMLElement).textContent = String(st.totalItems);
    (document.getElementById('admin-total-jobs') as HTMLElement).textContent = String(st.totalJobs);
    (document.getElementById('admin-total-totp') as HTMLElement).textContent = String(st.totalTotp);
  }

  const listEl = document.getElementById('admin-users-list') as HTMLElement; listEl.innerHTML = '';
  if (usersRes.ok && usersRes.users.length) {
    usersRes.users.forEach((u: UserProfile) => {
      const row = document.createElement('div'); row.className = 'admin-user-row';
      const init = (u.name || u.email || '?')[0].toUpperCase();
      if (u.avatar && u.avatar.startsWith('https://')) { const img = document.createElement('img'); img.className = 'admin-user-avatar'; img.src = u.avatar; row.appendChild(img); }
      else { const fb = document.createElement('div'); fb.className = 'admin-user-avatar admin-user-avatar-fb'; fb.textContent = init; row.appendChild(fb); }
      const info = document.createElement('div'); info.className = 'admin-user-info';
      const nm = document.createElement('div'); nm.className = 'admin-user-name'; nm.textContent = u.name || '—';
      const em = document.createElement('div'); em.className = 'admin-user-email'; em.textContent = u.email || '—';
      const joined = u.created_at ? new Date(u.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
      const lastLogin = u.last_seen ? new Date(u.last_seen).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : 'never';
      const meta = document.createElement('div'); meta.className = 'admin-user-meta'; meta.textContent = 'Joined ' + joined + ' · Last login ' + lastLogin;
      info.appendChild(nm); info.appendChild(em); info.appendChild(meta);
      row.appendChild(info);
      if (u.email === S.user?.email && S.user?.isAdmin) {
        const badge = document.createElement('span'); badge.className = 'admin-user-badge badge-admin'; badge.textContent = 'admin'; row.appendChild(badge);
      }
      listEl.appendChild(row);
    });
  } else {
    const noUsers = document.createElement('div'); noUsers.className = 'admin-no-users'; noUsers.textContent = 'No users found'; listEl.appendChild(noUsers);
  }
  logOk('admin', 'Admin dashboard loaded');
}

function makeCircleSvg(pct: number, color: string): string {
  const safePct = Math.max(0, Math.min(100, parseInt(String(pct)) || 0));
  const safeColor = String(color).replace(/[<>"'&]/g, '');
  const r = 44, circ = 2 * Math.PI * r;
  const dash = circ * (safePct / 100);
  return `<svg class="mon-circle-svg" viewBox="0 0 100 100">
    <circle cx="50" cy="50" r="${r}" fill="none" stroke="rgba(255,255,255,.07)" stroke-width="8"/>
    <circle cx="50" cy="50" r="${r}" fill="none" stroke="${safeColor}" stroke-width="8"
      stroke-dasharray="${dash.toFixed(1)} ${circ.toFixed(1)}"
      stroke-dashoffset="${(circ / 4).toFixed(1)}" stroke-linecap="round"/>
    <text x="50" y="54" text-anchor="middle" fill="${safeColor}" font-size="16" font-weight="600" font-family="var(--mono)">${safePct}%</text>
  </svg>`;
}

(document.getElementById('btn-refresh-monitor') as HTMLButtonElement).addEventListener('click', () => { logInfo('monitor', 'Refresh clicked'); loadMonitor(); });
(document.getElementById('btn-clear-log') as HTMLButtonElement).addEventListener('click', async () => {
  logInfo('monitor', 'Clear log clicked');
  await api.monitor.clearLog(); _monitorEntries.length = 0; renderLogEntries(); toast('Log cleared');
  logOk('monitor', 'Log cleared');
});

document.querySelectorAll('.log-filter').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.log-filter').forEach((b) => (b as HTMLElement).classList.remove('active'));
    (btn as HTMLElement).classList.add('active');
    _monitorFilter = (btn as HTMLElement).dataset.level!;
    renderLogEntries();
  });
});

// ═══ SETTINGS ══════════════════════════════════════════════════════════════════
const DEFAULT_SETTINGS: AppSettings = {
  lock_timeout: 5, lock_action: 'lock',
  lock_countdown: true, lock_on_minimize: false,
  compact: false, animations: true, accent: 'violet',
  gen_length: 20, gen_symbols: true, gen_numbers: true, gen_ambiguous: false, gen_copy: true,
  sounds: true, toast_duration: 2400,
  sound_login: true, sound_exit: true, sound_hover: false,
  sound_login_tone: 'chime', sound_exit_tone: 'chime', sound_hover_tone: 'click',
  pin_login_enabled: false, pin_allow_alpha: false,
};

const ACCENT_MAP: Record<string, string> = {
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
function applyAccent(name: string): void {
  const c = ACCENT_MAP[name] || ACCENT_MAP.violet;
  document.documentElement.style.setProperty('--accent', c);
  document.documentElement.style.setProperty('--accent-dim', c.replace(')', ' / 0.1)').replace('oklch(', 'oklch('));
  document.documentElement.style.setProperty('--accent-glow', c.replace(')', ' / 0.15)').replace('oklch(', 'oklch('));
  document.documentElement.style.setProperty('--accent-strong', c.replace(/0\.\d+/, (m) => String(Math.min(1, parseFloat(m) + 0.08))));
  document.documentElement.style.setProperty('--accent-glass', c.replace(')', ' / 0.18)').replace('oklch(', 'oklch('));
  document.querySelectorAll('.accent-swatch').forEach((s) => { (s as HTMLElement).classList.toggle('active', (s as HTMLElement).dataset.accent === name); });
}

function applySetting(key: string, value: unknown): void {
  (S.settings as unknown as Record<string, unknown>)[key] = value;
  if (key === 'lock_timeout' || key === 'lock_action' || key === 'lock_countdown') { applyLockSettings(); armLock(); }
  if (key === 'compact') document.body.classList.toggle('compact', !!value);
  if (key === 'animations') document.body.style.setProperty('--transition', value ? '' : '0s');
  if (key === 'accent') applyAccent(value as string);
  if (key === 'sounds') window.__soundsEnabled = !!value;
  __saveSettings();
}
let __saveTimer: ReturnType<typeof setTimeout> | null = null;
function __saveSettings(): void {
  clearTimeout(__saveTimer!);
  __saveTimer = setTimeout(async () => { try { await api.settings.save(S.settings as unknown as Record<string, unknown>); } catch { /* noop */ } }, 400);
}

async function loadSettingsTab(): Promise<void> {
  logInfo('settings', 'Loading settings tab');
  const r = await api.settings.load();
  if (r.ok) S.settings = { ...DEFAULT_SETTINGS, ...r.settings } as AppSettings;
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    if ((S.settings as unknown as Record<string, unknown>)[k] === undefined) (S.settings as unknown as Record<string, unknown>)[k] = v;
  }

  const bind = (id: string, key: string, type: string): void => {
    const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
    if (!el) return;
    if (type === 'toggle') (el as HTMLInputElement).checked = !!(S.settings as unknown as Record<string, unknown>)[key];
    else el.value = String((S.settings as unknown as Record<string, unknown>)[key] ?? '');
    el.addEventListener('change', () => {
      let val: unknown;
      if (type === 'toggle') val = (el as HTMLInputElement).checked;
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
  bind('s-pin-enabled', 'pin_login_enabled', 'toggle');
  bind('s-pin-alpha', 'pin_allow_alpha', 'toggle');

  // PIN settings UI logic
  const pinSetupRow = document.getElementById('pin-setup-row') as HTMLElement;
  const pinChangeRow = document.getElementById('pin-change-row') as HTMLElement;
  const pinDisableRow = document.getElementById('pin-disable-row') as HTMLElement;

  // Check if a PIN file already exists to decide which row to show
  let _pinFileExists = false;
  const pinStatusR = await api.pin.status();
  _pinFileExists = pinStatusR.ok && pinStatusR.enabled;

  const pinEnabled = S.settings.pin_login_enabled;
  // If PIN is enabled and file exists → show change + disable rows
  // If PIN is enabled but no file → show setup row (first time)
  // If PIN is disabled → hide all
  if (pinSetupRow) pinSetupRow.hidden = !pinEnabled || _pinFileExists;
  if (pinChangeRow) pinChangeRow.hidden = !pinEnabled || !_pinFileExists;
  if (pinDisableRow) pinDisableRow.hidden = !pinEnabled || !_pinFileExists;

  // PIN enable toggle handler
  const pinEnabledEl = document.getElementById('s-pin-enabled') as HTMLInputElement;
  if (pinEnabledEl) {
    pinEnabledEl.addEventListener('change', () => {
      const enabled = pinEnabledEl.checked;
      S.settings.pin_login_enabled = enabled;
      if (enabled) {
        // When enabling, always show setup first (no "Current PIN" field)
        if (pinSetupRow) pinSetupRow.hidden = false;
        if (pinChangeRow) pinChangeRow.hidden = true;
        if (pinDisableRow) pinDisableRow.hidden = true;
        _pinFileExists = false;
      } else {
        // When disabling, hide all PIN rows
        if (pinSetupRow) pinSetupRow.hidden = true;
        if (pinChangeRow) pinChangeRow.hidden = true;
        if (pinDisableRow) pinDisableRow.hidden = true;
      }
      __saveSettings();
      toast(enabled ? 'PIN login enabled — set your PIN below' : 'PIN login disabled', 1500);
      logInfo('settings', 'PIN login toggled', { enabled });
    });
  }

  // PIN allow alpha toggle handler
  const pinAlphaEl = document.getElementById('s-pin-alpha') as HTMLInputElement;
  if (pinAlphaEl) {
    pinAlphaEl.addEventListener('change', () => {
      S.settings.pin_allow_alpha = pinAlphaEl.checked;
      __saveSettings();
      toast(pinAlphaEl.checked ? 'Alphanumeric PINs enabled' : 'Numbers-only PINs', 1500);
      logInfo('settings', 'PIN alpha setting changed', { allowAlpha: pinAlphaEl.checked });
    });
  }

  // Set PIN button
  document.getElementById('s-pin-save')?.addEventListener('click', async () => {
    const pinVal = (document.getElementById('s-pin-value') as HTMLInputElement).value;
    logInfo('pin', 'Set PIN clicked');
    const r = await api.pin.setup(pinVal, S.settings.pin_allow_alpha);
    if (!r.ok) {
      toast(r.error || 'Failed to set PIN');
      logWarn('pin', 'Set PIN failed', r.error);
      return;
    }
    toast('PIN set successfully');
    logOk('pin', 'PIN set');
    (document.getElementById('s-pin-value') as HTMLInputElement).value = '';
    // Switch to change/disable view
    _pinFileExists = true;
    S.settings.pin_login_enabled = true;
    if (pinSetupRow) pinSetupRow.hidden = true;
    if (pinChangeRow) pinChangeRow.hidden = false;
    if (pinDisableRow) pinDisableRow.hidden = false;
    if (pinEnabledEl) pinEnabledEl.checked = true;
    __saveSettings();
  });

  // Change PIN button
  document.getElementById('s-pin-change-btn')?.addEventListener('click', async () => {
    const oldPin = (document.getElementById('s-pin-old') as HTMLInputElement).value;
    const newPin = (document.getElementById('s-pin-new') as HTMLInputElement).value;
    logInfo('pin', 'Change PIN clicked');
    const r = await api.pin.change(oldPin, newPin, S.settings.pin_allow_alpha);
    if (!r.ok) {
      toast(r.error || 'Failed to change PIN');
      logWarn('pin', 'Change PIN failed', r.error);
      return;
    }
    toast('PIN changed successfully');
    logOk('pin', 'PIN changed');
    (document.getElementById('s-pin-old') as HTMLInputElement).value = '';
    (document.getElementById('s-pin-new') as HTMLInputElement).value = '';
  });

  // Disable PIN button
  document.getElementById('s-pin-disable')?.addEventListener('click', async () => {
    logInfo('pin', 'Disable PIN clicked');
    const r = await api.pin.disable();
    if (!r.ok) {
      toast(r.error || 'Failed to disable PIN');
      logWarn('pin', 'Disable PIN failed', r.error);
      return;
    }
    toast('PIN login disabled');
    logOk('pin', 'PIN disabled');
    _pinFileExists = false;
    S.settings.pin_login_enabled = false;
    if (pinSetupRow) pinSetupRow.hidden = false;
    if (pinChangeRow) pinChangeRow.hidden = true;
    if (pinDisableRow) pinDisableRow.hidden = true;
    if (pinEnabledEl) pinEnabledEl.checked = false;
    __saveSettings();
  });

  document.querySelectorAll('.accent-swatch').forEach((s) => {
    (s as HTMLElement).classList.toggle('active', (s as HTMLElement).dataset.accent === S.settings.accent);
    s.addEventListener('click', () => applySetting('accent', (s as HTMLElement).dataset.accent));
  });

  document.body.classList.toggle('compact', !!S.settings.compact);
  document.body.style.setProperty('--transition', S.settings.animations ? '' : '0s');
  applyAccent(S.settings.accent);
  window.__soundsEnabled = !!S.settings.sounds;

  const r2 = await api.twofa.status();
  (document.getElementById('s-2fa-status') as HTMLElement).textContent = r2.enabled ? '✅ Enabled' : '❌ Disabled';
  logOk('settings', 'Settings tab loaded', { ...S.settings, twofa: r2.enabled });
}

api.onMinimize(() => { if (S.settings.lock_on_minimize && S.user) doLock(); });

(document.getElementById('s-btn-2fa') as HTMLButtonElement).addEventListener('click', () => {
  hide('tab-settings');
  (document.getElementById('btn-2fa') as HTMLButtonElement).click();
});

// ═══ STRENGTH ══════════════════════════════════════════════════════════════════
function scoreP(pw: string): { n: number; lbl: string; cls: string } {
  if (!pw) return { n: 0, lbl: '—', cls: '' };
  let s = 0;
  if (pw.length >= 8) s++; if (pw.length >= 14) s++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
  if (/[0-9]/.test(pw)) s++; if (/[^A-Za-z0-9]/.test(pw)) s++;
  const n = Math.min(4, Math.ceil(s * 4 / 5));
  return { n, lbl: ['', 'weak', 'fair', 'good', 'strong'][n] || '—', cls: ['', 'sl-w', 'sl-f', 'sl-g', 'sl-s'][n] || '' };
}
function updateSm(wrapId: string, pw: string): void {
  const wrap = document.getElementById(wrapId) as HTMLElement; if (!wrap) return;
  const { n, lbl, cls } = scoreP(pw);
  wrap.querySelectorAll('.sm-bar').forEach((b, i) => { b.className = 'sm-bar' + (i < n ? ` l${n}` : ''); });
  const l = wrap.querySelector('.sm-lbl'); if (l) { l.textContent = lbl; l.className = 'sm-lbl ' + cls; }
}

// ═══ GENERATOR ════════════════════════════════════════════════════════════════
const LOWER = 'abcdefghijklmnopqrstuvwxyz', UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', NUMS = '0123456789', SYMS = '!@#$%^&*()_+-=[]{}|;:,.<>?';
function doGenerate(): string {
  const len = parseInt((document.getElementById('gen-len') as HTMLInputElement).value);
  const classes = [LOWER];
  if ((document.getElementById('go-upper') as HTMLInputElement).checked) classes.push(UPPER);
  if ((document.getElementById('go-nums') as HTMLInputElement).checked) classes.push(NUMS);
  if ((document.getElementById('go-syms') as HTMLInputElement).checked) classes.push(SYMS);
  const allCs = classes.join('');
  // Use rejection sampling to avoid modulo bias
  function pickRandom(chars: string): string {
    const max = 0x100000000 - (0x100000000 % chars.length);
    let v: number;
    do { const tmp = new Uint32Array(1); crypto.getRandomValues(tmp); v = tmp[0]; } while (v >= max);
    return chars[v % chars.length];
  }
  const guaranteed = classes.map((cs) => pickRandom(cs));
  const rest = Array.from({ length: len - classes.length }, () => pickRandom(allCs));
  let pw = [...guaranteed, ...rest];
  const shuffleArr = new Uint32Array(pw.length); crypto.getRandomValues(shuffleArr);
  for (let i = pw.length - 1; i > 0; i--) { const j = shuffleArr[i] % (i + 1); [pw[i], pw[j]] = [pw[j], pw[i]]; }
  const pwStr = pw.join('');
  (document.getElementById('gen-out') as HTMLElement).textContent = pwStr;
  const { n, lbl, cls } = scoreP(pwStr);
  document.querySelectorAll('#gen-strength-row .bar').forEach((b, i) => { b.className = 'bar' + (i < n ? ` g${n}` : ''); });
  const l = document.getElementById('gen-slabel'); if (l) { l.textContent = lbl; l.className = 'slabel ' + cls.replace('sl-', 's'); }
  if (S.settings.gen_copy) { try { navigator.clipboard.writeText(pwStr); } catch { /* noop */ } }
  logInfo('generator', 'Password generated', { length: len, strength: lbl });
  return pwStr;
}
(document.getElementById('gen-len') as HTMLInputElement).addEventListener('input', function () { (document.getElementById('gen-len-val') as HTMLElement).textContent = this.value; if ((document.getElementById('gen-out') as HTMLElement).textContent !== '—') doGenerate(); });
function openGen(fillMode = false): void {
  logInfo('generator', 'Generator opened', { fillMode });
  (document.getElementById('gen-len') as HTMLInputElement).value = String(S.settings.gen_length || 20);
  (document.getElementById('gen-len-val') as HTMLElement).textContent = String(S.settings.gen_length || 20);
  (document.getElementById('go-syms') as HTMLInputElement).checked = !!S.settings.gen_symbols;
  (document.getElementById('go-nums') as HTMLInputElement).checked = !!S.settings.gen_numbers;
  show('gen-overlay');
  const useBtn = document.getElementById('gen-use') as HTMLButtonElement;
  const newUse = useBtn.cloneNode(true) as HTMLButtonElement; useBtn.parentNode!.replaceChild(newUse, useBtn);
  newUse.hidden = !fillMode;
  newUse.addEventListener('click', () => {
    const pw = (document.getElementById('gen-out') as HTMLElement).textContent;
    if (!pw || pw === '—') { toast('Generate first'); return; }
    const f = document.getElementById('f-pw') as HTMLInputElement; if (f) { f.value = pw; f.type = 'text'; updateSm('sm', pw); }
    closeGen();
  });
  doGenerate();
}
function closeGen(): void { hide('gen-overlay'); }
['go-upper', 'go-nums', 'go-syms'].forEach((id) => {
  (document.getElementById(id) as HTMLInputElement).addEventListener('change', () => {
    if ((document.getElementById('gen-overlay') as HTMLElement).hidden) return;
    doGenerate();
    if (id === 'go-syms') S.settings.gen_symbols = (document.getElementById(id) as HTMLInputElement).checked;
    if (id === 'go-nums') S.settings.gen_numbers = (document.getElementById(id) as HTMLInputElement).checked;
    __saveSettings();
  });
});
(document.getElementById('btn-gen') as HTMLButtonElement).addEventListener('click', () => openGen(false));
(document.getElementById('gen-close') as HTMLButtonElement).addEventListener('click', closeGen);
(document.getElementById('gen-generate') as HTMLButtonElement).addEventListener('click', doGenerate);
(document.getElementById('gen-copy') as HTMLButtonElement).addEventListener('click', () => {
  const pw = (document.getElementById('gen-out') as HTMLElement).textContent;
  if (pw && pw !== '—') { navigator.clipboard.writeText(pw); toast('Copied!'); logInfo('generator', 'Password copied to clipboard'); }
});
(document.querySelector('#gen-overlay .modal') as HTMLElement).addEventListener('click', (e: Event) => e.stopPropagation());
(document.getElementById('gen-overlay') as HTMLElement).addEventListener('click', closeGen);

// ═══ 2FA SETTINGS MODAL ════════════════════════════════════════════════════════
(document.getElementById('btn-2fa') as HTMLButtonElement).addEventListener('click', async () => {
  logInfo('2fa', '2FA settings opened');
  const r = await api.twofa.status();
  const body = document.getElementById('twofa-modal-body') as HTMLElement;
  const okBtn = document.getElementById('twofa-ok') as HTMLButtonElement;
  const disBtn = document.getElementById('twofa-disable') as HTMLButtonElement;
  if (r.enabled) {
    (document.getElementById('twofa-modal-title') as HTMLElement).textContent = '2FA is enabled';
    body.innerHTML = '';
    const disMsg = document.createElement('p'); disMsg.className = 'sub'; disMsg.style.cssText = 'margin:12px 0'; disMsg.textContent = 'Two-factor authentication is active.'; body.appendChild(disMsg); body.appendChild(document.createElement('br'));
    const disMsg2 = document.createElement('span'); disMsg2.textContent = 'Disable it below.'; body.appendChild(disMsg2);
    okBtn.hidden = true; disBtn.hidden = false;
    logInfo('2fa', '2FA is currently enabled');
  } else {
    (document.getElementById('twofa-modal-title') as HTMLElement).textContent = 'Enable 2FA';
    body.innerHTML = '';
    const scanMsg = document.createElement('p'); scanMsg.className = 'sub'; scanMsg.style.cssText = 'margin-bottom:14px'; scanMsg.textContent = 'Scan this QR code with your authenticator app, then enter the 6-digit code to confirm.'; body.appendChild(scanMsg); body.appendChild(document.createElement('br'));
    body.appendChild(document.createElement('br'));
    const qrWrap = document.createElement('div'); qrWrap.id = 'qr-wrap'; qrWrap.style.cssText = 'display:flex;justify-content:center;margin:12px 0';
    const qrLoading = document.createElement('p'); qrLoading.style.color = 'var(--muted)'; qrLoading.textContent = 'Loading…'; qrWrap.appendChild(qrLoading); body.appendChild(qrWrap);
    const secretText = document.createElement('p'); secretText.className = 'sub'; secretText.style.cssText = 'margin-bottom:10px;font-size:11px;font-family:var(--mono)'; secretText.id = '2fa-secret-text'; secretText.textContent = 'Loading…'; body.appendChild(secretText);
    const setupCode = document.createElement('input'); setupCode.className = 'fi twofa-input'; setupCode.id = 'twofa-setup-code'; setupCode.placeholder = '000000'; setupCode.maxLength = 6; setupCode.inputMode = 'numeric'; setupCode.style.cssText = 'text-align:center;font-size:20px;letter-spacing:.3em;font-family:var(--mono);margin-top:6px'; body.appendChild(setupCode);
    const setupErr = document.createElement('p'); setupErr.className = 'err'; setupErr.id = 'twofa-setup-err'; setupErr.hidden = true; body.appendChild(setupErr);
    okBtn.hidden = false; disBtn.hidden = true;
    const sr = await api.twofa.setup();
    if (sr.ok) {
      (document.getElementById('2fa-secret-text') as HTMLElement).textContent = sr.secret ?? '';
      const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(sr.otpauth!)}`;
      const qrEl = document.getElementById('qr-wrap') as HTMLElement; qrEl.innerHTML = '';
      const qrImg = document.createElement('img'); qrImg.width = 160; qrImg.height = 160;
      qrImg.style.borderRadius = '8px'; qrImg.style.background = '#fff'; qrImg.style.padding = '6px';
      qrImg.src = qrUrl; qrEl.appendChild(qrImg);
      logOk('2fa', '2FA setup initiated');
    } else { logErr('2fa', '2FA setup failed', sr.error); }
    const newOk = okBtn.cloneNode(true) as HTMLButtonElement; okBtn.parentNode!.replaceChild(newOk, okBtn);
    newOk.hidden = false;
    newOk.addEventListener('click', async () => {
      const token = (document.getElementById('twofa-setup-code') as HTMLInputElement)?.value.trim();
      const er = await api.twofa.enable(token);
      if (!er.ok) { const el = document.getElementById('twofa-setup-err') as HTMLElement; el.hidden = false; el.textContent = er.error ?? ""; logWarn('2fa', '2FA enable failed', er.error); return; }
      hide('twofa-overlay'); toast('2FA enabled ✓'); logOk('2fa', '2FA enabled');
    });
  }
  const newDis = disBtn.cloneNode(true) as HTMLButtonElement; disBtn.parentNode!.replaceChild(newDis, disBtn);
  newDis.hidden = !r.enabled;
  newDis.addEventListener('click', async () => {
    const code = prompt('Enter your current 6-digit 2FA code to confirm disabling:');
    if (!code || !/^\d{6}$/.test(code)) { toast('Invalid code format'); return; }
    logInfo('2fa', '2FA disable clicked');
    const res = await api.twofa.disable(code);
    if (!res.ok) { toast(res.error || 'Failed to disable 2FA'); return; }
    hide('twofa-overlay'); toast('2FA disabled'); logOk('2fa', '2FA disabled');
  });
  show('twofa-overlay');
});
(document.getElementById('twofa-cancel') as HTMLButtonElement).addEventListener('click', () => hide('twofa-overlay'));
(document.getElementById('twofa-overlay') as HTMLElement).addEventListener('click', (e: MouseEvent) => {
  if (e.target === (document.getElementById('twofa-overlay') as HTMLElement)) hide('twofa-overlay');
});

// ═══ KEYBOARD ═══════════════════════════════════════════════════════════
document.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Escape') {
    logInfo('ui', 'Escape pressed — closing overlays');
    ['modal-overlay', 'gen-overlay', 'confirm-overlay', 'twofa-overlay', 'job-overlay', 'totp-overlay', 'status-popup'].forEach((id) => hide(id));
  }
});

// ═══ HOVER SOUNDS ══════════════════════════════════════════════════════════════
let __hoverTimer: ReturnType<typeof setTimeout> | null = null;
document.addEventListener('mouseover', (e: MouseEvent) => {
  if (!S.settings.sound_hover || window.__soundsEnabled === false) return;
  const t = (e.target as HTMLElement).closest('.nav-btn, .accent-swatch, .wb, .btn-primary, .btn-ghost, .icon-btn, .filter-pill, .job-stat') as HTMLElement;
  if (!t) return;
  clearTimeout(__hoverTimer!);
  __hoverTimer = setTimeout(() => playSound('hover'), 20);
});

// ── Startup: check if PIN login is available ──
(async () => {
  try {
    const pr = await api.pin.status();
    if (pr.ok && pr.enabled) {
      screen('s-pin');
      await loadPinAccounts();
      logInfo('app', 'PIN login available, showing PIN entry screen');
      return;
    }
  } catch { /* noop — fall through to login screen */ }
  screen('s-login');
  logInfo('app', 'App initialized, showing login screen');
})();