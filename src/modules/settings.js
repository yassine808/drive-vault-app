'use strict';

// ── Settings DB helpers ──────────────────────────────────────────────────────

async function dbLoadSettings(supabase, userId, logger) {
  logger.db('dbLoadSettings', 'Loading settings', { userId });
  const { data } = await supabase.from('vault_settings')
    .select('user_id,lock_timeout,lock_action,lock_countdown,lock_on_minimize,compact,animations,accent,gen_length,gen_symbols,gen_numbers,gen_ambiguous,gen_copy,sounds,sound_login,sound_exit,sound_hover,sound_login_tone,sound_exit_tone,sound_hover_tone,toast_duration')
    .eq('user_id', userId).single();
  const result = data || {};
  logger.db('dbLoadSettings', 'Settings loaded', result);
  return result;
}

async function dbSaveSettings(supabase, userId, settings, logger) {
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

// ── Validation ───────────────────────────────────────────────────────────────

const VALID_ACCENTS = ['violet', 'blue', 'teal', 'green', 'orange', 'rose', 'red', 'pink', 'yellow', 'amber', 'cyan', 'indigo', 'lime'];
const VALID_TOAST_DURATIONS = [1500, 2400, 3500, 5000];
const VALID_TONES = ['chime', 'ding', 'soft', 'bright'];
const VALID_HOVER_TONES = ['chime', 'ding', 'soft', 'bright', 'click', 'tap', 'pop', 'none'];

function validateSettings(input, logger) {
  if (!input || typeof input !== 'object') {
    return { ok: false, error: 'Invalid settings' };
  }

  const t = parseInt(input.lock_timeout);
  if (isNaN(t) || t < 0 || t > 120) {
    return { ok: false, error: 'Lock timeout must be 0-120 minutes' };
  }

  if (!['lock', 'exit'].includes(input.lock_action)) {
    return { ok: false, error: 'Invalid lock action' };
  }

  const accent = VALID_ACCENTS.includes(input.accent) ? input.accent : 'violet';

  const gl = parseInt(input.gen_length);
  const gen_length = (isNaN(gl) || gl < 8 || gl > 128) ? 20 : gl;

  const td = parseInt(input.toast_duration);
  const toast_duration = VALID_TOAST_DURATIONS.includes(td) ? td : 2400;

  const out = {
    lock_timeout: t,
    lock_action: input.lock_action,
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
    sound_login_tone: VALID_TONES.includes(input.sound_login_tone) ? input.sound_login_tone : 'chime',
    sound_exit_tone: VALID_TONES.includes(input.sound_exit_tone) ? input.sound_exit_tone : 'chime',
    sound_hover_tone: VALID_HOVER_TONES.includes(input.sound_hover_tone) ? input.sound_hover_tone : 'click',
    toast_duration,
  };

  return { ok: true, settings: out };
}

// ── IPC handler registration ─────────────────────────────────────────────────

function register(ipcMain, requireAuth, requireAuthNoArgs, supabase, getSession, logger, logError) {

  ipcMain.handle('settings:load', requireAuthNoArgs(async () => {
    const session = getSession();
    logger.ipc('settings:load', 'Loading settings');
    try {
      const settings = await dbLoadSettings(supabase, session.userId, logger);
      logger.success('settings:load', 'Settings loaded', settings);
      return { ok: true, settings };
    } catch (e) {
      logger.warn('settings:load', 'Using defaults');
      return { ok: true, settings: { lock_timeout: 5, lock_action: 'lock' } };
    }
  }));

  ipcMain.handle('settings:save', requireAuth(async (_e, { settings }) => {
    const session = getSession();
    logger.ipc('settings:save', 'Saving settings', settings);
    try {
      const validation = validateSettings(settings, logger);
      if (!validation.ok) {
        logger.warn('settings:save', validation.error, { lock_timeout: settings?.lock_timeout, lock_action: settings?.lock_action });
        return validation;
      }
      await dbSaveSettings(supabase, session.userId, validation.settings, logger);
      logger.success('settings:save', 'Settings saved');
      return { ok: true };
    } catch (e) {
      logError('settings:save', e);
      return { ok: false };
    }
  }));

}

module.exports = { register };
