import type { SupabaseClient } from '@supabase/supabase-js';
import type { TotpItem, Session } from '../types';
import { sanitizeStr, validTotpSecret } from './validation';

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
type EncFn = (obj: object, key: string) => string;
type DecFn = (str: string, key: string) => Record<string, unknown> | null;

function register(
  ipcMain: Electron.IpcMain,
  requireAuth: AuthWrapper,
  requireAuthNoArgs: AuthWrapper,
  supabase: SupabaseClient,
  getSession: () => Session | null,
  logger: Logger,
  enc: EncFn,
  dec: DecFn,
  logError: LogError,
) {
  async function dbLoadTotp(userId: string, encKey: string): Promise<TotpItem[]> {
    logger.dbLog('dbLoadTotp', 'Loading TOTP items', { userId });
    const { data, error } = await supabase.from('vault_totp')
      .select('id,user_id,name,issuer,secret,icon,sort_order')
      .eq('user_id', userId).order('sort_order', { ascending: true });
    if (error) { logger.error('dbLoadTotp', 'Failed', error.message); throw new Error('Failed to load TOTP items'); }
    logger.dbLog('dbLoadTotp', 'TOTP items loaded', { count: data.length });
    return data.map((row: Record<string, unknown>) => ({
      id: row.id as number, name: row.name as string, issuer: row.issuer as string,
      secret: (dec(row.secret as string, encKey) as Record<string, string>)?.['secret'] || '',
      icon: row.icon as string, sort_order: row.sort_order as number,
    }));
  }

  async function dbSaveTotp(userId: string, item: TotpItem, encKey: string): Promise<number> {
    logger.dbLog('dbSaveTotp', 'Saving TOTP item', { userId, itemId: item?.id, name: item?.name });
    const { id, ...payload } = item;
    const encSecret = enc({ secret: item.secret }, encKey);
    if (id) {
      const { error } = await supabase.from('vault_totp')
        .update({ name: payload.name, issuer: payload.issuer, secret: encSecret, icon: payload.icon })
        .eq('id', id).eq('user_id', userId);
      if (error) { logger.error('dbSaveTotp', 'Update failed', error.message); throw new Error('Failed to save TOTP item'); }
      logger.dbLog('dbSaveTotp', 'TOTP item updated', { itemId: id });
      return id;
    }
    const { data, error } = await supabase.from('vault_totp')
      .insert({ user_id: userId, name: payload.name, issuer: payload.issuer, secret: encSecret, icon: payload.icon || '🔐' })
      .select('id').single();
    if (error) { logger.error('dbSaveTotp', 'Insert failed', error.message); throw new Error('Failed to save TOTP item'); }
    logger.dbLog('dbSaveTotp', 'TOTP item inserted', { itemId: data.id });
    return data.id;
  }

  async function dbDeleteTotp(id: number, userId: string): Promise<void> {
    logger.dbLog('dbDeleteTotp', 'Deleting TOTP item', { itemId: id, userId });
    const { error } = await supabase.from('vault_totp').delete().eq('id', id).eq('user_id', userId);
    if (error) { logger.error('dbDeleteTotp', 'Failed', error.message); throw new Error('Failed to delete TOTP item'); }
    logger.dbLog('dbDeleteTotp', 'Success', { itemId: id });
  }

  ipcMain.handle('totp:load', requireAuthNoArgs(async () => {
    logger.ipcLog('totp:load', 'Loading TOTP items');
    try {
      const session = getSession();
      if (!session) throw new Error('No session');
      const items = await dbLoadTotp(session.userId, session.encKey);
      logger.success('totp:load', 'TOTP items loaded', { count: items.length });
      return { ok: true, items };
    } catch (e: unknown) { const err = e as Error; logError('totp:load', err); return { ok: false, error: err.message }; }
  }));

  ipcMain.handle('totp:save', requireAuth(async (_e, { item }: { item: TotpItem }) => {
    logger.ipcLog('totp:save', 'Saving TOTP item', { itemId: item?.id, name: item?.name });
    try {
      if (!item || typeof item !== 'object') { logger.warn('totp:save', 'Invalid TOTP data'); return { ok: false, error: 'Invalid TOTP data' }; }
      item.name = sanitizeStr(item.name); item.issuer = sanitizeStr(item.issuer);
      if (!validTotpSecret(item.secret)) { logger.warn('totp:save', 'Invalid TOTP secret'); return { ok: false, error: 'Invalid TOTP secret (base32: A-Z, 2-7, 16+ chars)' }; }
      const session = getSession();
      if (!session) throw new Error('No session');
      const id = await dbSaveTotp(session.userId, item, session.encKey);
      logger.success('totp:save', 'TOTP item saved', { itemId: id, name: item.name });
      return { ok: true, id };
    } catch (e: unknown) { const err = e as Error; logError('totp:save', err); return { ok: false, error: err.message }; }
  }));

  ipcMain.handle('totp:delete', requireAuth(async (_e, { id }: { id: number }) => {
    logger.ipcLog('totp:delete', 'Deleting TOTP item', { itemId: id });
    try {
      const session = getSession();
      if (!session) throw new Error('No session');
      await dbDeleteTotp(id, session.userId);
      logger.success('totp:delete', 'TOTP item deleted', { itemId: id });
      return { ok: true };
    } catch (e: unknown) { const err = e as Error; logError('totp:delete', err); return { ok: false, error: err.message }; }
  }));
}

export { register };
