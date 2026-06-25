/// <reference types="vite/client" />
import type { PreloadApi } from "./src/types/renderer.d.ts";
import type {
  VaultItem,
  Job,
  TotpItem,
  Settings,
  UserProfile,
  VaultData,
  ConfirmOpts,
} from "./src/types";

// ── Global declarations from preload bridge ──
declare global {
  interface Window {
    api: PreloadApi;
    __vaultToken: { set(t: string): void; clear(): void };
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
  user: UserProfile | null | undefined;
  passwords: VaultItem[];
  notes: VaultItem[];
  trash: Array<
    | (VaultItem & { _type: string; _deletedAt: string })
    | (Job & { _type: string; _deletedAt: string })
  >;
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
  user: null,
  passwords: [],
  notes: [],
  trash: [],
  jobs: [],
  totp: [],
  activeNote: null,
  jobSort: { col: "", dir: 1 },
  jobFilter: "all",
  settings: {
    lock_timeout: 5,
    lock_action: "lock",
    lock_countdown: true,
    lock_on_minimize: false,
    compact: false,
    animations: true,
    accent: "violet",
    sounds: true,
    sound_login: true,
    sound_exit: true,
    sound_hover: false,
    sound_login_tone: "chime",
    sound_exit_tone: "chime",
    sound_hover_tone: "click",
    gen_length: 20,
    gen_symbols: true,
    gen_numbers: true,
    gen_ambiguous: false,
    gen_copy: true,
    toast_duration: 2400,
    pin_login_enabled: false,
    pin_allow_alpha: false,
  },
};

// ── In-memory icon cache (session only; cleared on app close, NOT on logout) ──
const iconCache: Record<string, string> = {};

// ═══ LOGGER ═══════════════════════════════════════════════════════════════════
const RLOG_KEY = "vault-renderer-log";
const RLOG_MAX = 2000;
function rlog(level: string, ctx: string, msg: string, data?: unknown): void {
  const entry = { ts: new Date().toISOString(), level, ctx, msg, data };
  try {
    const arr: (typeof entry)[] = JSON.parse(
      localStorage.getItem(RLOG_KEY) || "[]",
    );
    arr.push(entry);
    if (arr.length > RLOG_MAX) arr.splice(0, arr.length - RLOG_MAX);
    localStorage.setItem(RLOG_KEY, JSON.stringify(arr));
  } catch {
    /* noop */
  }
}
const logInfo = (ctx: string, msg: string, data?: unknown): void =>
  rlog("INFO", ctx, msg, data);
const logOk = (ctx: string, msg: string, data?: unknown): void =>
  rlog("OK", ctx, msg, data);
const logWarn = (ctx: string, msg: string, data?: unknown): void =>
  rlog("WARN", ctx, msg, data);
const logErr = (ctx: string, msg: string, data?: unknown): void =>
  rlog("ERROR", ctx, msg, data);
logInfo("app", "Renderer initialized");

const CLIPBOARD_CLEAR_MS = 30000;
let _clipboardTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleClipboardClear(): void {
  if (_clipboardTimer) clearTimeout(_clipboardTimer);
  _clipboardTimer = setTimeout(() => {
    navigator.clipboard.writeText("")?.catch?.(() => {});
    logInfo("password", "Clipboard auto-cleared");
    _clipboardTimer = null;
  }, CLIPBOARD_CLEAR_MS);
}

// ═══ UTILS ════════════════════════════════════════════════════════════════════
const uid = (): string => {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  const rnd = Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return Date.now().toString(36) + rnd;
};
const wc = (t: unknown): number => {
  // Only strings carry meaningful word counts; objects would stringify to
  // "[object Object]", so we coerce everything else to an empty string.
  const s = typeof t === "string" ? t.trim() : "";
  return s ? s.split(/\s+/).length : 0;
};
const days = (d: string): number =>
  Math.max(
    0,
    Math.ceil(
      (30 * 86400000 - (Date.now() - new Date(d).getTime())) / 86400000,
    ),
  );

function formatLockTimer(ms: number): string {
  const totalSec = Math.ceil(ms / 1000);
  if (totalSec <= 0) return "0s";
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const totalHr = Math.floor(totalMin / 60);
  const h = totalHr % 24;
  const dd = Math.floor(totalHr / 24);
  if (dd > 0) return `${dd}d ${h}h`;
  if (totalHr > 0) return `${totalHr}h ${String(m).padStart(2, "0")}min`;
  if (totalMin > 0) return `${totalMin}min ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}
function toast(msg: string, ms?: number): void {
  ms ??= S.settings.toast_duration || 2400;
  logInfo("ui", "Toast: " + msg);
  const el = document.getElementById("toast") as HTMLElement;
  el.textContent = msg;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), ms);
}
function confirmDialog(opts: ConfirmOpts): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const overlay = document.getElementById("confirm-overlay") as HTMLElement;
    const title = document.getElementById("confirm-title") as HTMLElement;
    const msg = document.getElementById("confirm-msg") as HTMLElement;
    const icon = document.getElementById("confirm-icon") as HTMLElement;
    const cancelBtn = document.getElementById(
      "confirm-cancel",
    ) as HTMLButtonElement;
    const okBtn = document.getElementById("confirm-ok") as HTMLButtonElement;
    if (opts.title) title.textContent = opts.title;
    if (opts.msg) msg.textContent = opts.msg;
    if (opts.icon) icon.textContent = opts.icon;
    if (opts.okLabel) okBtn.textContent = opts.okLabel;
    if (opts.okClass) okBtn.className = "btn " + opts.okClass;
    overlay.hidden = false;
    const cleanup = () => {
      overlay.hidden = true;
      cancelBtn.removeEventListener("click", onCancel);
      okBtn.removeEventListener("click", onOk);
    };
    const onCancel = () => {
      cleanup();
      resolve(false);
    };
    const onOk = () => {
      cleanup();
      resolve(true);
    };
    cancelBtn.addEventListener("click", onCancel);
    okBtn.addEventListener("click", onOk);
  });
}
function show(id: string): void {
  (document.getElementById(id) as HTMLElement).hidden = false;
}
function hide(id: string): void {
  (document.getElementById(id) as HTMLElement).hidden = true;
}

// ── Modal blur: track overlay open/close to blur sidebar + main (not titlebar) ──
const _OVERLAY_IDS = [
  "modal-overlay",
  "gen-overlay",
  "job-overlay",
  "totp-overlay",
  "twofa-overlay",
  "confirm-overlay",
];
function _updateModalBlur(): void {
  const anyOpen = _OVERLAY_IDS.some(
    (id) => !(document.getElementById(id) as HTMLElement).hidden,
  );
  document.querySelector(".screen")?.classList.toggle("modal-open", anyOpen);
}
function showOverlay(id: string): void {
  show(id);
  _updateModalBlur();
}
function hideOverlay(id: string): void {
  hide(id);
  _updateModalBlur();
}

function screen(s: string): void {
  ["s-login", "s-2fa", "s-lock", "s-pin", "s-app"].forEach((id: string) => {
    const el = document.getElementById(id);
    if (el) el.hidden = id !== s;
  });
}
function clearAllInputs(): void {
  document
    .querySelectorAll("input:not([type=checkbox]):not([type=range]),textarea")
    .forEach((el) => {
      (el as HTMLInputElement | HTMLTextAreaElement).value = "";
    });
}

// ═══ SOUNDS ═══════════════════════════════════════════════════════════════════
const AudioCtx: typeof AudioContext =
  globalThis.AudioContext ||
  (globalThis as unknown as { webkitAudioContext: typeof AudioContext })
    .webkitAudioContext;
let actx: AudioContext | null = null;
function getACtx(): AudioContext {
  actx ??= new AudioCtx();
  return actx;
}
function playTone(
  freq: number,
  type: OscillatorType = "sine",
  dur: number = 0.15,
  vol: number = 0.18,
  delay: number = 0,
): void {
  try {
    const ctx = getACtx();
    const now = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(vol, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, now + dur);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + dur);
  } catch {
    /* noop */
  }
}
const TONES: Record<string, ToneConfig> = {
  chime: {
    freqs: [523, 659, 784, 1047],
    type: "sine",
    dur: 0.2,
    vol: 0.15,
    gap: 0.1,
  },
  ding: { freqs: [880, 1100], type: "sine", dur: 0.18, vol: 0.18, gap: 0.08 },
  soft: { freqs: [440, 554], type: "sine", dur: 0.25, vol: 0.1, gap: 0.12 },
  bright: {
    freqs: [660, 880, 1100, 1320],
    type: "triangle",
    dur: 0.15,
    vol: 0.16,
    gap: 0.07,
  },
  click: { freqs: [1200], type: "square", dur: 0.03, vol: 0.06, gap: 0 },
  tap: { freqs: [800], type: "sine", dur: 0.04, vol: 0.08, gap: 0 },
  pop: { freqs: [600, 900], type: "sine", dur: 0.06, vol: 0.1, gap: 0.03 },
};
function playToneSeq(toneName: string): void {
  const t = TONES[toneName] || TONES.chime;
  t.freqs.forEach((f: number, i: number) =>
    playTone(f, t.type, t.dur, t.vol, i * t.gap),
  );
}
function playSound(type: string): void {
  if (
    (globalThis as unknown as Record<string, boolean>).__soundsEnabled === false
  )
    return;
  const s = S.settings;
  switch (type) {
    case "login":
      if (!s.sound_login) return;
      playToneSeq(s.sound_login_tone || "chime");
      break;
    case "logout":
    case "lock":
      if (!s.sound_exit) return;
      if (s.sound_exit_tone && TONES[s.sound_exit_tone]) {
        const t = TONES[s.sound_exit_tone];
        t.freqs
          .slice()
          .reverse()
          .forEach((f: number, i: number) =>
            playTone(f, t.type, t.dur, t.vol * 0.8, i * t.gap),
          );
      } else {
        [784, 659, 523].forEach((f: number, i: number) =>
          playTone(f, "sine", 0.18, 0.12, i * 0.09),
        );
      }
      break;
    case "hover":
      if (!s.sound_hover) return;
      playToneSeq(s.sound_hover_tone || "click");
      break;
  }
}
api.onPlaySound((type: string) => playSound(type));
api.onTrayLock(() => {
  if (S.user) {
    logInfo("auth", "Tray lock");
    doLock();
    switchTab("passwords");
  }
});
api.onTrayLogout(() => {
  if (S.user) {
    logInfo("auth", "Tray logout");
    doLogout();
    switchTab("passwords");
  }
});

// ═══ SOUND TEST BUTTONS ════════════════════════════════════════════════════════
function testSound(soundType: string): void {
  if (
    (globalThis as unknown as Record<string, boolean>).__soundsEnabled === false
  )
    return;
  const s = S.settings;
  switch (soundType) {
    case "login":
      playToneSeq(s.sound_login_tone || "chime");
      break;
    case "exit":
      if (s.sound_exit_tone && TONES[s.sound_exit_tone]) {
        const t = TONES[s.sound_exit_tone];
        t.freqs
          .slice()
          .reverse()
          .forEach((f: number, i: number) =>
            playTone(f, t.type, t.dur, t.vol * 0.8, i * t.gap),
          );
      } else {
        [784, 659, 523].forEach((f: number, i: number) =>
          playTone(f, "sine", 0.18, 0.12, i * 0.09),
        );
      }
      break;
    case "hover":
      playToneSeq(s.sound_hover_tone || "click");
      break;
  }
}
(
  document.getElementById("btn-test-login-sound") as HTMLButtonElement
).addEventListener("click", () => testSound("login"));
(
  document.getElementById("btn-test-exit-sound") as HTMLButtonElement
).addEventListener("click", () => testSound("exit"));
(
  document.getElementById("btn-test-hover-sound") as HTMLButtonElement
).addEventListener("click", () => testSound("hover"));

// ═══ WINDOWS SNAP ═════════════════════════════════════════════════════════════
(document.getElementById("titlebar") as HTMLElement).addEventListener(
  "dblclick",
  (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest(".tb-right")) return;
    logInfo("ui", "Titlebar double-clicked — maximize toggle");
    api.maximize();
  },
);

// ═══ CONFIRM ══════════════════════════════════════════════════════════════════
function confirm(opts: ConfirmOpts): void {
  logInfo("ui", "Confirm dialog shown", { title: opts.title });
  (document.getElementById("confirm-title") as HTMLElement).textContent =
    opts.title || "Are you sure?";
  (document.getElementById("confirm-msg") as HTMLElement).textContent =
    opts.msg || "";
  (document.getElementById("confirm-icon") as HTMLElement).textContent =
    opts.icon || "🗑️";
  const okBtn = document.getElementById("confirm-ok") as HTMLButtonElement;
  const newOk = okBtn.cloneNode(true) as HTMLButtonElement;
  okBtn.parentNode!.replaceChild(newOk, okBtn);
  newOk.textContent = opts.okLabel || "Delete";
  newOk.className = opts.okClass || "btn-danger";
  newOk.addEventListener("click", () => {
    hideOverlay("confirm-overlay");
    logInfo("ui", "Confirm dialog accepted", { title: opts.title });
    opts.onOk?.();
  });
  showOverlay("confirm-overlay");
}
(
  document.getElementById("confirm-cancel") as HTMLButtonElement
).addEventListener("click", () => {
  hideOverlay("confirm-overlay");
  logInfo("ui", "Confirm dialog cancelled");
});
(document.getElementById("confirm-overlay") as HTMLElement).addEventListener(
  "click",
  (e: MouseEvent) => {
    if (
      e.target === (document.getElementById("confirm-overlay") as HTMLElement)
    ) {
      hideOverlay("confirm-overlay");
      logInfo("ui", "Confirm dialog dismissed (overlay click)");
    }
  },
);

// ═══ AUTO-LOCK ════════════════════════════════════════════════════════════════
let LOCK_MS: number = 5 * 60 * 1000;
let lockTimer: ReturnType<typeof setTimeout> | undefined;
let lockTick: ReturnType<typeof setInterval> | undefined;
let lockDeadline: number = 0;
function applyLockSettings(): void {
  const t = S.settings.lock_timeout;
  LOCK_MS = t > 0 ? t * 60 * 1000 : Infinity;
  const row = document.getElementById("lock-row") as HTMLElement;
  const showCountdown = S.settings.lock_countdown !== false;
  if (row) row.hidden = t === 0 || !showCountdown;
  logInfo("settings", "Lock settings applied", { timeout: t, lockMs: LOCK_MS });
}
function armLock(): void {
  clearTimeout(lockTimer);
  clearInterval(lockTick);
  if (S.settings.lock_timeout === 0) return;
  lockDeadline = Date.now() + LOCK_MS;
  const row = document.getElementById("lock-row") as HTMLElement;
  if (row && S.settings.lock_countdown !== false) row.hidden = false;
  lockTick = setInterval(() => {
    const rem = Math.max(0, lockDeadline - Date.now());
    const el = document.getElementById("lock-label") as HTMLElement;
    if (el) el.textContent = `locks in ${formatLockTimer(rem)}`;
    if (rem <= 0) clearInterval(lockTick);
  }, 1000);
  lockTimer = setTimeout(() => {
    logInfo("auth", "Auto-lock timer expired");
    playSound("lock");
    if (S.settings.lock_action === "exit") {
      logInfo("auth", "Lock action: exit");
      api.close();
    } else doLock();
  }, LOCK_MS);
}
function disarmLock(): void {
  clearTimeout(lockTimer);
  clearInterval(lockTick);
  const row = document.getElementById("lock-row") as HTMLElement;
  if (row) row.hidden = true;
}
let _lockInProgress = false;
function doLock(): void {
  if (_lockInProgress) return;
  _lockInProgress = true;
  logInfo("auth", "Locking vault");
  disarmLock();
  S.passwords = [];
  S.notes = [];
  S.totp = [];
  S.jobs = [];
  S.trash = [];
  S.activeNote = null;
  document.querySelectorAll(".pw-real").forEach((el) => {
    (el as HTMLElement).textContent = "";
    el.remove();
  });
  api.lock().catch(() => {
    /* noop */
  });
  if (S.settings.pin_login_enabled) {
    screen("s-pin");
    logInfo("auth", "Locked — showing PIN entry screen");
  } else {
    screen("s-lock");
    logInfo("auth", "Locked — showing Google unlock screen");
  }
  logInfo("auth", "Sensitive data cleared from memory on lock");
  setTimeout(() => {
    _lockInProgress = false;
  }, 2000);
}
["mousemove", "keydown", "mousedown", "touchstart"].forEach((ev) =>
  document.addEventListener(
    ev,
    () => {
      if (S.user && S.settings.lock_timeout > 0) armLock();
    },
    { passive: true },
  ),
);

(document.getElementById("btn-unlock") as HTMLButtonElement).addEventListener(
  "click",
  async () => {
    const btn = document.getElementById("btn-unlock") as HTMLButtonElement;
    if (btn.disabled) return;
    logInfo("auth", "Unlock button clicked");
    btn.textContent = "Opening browser…";
    btn.disabled = true;
    const r = await api.reauth();
    if (r.ok) {
      if (r.token)
        (
          globalThis as unknown as { __vaultToken: { set(t: string): void } }
        ).__vaultToken.set(r.token);
      S.user = r.user;
      loadVault(r.vault);
      screen("s-app");
      armLock();
      toast("Vault unlocked");
      logOk("auth", "Vault unlocked via reauth", { email: S.user?.email });
    } else {
      btn.textContent = "Unlock with Google";
      btn.disabled = false;
      toast("Unlock failed: " + r.error);
      logErr("auth", "Unlock failed", r.error);
    }
  },
);

// ═══ AUTH ═════════════════════════════════════════════════════════════════════
(document.getElementById("btn-login") as HTMLButtonElement).addEventListener(
  "click",
  async () => {
    const btn = document.getElementById("btn-login") as HTMLButtonElement;
    if (btn.disabled) return;
    logInfo("auth", "Login button clicked");
    btn.textContent = "Opening browser…";
    btn.disabled = true;
    const r = await api.login();
    if (!r.ok) {
      const err = document.getElementById("login-err") as HTMLElement;
      err.hidden = false;
      err.textContent = r.error ?? "";
      logErr("auth", "Login failed", r.error);
      btn.textContent = "Sign in with Google";
      btn.disabled = false;
      return;
    }
    if (r.needs2fa) {
      S.user = r.user;
      screen("s-2fa");
      btn.textContent = "Sign in with Google";
      btn.disabled = false;
      logInfo("auth", "Login requires 2FA", { email: S.user?.email });
      return;
    }
    if (r.token)
      (
        globalThis as unknown as { __vaultToken: { set(t: string): void } }
      ).__vaultToken.set(r.token);
    S.user = r.user;
    loadVault(r.vault);
    await loadSettings();
    enterApp();
    logOk("auth", "Login successful", { email: S.user?.email });
  },
);
(
  document.getElementById("btn-verify2fa") as HTMLButtonElement
).addEventListener("click", async () => {
  const token = (
    document.getElementById("twofa-code") as HTMLInputElement
  ).value.trim();
  logInfo("auth", "2FA verify attempt");
  const r = await api.verify2fa(token);
  if (!r.ok) {
    (document.getElementById("twofa-err") as HTMLElement).hidden = false;
    (document.getElementById("twofa-err") as HTMLElement).textContent =
      r.error ?? "";
    logWarn("auth", "2FA verify failed", r.error);
    return;
  }
  if (r.token)
    (
      globalThis as unknown as { __vaultToken: { set(t: string): void } }
    ).__vaultToken.set(r.token);
  S.user = r.user;
  loadVault(r.vault);
  await loadSettings();
  enterApp();
  logOk("auth", "2FA verified, login complete");
});
(document.getElementById("twofa-code") as HTMLInputElement).addEventListener(
  "keydown",
  (e: KeyboardEvent) => {
    if (e.key === "Enter")
      (document.getElementById("btn-verify2fa") as HTMLButtonElement).click();
  },
);

// ═══ PIN UNLOCK ═══════════════════════════════════════════════════════════════
let _selectedAccount: {
  googleId: string;
  email: string;
  name: string;
  avatar: string | null;
} | null = null;

function showPinAccounts() {
  _selectedAccount = null;
  hide("pin-selected-account");
  show("pin-user-label");
  show("pin-accounts");
  hide("pin-input-area");
  (document.getElementById("pin-code") as HTMLInputElement).value = "";
  (document.getElementById("pin-err") as HTMLElement).hidden = true;
  // If there are saved accounts, hide PIN input until user selects one
  const list = document.getElementById("pin-accounts-list") as HTMLElement;
  if (list && list.children.length > 0) {
    hide("pin-input-area");
  }
}

function selectPinAccount(account: {
  googleId: string;
  email: string;
  name: string;
  avatar: string | null;
}) {
  _selectedAccount = account;
  hide("pin-accounts");
  hide("pin-user-label");
  show("pin-selected-account");

  const avatarEl = document.getElementById(
    "pin-selected-avatar",
  ) as HTMLElement;
  avatarEl.innerHTML = "";
  avatarEl.className = "";
  if (account.avatar?.startsWith("https://")) {
    const img = document.createElement("img");
    img.className = "pin-selected-avatar";
    img.src = account.avatar.split("?")[0];
    img.addEventListener("error", () => {
      img.remove();
      avatarEl.className = "pin-selected-avatar-fb";
      avatarEl.textContent = (account.name || "?")[0].toUpperCase();
    });
    avatarEl.appendChild(img);
  } else {
    avatarEl.className = "pin-selected-avatar-fb";
    avatarEl.textContent = (account.name ||
      account.email ||
      "?")[0].toUpperCase();
  }

  (document.getElementById("pin-selected-name") as HTMLElement).textContent =
    account.name || account.email;
  (document.getElementById("pin-selected-email") as HTMLElement).textContent =
    account.email;
  (document.getElementById("pin-code") as HTMLInputElement).value = "";
  (document.getElementById("pin-err") as HTMLElement).hidden = true;
  show("pin-input-area");
  setTimeout(
    () => (document.getElementById("pin-code") as HTMLInputElement).focus(),
    60,
  );
}

function buildPinAccountItem(
  acct: {
    googleId: string;
    email: string;
    name: string;
    avatar: string | null;
  },
  list: HTMLElement,
): HTMLDivElement {
  const item = document.createElement("div");
  item.className = "pin-account-item";
  const init = (acct.name || acct.email || "?")[0].toUpperCase();
  if (acct.avatar?.startsWith("https://")) {
    const img = document.createElement("img");
    img.className = "pin-account-avatar";
    img.src = acct.avatar.split("?")[0];
    img.addEventListener("error", () => {
      img.remove();
      const fb = document.createElement("div");
      fb.className = "pin-account-avatar-fb";
      fb.textContent = init;
      item.insertBefore(fb, item.firstChild);
    });
    item.appendChild(img);
  } else {
    const fb = document.createElement("div");
    fb.className = "pin-account-avatar-fb";
    fb.textContent = init;
    item.appendChild(fb);
  }
  const nameEl = document.createElement("div");
  nameEl.className = "pin-account-name";
  nameEl.textContent = acct.name || acct.email;
  item.appendChild(nameEl);
  const emailEl = document.createElement("div");
  emailEl.className = "pin-account-email";
  emailEl.textContent = acct.email;
  item.appendChild(emailEl);
  const removeBtn = document.createElement("button");
  removeBtn.className = "pin-account-remove";
  removeBtn.title = "Remove account";
  removeBtn.innerHTML =
    '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  removeBtn.addEventListener("click", async function (e: Event) {
    e.stopPropagation();
    e.preventDefault();
    const confirmed = await new Promise<boolean>(function (resolve) {
      const overlay = document.getElementById("confirm-overlay")!;
      const title = document.getElementById("confirm-title")!;
      const msg = document.getElementById("confirm-msg")!;
      const okBtn = document.getElementById("confirm-ok")!;
      const cancelBtn = document.getElementById("confirm-cancel")!;
      const icon = document.getElementById("confirm-icon")!;
      title.textContent = "Remove account?";
      msg.textContent = "Remove " + acct.email + " from the quick login list?";
      icon.textContent = "✕";
      okBtn.textContent = "Remove";
      okBtn.className = "btn-danger";
      overlay.hidden = false;
      const cleanup = function () {
        overlay.hidden = true;
        okBtn.removeEventListener("click", onOk);
        cancelBtn.removeEventListener("click", onCancel);
      };
      const onOk = function () {
        cleanup();
        resolve(true);
      };
      const onCancel = function () {
        cleanup();
        resolve(false);
      };
      okBtn.addEventListener("click", onOk);
      cancelBtn.addEventListener("click", onCancel);
    });
    if (!confirmed) return;
    const res = await api.accounts.removeById(acct.googleId);
    if (res.ok) {
      item.remove();
      toast("Account removed");
      const remaining = list.querySelectorAll(".pin-account-item");
      if (remaining.length === 0) {
        hide("pin-accounts");
        show("pin-user-label");
        show("pin-input-area");
        _selectedAccount = null;
      }
    } else {
      toast("Failed to remove account");
    }
  });
  item.appendChild(removeBtn);
  item.addEventListener("click", () => selectPinAccount(acct));
  return item;
}

async function loadPinAccounts() {
  try {
    const r = await api.accounts.list();
    if (!r.ok || !r.accounts.length) {
      _selectedAccount = null;
      hide("pin-selected-account");
      hide("pin-accounts");
      show("pin-user-label");
      show("pin-input-area");
      (document.getElementById("pin-code") as HTMLInputElement).value = "";
      (document.getElementById("pin-err") as HTMLElement).hidden = true;
      setTimeout(
        () => (document.getElementById("pin-code") as HTMLInputElement).focus(),
        60,
      );
      return;
    }
    _selectedAccount = null;
    hide("pin-input-area");
    hide("pin-selected-account");
    show("pin-user-label");
    const list = document.getElementById("pin-accounts-list") as HTMLElement;
    list.innerHTML = "";
    for (const acct of r.accounts) {
      list.appendChild(buildPinAccountItem(acct, list));
    }
    const accountsWrap = document.getElementById("pin-accounts") as HTMLElement;
    accountsWrap.hidden = false;
  } catch {
    /* noop */
  }
}

(
  document.getElementById("btn-pin-unlock") as HTMLButtonElement
).addEventListener("click", async () => {
  const pin = (document.getElementById("pin-code") as HTMLInputElement).value;
  logInfo("auth", "PIN unlock attempt");
  const r = await api.pin.verify(pin);
  if (!r.ok) {
    (document.getElementById("pin-err") as HTMLElement).hidden = false;
    (document.getElementById("pin-err") as HTMLElement).textContent =
      r.error ?? "Incorrect PIN";
    logWarn("auth", "PIN verify failed", r.error);
    return;
  }
  logOk("auth", "PIN verified, completing login", { email: r.email });
  // Update lastUsed for the account
  if (_selectedAccount?.googleId) {
    api.accounts.touch(_selectedAccount.googleId).catch(() => {});
  }
  const r2 = await api.loginWithPin(r.verifyId!);
  if (!r2.ok) {
    (document.getElementById("pin-err") as HTMLElement).hidden = false;
    (document.getElementById("pin-err") as HTMLElement).textContent =
      r2.error ?? "Login failed";
    logErr("auth", "PIN login failed", r2.error);
    return;
  }
  if (r2.token)
    (
      (globalThis as unknown as Record<string, unknown>).__vaultToken as {
        set: (t: string) => void;
      }
    ).set(r2.token);
  S.user = r2.user;
  loadVault(r2.vault);
  await loadSettings();
  enterApp();
  logOk("auth", "PIN login successful", { email: S.user?.email });
});
(document.getElementById("pin-code") as HTMLInputElement).addEventListener(
  "keydown",
  (e: KeyboardEvent) => {
    if (e.key === "Enter")
      (document.getElementById("btn-pin-unlock") as HTMLButtonElement).click();
  },
);
(
  document.getElementById("btn-pin-google") as HTMLButtonElement
).addEventListener("click", () => {
  logInfo("auth", "Switching to Google OAuth from PIN screen");
  clearAllInputs();
  (document.getElementById("pin-err") as HTMLElement).hidden = true;
  screen("s-login");
});
const _pinBackBtn = document.getElementById(
  "pin-account-back",
) as HTMLButtonElement;
if (_pinBackBtn)
  _pinBackBtn.addEventListener("click", () => {
    showPinAccounts();
    loadPinAccounts();
  });

async function doLogout(): Promise<void> {
  logInfo("auth", "Logout clicked", { user: S.user?.email });
  playSound("logout");
  await api.logout();
  S.user = null;
  S.passwords = [];
  S.notes = [];
  S.trash = [];
  S.jobs = [];
  S.totp = [];
  S.activeNote = null;
  Object.keys(_tabCache).forEach((k) => delete _tabCache[k]);
  disarmLock();
  clearAllInputs();
  if (S.settings.pin_login_enabled) {
    screen("s-pin");
    logOk("auth", "Logged out, showing PIN entry screen");
  } else {
    screen("s-login");
    (document.getElementById("btn-login") as HTMLButtonElement).textContent =
      "Sign in with Google";
    (document.getElementById("btn-login") as HTMLButtonElement).disabled =
      false;
    (document.getElementById("login-err") as HTMLElement).hidden = true;
    logOk("auth", "Logged out, state cleared");
  }
}
(document.getElementById("btn-logout") as HTMLButtonElement).addEventListener(
  "click",
  () => doLogout(),
);

function loadVault(v: VaultData | null | undefined): void {
  S.passwords = v?.passwords || [];
  S.notes = v?.notes || [];
  logInfo("vault", "Vault loaded into memory", {
    passwords: S.passwords.length,
    notes: S.notes.length,
  });
}
async function loadSettings(): Promise<void> {
  const r = await api.settings.load();
  if (r.ok) S.settings = { ...S.settings, ...r.settings } as AppSettings;
  applyLockSettings();
  applyAccent(S.settings.accent || "violet");
  document.body.classList.toggle("compact", !!S.settings.compact);
  document.body.style.setProperty(
    "--transition",
    S.settings.animations ? "" : "0s",
  );
  (globalThis as unknown as Record<string, unknown>).__soundsEnabled =
    S.settings.sounds !== false;
  // Show PIN indicator in sidebar when PIN login is enabled
  const pinIndicator = document.getElementById("pin-indicator") as HTMLElement;
  if (pinIndicator) pinIndicator.hidden = !S.settings.pin_login_enabled;
  logInfo("settings", "settings loaded", S.settings);
}
function enterApp(): void {
  logInfo("app", "Entering app screen");
  screen("s-app");
  renderUserChip();
  switchTab("passwords");
  armLock();
  // Save account for quick PIN login — only if PIN login is enabled
  if (S.settings.pin_login_enabled) {
    api.accounts.save().catch(() => {});
  }
}
function renderUserChip(): void {
  const u = S.user!;
  const init = (u.name || u.email || "?")[0].toUpperCase();
  const chip = document.getElementById("user-chip") as HTMLElement;
  chip.innerHTML = "";
  if (u.avatar?.startsWith("https://")) {
    const img = document.createElement("img");
    img.className = "avatar";
    img.src = u.avatar.split("?")[0];
    img.addEventListener("error", () => {
      img.remove();
      const fb = document.createElement("div");
      fb.className = "avatar-fb";
      fb.textContent = init;
      chip.insertBefore(fb, chip.firstChild);
    });
    chip.appendChild(img);
  } else {
    const fb = document.createElement("div");
    fb.className = "avatar-fb";
    fb.textContent = init;
    chip.appendChild(fb);
  }
  const info = document.createElement("div");
  const nm = document.createElement("div");
  nm.className = "u-name";
  nm.textContent = u.name || "";
  const em = document.createElement("div");
  em.className = "u-email";
  em.textContent = u.email || "";
  info.appendChild(nm);
  info.appendChild(em);
  chip.appendChild(info);
}

// ═══ TABS ══════════════════════════════════════════════════════════════════════
const _tabCache: Record<string, boolean> = {};
document.querySelectorAll(".nav-btn[data-tab]").forEach((btn) => {
  const b = btn as HTMLElement;
  b.addEventListener("click", () => switchTab(b.dataset.tab!));
});
function switchTab(tab: string): void {
  logInfo("ui", "Tab switched", { tab });
  document.querySelectorAll(".nav-btn[data-tab]").forEach((b) => {
    const el = b as HTMLElement;
    el.classList.toggle("active", el.dataset.tab === tab);
  });
  for (const t of [
    "passwords",
    "notes",
    "jobs",
    "totp",
    "trash",
    "sync",
    "settings",
  ]) {
    (document.getElementById("tab-" + t) as HTMLElement).hidden = t !== tab;
  }
  const tabLoaders: Record<string, () => void> = {
    passwords: () => renderPasswords(),
    notes: () => renderNotesList(),
    trash: () => {
      if (!_tabCache.trash) {
        loadAndRenderTrash();
        _tabCache.trash = true;
      }
    },
    jobs: () => {
      if (!_tabCache.jobs) {
        loadAndRenderJobs();
        _tabCache.jobs = true;
      }
    },
    totp: () => {
      if (!_tabCache.totp) {
        loadAndRenderTotp();
        _tabCache.totp = true;
      }
    },
    sync: () => {
      if (!_tabCache.sync) {
        loadSyncTab();
        _tabCache.sync = true;
      }
    },
    settings: () => {
      if (!_tabCache.settings) {
        loadSettingsTab();
        _tabCache.settings = true;
      }
    },
  };
  if (tabLoaders[tab]) tabLoaders[tab]();
  updateCounts();
}
function updateCounts(): void {
  (document.getElementById("cnt-pw") as HTMLElement).textContent = String(
    S.passwords.length,
  );
  (document.getElementById("cnt-notes") as HTMLElement).textContent = String(
    S.notes.length,
  );
  (document.getElementById("cnt-trash") as HTMLElement).textContent = String(
    S.trash.length,
  );
  (document.getElementById("cnt-jobs") as HTMLElement).textContent = String(
    S.jobs.length,
  );
  (document.getElementById("cnt-totp") as HTMLElement).textContent = String(
    S.totp.length,
  );
}
(document.getElementById("btn-sync") as HTMLButtonElement).addEventListener(
  "click",
  async () => {
    logInfo("vault", "Sync triggered");
    const btn = document.getElementById("btn-sync") as HTMLButtonElement;
    btn.style.opacity = ".5";
    btn.style.pointerEvents = "none";
    const r = await api.vaultSync();
    btn.style.opacity = "";
    btn.style.pointerEvents = "";
    if (r.ok) {
      loadVault(r.vault);
      switchTab("passwords");
      toast("Synced ✓");
      logOk("vault", "Sync successful");
    } else {
      toast("Sync error: " + r.error);
      logErr("vault", "Sync failed", r.error);
    }
  },
);

// ═══ PASSWORDS ════════════════════════════════════════════════════════════════
(document.getElementById("btn-add-pw") as HTMLButtonElement).addEventListener(
  "click",
  () => {
    logInfo("password", "Add password clicked");
    openPwModal();
  },
);
async function loadSyncTab() {
  logInfo("sync", "Loading sync tab");
  await loadSyncFolders();
  initSyncDropZone();
}

// ── OS-level drag-and-drop: drop files/folders from Explorer onto sync panel ──
let _syncDropZoneInit = false;
function initSyncDropZone(): void {
  if (_syncDropZoneInit) return;
  _syncDropZoneInit = true;
  const panel = document.querySelector("#tab-sync .sync-body") as HTMLElement;
  if (!panel) return;
  let dragCounter = 0; // track nested dragenter/dragleave
  let dropOverlay: HTMLElement | null = null;

  panel.addEventListener("dragover", (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  });

  // Use globalThis-level dragenter/dragleave so we can detect when the drag leaves the tab entirely
  globalThis.addEventListener("dragenter", (e: DragEvent) => {
    // Only activate when files are being dragged (not internal row reordering)
    if (!e.dataTransfer?.types.includes("Files")) return;
    dragCounter++;
    if (dragCounter === 1) {
      // Create overlay
      dropOverlay = document.createElement("div");
      dropOverlay.className = "sync-drop-overlay";
      dropOverlay.innerHTML =
        '<div class="sync-drop-message"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin-bottom:12px;color:var(--accent)"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg><strong>Drop to sync</strong><br/>Folders will be added as sync folders<br/>Files will sync from their parent directory</div>';
      panel.appendChild(dropOverlay);
    }
  });

  globalThis.addEventListener("dragleave", (e: DragEvent) => {
    if (!e.dataTransfer?.types.includes("Files")) return;
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      if (dropOverlay) {
        dropOverlay.remove();
        dropOverlay = null;
      }
    }
  });

  globalThis.addEventListener("drop", async (e: DragEvent) => {
    // Clean up overlay
    dragCounter = 0;
    if (dropOverlay) {
      dropOverlay.remove();
      dropOverlay = null;
    }
    // Only handle file drops (not internal row reordering)
    if (!e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;
    const paths: string[] = [];
    for (const f of files) {
      const p = api.getFilePath(f);
      if (p) paths.push(p);
    }
    if (paths.length === 0) {
      toast("Drop not supported — try the Add folder button");
      return;
    }
    logInfo("sync", "OS drop: " + paths.length + " item(s)", paths);
    const r = await api.sync.handleDrop(paths);
    if (r.ok) {
      const added = (r.results as { ok: boolean }[]).filter(
        (x: { ok: boolean }) => x.ok,
      ).length;
      toast(added + " sync folder(s) added — syncing...");
      loadSyncFolders();
      syncNowWithDriveRetry().then((syncResult) => {
        if (!syncResult.ok) toast("Sync error: " + syncResult.error);
        loadSyncFolders();
      });
    } else {
      toast("Failed: " + r.error);
    }
  });
}

// Per-file status cache (refreshed on each loadSyncFolders call)
let _fileStates: Record<
  string,
  Record<
    string,
    { conflict: string; localHash: string | null; driveHash: string | null }
  >
> = {};

function classifyFolderStatus(status: string, hasConflict: boolean): string {
  if (status === "syncing") return "syncing";
  if (status === "error") return "err";
  if (hasConflict) return "conflict";
  return "idle";
}

function buildFolderStatusText(
  folder: {
    status: string;
    errorMessage?: string | null;
    lastSyncAt?: number | null;
  },
  hasConflict: boolean,
): string {
  if (folder.status === "syncing") return "Syncing...";
  if (folder.status === "error") return folder.errorMessage || "Error";
  if (hasConflict) return "Conflict";
  if (folder.lastSyncAt) return "Synced " + timeAgo(folder.lastSyncAt);
  return "Never synced";
}

function buildFolderStatusIcon(
  status: string,
  hasConflict: boolean,
  allSynced: boolean,
  lastSyncAt?: number | null,
): string {
  if (status === "syncing")
    return '<span class="sync-status-icon sync-status-syncing"><span class="sync-spinner"></span></span>';
  if (status === "error")
    return '<span class="sync-status-icon sync-status-error">✗</span>';
  if (hasConflict)
    return '<span class="sync-status-icon sync-status-conflict">⚡</span>';
  if (allSynced || lastSyncAt)
    return '<span class="sync-status-icon sync-status-synced">✓</span>';
  return '<span class="sync-status-icon"></span>';
}

function buildFileStatusIcon(fs: {
  conflict: string;
  localHash: string | null;
  driveHash: string | null;
}): string {
  if (fs.conflict && fs.conflict !== "none")
    return '<span class="sync-status-icon sync-status-conflict">⚡</span>';
  if (fs.localHash && fs.driveHash && fs.localHash === fs.driveHash)
    return '<span class="sync-status-icon sync-status-synced">✓</span>';
  if (fs.localHash || fs.driveHash)
    return '<span class="sync-status-icon sync-status-syncing"><span class="sync-spinner"></span></span>';
  return '<span class="sync-status-icon"></span>';
}

function buildFileTreeEl(
  files: Record<
    string,
    { conflict: string; localHash: string | null; driveHash: string | null }
  >,
  expandId: string,
): HTMLDivElement {
  const fileTree = document.createElement("div");
  fileTree.className = "sync-file-tree";
  fileTree.id = expandId;
  fileTree.hidden = true;
  const sortedFiles = Object.entries(files).sort((a, b) =>
    a[0].localeCompare(b[0]),
  );
  for (const [relPath, fs] of sortedFiles) {
    const fileRow = document.createElement("div");
    fileRow.className = "sync-file-row";
    const fileName = relPath.split("/").pop() || relPath;
    const fileIcon = buildFileStatusIcon(fs);
    fileRow.innerHTML =
      '<div class="sync-file-icon"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></div><div class="sync-file-name" title="' +
      escHtml(relPath) +
      '">' +
      escHtml(fileName) +
      '</div><div class="sync-file-detail">' +
      escHtml(
        relPath.includes("/") ? relPath.split("/").slice(0, -1).join("/") : "",
      ) +
      "</div>" +
      fileIcon;
    fileTree.appendChild(fileRow);
  }
  if (!sortedFiles.length) {
    fileTree.innerHTML =
      '<div class="sync-file-empty">No files synced yet</div>';
  }
  return fileTree;
}

function buildFolderRowHTML(opts: {
  folder: {
    id: string;
    localPath: string;
    driveFolderName?: string;
    status: string;
    lastSyncAt?: number | null;
    enabled?: boolean;
  };
  hasConflict: boolean;
  allSynced: boolean;
  sc: string;
  st: string;
  statusIcon: string;
  fileCount: number;
  expandId: string;
}): string {
  const { folder, sc, st, statusIcon, fileCount, expandId } = opts;
  const driveTarget = folder.driveFolderName
    ? "Vault/sync/" + folder.driveFolderName + "/"
    : "Vault/sync/";
  // Extract the singular/plural suffix to avoid a nested ternary.
  const fileSuffix = fileCount === 1 ? "file" : "files";
  const fileLabel = fileCount > 0 ? " · " + fileCount + " " + fileSuffix : "";
  return (
    '<div class="sync-folder-drag"><svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" style="opacity:0.3"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg></div>' +
    '<div class="sync-folder-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></div>' +
    '<div class="sync-folder-info"><div class="sync-folder-path" title="' +
    escHtml(folder.localPath) +
    '">' +
    escHtml(folder.localPath) +
    '</div><div class="sync-folder-detail">→ ' +
    escHtml(driveTarget) +
    ' · <span class="sync-status ' +
    sc +
    '">' +
    escHtml(st) +
    "</span>" +
    "</span>" +
    fileLabel +
    "</div></div>" +
    statusIcon +
    '<div class="sync-folder-actions"><button class="icon-btn sync-folder-expand" data-expand="' +
    expandId +
    '" title="Show files"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg></button><label class="toggle toggle-sm"><input type="checkbox" class="sync-folder-toggle" ' +
    (folder.enabled ? "checked" : "") +
    ' data-folder-id="' +
    folder.id +
    '" /><span class="toggle-track"></span></label><button class="icon-btn sync-folder-remove" data-folder-id="' +
    folder.id +
    '" title="Remove"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div>'
  );
}

async function loadSyncFolders() {
  const r = await api.sync.foldersList();
  if (!r.ok) {
    toast("Failed to load sync folders");
    return;
  }
  // Also fetch per-file states
  const sr = await api.sync.getFileStates();
  _fileStates = {};
  if (sr.ok && sr.states) {
    for (const [fid, fs] of Object.entries(
      sr.states as Record<
        string,
        {
          files: Record<
            string,
            {
              conflict: string;
              localHash: string | null;
              driveHash: string | null;
            }
          >;
        }
      >,
    )) {
      _fileStates[fid] = fs.files || {};
    }
  }
  const list = document.getElementById("sync-folders-list")!;
  const empty = document.getElementById("sync-empty")!;
  list.innerHTML = "";
  if (!r.folders.length) {
    empty.hidden = false;
    list.hidden = true;
    return;
  }
  empty.hidden = true;
  list.hidden = false;
  for (const folder of r.folders) {
    const files = _fileStates[folder.id] || {};
    const fileCount = Object.keys(files).length;
    const hasConflict = Object.values(files).some(
      (f) => f.conflict && f.conflict !== "none",
    );
    const allSynced =
      fileCount > 0 &&
      Object.values(files).every(
        (f) => f.localHash && f.driveHash && f.localHash === f.driveHash,
      );
    const sc = classifyFolderStatus(folder.status, hasConflict);
    const st = buildFolderStatusText(folder, hasConflict);
    const statusIcon = buildFolderStatusIcon(
      folder.status,
      hasConflict,
      allSynced,
      folder.lastSyncAt,
    );
    const row = document.createElement("div");
    row.className = "sync-folder-row";
    row.id = "sync-folder-" + folder.id;
    row.dataset.folderId = folder.id;
    const expandId = "sync-files-" + folder.id;
    row.innerHTML = buildFolderRowHTML({
      folder,
      hasConflict,
      allSynced,
      sc,
      st,
      statusIcon,
      fileCount,
      expandId,
    });
    const fileTree = buildFileTreeEl(files, expandId);
    list.appendChild(row);
    list.appendChild(fileTree);
  }
  // Expand/collapse handlers
  list.querySelectorAll(".sync-folder-expand").forEach(function (btn) {
    btn.addEventListener("click", function () {
      const expandId = (btn as HTMLElement).dataset.expand;
      const tree = document.getElementById(expandId!);
      if (tree) {
        const isOpen = !tree.hidden;
        tree.hidden = isOpen;
        btn.classList.toggle("expanded", !isOpen);
      }
    });
  });
  // Remove handlers
  list.querySelectorAll(".sync-folder-remove").forEach(function (btn) {
    btn.addEventListener("click", async function () {
      const id = (btn as HTMLElement).dataset.folderId!;
      const confirmed = await confirmDialog({
        title: "Remove sync folder?",
        msg: "Files on your PC and Drive will NOT be deleted. Only the sync mapping will be removed.",
        icon: "⚠️",
        okLabel: "Remove",
        okClass: "btn-danger",
      });
      if (!confirmed) return;
      const res = await api.sync.foldersRemove(id);
      if (res.ok) {
        toast("Folder removed");
        loadSyncFolders();
      } else {
        toast("Failed: " + res.error);
      }
    });
  });
  // Toggle handlers
  list.querySelectorAll(".sync-folder-toggle").forEach(function (input) {
    input.addEventListener("change", async function () {
      const el = input as HTMLInputElement;
      const folderId = (input as HTMLElement).dataset.folderId!;
      const toggleRes = await api.sync.foldersToggle(folderId, el.checked);
      if (toggleRes.ok) {
        toast(el.checked ? "Folder enabled" : "Folder disabled");
      } else {
        toast("Failed: " + toggleRes.error);
        el.checked = !el.checked;
      }
    });
  });
  // Row reordering via drag handle
  let dragSrcRow: HTMLElement | null = null;
  list.querySelectorAll(".sync-folder-drag").forEach(function (handle) {
    handle.addEventListener("dragstart", function (e) {
      const row = handle.closest(".sync-folder-row") as HTMLElement;
      dragSrcRow = row;
      row.classList.add("dragging");
      const de = e as DragEvent;
      if (de.dataTransfer) {
        de.dataTransfer.effectAllowed = "move";
        de.dataTransfer.setData("text/plain", row.dataset.folderId || "");
      }
    });
  });
  list.querySelectorAll(".sync-folder-row").forEach(function (row) {
    row.addEventListener("dragover", function (e) {
      const de = e as DragEvent;
      if (de.preventDefault) de.preventDefault();
      if (de.dataTransfer) de.dataTransfer.dropEffect = "move";
      if (dragSrcRow && dragSrcRow !== row) row.classList.add("drag-over");
    });
    row.addEventListener("dragleave", function () {
      row.classList.remove("drag-over");
    });
    row.addEventListener("drop", function (e) {
      const de = e as DragEvent;
      if (de.preventDefault) de.preventDefault();
      if (de.stopPropagation) de.stopPropagation();
      row.classList.remove("drag-over");
      if (!dragSrcRow || dragSrcRow === row) return;
      const rect = row.getBoundingClientRect();
      const listEl = row.parentElement!;
      if (de.clientY < rect.top + rect.height / 2) {
        row.before(dragSrcRow);
      } else {
        let next = row.nextSibling as HTMLElement | null;
        // Skip file-tree siblings
        if (next?.classList.contains("sync-file-tree"))
          next = next.nextSibling as HTMLElement | null;
        if (next) {
          next.before(dragSrcRow);
        } else {
          listEl.appendChild(dragSrcRow);
        }
      }
      // Also move the file-tree after its folder row
      const srcTree = document.getElementById(
        "sync-files-" + dragSrcRow.dataset.folderId,
      );
      if (srcTree) {
        dragSrcRow.nextSibling?.before(srcTree);
      }
      dragSrcRow = null;
    });
    row.addEventListener("dragend", function () {
      row.classList.remove("dragging");
      list.querySelectorAll(".sync-folder-row").forEach(function (r) {
        r.classList.remove("drag-over");
      });
      dragSrcRow = null;
    });
  });
}

function timeAgo(ts: number) {
  if (!ts) return "never";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  return Math.floor(h / 24) + "d ago";
}

function escHtml(s: string) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

async function syncNowWithDriveRetry(): Promise<any> {
  let r = await api.sync.syncNow();
  if (
    !r.ok &&
    typeof r.error === "string" &&
    r.error.includes("Drive not initialized")
  ) {
    toast("Google Drive connection needed — signing in...");
    const auth = await api.reauth();
    if (!auth.ok)
      return { ok: false, error: auth.error || "Google sign-in required" };
    if (auth.token)
      (
        (globalThis as unknown as Record<string, unknown>).__vaultToken as {
          set: (t: string) => void;
        }
      ).set(auth.token);
    if (auth.user) S.user = auth.user;
    if (auth.vault) loadVault(auth.vault);
    r = await api.sync.syncNow();
  }
  return r;
}

const _syncNowBtn = document.getElementById("btn-sync-now");
if (_syncNowBtn)
  _syncNowBtn.addEventListener("click", async function () {
    const btn = document.getElementById("btn-sync-now") as HTMLButtonElement;
    btn.style.opacity = ".5";
    btn.style.pointerEvents = "none";
    btn.textContent = "Syncing...";
    logInfo("sync", "Manual sync triggered");
    const r = await syncNowWithDriveRetry();
    btn.style.opacity = "";
    btn.style.pointerEvents = "";
    btn.innerHTML =
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><polyline points="23 20 23 14 17 14"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/></svg> Sync now';
    if (r.ok) {
      const parts: string[] = [];
      if (r.uploaded) parts.push(r.uploaded + " uploaded");
      if (r.downloaded) parts.push(r.downloaded + " downloaded");
      if (r.conflicts) parts.push(r.conflicts + " conflicts");
      if (r.errors) parts.push(r.errors + " errors");
      toast(
        parts.length
          ? "Sync complete: " + parts.join(", ")
          : "Everything up to date",
      );
      logOk("sync", "Sync complete", r);
    } else {
      toast("Sync error: " + r.error);
      logErr("sync", "Sync failed", r.error);
    }
    loadSyncFolders();
  });

const _syncAddBtn = document.getElementById("btn-sync-add");
if (_syncAddBtn)
  _syncAddBtn.addEventListener("click", async function () {
    logInfo("sync", "Add folder clicked");
    const res = await api.sync.browseFolder();
    if (!res.ok || !res.path) return;
    const defaultName = res.path.split(/[\\/]/).findLast(Boolean) ?? "Folder";
    // Use custom confirm modal with an inline input instead of window.prompt
    const driveName = await new Promise<string | null>(function (resolve) {
      const overlay = document.getElementById("confirm-overlay")!;
      const title = document.getElementById("confirm-title")!;
      const msg = document.getElementById("confirm-msg")!;
      const okBtn = document.getElementById("confirm-ok")!;
      const cancelBtn = document.getElementById("confirm-cancel")!;
      const icon = document.getElementById("confirm-icon")!;
      title.textContent = "Name on Drive";
      msg.textContent = "Choose a name for this folder on Google Drive:";
      icon.textContent = "📁";
      okBtn.textContent = "Add folder";
      okBtn.className = "btn-primary";
      const inputId = "sync-folder-name-input";
      const existing = document.getElementById(inputId);
      if (existing) existing.remove();
      const inp = document.createElement("input");
      inp.id = inputId;
      inp.className = "fi";
      inp.style.cssText =
        "width:100%;margin-top:10px;text-align:center;font-size:14px;";
      inp.value = defaultName;
      inp.placeholder = "Folder name";
      msg.appendChild(inp);
      overlay.hidden = false;
      setTimeout(function () {
        inp.focus();
        inp.select();
      }, 60);
      const cleanup = function () {
        overlay.hidden = true;
        inp.remove();
        okBtn.removeEventListener("click", onOk);
        cancelBtn.removeEventListener("click", onCancel);
        document.removeEventListener("keydown", onKey);
      };
      const onOk = function () {
        cleanup();
        resolve(inp.value.trim() || defaultName);
      };
      const onCancel = function () {
        cleanup();
        resolve(null);
      };
      const onKey = function (e: KeyboardEvent) {
        if (e.key === "Enter") onOk();
        if (e.key === "Escape") onCancel();
      };
      okBtn.addEventListener("click", onOk);
      cancelBtn.addEventListener("click", onCancel);
      document.addEventListener("keydown", onKey);
    });
    if (driveName === null) return;
    const addRes = await api.sync.foldersAdd(res.path, driveName);
    if (addRes.ok) {
      toast("Folder added — syncing...");
      api.sync.syncNow().then(function () {
        loadSyncFolders();
      });
      loadSyncFolders();
    } else {
      toast("Failed: " + addRes.error);
    }
  });

(document.getElementById("btn-add-pw") as HTMLButtonElement).addEventListener(
  "click",
  () => {
    logInfo("password", "Add password clicked");
    openPwModal();
  },
);
(document.getElementById("pw-search") as HTMLInputElement).addEventListener(
  "input",
  renderPasswords,
);

async function getLogo(site: string): Promise<string | null> {
  if (!site) return null;
  const domain = site.toLowerCase();
  if (iconCache[domain]) return iconCache[domain];
  try {
    const r = await api.logoFetch(site);
    const url = r?.ok ? (r.url ?? null) : null;
    if (url) iconCache[domain] = url;
    return url;
  } catch {
    return null;
  }
}

// HIBP breach check — k-anonymity model with proper line-by-line suffix matching.
// Cache stores parsed suffix maps (suffix → count) to avoid false-positive substring matches.
const breachCache: Record<string, Map<string, number>> = {};
async function checkBreach(
  password: string,
): Promise<{ breached: boolean; count: number }> {
  try {
    const sha1 = await crypto.subtle.digest(
      "SHA-1", // NOSONAR: SHA-1 required by HIBP k-anonymity API
      new TextEncoder().encode(password),
    );
    const hex = Array.from(new Uint8Array(sha1))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase();
    const prefix = hex.slice(0, 5),
      suffix = hex.slice(5);
    // Use cached result if available
    if (breachCache[prefix] !== undefined) {
      const count = breachCache[prefix].get(suffix) || 0;
      return { breached: count > 0, count };
    }
    // Fetch with retry for transient failures
    let text = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(
          `https://api.pwnedpasswords.com/range/${prefix}`,
          {
            headers: { "Add-Padding": "true" },
          },
        );
        if (res.ok) {
          text = await res.text();
          break;
        }
        if (res.status === 429) {
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
          continue;
        }
        console.warn(
          `[breach] HIBP returned ${res.status} for prefix ${prefix}`,
        );
        return { breached: false, count: 0 };
      } catch (e) {
        if (attempt === 2) throw e;
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    // Parse response into a Map of suffix → count.
    // Response format: each line is "SUFFIX:COUNT" where SUFFIX is 35 hex chars.
    const suffixMap = new Map<string, number>();
    for (const line of text.split("\n")) {
      const idx = line.indexOf(":");
      if (idx > 0) {
        const s = line.slice(0, idx).trim().toUpperCase();
        const count = Number.parseInt(line.slice(idx + 1).trim(), 10) || 0;
        suffixMap.set(s, count);
      }
    }
    breachCache[prefix] = suffixMap;
    const count = suffixMap.get(suffix) || 0;
    return { breached: count > 0, count };
  } catch (e) {
    console.warn("[breach] checkBreach failed:", e);
    return { breached: false, count: 0 };
  }
}

function renderPasswords(): void {
  const q = (
    document.getElementById("pw-search") as HTMLInputElement
  ).value.toLowerCase();
  const list = S.passwords.filter(
    (p) =>
      !q ||
      p.site?.toLowerCase().includes(q) ||
      p.username?.toLowerCase().includes(q),
  );
  const wrap = document.getElementById("pw-list") as HTMLElement;
  wrap.querySelectorAll(".pw-row").forEach((e) => (e as HTMLElement).remove());
  (document.getElementById("pw-empty") as HTMLElement).hidden = !!list.length;
  if (!list.length) return;

  list.forEach((pw) => {
    const row = document.createElement("div");
    row.className = "pw-row";
    const initial = (pw.site || "?")[0].toUpperCase();

    const iconId = "icon-" + pw.id;
    const iconDiv = document.createElement("div");
    iconDiv.className = "pw-icon";
    iconDiv.id = iconId;
    iconDiv.textContent = initial;
    row.appendChild(iconDiv);
    const infoDiv = document.createElement("div");
    infoDiv.className = "pw-info";
    const siteDiv = document.createElement("div");
    siteDiv.className = "pw-site";
    siteDiv.textContent = pw.site || "";
    infoDiv.appendChild(siteDiv);
    const userDiv = document.createElement("div");
    userDiv.className = "pw-user";
    userDiv.textContent = pw.username || "";
    infoDiv.appendChild(userDiv);
    if (pw.notes) {
      const noteDiv = document.createElement("div");
      noteDiv.className = "pw-note";
      noteDiv.textContent = pw.notes;
      infoDiv.appendChild(noteDiv);
    }
    row.appendChild(infoDiv);
    const pwWrap = document.createElement("div");
    pwWrap.className = "pw-pw-wrap";
    const hidSpan = document.createElement("span");
    hidSpan.className = "pw-hidden";
    hidSpan.textContent = "••••••••";
    pwWrap.appendChild(hidSpan);
    const revSpan = document.createElement("span");
    revSpan.className = "pw-real";
    revSpan.hidden = true;
    revSpan.textContent = pw.password || "";
    pwWrap.appendChild(revSpan);
    const smWrap = document.createElement("div");
    smWrap.className = "pw-inline-sm";
    smWrap.id = "psm-" + pw.id;
    smWrap.hidden = true;
    const smBars = document.createElement("div");
    smBars.className = "sm-bars sm-inline";
    for (let i = 0; i < 4; i++) {
      const b = document.createElement("div");
      b.className = "sm-bar";
      smBars.appendChild(b);
    }
    smWrap.appendChild(smBars);
    const smLbl = document.createElement("span");
    smLbl.className = "sm-lbl psm-lbl";
    smLbl.textContent = "—";
    smWrap.appendChild(smLbl);
    const breachBadge = document.createElement("span");
    breachBadge.className = "breach-badge";
    breachBadge.id = "breach-" + pw.id;
    breachBadge.hidden = true;
    breachBadge.textContent = "⚠️ breached";
    row.appendChild(breachBadge);
    pwWrap.appendChild(smWrap);
    const eyeBtn = document.createElement("button");
    eyeBtn.className = "eye-inline";
    eyeBtn.title = "Hold to show";
    eyeBtn.innerHTML =
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
    pwWrap.appendChild(eyeBtn);
    row.appendChild(pwWrap);
    const actsDiv = document.createElement("div");
    actsDiv.className = "pw-acts";
    const copyBtn = document.createElement("button");
    copyBtn.className = "icon-btn copy";
    copyBtn.title = "Copy password";
    copyBtn.innerHTML =
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    actsDiv.appendChild(copyBtn);
    const editBtn = document.createElement("button");
    editBtn.className = "icon-btn";
    editBtn.title = "Edit";
    editBtn.innerHTML =
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
    actsDiv.appendChild(editBtn);
    const delBtn = document.createElement("button");
    delBtn.className = "icon-btn del";
    delBtn.title = "Move to trash";
    delBtn.innerHTML =
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';
    actsDiv.appendChild(delBtn);
    row.appendChild(actsDiv);
    getLogo(pw.site ?? "").then((url) => {
      if (!url) return;
      const el = document.getElementById(iconId) as HTMLElement;
      if (!el) return;
      el.innerHTML = "";
      const img = document.createElement("img");
      img.width = 22;
      img.height = 22;
      img.style.borderRadius = "4px";
      img.style.objectFit = "contain";
      img.style.display = "block";
      img.src = url;
      img.addEventListener("error", () => {
        // Fallback to initial letter on error
        el.innerHTML = "";
        el.textContent = initial;
      });
      el.appendChild(img);
    });
    checkBreach(pw.password || "").then(({ breached, count }) => {
      const b = document.getElementById("breach-" + pw.id) as HTMLElement;
      if (b) {
        b.hidden = !breached;
        if (breached && count > 0) {
          b.textContent =
            count >= 100000
              ? "⚠️ breached (100k+ times)"
              : `⚠️ breached (${count.toLocaleString()} times)`;
          b.title = `This password has appeared ${count.toLocaleString()} times in known data breaches`;
        }
      }
    });
    eyeBtn.addEventListener("mousedown", () => {
      hidSpan.hidden = true;
      revSpan.hidden = false;
      smWrap.hidden = false;
      updateInlineSm(smWrap, pw.password || "");
    });
    const hideEye = (): void => {
      hidSpan.hidden = false;
      revSpan.hidden = true;
      smWrap.hidden = true;
    };
    eyeBtn.addEventListener("mouseup", hideEye);
    eyeBtn.addEventListener("mouseleave", hideEye);
    eyeBtn.addEventListener(
      "touchstart",
      (e: TouchEvent) => {
        e.preventDefault();
        hidSpan.hidden = true;
        revSpan.hidden = false;
        smWrap.hidden = false;
        updateInlineSm(smWrap, pw.password || "");
      },
      { passive: false },
    );
    eyeBtn.addEventListener("touchend", hideEye);

    copyBtn.onclick = () => {
      navigator.clipboard.writeText(pw.password || "");
      toast("Password copied! (clipboard clears in 30s)");
      logInfo("password", "Password copied to clipboard", { site: pw.site });
      scheduleClipboardClear();
    };
    editBtn.onclick = () => {
      logInfo("password", "Edit password", { site: pw.site });
      openPwModal(pw);
    };
    delBtn.onclick = () => {
      confirm({
        title: "Move to Trash?",
        msg: `"${pw.site}" will be moved to Trash and auto-deleted after 30 days.`,
        icon: "🗑️",
        okLabel: "Move to Trash",
        onOk: () => movePasswordToTrash(pw),
      });
    };
    wrap.appendChild(row);
  });
}

async function movePasswordToTrash(pw: VaultItem): Promise<void> {
  logInfo("password", "Moving to trash", {
    site: pw.site,
    dbId: pw._localId,
  });
  if (pw._localId) await api.delete(pw._localId, "password");
  S.passwords = S.passwords.filter((p) => p.id !== pw.id);
  renderPasswords();
  updateCounts();
  toast("Moved to Trash");
  logOk("password", "Moved to trash", { site: pw.site });
}

function updateInlineSm(wrap: HTMLElement, pw: string): void {
  const { n, lbl, cls } = scoreP(pw);
  wrap.querySelectorAll(".sm-bar").forEach((b, i) => {
    b.className = "sm-bar" + (i < n ? ` l${n}` : "");
  });
  const l = wrap.querySelector(".psm-lbl");
  if (l) {
    l.textContent = lbl;
    l.className = "sm-lbl psm-lbl " + cls;
  }
}

let _pwEx: VaultItem | null = null;
function openPwModal(existing: VaultItem | null = null): void {
  _pwEx = existing;
  logInfo(
    "password",
    existing ? "Opening edit password modal" : "Opening add password modal",
    { site: existing?.site },
  );
  (document.getElementById("modal-title") as HTMLElement).textContent = existing
    ? "Edit password"
    : "Add password";
  (document.getElementById("f-site") as HTMLInputElement).value =
    existing?.site || "";
  (document.getElementById("f-user") as HTMLInputElement).value =
    existing?.username || "";
  (document.getElementById("f-pw") as HTMLInputElement).value =
    existing?.password || "";
  (document.getElementById("f-pw") as HTMLInputElement).type = "password";
  (document.getElementById("f-notes") as HTMLTextAreaElement).value =
    existing?.notes || "";
  updateSm("sm", existing?.password || "");
  const pwInp = document.getElementById("f-pw") as HTMLInputElement;
  const newInp = pwInp.cloneNode(true) as HTMLInputElement;
  pwInp.parentNode!.replaceChild(newInp, pwInp);
  newInp.value = existing?.password || "";
  newInp.type = "password";
  newInp.addEventListener("input", () => updateSm("sm", newInp.value));
  showOverlay("modal-overlay");
  setTimeout(
    () => (document.getElementById("f-site") as HTMLInputElement).focus(),
    60,
  );
}
(document.getElementById("eye-btn") as HTMLButtonElement).addEventListener(
  "click",
  () => {
    const f = document.getElementById("f-pw") as HTMLInputElement;
    f.type = f.type === "password" ? "text" : "password";
  },
);
(document.getElementById("use-gen-btn") as HTMLButtonElement).addEventListener(
  "click",
  () => openGen(true),
);
(document.getElementById("modal-ok") as HTMLButtonElement).addEventListener(
  "click",
  async () => {
    const site = (
      document.getElementById("f-site") as HTMLInputElement
    ).value.trim();
    const username = (
      document.getElementById("f-user") as HTMLInputElement
    ).value.trim();
    const password = (document.getElementById("f-pw") as HTMLInputElement)
      .value;
    const notes = (
      document.getElementById("f-notes") as HTMLTextAreaElement
    ).value.trim();
    if (!site || !password) {
      toast("Site and password required");
      return;
    }
    const existing = _pwEx;
    hideOverlay("modal-overlay");
    if (existing) {
      Object.assign(existing, { site, username, password, notes });
      const r = await api.save("password", existing);
      if (r.ok && !existing._localId) existing._localId = r.id;
      toast("Updated");
      logOk("password", "Password updated", { site });
    } else {
      const item: VaultItem = { id: uid(), site, username, password, notes };
      const r = await api.save("password", item);
      if (r.ok) item._localId = r.id;
      S.passwords.unshift(item);
      toast("Saved");
      logOk("password", "Password created", { site });
    }
    renderPasswords();
    updateCounts();
  },
);
(document.getElementById("modal-cancel") as HTMLButtonElement).addEventListener(
  "click",
  () => hideOverlay("modal-overlay"),
);
(document.getElementById("modal-overlay") as HTMLElement).addEventListener(
  "click",
  (e: MouseEvent) => {
    if (e.target === (document.getElementById("modal-overlay") as HTMLElement))
      hideOverlay("modal-overlay");
  },
);

// ═══ NOTES with drag reorder (vertical only) ═══════════════════════════════
(document.getElementById("btn-add-note") as HTMLButtonElement).addEventListener(
  "click",
  async () => {
    logInfo("note", "New note created");
    const note: VaultItem = { id: uid(), title: "Untitled", body: "" };
    const r = await api.save("note", note);
    if (r.ok) note._localId = r.id;
    S.notes.unshift(note);
    renderNotesList();
    updateCounts();
    openNote(note.id as string);
  },
);

function renderNotesList(): void {
  const wrap = document.getElementById("notes-list") as HTMLElement;
  wrap
    .querySelectorAll(".note-chip")
    .forEach((e) => (e as HTMLElement).remove());
  (document.getElementById("notes-empty") as HTMLElement).hidden =
    !!S.notes.length;
  if (!S.notes.length) return;
  S.notes.forEach((n) => {
    const el = document.createElement("div");
    el.className =
      "note-chip draggable" + (String(n.id) === S.activeNote ? " active" : "");
    el.draggable = true;
    el.dataset.id = String(n.id);
    const dragHandle = document.createElement("span");
    dragHandle.className = "drag-handle";
    dragHandle.textContent = "⠿";
    el.appendChild(dragHandle);
    const chipBody = document.createElement("div");
    chipBody.className = "note-chip-body";
    const ncTitle = document.createElement("div");
    ncTitle.className = "nc-title";
    ncTitle.textContent = n.title || "Untitled";
    chipBody.appendChild(ncTitle);
    const ncPrev = document.createElement("div");
    ncPrev.className = "nc-prev";
    ncPrev.textContent = n.body?.slice(0, 55) || "Empty";
    chipBody.appendChild(ncPrev);
    chipBody.onclick = () => openNote(String(n.id));
    el.appendChild(chipBody);
    addVerticalDrag(el, "notes-list", () => api.reorder("note", S.notes));
    wrap.appendChild(el);
  });
}

function openNote(id: string): void {
  S.activeNote = id;
  const note = S.notes.find((n) => String(n.id) === id) as
    | VaultItem
    | undefined;
  if (!note) return;
  logInfo("note", "Note opened", { noteId: id, title: note.title });
  renderNotesList();
  const editor = document.getElementById("note-editor") as HTMLElement;
  editor.innerHTML = "";
  const toolbar = document.createElement("div");
  toolbar.className = "note-toolbar";
  const titleInp = document.createElement("input");
  titleInp.className = "note-title-inp";
  titleInp.id = "n-title";
  titleInp.value = note.title || "";
  titleInp.placeholder = "Title";
  toolbar.appendChild(titleInp);
  const nDel = document.createElement("button");
  nDel.className = "icon-btn del";
  nDel.id = "n-del";
  nDel.innerHTML =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';
  toolbar.appendChild(nDel);
  editor.appendChild(toolbar);
  const bodyArea = document.createElement("textarea");
  bodyArea.className = "note-body";
  bodyArea.id = "n-body";
  bodyArea.placeholder = "Start writing…";
  bodyArea.value = note.body || "";
  editor.appendChild(bodyArea);
  const noteFoot = document.createElement("div");
  noteFoot.className = "note-foot";
  const wcSpan = document.createElement("span");
  wcSpan.id = "n-wc";
  wcSpan.textContent = wc(note.body) + " words";
  noteFoot.appendChild(wcSpan);
  const statusSpan = document.createElement("span");
  statusSpan.id = "n-status";
  statusSpan.textContent = "Saved";
  noteFoot.appendChild(statusSpan);
  editor.appendChild(noteFoot);
  let st: ReturnType<typeof setTimeout> | undefined;
  const autoSave = async (): Promise<void> => {
    note.title = (document.getElementById("n-title") as HTMLInputElement).value;
    note.body = (
      document.getElementById("n-body") as HTMLTextAreaElement
    ).value;
    (document.getElementById("n-wc") as HTMLElement).textContent =
      wc(note.body) + " words";
    renderNotesList();
    (document.getElementById("n-status") as HTMLElement).textContent =
      "Saving…";
    const r = await api.save("note", note);
    if (r.ok && !note._localId) note._localId = r.id;
    const s = document.getElementById("n-status") as HTMLElement;
    if (s) s.textContent = "Saved";
    logOk("note", "Note auto-saved", { noteId: id, title: note.title });
  };
  (document.getElementById("n-title") as HTMLInputElement).addEventListener(
    "input",
    () => {
      clearTimeout(st);
      st = setTimeout(autoSave, 700);
    },
  );
  (document.getElementById("n-body") as HTMLTextAreaElement).addEventListener(
    "input",
    () => {
      clearTimeout(st);
      st = setTimeout(autoSave, 700);
    },
  );
  (document.getElementById("n-del") as HTMLButtonElement).addEventListener(
    "click",
    () =>
      confirm({
        title: "Move to Trash?",
        msg: `"${note.title || "Untitled"}" will be moved to Trash.`,
        icon: "🗑️",
        okLabel: "Move to Trash",
        onOk: async () => {
          logInfo("note", "Note moved to trash", {
            noteId: id,
            title: note.title,
          });
          if (note._localId) await api.delete(note._localId, "note");
          S.notes = S.notes.filter((n) => n.id !== id);
          S.activeNote = null;
          renderNotesList();
          updateCounts();
          (document.getElementById("note-editor") as HTMLElement).innerHTML =
            '<p class="note-placeholder">Select or create a note</p>';
          toast("Moved to Trash");
        },
      }),
  );
}

// ═══ VERTICAL-ONLY DRAG ═══════════════════════════════════════════════════════
let dragSrc: HTMLElement | null = null;
function addVerticalDrag(
  el: HTMLElement,
  listId: string,
  onReorder: () => void,
): void {
  el.addEventListener("dragstart", (e: DragEvent) => {
    dragSrc = el;
    e.dataTransfer!.effectAllowed = "move";
    e.dataTransfer!.setData("text/plain", "");
    setTimeout(() => el.classList.add("dragging"), 0);
  });
  el.addEventListener("dragend", () => {
    el.classList.remove("dragging");
    dragSrc = null;
  });
  el.addEventListener("dragover", (e: DragEvent) => {
    e.preventDefault();
    e.dataTransfer!.dropEffect = "move";
    if (dragSrc && dragSrc !== el) {
      const wrap = document.getElementById(listId)!;
      const items = [...wrap.querySelectorAll(".draggable")] as HTMLElement[];
      const srcIdx = items.indexOf(dragSrc),
        tgtIdx = items.indexOf(el);
      if (srcIdx < tgtIdx) el.after(dragSrc);
      else el.before(dragSrc);
    }
  });
  el.addEventListener("drop", (e: DragEvent) => {
    e.preventDefault();
    const wrap = document.getElementById(listId)!;
    const newOrder = [...wrap.querySelectorAll(".draggable")].map(
      (e) => (e as HTMLElement).dataset.id,
    );
    S.notes = newOrder
      .map((id) => S.notes.find((n) => n.id === id))
      .filter(Boolean) as VaultItem[];
    onReorder();
  });
}

// ═══ TRASH ════════════════════════════════════════════════════════════════════
async function restoreTrashItem(
  isJob: boolean,
  jobItem: Job,
  vaultItem: VaultItem,
  item: { _type: string },
  label: string,
): Promise<void> {
  let ok = false;
  if (isJob) {
    const res = await api.jobsTrash.restore(jobItem.id!);
    ok = res.ok;
  } else {
    const res = await api.trashRestore(vaultItem._localId!, item._type);
    ok = res.ok;
  }
  if (!ok) {
    toast("Restore failed");
    logErr("trash", "Restore failed", { label });
    return;
  }
  const itemDbId = (item as unknown as VaultItem)._localId;
  S.trash = S.trash.filter(
    (t) => (t as unknown as VaultItem)._localId !== itemDbId,
  );
  loadAndRenderTrash();
  updateCounts();
  toast("Restored ✓");
  logOk("trash", "Item restored", { label });
}

async function purgeTrashItem(
  isJob: boolean,
  jobItem: Job,
  vaultItem: VaultItem,
  item: { _type: string },
  row: HTMLElement,
  label: string,
): Promise<void> {
  logInfo("trash", "Permanently deleting", { label });
  if (isJob) await api.jobsTrash.purge(jobItem.id!);
  else await api.trashPurge(vaultItem._localId!, item._type);
  S.trash = S.trash.filter((t) => {
    const tId =
      t._type === "job"
        ? (t as unknown as Job).id
        : (t as unknown as VaultItem)._localId;
    const itemId = isJob ? jobItem.id : vaultItem._localId;
    return tId !== itemId;
  });
  row.remove();
  if (!S.trash.length)
    (document.getElementById("trash-empty") as HTMLElement).hidden = false;
  updateCounts();
  toast("Permanently deleted");
  logOk("trash", "Item purged", { label });
}

async function loadAndRenderTrash(): Promise<void> {
  logInfo("trash", "Loading trash");
  const wrap = document.getElementById("trash-list") as HTMLElement;
  wrap
    .querySelectorAll(".trash-row")
    .forEach((e) => (e as HTMLElement).remove());
  (wrap.querySelector(".trash-loading") as HTMLElement)?.remove();
  const loading = document.createElement("div");
  loading.className = "empty trash-loading";
  loading.innerHTML = '<p style="color:var(--muted)">Loading…</p>';
  wrap.appendChild(loading);

  const [r1, r2] = await Promise.all([api.trashLoad(), api.jobsTrash.load()]);
  loading.remove();
  if (!r1.ok) {
    logErr("trash", "Failed to load vault trash", r1.error);
    toast("Failed to load some trash items");
  }
  if (!r2.ok) {
    logErr("trash", "Failed to load job trash", r2.error);
    toast("Failed to load job trash");
  }
  const vaultItems: (VaultItem & { _type: string; _deletedAt: string })[] =
    r1.ok
      ? (r1.items as (VaultItem & { _type: string; _deletedAt: string })[])
      : [];
  const jobItems: (Job & { _type: string; _deletedAt: string })[] = (
    r2.ok ? r2.items : []
  ).map((j: Job) => ({
    ...j,
    _type: "job",
    _localId: j.id,
    _deletedAt: j.deleted_at!,
  }));
  S.trash = [...vaultItems, ...jobItems].sort(
    (a, b) =>
      new Date(b._deletedAt).getTime() - new Date(a._deletedAt).getTime(),
  );
  updateCounts();
  (document.getElementById("trash-empty") as HTMLElement).hidden =
    !!S.trash.length;
  logOk("trash", "Trash loaded", { count: S.trash.length });
  if (!S.trash.length) return;

  S.trash.forEach((item) => {
    const isNote = item._type === "note";
    const isJob = item._type === "job";
    const jobItem = item as unknown as Job;
    const vaultItem = item as unknown as VaultItem;
    let label: string;
    if (isNote) {
      label = vaultItem.title || "Untitled note";
    } else if (isJob) {
      label = jobItem.company || "Unknown company";
    } else {
      label = vaultItem.site || "Unknown site";
    }
    let sub: string;
    if (isNote) {
      sub = vaultItem.body?.slice(0, 40) || "";
    } else if (isJob) {
      sub = jobItem.role || "";
    } else {
      sub = vaultItem.username || "";
    }
    const d = days(item._deletedAt);
    // Resolve the row icon via a lookup to avoid a nested ternary.
    const trashIcons = { note: "📝", job: "💼", password: "🔑" } as const;
    const icon =
      trashIcons[(item._type as keyof typeof trashIcons) || "password"] || "🔑";
    const row = document.createElement("div");
    row.className = "trash-row";
    const trashIcon = document.createElement("div");
    trashIcon.className = "trash-icon";
    trashIcon.textContent = icon;
    row.appendChild(trashIcon);
    const pwInfo = document.createElement("div");
    pwInfo.className = "pw-info";
    const pwSite = document.createElement("div");
    pwSite.className = "pw-site";
    pwSite.textContent = label;
    pwInfo.appendChild(pwSite);
    const pwUser = document.createElement("div");
    pwUser.className = "pw-user";
    pwUser.textContent = sub;
    pwInfo.appendChild(pwUser);
    row.appendChild(pwInfo);
    const trashDays = document.createElement("div");
    trashDays.className = "trash-days";
    trashDays.textContent = d + "d left";
    row.appendChild(trashDays);
    const pwActs = document.createElement("div");
    pwActs.className = "pw-acts";
    const restBtn = document.createElement("button");
    restBtn.className = "icon-btn restore";
    restBtn.title = "Restore";
    restBtn.innerHTML =
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4"/></svg>';
    pwActs.appendChild(restBtn);
    const delBtn = document.createElement("button");
    delBtn.className = "icon-btn del";
    delBtn.title = "Delete forever";
    delBtn.innerHTML =
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    pwActs.appendChild(delBtn);
    row.appendChild(pwActs);
    restBtn.onclick = () => {
      confirm({
        title: "Restore?",
        msg: `"${label}" will be restored.`,
        icon: "↩️",
        okLabel: "Restore",
        okClass: "btn-primary",
        onOk: () => restoreTrashItem(isJob, jobItem, vaultItem, item, label),
      });
    };
    delBtn.onclick = () => {
      confirm({
        title: "Delete permanently?",
        msg: `"${label}" will be gone forever.`,
        icon: "⚠️",
        okLabel: "Delete forever",
        onOk: () => purgeTrashItem(isJob, jobItem, vaultItem, item, row, label),
      });
    };
    wrap.appendChild(row);
  });
}
(
  document.getElementById("btn-empty-trash") as HTMLButtonElement
).addEventListener("click", () => {
  if (!S.trash.length) {
    toast("Trash is already empty");
    return;
  }
  logInfo("trash", "Empty trash clicked", { count: S.trash.length });
  confirm({
    title: "Empty Trash?",
    msg: `All ${S.trash.length} item(s) will be permanently deleted.`,
    icon: "⚠️",
    okLabel: "Empty Trash",
    onOk: () => emptyTrash(),
  });
});

async function emptyTrash(): Promise<void> {
  const vaultItems = S.trash.filter((t) => t._type !== "job");
  const jobItems = S.trash.filter((t) => t._type === "job");
  await Promise.all([
    ...vaultItems.map((t) =>
      api.trashPurge((t as unknown as VaultItem)._localId!, t._type),
    ),
    ...jobItems.map((t) => api.jobsTrash.purge((t as unknown as Job).id!)),
  ]);
  S.trash = [];
  loadAndRenderTrash();
  updateCounts();
  toast("Trash emptied");
  logOk("trash", "Trash emptied");
}

// ═══ JOBS — inline edit, sort, search, filter ═════════════════════════════════
let _jobEdit: Job | null = null;
async function loadAndRenderJobs(): Promise<void> {
  logInfo("jobs", "Loading jobs");
  const r = await api.jobsLoad();
  if (!r.ok) {
    logErr("jobs", "Failed to load jobs", r.error);
    return;
  }
  S.jobs = r.jobs;
  renderJobsTable();
  updateCounts();
  logOk("jobs", "Jobs loaded", { count: S.jobs.length });
}

function getFilteredJobs(): Job[] {
  const q =
    (
      document.getElementById("jobs-search") as HTMLInputElement
    )?.value.toLowerCase() || "";
  let list = S.jobs.filter((j) => {
    if (S.jobFilter !== "all" && j.status !== S.jobFilter) return false;
    if (!q) return true;
    return [j.company, j.role, j.email, j.notes, j.applied_at, j.status].some(
      (v) => (v || "").toLowerCase().includes(q),
    );
  });
  if (S.jobSort.col) {
    list = [...list].sort((a, b) => {
      const va = (a[S.jobSort.col as keyof Job] || "").toString().toLowerCase();
      const vb = (b[S.jobSort.col as keyof Job] || "").toString().toLowerCase();
      if (va < vb) return -S.jobSort.dir;
      if (va > vb) return S.jobSort.dir;
      return 0;
    });
  }
  return list;
}

let _statusPopupJob: Job | null = null;
const popup = document.getElementById("status-popup") as HTMLDivElement;
document.querySelectorAll(".status-pop-opt").forEach((btn) => {
  btn.addEventListener("click", async () => {
    if (!_statusPopupJob) return;
    const newStatus = (btn as HTMLElement).dataset.val as Job["status"];
    logInfo("jobs", "Status changed", {
      jobId: _statusPopupJob.id,
      company: _statusPopupJob.company,
      from: _statusPopupJob.status,
      to: newStatus,
    });
    _statusPopupJob.status = newStatus;
    hide("status-popup");
    const r = await api.jobsSave({ job: _statusPopupJob });
    if (!r.ok) {
      toast("Save failed");
      logErr("jobs", "Status save failed", r.error);
    }
    renderJobsTable();
  });
});
document.addEventListener("click", (e: MouseEvent) => {
  if (
    !(e.target as HTMLElement).closest("#status-popup") &&
    !(e.target as HTMLElement).closest(".job-status-cell")
  )
    hide("status-popup");
});

function buildJobRow(
  job: Job,
  stMap: Record<string, { cls: string; label: string }>,
): HTMLTableRowElement {
  const tr = document.createElement("tr");
  tr.className = "draggable";
  tr.draggable = true;
  tr.dataset.id = String(job.id);
  const st = stMap[job.status] || stMap.wait;

  const dragTd = document.createElement("td");
  dragTd.className = "drag-handle-cell";
  dragTd.textContent = "⠿";
  tr.appendChild(dragTd);
  const companyTd = document.createElement("td");
  companyTd.className = "editable-cell";
  companyTd.dataset.field = "company";
  const companyStrong = document.createElement("strong");
  companyStrong.textContent = job.company || "";
  companyTd.appendChild(companyStrong);
  tr.appendChild(companyTd);
  const roleTd = document.createElement("td");
  roleTd.className = "editable-cell";
  roleTd.dataset.field = "role";
  roleTd.textContent = job.role || "";
  tr.appendChild(roleTd);
  const emailTd = document.createElement("td");
  const emailWrap = document.createElement("div");
  emailWrap.style.cssText = "display:flex;align-items:center;gap:5px";
  const emailLink = document.createElement("a");
  emailLink.className = "job-email";
  emailLink.href = "mailto:" + encodeURIComponent(job.email || "");
  emailLink.textContent = job.email || "";
  emailWrap.appendChild(emailLink);
  const copyEmailBtn = document.createElement("button");
  copyEmailBtn.className = "icon-btn copy copy-email-btn";
  copyEmailBtn.title = "Copy email";
  copyEmailBtn.style.cssText = "width:22px;height:22px;flex-shrink:0";
  copyEmailBtn.innerHTML =
    '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  emailWrap.appendChild(copyEmailBtn);
  emailTd.appendChild(emailWrap);
  tr.appendChild(emailTd);
  const dateTd = document.createElement("td");
  dateTd.className = "editable-cell";
  dateTd.dataset.field = "applied_at";
  dateTd.textContent = job.applied_at || "—";
  tr.appendChild(dateTd);
  const statusTd = document.createElement("td");
  statusTd.className = "job-status-cell";
  const statusSpan = document.createElement("span");
  statusSpan.className = "job-status " + st.cls;
  statusSpan.textContent = st.label;
  statusTd.appendChild(statusSpan);
  tr.appendChild(statusTd);
  const delTd = document.createElement("td");
  const delJobBtn = document.createElement("button");
  delJobBtn.className = "icon-btn del del-job-btn";
  delJobBtn.title = "Delete";
  delJobBtn.innerHTML =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>';
  delTd.appendChild(delJobBtn);
  tr.appendChild(delTd);
  return tr;
}

function renderJobsTable(): void {
  const tbody = document.getElementById("jobs-body") as HTMLTableSectionElement;
  tbody
    .querySelectorAll("tr:not(#jobs-empty-row)")
    .forEach((e) => (e as HTMLElement).remove());
  const list = getFilteredJobs();
  (document.getElementById("jobs-empty-row") as HTMLElement).hidden =
    !!list.length;
  if (!S.jobs.length) return;

  const acc = S.jobs.filter((j) => j.status === "accepted").length;
  const wait = S.jobs.filter((j) => j.status === "wait").length;
  const rej = S.jobs.filter((j) => j.status === "rejected").length;
  const jobsStats = document.getElementById("jobs-stats") as HTMLElement;
  jobsStats.innerHTML = "";
  const mkStat = (cls: string, num: number, lbl: string): HTMLElement => {
    const d = document.createElement("div");
    d.className = "job-stat " + cls;
    const s = document.createElement("span");
    s.textContent = String(num);
    d.appendChild(s);
    const l = document.createElement("small");
    l.textContent = lbl;
    d.appendChild(l);
    return d;
  };
  jobsStats.appendChild(mkStat("accepted", acc, "Accepted"));
  jobsStats.appendChild(mkStat("wait", wait, "Waiting"));
  jobsStats.appendChild(mkStat("rejected", rej, "Rejected"));
  jobsStats.appendChild(mkStat("total", S.jobs.length, "Total"));

  const stMap: Record<string, { cls: string; label: string }> = {
    accepted: { cls: "status-accepted", label: "✅ Accepted" },
    wait: { cls: "status-wait", label: "⏳ Waiting" },
    rejected: { cls: "status-rejected", label: "❌ Rejected" },
  };

  list.forEach((job) => {
    const tr = buildJobRow(job, stMap);
    bindJobRow(tr, job, popup, tbody);
    tbody.appendChild(tr);
  });
}

async function saveInlineJobEdit(
  job: Job,
  field: keyof Job,
  inp: HTMLInputElement,
): Promise<void> {
  const val = inp.value.trim();
  (job as unknown as Record<string, unknown>)[field] = val;
  await api.jobsSave({
    job: job as unknown as Record<string, unknown>,
  });
  renderJobsTable();
}

function cancelInlineEdit(
  td: HTMLElement,
  field: keyof Job,
  job: Job,
  current: unknown,
): void {
  td.innerHTML = "";
  if (field === "company") {
    const s = document.createElement("strong");
    s.textContent = job.company || "";
    td.appendChild(s);
  } else {
    td.textContent = String(current);
  }
}

function bindInlineEdit(td: HTMLElement, job: Job): void {
  td.addEventListener("dblclick", () => {
    const field = (td as HTMLElement).dataset.field as keyof Job;
    const current = job[field] || "";
    logInfo("jobs", "Inline edit started", {
      jobId: job.id,
      field,
      company: job.company,
    });
    const inp = document.createElement("input");
    inp.type = field === "applied_at" ? "date" : "text";
    inp.value = String(current);
    inp.className = "inline-cell-input";
    td.innerHTML = "";
    td.appendChild(inp);
    inp.focus();
    inp.select();
    const save = () => saveInlineJobEdit(job, field, inp);
    inp.addEventListener("blur", save);
    inp.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") inp.blur();
      if (e.key === "Escape") cancelInlineEdit(td, field, job, current);
    });
  });
}

function bindJobRow(
  tr: HTMLElement,
  job: Job,
  popup: HTMLElement,
  tbody: HTMLElement,
): void {
  (tr.querySelector(".copy-email-btn") as HTMLButtonElement).onclick = (
    e: MouseEvent,
  ) => {
    e.stopPropagation();
    navigator.clipboard.writeText(job.email || "");
    toast("Email copied!");
    logInfo("jobs", "Email copied", { company: job.company });
  };

  tr.querySelectorAll(".editable-cell").forEach((td) => {
    bindInlineEdit(td as HTMLElement, job);
  });

  (tr.querySelector(".job-status-cell") as HTMLElement).addEventListener(
    "click",
    (e: MouseEvent) => {
      e.stopPropagation();
      _statusPopupJob = job;
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      popup.style.top = rect.bottom + 4 + "px";
      popup.style.left = rect.left + "px";
      show("status-popup");
    },
  );

  (tr.querySelector(".del-job-btn") as HTMLButtonElement).onclick = () => {
    confirm({
      title: "Move to Trash?",
      msg: `"${job.company}" will be moved to Trash.`,
      icon: "🗑️",
      okLabel: "Move to Trash",
      onOk: () => moveJobToTrash(job),
    });
  };

  tr.addEventListener("dragstart", (e: DragEvent) => {
    dragSrc = tr;
    tr.classList.add("dragging");
    e.dataTransfer!.effectAllowed = "move";
    e.dataTransfer!.setData("text/plain", "");
  });
  tr.addEventListener("dragend", () => {
    tr.classList.remove("dragging");
    dragSrc = null;
  });
  tr.addEventListener("dragover", (e: DragEvent) => {
    e.preventDefault();
    e.dataTransfer!.dropEffect = "move";
    if (dragSrc && dragSrc !== tr && dragSrc.tagName === "TR") {
      const rows = [...tbody.querySelectorAll("tr.draggable")] as HTMLElement[];
      const si = rows.indexOf(dragSrc),
        ti = rows.indexOf(tr);
      if (si < ti) tr.after(dragSrc);
      else tr.before(dragSrc);
    }
  });
  tr.addEventListener("drop", (e: DragEvent) => {
    e.preventDefault();
    const newOrder = [...tbody.querySelectorAll("tr.draggable")].map(
      (r) => (r as HTMLElement).dataset.id,
    );
    S.jobs = newOrder
      .map((id) => S.jobs.find((j) => String(j.id) === id))
      .filter(Boolean) as Job[];
    api.jobsReorder(S.jobs);
  });
}

async function moveJobToTrash(job: Job): Promise<void> {
  logInfo("jobs", "Job moved to trash", {
    jobId: job.id,
    company: job.company,
  });
  const res = await api.jobsDelete(job.id!);
  if (!res.ok) {
    toast("Delete failed");
    logErr("jobs", "Delete failed", { jobId: job.id });
    return;
  }
  S.jobs = S.jobs.filter((j) => j.id !== job.id);
  renderJobsTable();
  updateCounts();
  toast("Moved to Trash");
}

function openJobModal(existing: Job | null = null): void {
  _jobEdit = existing;
  logInfo("jobs", existing ? "Edit job modal opened" : "Add job modal opened", {
    company: existing?.company,
  });
  (document.getElementById("job-modal-title") as HTMLElement).textContent =
    existing ? "Edit application" : "Add application";
  (document.getElementById("j-company") as HTMLInputElement).value =
    existing?.company || "";
  (document.getElementById("j-role") as HTMLInputElement).value =
    existing?.role || "";
  (document.getElementById("j-email") as HTMLInputElement).value =
    existing?.email || "";
  (document.getElementById("j-date") as HTMLInputElement).value =
    existing?.applied_at || new Date().toISOString().slice(0, 10);
  (document.getElementById("j-notes") as HTMLTextAreaElement).value =
    existing?.notes || "";
  const status = existing?.status || "wait";
  document.querySelectorAll(".status-pick").forEach((b) => {
    (b as HTMLElement).classList.toggle(
      "active",
      (b as HTMLElement).dataset.val === status,
    );
  });
  showOverlay("job-overlay");
  setTimeout(
    () => (document.getElementById("j-company") as HTMLInputElement).focus(),
    60,
  );
}
document.querySelectorAll(".status-pick").forEach((btn) => {
  btn.addEventListener("click", () => {
    document
      .querySelectorAll(".status-pick")
      .forEach((b) => (b as HTMLElement).classList.remove("active"));
    (btn as HTMLElement).classList.add("active");
  });
});
(document.getElementById("btn-add-job") as HTMLButtonElement).addEventListener(
  "click",
  () => openJobModal(),
);
(document.getElementById("job-ok") as HTMLButtonElement).addEventListener(
  "click",
  async () => {
    const company = (
      document.getElementById("j-company") as HTMLInputElement
    ).value.trim();
    const role = (
      document.getElementById("j-role") as HTMLInputElement
    ).value.trim();
    if (!company) {
      toast("Company name required");
      return;
    }
    const status = ((
      document.querySelector(".status-pick.active") as HTMLElement
    )?.dataset.val || "wait") as Job["status"];
    const job: Job = {
      id: _jobEdit?.id,
      company,
      role,
      email: (
        document.getElementById("j-email") as HTMLInputElement
      ).value.trim(),
      applied_at: (document.getElementById("j-date") as HTMLInputElement).value,
      notes: (
        document.getElementById("j-notes") as HTMLTextAreaElement
      ).value.trim(),
      status,
    };
    hideOverlay("job-overlay");
    const r = await api.jobsSave(job as unknown as Record<string, unknown>);
    if (r.ok) {
      if (_jobEdit) Object.assign(_jobEdit, job);
      else {
        job.id = r.id;
        S.jobs.unshift(job);
      }
      renderJobsTable();
      updateCounts();
      toast(_jobEdit ? "Updated" : "Saved");
      logOk("jobs", _jobEdit ? "Job updated" : "Job created", {
        company,
        status,
      });
    } else {
      toast("Save failed: " + r.error);
      logErr("jobs", "Job save failed", { company, error: r.error });
    }
  },
);
(document.getElementById("job-cancel") as HTMLButtonElement).addEventListener(
  "click",
  () => hideOverlay("job-overlay"),
);
(document.getElementById("job-overlay") as HTMLElement).addEventListener(
  "click",
  (e: MouseEvent) => {
    if (e.target === (document.getElementById("job-overlay") as HTMLElement))
      hideOverlay("job-overlay");
  },
);

// ═══ TOTP VAULT ════════════════════════════════════════════════════════════════
let totpTimers: Array<ReturnType<typeof setInterval>> = [];
async function loadAndRenderTotp(): Promise<void> {
  logInfo("totp", "Loading TOTP accounts");
  totpTimers.forEach((t) => clearInterval(t));
  totpTimers = [];
  const r = await api.totpLoad();
  if (!r.ok) {
    toast("Could not load accounts");
    logErr("totp", "Failed to load", r.error);
    return;
  }
  S.totp = r.items;
  renderTotpGrid();
  updateCounts();
  logOk("totp", "TOTP accounts loaded", { count: S.totp.length });
}
function buildTotpCard(item: TotpItem): HTMLDivElement {
  const card = document.createElement("div");
  card.className = "totp-card";
  const codeId = "totp-code-" + item.id;
  const progId = "totp-prog-" + item.id;
  const header = document.createElement("div");
  header.className = "totp-header";
  const totpIcon = document.createElement("span");
  totpIcon.className = "totp-icon";
  totpIcon.textContent = item.icon || "🔐";
  header.appendChild(totpIcon);
  const totpInfo = document.createElement("div");
  totpInfo.className = "totp-info";
  const totpName = document.createElement("div");
  totpName.className = "totp-name";
  totpName.textContent = item.name || "";
  totpInfo.appendChild(totpName);
  const totpIssuer = document.createElement("div");
  totpIssuer.className = "totp-issuer";
  totpIssuer.textContent = item.issuer || "";
  totpInfo.appendChild(totpIssuer);
  header.appendChild(totpInfo);
  const totpDel = document.createElement("button");
  totpDel.className = "icon-btn del totp-del";
  totpDel.title = "Remove";
  totpDel.innerHTML =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  header.appendChild(totpDel);
  card.appendChild(header);
  const totpCode = document.createElement("div");
  totpCode.className = "totp-code";
  totpCode.id = codeId;
  totpCode.textContent = "——";
  card.appendChild(totpCode);
  const totpFoot = document.createElement("div");
  totpFoot.className = "totp-foot";
  const barWrap = document.createElement("div");
  barWrap.className = "totp-bar-wrap";
  const bar = document.createElement("div");
  bar.className = "totp-bar";
  bar.id = progId;
  barWrap.appendChild(bar);
  totpFoot.appendChild(barWrap);
  const totpCopy = document.createElement("button");
  totpCopy.className = "icon-btn copy totp-copy";
  totpCopy.title = "Copy";
  totpCopy.innerHTML =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  totpFoot.appendChild(totpCopy);
  card.appendChild(totpFoot);
  (card.querySelector(".totp-del") as HTMLButtonElement).onclick = () => {
    confirm({
      title: "Remove account?",
      msg: `"${item.name}" will be removed.`,
      icon: "🗑️",
      okLabel: "Remove",
      onOk: () => deleteTotpItem(item),
    });
  };
  (card.querySelector(".totp-copy") as HTMLButtonElement).onclick = () => {
    const code = (
      document.getElementById(codeId) as HTMLElement
    ).textContent!.replace(/\s/g, "");
    if (code && code !== "——") {
      navigator.clipboard.writeText(code);
      toast("Code copied! (clipboard clears in 30s)");
      logInfo("totp", "TOTP code copied", { name: item.name });
      setTimeout(() => {
        navigator.clipboard.writeText("").catch(() => {});
        logInfo("app", "Clipboard auto-cleared");
      }, 30000);
    }
  };
  return card;
}

function renderTotpGrid(): void {
  const grid = document.getElementById("totp-grid") as HTMLElement;
  grid
    .querySelectorAll(".totp-card")
    .forEach((e) => (e as HTMLElement).remove());
  (document.getElementById("totp-empty") as HTMLElement).hidden =
    !!S.totp.length;
  if (!S.totp.length) return;
  S.totp.forEach((item) => {
    const card = buildTotpCard(item);
    grid.appendChild(card);
    const progId = "totp-prog-" + item.id;
    const updateCode = (): void => {
      const epoch = Math.floor(Date.now() / 1000);
      const remaining = (30 - (epoch % 30)) / 30;
      const prog = document.getElementById(progId) as HTMLElement;
      if (prog) prog.style.width = remaining * 100 + "%";
      computeTotpAsync(item.secret, item.id);
    };
    updateCode();
    totpTimers.push(setInterval(updateCode, 1000));
  });
}
async function deleteTotpItem(item: TotpItem): Promise<void> {
  logInfo("totp", "TOTP account removed", { name: item.name });
  await api.totpDelete(item.id!);
  S.totp = S.totp.filter((t) => t.id !== item.id);
  renderTotpGrid();
  updateCounts();
  toast("Removed");
}

function base32Decode(b32: string): Uint8Array {
  const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "",
    res: number[] = [];
  for (const c of b32.toUpperCase().replace(/=+$/, "")) {
    const v = alpha.indexOf(c);
    if (v === -1) continue;
    bits += v.toString(2).padStart(5, "0");
  }
  for (let i = 0; i + 8 <= bits.length; i += 8)
    res.push(Number.parseInt(bits.slice(i, i + 8), 2));
  return new Uint8Array(res);
}
async function computeTotpAsync(
  secret: string,
  id: string | undefined,
): Promise<void> {
  try {
    const key = base32Decode(secret);
    const T = Math.floor(Date.now() / 30000);
    const msg = new DataView(new ArrayBuffer(8));
    msg.setUint32(4, T, false);
    const ck = await crypto.subtle.importKey(
      "raw",
      key as BufferSource,
      { name: "HMAC", hash: "SHA-1" }, // NOSONAR: SHA-1 is required by TOTP spec (RFC 6238)
      false,
      ["sign"],
    );
    const hmac = new Uint8Array(
      (await crypto.subtle.sign("HMAC", ck, msg.buffer)) as ArrayBuffer,
    );
    const off = hmac[19] & 0xf;
    const code =
      (((hmac[off] & 0x7f) << 24) |
        ((hmac[off + 1] & 0xff) << 16) |
        ((hmac[off + 2] & 0xff) << 8) |
        (hmac[off + 3] & 0xff)) %
      1000000;
    const str = String(code).padStart(6, "0");
    const el = document.getElementById(`totp-code-${id}`) as HTMLElement;
    if (el) el.textContent = str.slice(0, 3) + " " + str.slice(3);
  } catch {
    /* noop */
  }
}

let _totpEdit: TotpItem | null = null;
(document.getElementById("btn-add-totp") as HTMLButtonElement).addEventListener(
  "click",
  () => {
    _totpEdit = null;
    (document.getElementById("t-name") as HTMLInputElement).value = "";
    (document.getElementById("t-issuer") as HTMLInputElement).value = "";
    (document.getElementById("t-secret") as HTMLInputElement).value = "";
    (document.getElementById("t-icon") as HTMLInputElement).value = "";
    logInfo("totp", "Add TOTP account modal opened");
    showOverlay("totp-overlay");
    setTimeout(
      () => (document.getElementById("t-name") as HTMLInputElement).focus(),
      60,
    );
  },
);
(document.getElementById("totp-ok") as HTMLButtonElement).addEventListener(
  "click",
  async () => {
    const name = (
      document.getElementById("t-name") as HTMLInputElement
    ).value.trim();
    const secret = (
      document.getElementById("t-secret") as HTMLInputElement
    ).value
      .trim()
      .replace(/\s/g, "")
      .toUpperCase();
    if (!name || !secret) {
      toast("Name and secret key required");
      return;
    }
    const item: TotpItem = {
      id: _totpEdit?.id,
      name,
      issuer: (
        document.getElementById("t-issuer") as HTMLInputElement
      ).value.trim(),
      secret,
      icon:
        (document.getElementById("t-icon") as HTMLInputElement).value || "🔐",
    };
    hideOverlay("totp-overlay");
    const r = await api.totpSave(item as unknown as Record<string, unknown>);
    if (r.ok) {
      if (_totpEdit) Object.assign(_totpEdit, item);
      else {
        item.id = r.id;
        S.totp.unshift(item);
      }
      renderTotpGrid();
      updateCounts();
      toast("Saved");
      logOk(
        "totp",
        _totpEdit ? "TOTP account updated" : "TOTP account created",
        { name },
      );
    } else {
      toast("Save failed: " + r.error);
      logErr("totp", "TOTP save failed", { name, error: r.error });
    }
  },
);
(document.getElementById("totp-cancel") as HTMLButtonElement).addEventListener(
  "click",
  () => hideOverlay("totp-overlay"),
);
(document.getElementById("totp-overlay") as HTMLElement).addEventListener(
  "click",
  (e: MouseEvent) => {
    if (e.target === (document.getElementById("totp-overlay") as HTMLElement))
      hideOverlay("totp-overlay");
  },
);

// ═══ SETTINGS ══════════════════════════════════════════════════════════════════
const DEFAULT_SETTINGS: AppSettings = {
  lock_timeout: 5,
  lock_action: "lock",
  lock_countdown: true,
  lock_on_minimize: false,
  compact: false,
  animations: true,
  accent: "violet",
  gen_length: 20,
  gen_symbols: true,
  gen_numbers: true,
  gen_ambiguous: false,
  gen_copy: true,
  sounds: true,
  toast_duration: 2400,
  sound_login: true,
  sound_exit: true,
  sound_hover: false,
  sound_login_tone: "chime",
  sound_exit_tone: "chime",
  sound_hover_tone: "click",
  pin_login_enabled: false,
  pin_allow_alpha: false,
};

const ACCENT_MAP: Record<string, string> = {
  violet: "oklch(0.65 0.22 290)",
  blue: "oklch(0.62 0.20 250)",
  teal: "oklch(0.62 0.18 190)",
  green: "oklch(0.65 0.20 145)",
  orange: "oklch(0.68 0.20 55)",
  rose: "oklch(0.62 0.22 15)",
  red: "oklch(0.62 0.22 25)",
  pink: "oklch(0.65 0.20 350)",
  yellow: "oklch(0.78 0.16 95)",
  amber: "oklch(0.72 0.18 70)",
  cyan: "oklch(0.65 0.16 210)",
  indigo: "oklch(0.58 0.20 270)",
  lime: "oklch(0.72 0.20 130)",
};
function applyAccent(name: string): void {
  const c = ACCENT_MAP[name] || ACCENT_MAP.violet;
  document.documentElement.style.setProperty("--accent", c);
  document.documentElement.style.setProperty(
    "--accent-dim",
    c.replace(")", " / 0.1)").replace("oklch(", "oklch("),
  );
  document.documentElement.style.setProperty(
    "--accent-glow",
    c.replace(")", " / 0.15)").replace("oklch(", "oklch("),
  );
  document.documentElement.style.setProperty(
    "--accent-strong",
    c.replace(/0\.\d+/, (m) =>
      String(Math.min(1, Number.parseFloat(m) + 0.08)),
    ),
  );
  document.documentElement.style.setProperty(
    "--accent-glass",
    c.replace(")", " / 0.18)").replace("oklch(", "oklch("),
  );
  document.querySelectorAll(".accent-swatch").forEach((s) => {
    (s as HTMLElement).classList.toggle(
      "active",
      (s as HTMLElement).dataset.accent === name,
    );
  });
}

function applySetting(key: string, value: unknown): void {
  (S.settings as unknown as Record<string, unknown>)[key] = value;
  if (
    key === "lock_timeout" ||
    key === "lock_action" ||
    key === "lock_countdown"
  ) {
    applyLockSettings();
    armLock();
  }
  if (key === "compact") document.body.classList.toggle("compact", !!value);
  if (key === "animations")
    document.body.style.setProperty("--transition", value ? "" : "0s");
  if (key === "accent") applyAccent(value as string);
  if (key === "sounds")
    (globalThis as unknown as Record<string, unknown>).__soundsEnabled =
      !!value;
  __saveSettings();
}
let __saveTimer: ReturnType<typeof setTimeout> | null = null;
function __saveSettings(): void {
  clearTimeout(__saveTimer!);
  __saveTimer = setTimeout(async () => {
    try {
      await api.settings.save(S.settings as unknown as Record<string, unknown>);
    } catch {
      /* noop */
    }
  }, 400);
}

async function loadSettingsTab(): Promise<void> {
  logInfo("settings", "Loading settings tab");
  const r = await api.settings.load();
  if (r.ok) S.settings = { ...DEFAULT_SETTINGS, ...r.settings } as AppSettings;
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    if ((S.settings as unknown as Record<string, unknown>)[k] === undefined)
      (S.settings as unknown as Record<string, unknown>)[k] = v;
  }

  const bind = (id: string, key: string, type: string): void => {
    const el = document.getElementById(id) as
      | HTMLInputElement
      | HTMLSelectElement
      | null;
    if (!el) return;
    if (type === "toggle")
      (el as HTMLInputElement).checked = !!(
        S.settings as unknown as Record<string, unknown>
      )[key];
    else {
      const raw = (S.settings as unknown as Record<string, unknown>)[key];
      // Only strings/numbers/primitives are meaningful here; objects would
      // stringify to "[object Object]".
      el.value =
        typeof raw === "string" || typeof raw === "number" ? String(raw) : "";
    }
    el.addEventListener("change", () => {
      let val: unknown;
      if (type === "toggle") val = (el as HTMLInputElement).checked;
      else if (type === "number") val = Number.parseInt(el.value, 10) || 0;
      else val = el.value;
      applySetting(key, val);
      toast("Setting updated", 1200);
    });
  };

  bind("s-lock-timeout", "lock_timeout", "number");
  bind("s-lock-action", "lock_action", "select");
  bind("s-lock-countdown", "lock_countdown", "toggle");
  bind("s-lock-minimize", "lock_on_minimize", "toggle");
  bind("s-compact", "compact", "toggle");
  bind("s-animations", "animations", "toggle");
  bind("s-gen-length", "gen_length", "number");
  bind("s-gen-symbols", "gen_symbols", "toggle");
  bind("s-gen-numbers", "gen_numbers", "toggle");
  bind("s-gen-ambiguous", "gen_ambiguous", "toggle");
  bind("s-gen-copy", "gen_copy", "toggle");
  bind("s-sounds", "sounds", "toggle");
  bind("s-sound-login", "sound_login", "toggle");
  bind("s-sound-exit", "sound_exit", "toggle");
  bind("s-sound-hover", "sound_hover", "toggle");
  bind("s-sound-login-tone", "sound_login_tone", "select");
  bind("s-sound-exit-tone", "sound_exit_tone", "select");
  bind("s-sound-hover-tone", "sound_hover_tone", "select");
  bind("s-toast-duration", "toast_duration", "select");
  bind("s-pin-enabled", "pin_login_enabled", "toggle");
  bind("s-pin-alpha", "pin_allow_alpha", "toggle");

  // PIN settings UI logic
  const pinSetupRow = document.getElementById("pin-setup-row") as HTMLElement;
  const pinChangeRow = document.getElementById("pin-change-row") as HTMLElement;
  const pinDeleteRow = document.getElementById("pin-delete-row") as HTMLElement;
  const pinDeleteDivider = document.getElementById(
    "pin-delete-divider",
  ) as HTMLElement;

  // Check if a PIN file already exists to decide which row to show
  let _pinFileExists = false;
  const pinStatusR = await api.pin.status();
  _pinFileExists = pinStatusR.ok && pinStatusR.enabled;

  const pinEnabled = S.settings.pin_login_enabled;
  // If PIN file exists → show change + delete rows (regardless of toggle)
  // If no PIN file → show setup row only when toggle is on
  // If PIN is disabled and no file → hide all
  let initialPinView: "setup" | "changeDelete" | "none";
  if (_pinFileExists) initialPinView = "changeDelete";
  else if (pinEnabled) initialPinView = "setup";
  else initialPinView = "none";
  setPinRowsView(initialPinView);

  function setPinRowsView(view: "setup" | "changeDelete" | "none"): void {
    if (pinSetupRow) pinSetupRow.hidden = view !== "setup";
    if (pinChangeRow) pinChangeRow.hidden = view !== "changeDelete";
    if (pinDeleteRow) pinDeleteRow.hidden = view !== "changeDelete";
    if (pinDeleteDivider) pinDeleteDivider.hidden = view !== "changeDelete";
  }

  // PIN enable toggle handler
  const pinEnabledEl = document.getElementById(
    "s-pin-enabled",
  ) as HTMLInputElement;
  if (pinEnabledEl) {
    pinEnabledEl.addEventListener("change", () => {
      const enabled = pinEnabledEl.checked;
      S.settings.pin_login_enabled = enabled;
      if (enabled) {
        setPinRowsView(_pinFileExists ? "changeDelete" : "setup");
      } else {
        setPinRowsView("none");
      }
      __saveSettings();
      toast(
        enabled
          ? "PIN login enabled — set your PIN below"
          : "PIN login disabled",
        1500,
      );
      logInfo("settings", "PIN login toggled", { enabled });
    });
  }

  // PIN allow alpha toggle handler
  const pinAlphaEl = document.getElementById("s-pin-alpha") as HTMLInputElement;
  if (pinAlphaEl) {
    pinAlphaEl.addEventListener("change", () => {
      S.settings.pin_allow_alpha = pinAlphaEl.checked;
      __saveSettings();
      toast(
        pinAlphaEl.checked ? "Alphanumeric PINs enabled" : "Numbers-only PINs",
        1500,
      );
      logInfo("settings", "PIN alpha setting changed", {
        allowAlpha: pinAlphaEl.checked,
      });
    });
  }

  function switchToPinChangeDeleteView(): void {
    _pinFileExists = true;
    S.settings.pin_login_enabled = true;
    setPinRowsView("changeDelete");
    if (pinEnabledEl) pinEnabledEl.checked = true;
    __saveSettings();
  }

  // Set PIN button
  document.getElementById("s-pin-save")?.addEventListener("click", async () => {
    const pinVal = (document.getElementById("s-pin-value") as HTMLInputElement)
      .value;
    logInfo("pin", "Set PIN clicked");
    const r = await api.pin.setup(pinVal, S.settings.pin_allow_alpha);
    if (!r.ok) {
      if (r.error?.includes("already set")) {
        switchToPinChangeDeleteView();
        toast("PIN is already set — you can change or delete it below", 3000);
      } else {
        toast(r.error || "Failed to set PIN");
      }
      logWarn("pin", "Set PIN failed", r.error);
      return;
    }
    toast("PIN set successfully");
    logOk("pin", "PIN set");
    (document.getElementById("s-pin-value") as HTMLInputElement).value = "";
    switchToPinChangeDeleteView();
  });

  // Change PIN button
  document
    .getElementById("s-pin-change-btn")
    ?.addEventListener("click", async () => {
      const oldPin = (document.getElementById("s-pin-old") as HTMLInputElement)
        .value;
      const newPin = (document.getElementById("s-pin-new") as HTMLInputElement)
        .value;
      logInfo("pin", "Change PIN clicked");
      const r = await api.pin.change(
        oldPin,
        newPin,
        S.settings.pin_allow_alpha,
      );
      if (!r.ok) {
        toast(r.error || "Failed to change PIN");
        logWarn("pin", "Change PIN failed", r.error);
        return;
      }
      toast("PIN changed successfully");
      logOk("pin", "PIN changed");
      (document.getElementById("s-pin-old") as HTMLInputElement).value = "";
      (document.getElementById("s-pin-new") as HTMLInputElement).value = "";
    });

  // Delete PIN button — requires confirmation
  document
    .getElementById("s-pin-delete")
    ?.addEventListener("click", async () => {
      const confirmed = await confirmDialog({
        title: "Delete PIN?",
        msg: "This will permanently delete your PIN. You can set a new one anytime from settings.",
        okLabel: "Delete",
        okClass: "btn-danger",
      });
      if (!confirmed) return;
      logInfo("pin", "Delete PIN confirmed");
      const r = await api.pin.disable();
      if (!r.ok) {
        toast(r.error || "Failed to delete PIN");
        logWarn("pin", "Delete PIN failed", r.error);
        return;
      }
      toast("PIN deleted");
      logOk("pin", "PIN deleted");
      _pinFileExists = false;
      // Disable PIN login setting and clear saved account
      S.settings.pin_login_enabled = false;
      if (pinEnabledEl) pinEnabledEl.checked = false;
      // Remove the saved account for this PIN user
      api.accounts.remove().catch(() => {});
      // Update UI: show setup row, hide change/delete rows
      if (pinSetupRow) pinSetupRow.hidden = true;
      if (pinChangeRow) pinChangeRow.hidden = true;
      if (pinDeleteRow) pinDeleteRow.hidden = true;
      if (pinDeleteDivider) pinDeleteDivider.hidden = true;
      // Update PIN indicator in sidebar
      const pinIndicator = document.getElementById("pin-indicator");
      if (pinIndicator) pinIndicator.hidden = true;
      __saveSettings();
    });

  document.querySelectorAll(".accent-swatch").forEach((s) => {
    (s as HTMLElement).classList.toggle(
      "active",
      (s as HTMLElement).dataset.accent === S.settings.accent,
    );
    s.addEventListener("click", () =>
      applySetting("accent", (s as HTMLElement).dataset.accent),
    );
  });

  document.body.classList.toggle("compact", !!S.settings.compact);
  document.body.style.setProperty(
    "--transition",
    S.settings.animations ? "" : "0s",
  );
  applyAccent(S.settings.accent);
  (globalThis as unknown as Record<string, unknown>).__soundsEnabled =
    !!S.settings.sounds;

  const r2 = await api.twofa.status();
  (document.getElementById("s-2fa-status") as HTMLElement).textContent =
    r2.enabled ? "✅ Enabled" : "❌ Disabled";
  logOk("settings", "Settings tab loaded", {
    ...S.settings,
    twofa: r2.enabled,
  });
}

api.onMinimize(() => {
  if (S.settings.lock_on_minimize && S.user) doLock();
});

(document.getElementById("s-btn-2fa") as HTMLButtonElement).addEventListener(
  "click",
  () => {
    hide("tab-settings");
    (document.getElementById("btn-2fa") as HTMLButtonElement).click();
  },
);

// ═══ STRENGTH ══════════════════════════════════════════════════════════════════
function scoreP(pw: string): { n: number; lbl: string; cls: string } {
  if (!pw) return { n: 0, lbl: "—", cls: "" };
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 14) s++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
  if (/\d/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  const n = Math.min(4, Math.ceil((s * 4) / 5));
  return {
    n,
    lbl: ["", "weak", "fair", "good", "strong"][n] || "—",
    cls: ["", "sl-w", "sl-f", "sl-g", "sl-s"][n] || "",
  };
}
function updateSm(wrapId: string, pw: string): void {
  const wrap = document.getElementById(wrapId) as HTMLElement;
  if (!wrap) return;
  const { n, lbl, cls } = scoreP(pw);
  wrap.querySelectorAll(".sm-bar").forEach((b, i) => {
    b.className = "sm-bar" + (i < n ? ` l${n}` : "");
  });
  const l = wrap.querySelector(".sm-lbl");
  if (l) {
    l.textContent = lbl;
    l.className = "sm-lbl " + cls;
  }
}

// ═══ GENERATOR ════════════════════════════════════════════════════════════════
const LOWER = "abcdefghijklmnopqrstuvwxyz",
  UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  NUMS = "0123456789",
  SYMS = "!@#$%^&*()_+-=[]{}|;:,.<>?";
async function doGenerate(): Promise<string> {
  const len = Number.parseInt(
    (document.getElementById("gen-len") as HTMLInputElement).value,
    10,
  );
  const classes = [LOWER];
  if ((document.getElementById("go-upper") as HTMLInputElement).checked)
    classes.push(UPPER);
  if ((document.getElementById("go-nums") as HTMLInputElement).checked)
    classes.push(NUMS);
  if ((document.getElementById("go-syms") as HTMLInputElement).checked)
    classes.push(SYMS);
  const allCs = classes.join("");
  // Use rejection sampling to avoid modulo bias
  function pickRandom(chars: string): string {
    const max = 0x100000000 - (0x100000000 % chars.length);
    let v: number;
    do {
      const tmp = new Uint32Array(1);
      crypto.getRandomValues(tmp);
      v = tmp[0];
    } while (v >= max);
    return chars[v % chars.length];
  }
  const guaranteed = classes.map((cs) => pickRandom(cs));
  const rest = Array.from({ length: len - classes.length }, () =>
    pickRandom(allCs),
  );
  let pw = [...guaranteed, ...rest];
  const shuffleArr = new Uint32Array(pw.length);
  crypto.getRandomValues(shuffleArr);
  for (let i = pw.length - 1; i > 0; i--) {
    const j = shuffleArr[i] % (i + 1);
    [pw[i], pw[j]] = [pw[j], pw[i]];
  }
  const pwStr = pw.join("");
  (document.getElementById("gen-out") as HTMLElement).textContent = pwStr;
  const { n, lbl, cls } = scoreP(pwStr);
  document.querySelectorAll("#gen-strength-row .bar").forEach((b, i) => {
    b.className = "bar" + (i < n ? ` g${n}` : "");
  });
  const l = document.getElementById("gen-slabel");
  if (l) {
    l.textContent = lbl;
    l.className = "slabel " + cls.replace("sl-", "s");
  }
  if (S.settings.gen_copy) {
    try {
      await navigator.clipboard.writeText(pwStr);
    } catch {
      /* noop */
    }
  }
  logInfo("generator", "Password generated", { length: len, strength: lbl });
  return pwStr;
}
(document.getElementById("gen-len") as HTMLInputElement).addEventListener(
  "input",
  function () {
    (document.getElementById("gen-len-val") as HTMLElement).textContent =
      this.value;
    if ((document.getElementById("gen-out") as HTMLElement).textContent !== "—")
      doGenerate();
  },
);
function openGen(fillMode = false): void {
  logInfo("generator", "Generator opened", { fillMode });
  (document.getElementById("gen-len") as HTMLInputElement).value = String(
    S.settings.gen_length || 20,
  );
  (document.getElementById("gen-len-val") as HTMLElement).textContent = String(
    S.settings.gen_length || 20,
  );
  (document.getElementById("go-syms") as HTMLInputElement).checked =
    !!S.settings.gen_symbols;
  (document.getElementById("go-nums") as HTMLInputElement).checked =
    !!S.settings.gen_numbers;
  showOverlay("gen-overlay");
  const useBtn = document.getElementById("gen-use") as HTMLButtonElement;
  const newUse = useBtn.cloneNode(true) as HTMLButtonElement;
  useBtn.parentNode!.replaceChild(newUse, useBtn);
  newUse.hidden = !fillMode;
  newUse.addEventListener("click", () => {
    const pw = (document.getElementById("gen-out") as HTMLElement).textContent;
    if (!pw || pw === "—") {
      toast("Generate first");
      return;
    }
    const f = document.getElementById("f-pw") as HTMLInputElement;
    if (f) {
      f.value = pw;
      f.type = "text";
      updateSm("sm", pw);
    }
    closeGen();
  });
  doGenerate();
}
function closeGen(): void {
  hideOverlay("gen-overlay");
}
["go-upper", "go-nums", "go-syms"].forEach((id) => {
  (document.getElementById(id) as HTMLInputElement).addEventListener(
    "change",
    () => {
      if ((document.getElementById("gen-overlay") as HTMLElement).hidden)
        return;
      doGenerate();
      if (id === "go-syms")
        S.settings.gen_symbols = (
          document.getElementById(id) as HTMLInputElement
        ).checked;
      if (id === "go-nums")
        S.settings.gen_numbers = (
          document.getElementById(id) as HTMLInputElement
        ).checked;
      __saveSettings();
    },
  );
});
(document.getElementById("btn-gen") as HTMLButtonElement).addEventListener(
  "click",
  () => openGen(false),
);
(document.getElementById("gen-close") as HTMLButtonElement).addEventListener(
  "click",
  closeGen,
);
(document.getElementById("gen-generate") as HTMLButtonElement).addEventListener(
  "click",
  doGenerate,
);
(document.getElementById("gen-copy") as HTMLButtonElement).addEventListener(
  "click",
  () => {
    const pw = (document.getElementById("gen-out") as HTMLElement).textContent;
    if (pw && pw !== "—") {
      navigator.clipboard.writeText(pw);
      toast("Copied!");
      logInfo("generator", "Password copied to clipboard");
    }
  },
);
(document.querySelector("#gen-overlay .modal") as HTMLElement).addEventListener(
  "click",
  (e: Event) => e.stopPropagation(),
);
(document.getElementById("gen-overlay") as HTMLElement).addEventListener(
  "click",
  closeGen,
);

// ═══ 2FA SETTINGS MODAL ════════════════════════════════════════════════════════
(document.getElementById("btn-2fa") as HTMLButtonElement).addEventListener(
  "click",
  async () => {
    logInfo("2fa", "2FA settings opened");
    const r = await api.twofa.status();
    const body = document.getElementById("twofa-modal-body") as HTMLElement;
    const okBtn = document.getElementById("twofa-ok") as HTMLButtonElement;
    const disBtn = document.getElementById(
      "twofa-disable",
    ) as HTMLButtonElement;
    if (r.enabled) {
      (
        document.getElementById("twofa-modal-title") as HTMLElement
      ).textContent = "2FA is enabled";
      body.innerHTML = "";
      const disMsg = document.createElement("p");
      disMsg.className = "sub";
      disMsg.style.cssText = "margin:12px 0";
      disMsg.textContent = "Two-factor authentication is active.";
      body.appendChild(disMsg);
      body.appendChild(document.createElement("br"));
      const disMsg2 = document.createElement("span");
      disMsg2.textContent = "Disable it below.";
      body.appendChild(disMsg2);
      okBtn.hidden = true;
      disBtn.hidden = false;
      logInfo("2fa", "2FA is currently enabled");
    } else {
      (
        document.getElementById("twofa-modal-title") as HTMLElement
      ).textContent = "Enable 2FA";
      body.innerHTML = "";
      const scanMsg = document.createElement("p");
      scanMsg.className = "sub";
      scanMsg.style.cssText = "margin-bottom:14px";
      scanMsg.textContent =
        "Scan this QR code with your authenticator app, then enter the 6-digit code to confirm.";
      body.appendChild(scanMsg);
      body.appendChild(document.createElement("br"));
      body.appendChild(document.createElement("br"));
      const qrWrap = document.createElement("div");
      qrWrap.id = "qr-wrap";
      qrWrap.style.cssText =
        "display:flex;justify-content:center;margin:12px 0";
      const qrLoading = document.createElement("p");
      qrLoading.style.color = "var(--muted)";
      qrLoading.textContent = "Loading…";
      qrWrap.appendChild(qrLoading);
      body.appendChild(qrWrap);
      const secretText = document.createElement("p");
      secretText.className = "sub";
      secretText.style.cssText =
        "margin-bottom:10px;font-size:11px;font-family:var(--mono)";
      secretText.id = "2fa-secret-text";
      secretText.textContent = "Loading…";
      body.appendChild(secretText);
      const setupCode = document.createElement("input");
      setupCode.className = "fi twofa-input";
      setupCode.id = "twofa-setup-code";
      setupCode.placeholder = "000000";
      setupCode.maxLength = 6;
      setupCode.inputMode = "numeric";
      setupCode.style.cssText =
        "text-align:center;font-size:20px;letter-spacing:.3em;font-family:var(--mono);margin-top:6px";
      body.appendChild(setupCode);
      const setupErr = document.createElement("p");
      setupErr.className = "err";
      setupErr.id = "twofa-setup-err";
      setupErr.hidden = true;
      body.appendChild(setupErr);
      okBtn.hidden = false;
      disBtn.hidden = true;
      const sr = await api.twofa.setup();
      if (sr.ok) {
        (
          document.getElementById("2fa-secret-text") as HTMLElement
        ).textContent = sr.secret ?? "";
        const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(sr.otpauth!)}`;
        const qrEl = document.getElementById("qr-wrap") as HTMLElement;
        qrEl.innerHTML = "";
        const qrImg = document.createElement("img");
        qrImg.width = 160;
        qrImg.height = 160;
        qrImg.style.borderRadius = "8px";
        qrImg.style.background = "#fff";
        qrImg.style.padding = "6px";
        qrImg.src = qrUrl;
        qrEl.appendChild(qrImg);
        logOk("2fa", "2FA setup initiated");
      } else {
        logErr("2fa", "2FA setup failed", sr.error);
      }
      const newOk = okBtn.cloneNode(true) as HTMLButtonElement;
      okBtn.parentNode!.replaceChild(newOk, okBtn);
      newOk.hidden = false;
      newOk.addEventListener("click", async () => {
        const token = (
          document.getElementById("twofa-setup-code") as HTMLInputElement
        )?.value.trim();
        const er = await api.twofa.enable(token);
        if (!er.ok) {
          const el = document.getElementById("twofa-setup-err") as HTMLElement;
          el.hidden = false;
          el.textContent = er.error ?? "";
          logWarn("2fa", "2FA enable failed", er.error);
          return;
        }
        hideOverlay("twofa-overlay");
        toast("2FA enabled ✓");
        logOk("2fa", "2FA enabled");
      });
    }
    const newDis = disBtn.cloneNode(true) as HTMLButtonElement;
    disBtn.parentNode!.replaceChild(newDis, disBtn);
    newDis.hidden = !r.enabled;
    newDis.addEventListener("click", async () => {
      const code = prompt(
        "Enter your current 6-digit 2FA code to confirm disabling:",
      );
      if (!code || !/^\d{6}$/.test(code)) {
        toast("Invalid code format");
        return;
      }
      logInfo("2fa", "2FA disable clicked");
      const res = await api.twofa.disable(code);
      if (!res.ok) {
        toast(res.error || "Failed to disable 2FA");
        return;
      }
      hideOverlay("twofa-overlay");
      toast("2FA disabled");
      logOk("2fa", "2FA disabled");
    });
    showOverlay("twofa-overlay");
  },
);
(document.getElementById("twofa-cancel") as HTMLButtonElement).addEventListener(
  "click",
  () => hideOverlay("twofa-overlay"),
);
(document.getElementById("twofa-overlay") as HTMLElement).addEventListener(
  "click",
  (e: MouseEvent) => {
    if (e.target === (document.getElementById("twofa-overlay") as HTMLElement))
      hideOverlay("twofa-overlay");
  },
);

// ═══ KEYBOARD ═══════════════════════════════════════════════════════════
document.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Escape") {
    logInfo("ui", "Escape pressed — closing overlays");
    [
      "modal-overlay",
      "gen-overlay",
      "confirm-overlay",
      "twofa-overlay",
      "job-overlay",
      "totp-overlay",
      "status-popup",
    ].forEach((id) => hide(id));
  }
});

// ═══ HOVER SOUNDS ══════════════════════════════════════════════════════════════
let __hoverTimer: ReturnType<typeof setTimeout> | null = null;
document.addEventListener("mouseover", (e: MouseEvent) => {
  if (
    !S.settings.sound_hover ||
    (globalThis as unknown as Record<string, boolean>).__soundsEnabled === false
  )
    return;
  const t = (e.target as HTMLElement).closest(
    ".nav-btn, .accent-swatch, .wb, .btn-primary, .btn-ghost, .icon-btn, .filter-pill, .job-stat",
  ) as HTMLElement;
  if (!t) return;
  clearTimeout(__hoverTimer!);
  __hoverTimer = setTimeout(() => playSound("hover"), 20);
});

// ── Startup: check if PIN login is available ──
(async () => {
  try {
    const pr = await api.pin.status();
    if (pr.ok && pr.enabled) {
      screen("s-pin");
      await loadPinAccounts();
      logInfo("app", "PIN login available, showing PIN entry screen");
      return;
    }
  } catch {
    /* noop — fall through to login screen */
  }
  screen("s-login");
  logInfo("app", "App initialized, showing login screen");
})();

// Clear in-memory icon cache on app close (NOT on logout)
globalThis.addEventListener("beforeunload", () => {
  Object.keys(iconCache).forEach((k) => delete iconCache[k]);
});
