'use strict';

const https = require('https');
const url   = require('url');

const { validDomain } = require('./validation');

async function fetchLogo(site, supabase, logger) {
  logger.db('fetchLogo', 'Fetching logo', { site });
  try {
    let domain = site.replace(/^https?:\/\//,'').replace(/\/.*$/,'').toLowerCase().trim();
    if (!domain.includes('.')) domain += '.com';
    if (!validDomain(domain)) { logger.warn('fetchLogo', 'Rejected invalid domain', { site, domain }); return null; }

    const { data, error } = await supabase.from('vault_logos').select('url').eq('domain',domain).maybeSingle();
    if (error) throw error;
    if (data?.url && data.url.startsWith('data:')) {
      logger.db('fetchLogo', 'Logo from cache', { domain });
      return data.url;
    }

    const faviconUrl = `https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(domain)}`;
    const imgData = await new Promise((resolve, reject) => {
      const req = https.get(faviconUrl, { timeout: 5000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirectUrl = new URL(res.headers.location, faviconUrl);
          https.get(redirectUrl.toString(), { timeout: 5000 }, (res2) => {
            const chunks = [];
            res2.on('data', (c) => chunks.push(c));
            res2.on('end', () => resolve(Buffer.concat(chunks)));
          }).on('error', reject).on('timeout', () => reject(new Error('timeout')));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
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

    const dataUrl = `data:${mime};base64,${imgData.toString('base64')}`;

    await supabase.from('vault_logos').upsert({ domain, url: dataUrl, cached_at: new Date().toISOString() });
    logger.db('fetchLogo', 'Logo fetched and cached as data URL', { domain, mime, size: imgData.length });
    return dataUrl;
  } catch (e) { logger.warn('fetchLogo', 'Failed to fetch logo', { site, error: e?.message }); return null; }
}

function register(ipcMain, requireAuth, supabase, logger, getSession, logError) {
  ipcMain.handle('logo:fetch', requireAuth(async (_e, { site }) => {
    logger.ipc('logo:fetch', 'Fetching logo', { site });
    if (typeof site !== 'string' || !site.trim()) return { ok: false, error: 'Invalid site' };
    try {
      const url = await fetchLogo(site, supabase, logger);
      return { ok: true, url };
    } catch (e) { logError('logo:fetch', e); return { ok: false }; }
  }));
}

module.exports = { register };
