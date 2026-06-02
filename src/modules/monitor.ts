import path from 'path';
import fs from 'fs';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DbStats, AdminStats, LogEntry, Session, VaultUser } from '../types';

import type Electron from 'electron';
type Logger = {
  db: (ctx: string, msg: string, data?: unknown) => void;
  error: (ctx: string, msg: string, data?: unknown) => void;
  success: (ctx: string, msg: string, data?: unknown) => void;
  ipc: (ctx: string, msg: string, data?: unknown) => void;
  warn: (ctx: string, msg: string, data?: unknown) => void;
  readLog?: (level: string, maxLines: number) => string;
  clearAllLogs?: () => void;
  writeError?: (ctx: string, err: unknown) => void;
};
type LogError = (ctx: string, err: unknown) => void;
type IpcHandler = (...args: any[]) => any;
type AdminWrapper = (fn: IpcHandler) => IpcHandler;

function register(
  ipcMain: Electron.IpcMain,
  requireAdminNoArgs: AdminWrapper,
  supabase: SupabaseClient,
  logger: Logger,
  getSession: () => Session | null,
  LOG_PATH: string,
) {
  async function dbGetStats(userId: string): Promise<DbStats> {
    logger.db('dbGetStats', 'Getting stats', { userId });
    const [items, jobs, jobTrash, itemTrash] = await Promise.all([
      supabase.from('vault_items').select('id', { count: 'exact' }).eq('user_id', userId).is('deleted_at', null),
      supabase.from('vault_jobs').select('id', { count: 'exact' }).eq('user_id', userId).is('deleted_at', null),
      supabase.from('vault_jobs').select('id', { count: 'exact' }).eq('user_id', userId).not('deleted_at', 'is', null),
      supabase.from('vault_items').select('id', { count: 'exact' }).eq('user_id', userId).not('deleted_at', 'is', null),
    ]);
    let logSize = 0;
    try { logSize = fs.statSync(LOG_PATH).size; } catch { /* noop */ }
    let dbSizeBytes = 0;
    try {
      const { data } = await supabase.rpc('get_db_size').single();
      if (data) dbSizeBytes = data as number;
    } catch { /* noop */ }
    const stats: DbStats = {
      items: items.count || 0,
      jobs: jobs.count || 0,
      trash: (itemTrash.count || 0) + (jobTrash.count || 0),
      logSize,
      dbSizeBytes,
    };
    logger.db('dbGetStats', 'Stats retrieved', stats);
    return stats;
  }

  ipcMain.handle('monitor:stats', requireAdminNoArgs(async () => {
    logger.ipc('monitor:stats', 'Loading monitor stats');
    try {
      const session = getSession();
      if (!session) throw new Error('No session');
      const stats = await dbGetStats(session.userId);
      logger.success('monitor:stats', 'Stats loaded', stats);
      return { ok: true, stats };
    } catch (e: unknown) { const err = e as Error; logger.error('monitor:stats', err.message, { stack: err.stack }); return { ok: false, error: err.message }; }
  }));

  ipcMain.handle('log:read', requireAdminNoArgs(async () => {
    logger.ipc('log:read', 'Reading logs');
    try {
      const levels = ['ERROR', 'WARN', 'INFO', 'DEBUG', 'AUTH', 'DB', 'IPC', 'SUCCESS'];
      const allEntries: LogEntry[] = [];
      for (const lvl of levels) {
        const content = logger.readLog ? logger.readLog(lvl, 5000) : '';
        if (!content || content.startsWith('(no ') || content.startsWith('(could')) continue;
        const lines = content.split('\n').filter(l => l.trim());
        for (const line of lines) {
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
      allEntries.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
      return { ok: true, entries: allEntries.slice(-200) };
    } catch {
      return { ok: true, entries: [] };
    }
  }));

  ipcMain.handle('log:clear', requireAdminNoArgs(async () => {
    logger.ipc('log:clear', 'Clearing log');
    try {
      if (logger.clearAllLogs) logger.clearAllLogs();
      logger.success('log:clear', 'All logs cleared');
      return { ok: true };
    } catch (e: unknown) { const err = e as Error; logger.error('log:clear', err.message, { stack: err.stack }); return { ok: false }; }
  }));

  ipcMain.handle('admin:users', requireAdminNoArgs(async () => {
    logger.ipc('admin:users', 'Admin listing all users');
    try {
      const { data: users, error } = await supabase.from('vault_users')
        .select('id,name,email,avatar_url,created_at,last_seen')
        .order('created_at', { ascending: false });
      if (error) { logger.error('admin:users', 'Failed', error.message); throw new Error('Failed to list users'); }
      logger.success('admin:users', 'Found ' + (users ? users.length : 0) + ' users');
      return { ok: true, users: (users || []) as unknown as VaultUser[] };
    } catch (e: unknown) { const err = e as Error; logger.error('admin:users', err.message, { stack: err.stack }); logger.writeError ? logger.writeError('admin:users', err) : null; return { ok: false, error: 'Failed to list users' }; }
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
      const stats: AdminStats = {
        totalUsers: users.count || 0,
        totalItems: items.count || 0,
        totalJobs: jobs.count || 0,
        totalTotp: totp.count || 0,
      };
      logger.success('admin:stats', 'Global stats loaded', stats);
      return { ok: true, stats };
    } catch (e: unknown) { const err = e as Error; logger.error('admin:stats', err.message, { stack: err.stack }); logger.writeError ? logger.writeError('admin:stats', err) : null; return { ok: false, error: 'Failed to load stats' }; }
  }));
}

export { register };
