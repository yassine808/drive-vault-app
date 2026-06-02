import type { SupabaseClient } from '@supabase/supabase-js';
import type { Settings, Session } from '../types';

import type Electron from 'electron';
type Logger = {
  db: (ctx: string, msg: string, data?: unknown) => void;
  success: (ctx: string, msg: string, data?: unknown) => void;
  warn: (ctx: string, msg: string, data?: unknown) => void;
  ipc: (ctx: string, msg: string, data?: unknown) => void;
};
type LogError = (ctx: string, err: unknown) => void;
type IpcHandler = (...args: any[]) => any;
type AuthWrapper = (fn: IpcHandler) => IpcHandler;

const VALID_ACCENTS = ['violet', 'blue', 'teal', 'green', 'orange', 'rose', 'red', 'pink', 'yellow', 'amber', 'cyan', 'indigo', 'lime'] as const;
const VALID_TOAST_DURATIONS = [1500, 2400, 3500, 5000] as const;
const VALID_TONES = ['chime', 'ding', 'soft', 'bright'] as const;
const VALID_HOVER_TONES = ['chime', 'ding', 'soft', 'bright', 'click', 'tap', 'pop', 'none'] as const;

type ValidAccent = typeof VALID_ACCENTS[number];
type ValidToastDuration = typeof VALID_TOAST_DURATIONS[number];
type ValidTone = typeof VALID_TONES[number];
type ValidHoverTone = typeof VALID_HOVER_TONES[number];

type SettingsValidationResult = {
  ok: true;
  settings: Settings;
} | {
  ok: false;
  error: string;
};

function validateSettings(input: Record<string, unknown>, logger: Logger): SettingsValidationResult {
  if (!input || typeof input !== 'object') {
    return { ok: false, error: 'Invalid settings' };
  }

  const t = parseInt(input.lock_timeout as string);
  if (isNaN(t) || t < 0 || t > 120) {
    return { ok: false, error: 'Lock timeout must be 0-120 minutes' };
  }

  if (!['lock', 'exit'].includes(input.lock_action as string)) {
    return { ok: false, error: 'Invalid lock action' };
  }

  const accent: ValidAccent = (VALID_ACCENTS as readonly string[]).includes(input.accent as string)
    ? input.accent as ValidAccent : 'violet';

  const gl = parseInt(input.gen_length as string);
  const gen_length = (isNaN(gl) || gl < 8 || gl > 128) ? 20 : gl;

  const td = parseInt(input.toast_duration as string);
  const toast_duration: ValidToastDuration = (VALID_TOAST_DURATIONS as readonly number[]).includes(td)
    ? td as ValidToastDuration : 2400;

  const soundLoginTone: ValidTone = (VALID_TONES as readonly string[]).includes(input.sound_login_tone as string)
    ? input.sound_login_tone as ValidTone : 'chime';
  const soundExitTone: ValidTone = (VALID_TONES as readonly string[]).includes(input.sound_exit_tone as string)
    ? input.sound_exit_tone as ValidTone : 'chime';
  const soundHoverTone: ValidHoverTone = (VALID_HOVER_TONES as readonly string[]).includes(input.sound_hover_tone as string)
    ? input.sound_hover_tone as ValidHoverTone : 'click';

  const out: Settings = {
    lock_timeout: t,
    lock_action: input.lock_action as 'lock' | 'exit',
    lock_countdown: !!input.lock_countdown,
    lock_on_minimize: !!input.lock_on_minimize,
    compact: !!input.compact,
    animations: !!input.animations,
    accent,
    gen_length,
    gen_symbols: !!input.gen_symbols,
    gen_numbers: !!input.gen_numbers,
    gen_ambiguous: !!input.gen_ambiguous,
    gen_copy: !!input.gen_copy,
    sounds: !!input.sounds,
    sound_login: !!input.sound_login,
    sound_exit: !!input.sound_exit,
    sound_hover: !!input.sound_hover,
    sound_login_tone: soundLoginTone,
    sound_exit_tone: soundExitTone,
    sound_hover_tone: soundHoverTone,
    toast_duration,
  };

  return { ok: true, settings: out };
}

function register(
  ipcMain: Electron.IpcMain,
  requireAuth: AuthWrapper,
  requireAuthNoArgs: AuthWrapper,
  supabase: SupabaseClient,
  getSession: () => Session | null,
  logger: Logger,
  logError: LogError,
) {
  async function dbLoadSettings(userId: string): Promise<Partial<Settings>> {
    logger.db('dbLoadSettings', 'Loading settings', { userId });
    const { data } = await supabase.from('vault_settings')
      .select('user_id,lock_timeout,lock_action,lock_countdown,lock_on_minimize,compact,animations,accent,gen_length,gen_symbols,gen_numbers,gen_ambiguous,gen_copy,sounds,sound_login,sound_exit,sound_hover,sound_login_tone,sound_exit_tone,sound_hover_tone,toast_duration')
      .eq('user_id', userId).single();
    const result = data || {};
    logger.db('dbLoadSettings', 'Settings loaded', result);
    return result as Partial<Settings>;
  }

  async function dbSaveSettings(userId: string, settings: Settings): Promise<void> {
    logger.db('dbSaveSettings', 'Saving settings', { userId });
    const safeSettings = {
      lock_timeout: settings.lock_timeout,
      lock_action: settings.lock_action,
      lock_countdown: settings.lock_countdown,
      lock_on_minimize: settings.lock_on_minimize,
      compact: settings.compact,
      animations: settings.animations,
      accent: settings.accent,
      gen_length: settings.gen_length,
      gen_symbols: settings.gen_symbols,
      gen_numbers: settings.gen_numbers,
      gen_ambiguous: settings.gen_ambiguous,
      gen_copy: settings.gen_copy,
      sounds: settings.sounds,
      sound_login: settings.sound_login,
      sound_exit: settings.sound_exit,
      sound_hover: settings.sound_hover,
      sound_login_tone: settings.sound_login_tone,
      sound_exit_tone: settings.sound_exit_tone,
      sound_hover_tone: settings.sound_hover_tone,
      toast_duration: settings.toast_duration,
    };
    await supabase.from('vault_settings').upsert({ user_id: userId, ...safeSettings });
    logger.db('dbSaveSettings', 'Success');
  }

  ipcMain.handle('settings:load', requireAuthNoArgs(async () => {
    const session = getSession();
    if (!session) throw new Error('No session');
    logger.ipc('settings:load', 'Loading settings');
    try {
      const settings = await dbLoadSettings(session.userId);
      logger.success('settings:load', 'Settings loaded', settings);
      return { ok: true, settings };
    } catch {
      logger.warn('settings:load', 'Using defaults');
      return { ok: true, settings: { lock_timeout: 5, lock_action: 'lock' } as Partial<Settings> };
    }
  }));

  ipcMain.handle('settings:save', requireAuth(async (_e, { settings }: { settings: Record<string, unknown> }) => {
    const session = getSession();
    if (!session) throw new Error('No session');
    logger.ipc('settings:save', 'Saving settings', settings);
    try {
      const validation = validateSettings(settings, logger);
      if (!validation.ok) {
        logger.warn('settings:save', (validation as any).error, { lock_timeout: settings?.lock_timeout, lock_action: settings?.lock_action });
        return validation;
      }
      await dbSaveSettings(session.userId, validation.settings);
      logger.success('settings:save', 'Settings saved');
      return { ok: true };
    } catch (e: unknown) { const err = e as Error; logError('settings:save', err); return { ok: false, error: 'Failed to save settings' }; }
  }));
}

export { register };
