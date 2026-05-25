'use strict';

const { sanitizeStr, validEmail, MAX_NOTES_LEN } = require('./validation');

const VALID_JOB_STATUSES = ['wait', 'accepted', 'rejected'];

function register(ipcMain, requireAuth, requireAuthNoArgs, supabase, validation, getSession, logger, logError) {
  // ── DB helpers ──────────────────────────────────────────────────────────────

  async function dbLoadJobs(userId) {
    logger.db('dbLoadJobs', 'Loading jobs', { userId });
    const { data, error } = await supabase.from('vault_jobs')
      .select('id,user_id,company,role,email,applied_at,status,notes,sort_order,created_at,updated_at')
      .eq('user_id', userId).is('deleted_at', null)
      .order('sort_order', { ascending: true }).order('created_at', { ascending: false });
    if (error) { logger.error('dbLoadJobs', 'Failed', error.message); throw new Error('Failed to load jobs'); }
    logger.db('dbLoadJobs', 'Jobs loaded', { count: data.length });
    return data;
  }

  async function dbSaveJob(userId, job) {
    logger.db('dbSaveJob', 'Saving job', { userId, jobId: job?.id, company: job?.company });
    const { id, ...payload } = job;
    if (id) {
      const { error } = await supabase.from('vault_jobs')
        .update({ ...payload, updated_at: new Date().toISOString() }).eq('id', id).eq('user_id', userId);
      if (error) { logger.error('dbSaveJob', 'Update failed', error.message); throw new Error('Failed to save job'); }
      logger.db('dbSaveJob', 'Job updated', { jobId: id });
      return id;
    }
    const { data, error } = await supabase.from('vault_jobs')
      .insert({ user_id: userId, ...payload }).select('id').single();
    if (error) { logger.error('dbSaveJob', 'Insert failed', error.message); throw new Error('Failed to save job'); }
    logger.db('dbSaveJob', 'Job inserted', { jobId: data.id });
    return data.id;
  }

  async function dbDeleteJob(id, userId) {
    logger.db('dbDeleteJob', 'Soft-deleting job', { jobId: id, userId });
    const { error } = await supabase.from('vault_jobs')
      .update({ deleted_at: new Date().toISOString() }).eq('id', id).eq('user_id', userId);
    if (error) { logger.error('dbDeleteJob', 'Failed', error.message); throw new Error('Failed to delete job'); }
    logger.db('dbDeleteJob', 'Success', { jobId: id });
  }

  async function dbRestoreJob(id, userId) {
    logger.db('dbRestoreJob', 'Restoring job', { jobId: id, userId });
    const { error } = await supabase.from('vault_jobs')
      .update({ deleted_at: null }).eq('id', id).eq('user_id', userId);
    if (error) { logger.error('dbRestoreJob', 'Failed', error.message); throw new Error('Failed to restore job'); }
    logger.db('dbRestoreJob', 'Success', { jobId: id });
  }

  async function dbPermDeleteJob(id, userId) {
    logger.db('dbPermDeleteJob', 'Permanently deleting job', { jobId: id, userId });
    const { error } = await supabase.from('vault_jobs').delete().eq('id', id).eq('user_id', userId);
    if (error) { logger.error('dbPermDeleteJob', 'Failed', error.message); throw new Error('Failed to delete job'); }
    logger.db('dbPermDeleteJob', 'Success', { jobId: id });
  }

  async function dbLoadJobTrash(userId) {
    logger.db('dbLoadJobTrash', 'Loading job trash', { userId });
    await supabase.from('vault_jobs').delete().eq('user_id', userId)
      .not('deleted_at', 'is', null).lt('deleted_at', new Date(Date.now() - 30 * 86400000).toISOString());
    const { data, error } = await supabase.from('vault_jobs')
      .select('id,user_id,company,role,email,applied_at,status,notes,sort_order,created_at,updated_at,deleted_at')
      .eq('user_id', userId).not('deleted_at', 'is', null).order('deleted_at', { ascending: false });
    if (error) { logger.error('dbLoadJobTrash', 'Failed', error.message); throw new Error('Failed to load job trash'); }
    logger.db('dbLoadJobTrash', 'Job trash loaded', { count: data.length });
    return data;
  }

  async function dbUpdateJobOrder(jobs, userId) {
    logger.db('dbUpdateJobOrder', 'Updating job order', { userId, count: jobs?.length });
    await Promise.all(jobs.map((j, i) =>
      j.id ? supabase.from('vault_jobs').update({ sort_order: i }).eq('id', j.id).eq('user_id', userId) : Promise.resolve()
    ));
    logger.db('dbUpdateJobOrder', 'Success');
  }

  // ── IPC handlers ────────────────────────────────────────────────────────────

  ipcMain.handle('jobs:load', requireAuthNoArgs(async () => {
    logger.ipc('jobs:load', 'Loading jobs');
    try {
      const session = getSession();
      const jobs = await dbLoadJobs(session.userId);
      logger.success('jobs:load', 'Jobs loaded', { count: jobs.length });
      return { ok: true, jobs };
    } catch (e) { logError('jobs:load', e); return { ok: false, error: e.message }; }
  }));

  ipcMain.handle('jobs:save', requireAuth(async (_e, { job }) => {
    logger.ipc('jobs:save', 'Saving job', { jobId: job?.id, company: job?.company });
    try {
      if (!job || typeof job !== 'object') { logger.warn('jobs:save', 'Invalid job data'); return { ok: false, error: 'Invalid job data' }; }
      job.company = sanitizeStr(job.company);
      job.role = sanitizeStr(job.role);
      if (job.email && !validEmail(job.email)) { logger.warn('jobs:save', 'Invalid email', { email: job.email }); return { ok: false, error: 'Invalid email' }; }
      job.notes = sanitizeStr(job.notes, MAX_NOTES_LEN);
      if (job.status && !VALID_JOB_STATUSES.includes(job.status)) { logger.warn('jobs:save', 'Invalid status', { status: job.status }); return { ok: false, error: 'Invalid status' }; }
      if (job.applied_at && !/^\d{4}-\d{2}-\d{2}$/.test(job.applied_at)) { logger.warn('jobs:save', 'Invalid date', { applied_at: job.applied_at }); return { ok: false, error: 'Invalid date format (YYYY-MM-DD)' }; }
      const session = getSession();
      const id = await dbSaveJob(session.userId, job);
      logger.success('jobs:save', 'Job saved', { jobId: id, company: job.company });
      return { ok: true, id };
    } catch (e) { logError('jobs:save', e); return { ok: false, error: e.message }; }
  }));

  ipcMain.handle('jobs:delete', requireAuth(async (_e, { id }) => {
    logger.ipc('jobs:delete', 'Deleting job', { jobId: id });
    try {
      const session = getSession();
      await dbDeleteJob(id, session.userId);
      logger.success('jobs:delete', 'Job deleted', { jobId: id });
      return { ok: true };
    } catch (e) { logError('jobs:delete', e); return { ok: false, error: e.message }; }
  }));

  ipcMain.handle('jobs:reorder', requireAuth(async (_e, { jobs }) => {
    logger.ipc('jobs:reorder', 'Reordering jobs', { count: jobs?.length });
    try {
      const session = getSession();
      await dbUpdateJobOrder(jobs, session.userId);
      logger.success('jobs:reorder', 'Jobs reordered');
      return { ok: true };
    } catch (e) { logError('jobs:reorder', e); return { ok: false }; }
  }));

  ipcMain.handle('jobs:trash:load', requireAuthNoArgs(async () => {
    logger.ipc('jobs:trash:load', 'Loading job trash');
    try {
      const session = getSession();
      const items = await dbLoadJobTrash(session.userId);
      logger.success('jobs:trash:load', 'Job trash loaded', { count: items.length });
      return { ok: true, items };
    } catch (e) { logError('jobs:trash:load', e); return { ok: false, error: e.message }; }
  }));

  ipcMain.handle('jobs:trash:restore', requireAuth(async (_e, { id }) => {
    logger.ipc('jobs:trash:restore', 'Restoring job', { jobId: id });
    try {
      const session = getSession();
      await dbRestoreJob(id, session.userId);
      logger.success('jobs:trash:restore', 'Job restored', { jobId: id });
      return { ok: true };
    } catch (e) { logError('jobs:trash:restore', e); return { ok: false, error: e.message }; }
  }));

  ipcMain.handle('jobs:trash:purge', requireAuth(async (_e, { id }) => {
    logger.ipc('jobs:trash:purge', 'Purging job', { jobId: id });
    try {
      const session = getSession();
      await dbPermDeleteJob(id, session.userId);
      logger.success('jobs:trash:purge', 'Job purged', { jobId: id });
      return { ok: true };
    } catch (e) { logError('jobs:trash:purge', e); return { ok: false, error: e.message }; }
  }));

  // Export DB helpers for testing / direct use
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

module.exports = { register };
