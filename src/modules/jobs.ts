import type { SupabaseClient } from '@supabase/supabase-js';
import type { Job, JobStatus, Session } from '../types';
import { sanitizeStr, validEmail, MAX_NOTES_LEN } from './validation';

import type Electron from 'electron';
type Logger = {
  dbLog: (ctx: string, msg: string, data?: unknown) => void;
  error: (ctx: string, msg: string, data?: unknown) => void;
  success: (ctx: string, msg: string, data?: unknown) => void;
  warn: (ctx: string, msg: string, data?: unknown) => void;
  ipcLog: (ctx: string, msg: string, data?: unknown) => void;
};
type LogError = (ctx: string, err: unknown) => void;
type IpcHandler = (...args: any[]) => any;
type AuthWrapper = (fn: IpcHandler) => IpcHandler;

const VALID_JOB_STATUSES: readonly JobStatus[] = ['wait', 'accepted', 'rejected'];

function register(
  ipcMain: Electron.IpcMain,
  requireAuth: AuthWrapper,
  requireAuthNoArgs: AuthWrapper,
  supabase: SupabaseClient,
  _validation: { sanitizeStr: typeof sanitizeStr; validEmail: typeof validEmail; MAX_NOTES_LEN: number },
  getSession: () => Session | null,
  logger: Logger,
  logError: LogError,
) {
  async function dbLoadJobs(userId: string): Promise<Job[]> {
    logger.dbLog('dbLoadJobs', 'Loading jobs', { userId });
    const { data, error } = await supabase.from('vault_jobs')
      .select('id,user_id,company,role,email,applied_at,status,notes,sort_order,created_at,updated_at')
      .eq('user_id', userId).is('deleted_at', null)
      .order('sort_order', { ascending: true }).order('created_at', { ascending: false });
    if (error) { logger.error('dbLoadJobs', 'Failed', error.message); throw new Error('Failed to load jobs'); }
    logger.dbLog('dbLoadJobs', 'Jobs loaded', { count: data.length });
    return data as unknown as Job[];
  }

  async function dbSaveJob(userId: string, job: Job): Promise<number> {
    logger.dbLog('dbSaveJob', 'Saving job', { userId, jobId: job?.id, company: job?.company });
    const { id, ...payload } = job;
    const safePayload = {
      company: payload.company,
      role: payload.role,
      email: payload.email,
      applied_at: payload.applied_at,
      status: payload.status,
      notes: payload.notes,
      sort_order: payload.sort_order,
    };
    if (id) {
      const { error } = await supabase.from('vault_jobs')
        .update({ ...safePayload, updated_at: new Date().toISOString() }).eq('id', id).eq('user_id', userId);
      if (error) { logger.error('dbSaveJob', 'Update failed', error.message); throw new Error('Failed to save job'); }
      logger.dbLog('dbSaveJob', 'Job updated', { jobId: id });
      return id;
    }
    const { data, error } = await supabase.from('vault_jobs')
      .insert({ user_id: userId, ...safePayload }).select('id').single();
    if (error) { logger.error('dbSaveJob', 'Insert failed', error.message); throw new Error('Failed to save job'); }
    logger.dbLog('dbSaveJob', 'Job inserted', { jobId: data.id });
    return data.id;
  }

  async function dbDeleteJob(id: number, userId: string): Promise<void> {
    logger.dbLog('dbDeleteJob', 'Soft-deleting job', { jobId: id, userId });
    const { error } = await supabase.from('vault_jobs')
      .update({ deleted_at: new Date().toISOString() }).eq('id', id).eq('user_id', userId);
    if (error) { logger.error('dbDeleteJob', 'Failed', error.message); throw new Error('Failed to delete job'); }
    logger.dbLog('dbDeleteJob', 'Success', { jobId: id });
  }

  async function dbRestoreJob(id: number, userId: string): Promise<void> {
    logger.dbLog('dbRestoreJob', 'Restoring job', { jobId: id, userId });
    const { error } = await supabase.from('vault_jobs')
      .update({ deleted_at: null }).eq('id', id).eq('user_id', userId);
    if (error) { logger.error('dbRestoreJob', 'Failed', error.message); throw new Error('Failed to restore job'); }
    logger.dbLog('dbRestoreJob', 'Success', { jobId: id });
  }

  async function dbPermDeleteJob(id: number, userId: string): Promise<void> {
    logger.dbLog('dbPermDeleteJob', 'Permanently deleting job', { jobId: id, userId });
    const { error } = await supabase.from('vault_jobs').delete().eq('id', id).eq('user_id', userId);
    if (error) { logger.error('dbPermDeleteJob', 'Failed', error.message); throw new Error('Failed to delete job'); }
    logger.dbLog('dbPermDeleteJob', 'Success', { jobId: id });
  }

  async function dbLoadJobTrash(userId: string): Promise<Job[]> {
    logger.dbLog('dbLoadJobTrash', 'Loading job trash', { userId });
    try {
      await supabase.from('vault_jobs').delete().eq('user_id', userId)
        .not('deleted_at', 'is', null).lt('deleted_at', new Date(Date.now() - 30 * 86400000).toISOString());
    } catch (e: unknown) { const msg = e instanceof Error ? e.message : String(e); logger.warn('dbLoadJobTrash', '30-day purge failed, continuing', msg); }
    const { data, error } = await supabase.from('vault_jobs')
      .select('id,user_id,company,role,email,applied_at,status,notes,sort_order,created_at,updated_at,deleted_at')
      .eq('user_id', userId).not('deleted_at', 'is', null).order('deleted_at', { ascending: false });
    if (error) { logger.error('dbLoadJobTrash', 'Failed', error.message); throw new Error('Failed to load job trash'); }
    logger.dbLog('dbLoadJobTrash', 'Job trash loaded', { count: data.length });
    return data as unknown as Job[];
  }

  async function dbUpdateJobOrder(jobs: Array<{ id?: number }>, userId: string): Promise<void> {
    logger.dbLog('dbUpdateJobOrder', 'Updating job order', { userId, count: jobs?.length });
    await Promise.all(jobs.map((j, i) =>
      j.id ? supabase.from('vault_jobs').update({ sort_order: i }).eq('id', j.id).eq('user_id', userId) : Promise.resolve()
    ));
    logger.dbLog('dbUpdateJobOrder', 'Success');
  }

  ipcMain.handle('jobs:load', requireAuthNoArgs(async () => {
    logger.ipcLog('jobs:load', 'Loading jobs');
    try {
      const session = getSession();
      if (!session) throw new Error('No session');
      const jobs = await dbLoadJobs(session.userId);
      logger.success('jobs:load', 'Jobs loaded', { count: jobs.length });
      return { ok: true, jobs };
    } catch (e: unknown) { const err = e as Error; logError('jobs:load', err); return { ok: false, error: err.message }; }
  }));

  ipcMain.handle('jobs:save', requireAuth(async (_e, { job }: { job: Job }) => {
    logger.ipcLog('jobs:save', 'Saving job', { jobId: job?.id, company: job?.company });
    try {
      if (!job || typeof job !== 'object') { logger.warn('jobs:save', 'Invalid job data'); return { ok: false, error: 'Invalid job data' }; }
      job.company = sanitizeStr(job.company);
      job.role = sanitizeStr(job.role);
      if (job.email && !validEmail(job.email)) { logger.warn('jobs:save', 'Invalid email', { email: job.email }); return { ok: false, error: 'Invalid email' }; }
      job.notes = sanitizeStr(job.notes, MAX_NOTES_LEN);
      if (job.status && !VALID_JOB_STATUSES.includes(job.status)) { logger.warn('jobs:save', 'Invalid status', { status: job.status }); return { ok: false, error: 'Invalid status' }; }
      if (job.applied_at) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(job.applied_at)) { logger.warn('jobs:save', 'Invalid date', { applied_at: job.applied_at }); return { ok: false, error: 'Invalid date format (YYYY-MM-DD)' }; }
        const year = parseInt(job.applied_at.slice(0, 4), 10);
        const month = parseInt(job.applied_at.slice(5, 7), 10);
        const day = parseInt(job.applied_at.slice(8, 10), 10);
        if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) { logger.warn('jobs:save', 'Date out of range', { applied_at: job.applied_at }); return { ok: false, error: 'Applied date must be a valid date between 2000 and 2100' }; }
        const d = new Date(job.applied_at + 'T00:00:00.000Z');
        if (isNaN(d.getTime()) || d.getUTCMonth() + 1 !== month || d.getUTCDate() !== day) { logger.warn('jobs:save', 'Invalid calendar date', { applied_at: job.applied_at }); return { ok: false, error: 'Applied date is not a valid calendar date' }; }
      }
      const session = getSession();
      if (!session) throw new Error('No session');
      const id = await dbSaveJob(session.userId, job);
      logger.success('jobs:save', 'Job saved', { jobId: id, company: job.company });
      return { ok: true, id };
    } catch (e: unknown) { const err = e as Error; logError('jobs:save', err); return { ok: false, error: err.message }; }
  }));

  ipcMain.handle('jobs:delete', requireAuth(async (_e, { id }: { id: number }) => {
    logger.ipcLog('jobs:delete', 'Deleting job', { jobId: id });
    try {
      const session = getSession();
      if (!session) throw new Error('No session');
      await dbDeleteJob(id, session.userId);
      logger.success('jobs:delete', 'Job deleted', { jobId: id });
      return { ok: true };
    } catch (e: unknown) { const err = e as Error; logError('jobs:delete', err); return { ok: false, error: err.message }; }
  }));

  ipcMain.handle('jobs:reorder', requireAuth(async (_e, { jobs }: { jobs: Array<{ id?: number }> }) => {
    logger.ipcLog('jobs:reorder', 'Reordering jobs', { count: jobs?.length });
    try {
      const session = getSession();
      if (!session) throw new Error('No session');
      await dbUpdateJobOrder(jobs, session.userId);
      logger.success('jobs:reorder', 'Jobs reordered');
      return { ok: true };
    } catch (e: unknown) { const err = e as Error; logError('jobs:reorder', err); return { ok: false }; }
  }));

  ipcMain.handle('jobs:trash:load', requireAuthNoArgs(async () => {
    logger.ipcLog('jobs:trash:load', 'Loading job trash');
    try {
      const session = getSession();
      if (!session) throw new Error('No session');
      const items = await dbLoadJobTrash(session.userId);
      logger.success('jobs:trash:load', 'Job trash loaded', { count: items.length });
      return { ok: true, items };
    } catch (e: unknown) { const err = e as Error; logError('jobs:trash:load', err); return { ok: false, error: err.message }; }
  }));

  ipcMain.handle('jobs:trash:restore', requireAuth(async (_e, { id }: { id: number }) => {
    logger.ipcLog('jobs:trash:restore', 'Restoring job', { jobId: id });
    try {
      const session = getSession();
      if (!session) throw new Error('No session');
      await dbRestoreJob(id, session.userId);
      logger.success('jobs:trash:restore', 'Job restored', { jobId: id });
      return { ok: true };
    } catch (e: unknown) { const err = e as Error; logError('jobs:trash:restore', err); return { ok: false, error: err.message }; }
  }));

  ipcMain.handle('jobs:trash:purge', requireAuth(async (_e, { id }: { id: number }) => {
    logger.ipcLog('jobs:trash:purge', 'Purging job', { jobId: id });
    try {
      const session = getSession();
      if (!session) throw new Error('No session');
      await dbPermDeleteJob(id, session.userId);
      logger.success('jobs:trash:purge', 'Job purged', { jobId: id });
      return { ok: true };
    } catch (e: unknown) { const err = e as Error; logError('jobs:trash:purge', err); return { ok: false, error: err.message }; }
  }));

  return {
    dbLoadJobs,
    dbSaveJob,
    dbDeleteJob,
    dbRestoreJob,
    dbPermDeleteJob,
    dbLoadJobTrash,
    dbUpdateJobOrder,
  };
}

export { register };
