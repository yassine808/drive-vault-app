'use strict';

const path = require('path');
const fs   = require('fs');

function register(ipcMain, requireAdminNoArgs, supabase, logger, getSession, LOG_PATH) {

  // ── DB helpers ──────────────────────────────────────────────────────────────

  async function dbGetStats(userId) {
    logger.db('dbGetStats', 'Getting stats', { userId });
    const [items, jobs, jobTrash, itemTrash] = await Promise.all([
      supabase.from('vault_items').select('id', { count: 'exact' }).eq('user_id', userId).is('deleted_at', null),
      supabase.from('vault_jobs').select('id', { count: 'exact' }).eq('user_id', userId).is('deleted_at', null),
      supabase.from('vault_jobs').select('id', { count: 'exact' }).eq('user_id', userId).not('deleted_at', 'is', null),
      supabase.from('vault_items').select('id', { count: 'exact' }).eq('user_id', userId).not('deleted_at', 'is', null),
    ]);
    let logSize = 0;
    try { logSize = fs.statSync(LOG_PATH).size; } catch {}
    let dbSizeBytes = 0;
    try {
      const { data } = await supabase.rpc('get_db_size').single();
      if (data) dbSizeBytes = data;
    } catch {}
    const stats = {
      items: items.count || 0,
      jobs: jobs.count || 0,
      trash: (itemTrash.count || 0) + (jobTrash.count || 0),
      logSize,
      dbSizeBytes,
    };
    logger.db('dbGetStats', 'Stats retrieved', stats);
    return stats;
  }

  // ── IPC handlers ────────────────────────────────────────────────────────────

  ipcMain.handle('monitor:stats', requireAdminNoArgs(async () => {
    logger.ipc('monitor:stats', 'Loading monitor stats');
    try {
      const session = getSession();
      const stats = await dbGetStats(session.userId);
      logger.success('monitor:stats', 'Stats loaded', stats);
      return { ok: true, stats };
    } catch (e) {
      logger.error('monitor:stats', e.message, { stack: e.stack });
      return { ok: false, error: e.message };
    }
  }));

  ipcMain.handle('log:read', requireAdminNoArgs(async () => {
    logger.ipc('log:read', 'Reading logs');
    try {
      const levels = ['ERROR','WARN','INFO','DEBUG','AUTH','DB','IPC','SUCCESS'];
      const allEntries = [];
      for (const lvl of levels) {
        const content = logger.readLog(lvl, 5000);
        if (!content || content.startsWith('(no ') || content.startsWith('(could')) continue;
        const lines = content.split('\n').filter(l => l.trim());
        for (const line of lines) {
          // Parse: [2026-01-01T00:00:00.000Z] [context] message
          const tsMatch = line.match(/^\[([^\]]+)\]/);
          const ctxMatch = line.match(/\]\s+\[([^\]]+)\]/);
          allEntries.push({
            level: lvl,
            ts: tsMatch ? tsMatch[1] : '',
            ctx: ctxMatch ? ctxMatch[1] : '',
            text: line,
          });
        }
      }
      // Sort by timestamp
      allEntries.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
      return { ok: true, entries: allEntries.slice(-200) };
    } catch (e) {
      return { ok: true, entries: [] };
    }
  }));

  ipcMain.handle('log:clear', requireAdminNoArgs(async () => {
    logger.ipc('log:clear', 'Clearing log');
    try {
      logger.clearAllLogs();
      logger.success('log:clear', 'All logs cleared');
      return { ok: true };
    } catch (e) {
      logger.error('log:clear', e.message, { stack: e.stack });
      return { ok: false };
    }
  }));

  ipcMain.handle('admin:users', requireAdminNoArgs(async () => {
    logger.ipc('admin:users', 'Admin listing all users');
    try {
      const { data: users, error } = await supabase.from('vault_users')
        .select('id,name,email,avatar_url,created_at,last_seen')
        .order('created_at', { ascending: false });
      if (error) { logger.error('admin:users', 'Failed', error.message); throw new Error('Failed to list users'); }
      logger.success('admin:users', 'Found ' + (users ? users.length : 0) + ' users');
      return { ok: true, users: users || [] };
    } catch (e) {
      logger.error('admin:users', e.message, { stack: e.stack });
      logger.writeError('admin:users', e);
      return { ok: false, error: 'Failed to list users' };
    }
  }));

  ipcMain.handle('admin:stats', requireAdminNoArgs(async () => {
    logger.ipc('admin:stats', 'Admin fetching global stats');
    try {
      const [users, items, jobs, totp] = await Promise.all([
        supabase.from('vault_users').select('id', { count: 'exact', head: true }),
        supabase.from('vault_items').select('id', { count: 'exact', head: true }).is('deleted_at', null),
        supabase.from('vault_jobs').select('id', { count: 'exact', head: true }).is('deleted_at', null),
        supabase.from('vault_totp').select('id', { count: 'exact', head: true }),
      ]);
      const stats = {
        totalUsers: users.count || 0,
        totalItems: items.count || 0,
        totalJobs:  jobs.count || 0,
        totalTotp:  totp.count || 0,
      };
      logger.success('admin:stats', 'Global stats loaded', stats);
      return { ok: true, stats };
    } catch (e) {
      logger.error('admin:stats', e.message, { stack: e.stack });
      logger.writeError('admin:stats', e);
      return { ok: false, error: 'Failed to load stats' };
    }
  }));
}

module.exports = { register };
