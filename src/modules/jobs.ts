import type { DriveClient } from './drive';
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
  driveClient: DriveClient | null,
  _validation: { sanitizeStr: typeof sanitizeStr; validEmail: typeof validEmail; MAX_NOTES_LEN: number },
  getSession: () => Session | null,
  logger: Logger,
  logError: LogError,
) {
  function dbLoadJobs(): Job[] {
    logger.dbLog('dbLoadJobs', 'Loading jobs from cache');
    if (!driveClient) return [];
    const items = driveClient.loadItems('job');
    const jobs: Job[] = items.map(item => {
      const decrypted = JSON.parse(Buffer.from(item.encryptedData, 'base64').toString('utf8')) as Record<string, unknown>;
      return {
        id: item.id,
        company: decrypted.company as string || '',
        role: decrypted.role as string || '',
        email: decrypted.email as string || '',
        applied_at: decrypted.applied_at as string || '',
        status: (decrypted.status as JobStatus) || 'wait',
        notes: decrypted.notes as string || '',
        sort_order: item.sortOrder,
        created_at: item.createdAt,
        updated_at: item.updatedAt,
      };
    });
    logger.dbLog('dbLoadJobs', 'Jobs loaded', { count: jobs.length });
    return jobs;
  }

  function dbSaveJob(job: Job): string {
    logger.dbLog('dbSaveJob', 'Saving job', { jobId: job?.id, company: job?.company });
    if (!driveClient) throw new Error('Drive not initialized');
    const payload = {
      company: job.company,
      role: job.role,
      email: job.email,
      applied_at: job.applied_at,
      status: job.status,
      notes: job.notes,
    };
    const encrypted = Buffer.from(JSON.stringify(payload)).toString('base64');
    // We store the encrypted blob as-is; DriveClient handles encryption at rest
    // Actually, we need to use the same encryption as the rest of the vault
    // The item is already encrypted by the caller, so we store it directly
    const id = driveClient.saveItem('job', encrypted, job.id, job.sort_order);
    logger.dbLog('dbSaveJob', 'Job saved', { jobId: id });
    return id;
  }

  function dbDeleteJob(id: string): void {
    logger.dbLog('dbDeleteJob', 'Soft-deleting job', { jobId: id });
    if (!driveClient) throw new Error('Drive not initialized');
    driveClient.softDelete('job', id);
    logger.dbLog('dbDeleteJob', 'Success', { jobId: id });
  }

  function dbRestoreJob(id: string): void {
    logger.dbLog('dbRestoreJob', 'Restoring job', { jobId: id });
    if (!driveClient) throw new Error('Drive not initialized');
    driveClient.restore('job', id);
    logger.dbLog('dbRestoreJob', 'Success', { jobId: id });
  }

  function dbPermDeleteJob(id: string): void {
    logger.dbLog('dbPermDeleteJob', 'Permanently deleting job', { jobId: id });
    if (!driveClient) throw new Error('Drive not initialized');
    driveClient.permDelete('job', id);
    logger.dbLog('dbPermDeleteJob', 'Success', { jobId: id });
  }

  function dbLoadJobTrash(): Job[] {
    logger.dbLog('dbLoadJobTrash', 'Loading job trash');
    if (!driveClient) return [];
    const items = driveClient.loadTrash('job');
    const jobs: Job[] = items.map(item => {
      const decrypted = JSON.parse(Buffer.from(item.encryptedData, 'base64').toString('utf8')) as Record<string, unknown>;
      return {
        id: item.id,
        company: decrypted.company as string || '',
        role: decrypted.role as string || '',
        email: decrypted.email as string || '',
        applied_at: decrypted.applied_at as string || '',
        status: (decrypted.status as JobStatus) || 'wait',
        notes: decrypted.notes as string || '',
        sort_order: item.sortOrder,
        created_at: item.createdAt,
        updated_at: item.updatedAt,
        deleted_at: item.deletedAt || undefined,
      };
    });
    logger.dbLog('dbLoadJobTrash', 'Job trash loaded', { count: jobs.length });
    return jobs;
  }

  function dbUpdateJobOrder(jobs: Array<{ id?: string }>): void {
    logger.dbLog('dbUpdateJobOrder', 'Updating job order', { count: jobs?.length });
    if (!driveClient) throw new Error('Drive not initialized');
    driveClient.updateSortOrder('job', jobs);
    logger.dbLog('dbUpdateJobOrder', 'Success');
  }

  ipcMain.handle('jobs:load', requireAuthNoArgs(async () => {
    logger.ipcLog('jobs:load', 'Loading jobs');
    try {
      const jobs = dbLoadJobs();
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
      const id = dbSaveJob(job);
      logger.success('jobs:save', 'Job saved', { jobId: id, company: job.company });
      return { ok: true, id };
    } catch (e: unknown) { const err = e as Error; logError('jobs:save', err); return { ok: false, error: err.message }; }
  }));

  ipcMain.handle('jobs:delete', requireAuth(async (_e, { id }: { id: string }) => {
    logger.ipcLog('jobs:delete', 'Deleting job', { jobId: id });
    try {
      dbDeleteJob(id);
      logger.success('jobs:delete', 'Job deleted', { jobId: id });
      return { ok: true };
    } catch (e: unknown) { const err = e as Error; logError('jobs:delete', err); return { ok: false, error: err.message }; }
  }));

  ipcMain.handle('jobs:reorder', requireAuth(async (_e, { jobs }: { jobs: Array<{ id?: string }> }) => {
    logger.ipcLog('jobs:reorder', 'Reordering jobs', { count: jobs?.length });
    try {
      dbUpdateJobOrder(jobs);
      logger.success('jobs:reorder', 'Jobs reordered');
      return { ok: true };
    } catch (e: unknown) { const err = e as Error; logError('jobs:reorder', err); return { ok: false }; }
  }));

  ipcMain.handle('jobs:trash:load', requireAuthNoArgs(async () => {
    logger.ipcLog('jobs:trash:load', 'Loading job trash');
    try {
      const items = dbLoadJobTrash();
      logger.success('jobs:trash:load', 'Job trash loaded', { count: items.length });
      return { ok: true, items };
    } catch (e: unknown) { const err = e as Error; logError('jobs:trash:load', err); return { ok: false, error: err.message }; }
  }));

  ipcMain.handle('jobs:trash:restore', requireAuth(async (_e, { id }: { id: string }) => {
    logger.ipcLog('jobs:trash:restore', 'Restoring job', { jobId: id });
    try {
      dbRestoreJob(id);
      logger.success('jobs:trash:restore', 'Job restored', { jobId: id });
      return { ok: true };
    } catch (e: unknown) { const err = e as Error; logError('jobs:trash:restore', err); return { ok: false, error: err.message }; }
  }));

  ipcMain.handle('jobs:trash:purge', requireAuth(async (_e, { id }: { id: string }) => {
    logger.ipcLog('jobs:trash:purge', 'Purging job', { jobId: id });
    try {
      dbPermDeleteJob(id);
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
