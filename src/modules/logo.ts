import https from "node:https";
import type { DriveClient } from "./drive";
import type { Session } from "../types";
import { validDomain } from "./validation";

import type Electron from "electron";
type Logger = {
  dbLog: (ctx: string, msg: string, data?: unknown) => void;
  error: (ctx: string, msg: string, data?: unknown) => void;
  success: (ctx: string, msg: string, data?: unknown) => void;
  warn: (ctx: string, msg: string, data?: unknown) => void;
  ipcLog: (ctx: string, msg: string, data?: unknown) => void;
  ipc: (ctx: string, msg: string, data?: unknown) => void;
};
type LogError = (ctx: string, err: unknown) => void;
type IpcHandler = (...args: any[]) => any;
type AuthWrapper = (fn: IpcHandler) => IpcHandler;

const FAVICON_ENDPOINT = "https://www.google.com/s2/favicons";

function isPrivateIP(d: string): boolean {
  if (d === "localhost" || d === "0.0.0.0" || d === "[::1]" || d.includes(":"))
    return true;
  const octets = d.split(".");
  if (octets.length < 4) return false;
  const a = Number.parseInt(octets[0], 10);
  const b = Number.parseInt(octets[1], 10);
  if (!Number.isNaN(a) && !Number.isNaN(b) && a === 10) return true;
  if (!Number.isNaN(a) && !Number.isNaN(b) && a === 127) return true;
  if (!Number.isNaN(a) && !Number.isNaN(b) && a === 192 && b === 168)
    return true;
  if (!Number.isNaN(a) && !Number.isNaN(b) && a === 172 && b >= 16 && b <= 31)
    return true;
  if (!Number.isNaN(a) && !Number.isNaN(b) && a === 169 && b === 254)
    return true;
  if (!Number.isNaN(a) && a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function detectMime(imgData: Buffer): string {
  if (imgData[0] === 0x89 && imgData[1] === 0x50) return "image/png";
  if (imgData[0] === 0xff && imgData[1] === 0xd8) return "image/jpeg";
  if (imgData[0] === 0x47 && imgData[1] === 0x49) return "image/gif";
  if (imgData[0] === 0x3c && imgData[1] === 0x3f) return "image/svg+xml";
  if (imgData.toString("utf8", 0, 4).includes("<svg")) return "image/svg+xml";
  if (
    imgData[0] === 0x00 &&
    imgData[1] === 0x00 &&
    imgData[2] === 0x01 &&
    imgData[3] === 0x00
  )
    return "image/x-icon";
  if (
    imgData[0] === 0x52 &&
    imgData[1] === 0x49 &&
    imgData[2] === 0x46 &&
    imgData[3] === 0x46
  )
    return "image/webp";
  return "image/png";
}

function extractDomain(site: string): string {
  return site
    .replace(/^https?:\/\//g, "")
    .replace(/\/.*$/g, "")
    .toLowerCase()
    .trim();
}

function isAllowedRedirect(hostname: string): boolean {
  return hostname.endsWith("google.com") || hostname.endsWith("gstatic.com");
}

function fetchImage(
  targetUrl: string,
  timeoutMs: number,
  logger: Logger,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const req = https.get(targetUrl, { timeout: timeoutMs }, (res) => {
      const statusCode = res.statusCode ?? 0;
      if (statusCode >= 300 && statusCode < 400 && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, targetUrl);
        if (!isAllowedRedirect(redirectUrl.hostname)) {
          logger.warn("fetchLogo", "Blocked redirect to untrusted domain", {
            host: redirectUrl.hostname,
          });
          return reject(new Error("redirect blocked"));
        }
        fetchImage(redirectUrl.toString(), timeoutMs, logger).then(
          resolve,
          reject,
        );
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c as Buffer));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

async function fetchLogo(
  site: string,
  driveClient: DriveClient | null,
  logger: Logger,
): Promise<string | null> {
  logger.dbLog("fetchLogo", "Fetching logo", { site });
  if (typeof site !== "string" || site.length > 2048) return null;

  let domain = extractDomain(site);
  if (!domain.includes(".")) domain += ".com";
  if (!validDomain(domain)) {
    logger.warn("fetchLogo", "Rejected invalid domain", { site, domain });
    return null;
  }
  if (isPrivateIP(domain)) {
    logger.warn("fetchLogo", "Blocked internal domain", { domain });
    return null;
  }

  if (driveClient) {
    const logos = await driveClient.loadLogos();
    const cached = logos.find((l) => l.domain === domain);
    if (cached?.url?.startsWith("data:")) {
      logger.dbLog("fetchLogo", "Logo from cache", { domain });
      return cached.url;
    }
  }

  const faviconUrl = `${FAVICON_ENDPOINT}?sz=64&domain=${encodeURIComponent(domain)}`;
  const imgData = await fetchImage(faviconUrl, 5000, logger);

  if (!imgData || imgData.length === 0) {
    logger.warn("fetchLogo", "Empty favicon response", { domain });
    return null;
  }

  const mime = detectMime(imgData);
  const dataUrl = `data:${mime};base64,${imgData.toString("base64")}`;

  if (driveClient) {
    await driveClient.saveLogo(domain, dataUrl);
  }
  logger.dbLog("fetchLogo", "Logo fetched and cached", {
    domain,
    mime,
    size: imgData.length,
  });
  return dataUrl;
}

function register(
  ipcMain: Electron.IpcMain,
  requireAuth: AuthWrapper,
  driveClient: DriveClient | null,
  logger: Logger,
  getSession: () => Session | null,
  logError: LogError,
) {
  ipcMain.handle(
    "logo:fetch",
    requireAuth(async (_e, { site }: { site: string }) => {
      logger.ipcLog("logo:fetch", "Fetching logo", { site });
      if (typeof site !== "string" || !site.trim())
        return { ok: false, error: "Invalid site" };
      try {
        const logoUrl = await fetchLogo(site, driveClient, logger);
        return { ok: true, url: logoUrl };
      } catch (e: unknown) {
        const err = e instanceof TypeError ? e : new TypeError(String(e));
        logError("logo:fetch", err);
        return { ok: false };
      }
    }),
  );
}

export { register };
