import https from 'https';
import url from 'url';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Session } from '../types';
import { validDomain } from './validation';

import type Electron from 'electron';
type Logger = {
  db: (ctx: string, msg: string, data?: unknown) => void;
  error: (ctx: string, msg: string, data?: unknown) => void;
  success: (ctx: string, msg: string, data?: unknown) => void;
  warn: (ctx: string, msg: string, data?: unknown) => void;
  ipc: (ctx: string, msg: string, data?: unknown) => void;
};
type LogError = (ctx: string, err: unknown) => void;
type AuthWrapper = (fn: Electron.IpcMainInvokeEventHandler) => Electron.IpcMainInvokeEventHandler;

async function fetchLogo(site: string, supabase: SupabaseClient, logger: Logger): Promise<string | null> {
  logger.db('fetchLogo', 'Fetching logo', { site });
  try {
    if (typeof site !== 'string' || site.length > 2048) return null;
    let domain = site.replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase().trim();
    if (!domain.includes('.')) domain += '.com';
    if (!validDomain(domain)) { logger.warn('fetchLogo', 'Rejected invalid domain', { site, domain }); return null; }
    const isPrivateIP = (d: string): boolean => {
      if (d === 'localhost' || d === '0.0.0.0' || d === '[::1]' || d.includes(':')) return true;
      const octets = d.split('.');
      if (octets.length !== 4) return false;
      const [a, b] = [parseInt(octets[0], 10), parseInt(octets[1], 10)];
      if (a === 10 || a === 127) return true;
      if (a === 192 && b === 168) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
      if (a === 169 && b === 254) return true;
      return false;
    };
    if (isPrivateIP(domain)) {
      logger.warn('fetchLogo', 'Blocked internal domain', { domain });
      return null;
    }

    const { data, error } = await supabase.from('vault_logos').select('url').eq('domain', domain).maybeSingle();
    if (error) throw error;
    if (data?.url && data.url.startsWith('data:')) {
      logger.db('fetchLogo', 'Logo from cache', { domain });
      return data.url;
    }

    const faviconUrl = `https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(domain)}`;
    const imgData = await new Promise<Buffer>((resolve, reject) => {
      const req = https.get(faviconUrl, { timeout: 5000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirectUrl = new URL(res.headers.location, faviconUrl);
          if (!redirectUrl.hostname.endsWith('google.com') && !redirectUrl.hostname.endsWith('gstatic.com')) {
            logger.warn('fetchLogo', 'Blocked redirect to untrusted domain', { host: redirectUrl.hostname });
            return reject(new Error('redirect blocked'));
          }
          https.get(redirectUrl.toString(), { timeout: 5000 }, (res2) => {
            const chunks: Buffer[] = [];
            res2.on('data', (c) => chunks.push(c as Buffer));
            res2.on('end', () => resolve(Buffer.concat(chunks)));
          }).on('error', reject).on('timeout', () => reject(new Error('timeout')));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });

    if (!imgData || imgData.length === 0) {
      logger.warn('fetchLogo', 'Empty favicon response', { domain });
      return null;
    }

    let mime = 'image/png';
    if (imgData[0] === 0x89 && imgData[1] === 0x50) mime = 'image/png';
    else if (imgData[0] === 0xFF && imgData[1] === 0xD8) mime = 'image/jpeg';
    else if (imgData[0] === 0x47 && imgData[1] === 0x49) mime = 'image/gif';
    else if (imgData[0] === 0x3C && imgData[1] === 0x3F) mime = 'image/svg+xml';
    else if (imgData.toString('utf8', 0, 4).includes('<svg')) mime = 'image/svg+xml';
    else if (imgData[0] === 0x00 && imgData[1] === 0x00 && imgData[2] === 0x01 && imgData[3] === 0x00) mime = 'image/x-icon';
    else if (imgData[0] === 0x52 && imgData[1] === 0x49 && imgData[2] === 0x46 && imgData[3] === 0x46) mime = 'image/webp';

    const dataUrl = `data:${mime};base64,${imgData.toString('base64')}`;

    await supabase.from('vault_logos').upsert({ domain, url: dataUrl, cached_at: new Date().toISOString() });
    logger.db('fetchLogo', 'Logo fetched and cached as data URL', { domain, mime, size: imgData.length });
    return dataUrl;
  } catch (e: unknown) { logger.warn('fetchLogo', 'Failed to fetch logo', { site, error: e instanceof Error ? e.message : String(e) }); return null; }
}

function register(
  ipcMain: Electron.IpcMain,
  requireAuth: AuthWrapper,
  supabase: SupabaseClient,
  logger: Logger,
  getSession: () => Session | null,
  logError: LogError,
) {
  ipcMain.handle('logo:fetch', requireAuth(async (_e, { site }: { site: string }) => {
    logger.ipc('logo:fetch', 'Fetching logo', { site });
    if (typeof site !== 'string' || !site.trim()) return { ok: false, error: 'Invalid site' };
    try {
      const logoUrl = await fetchLogo(site, supabase, logger);
      return { ok: true, url: logoUrl };
    } catch (e: unknown) { const err = e as Error; logError('logo:fetch', err); return { ok: false }; }
  }));
}

export { register };
