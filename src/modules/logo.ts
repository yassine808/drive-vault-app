import https from "https";
import url from "url";
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

async function fetchLogo(
  site: string,
  driveClient: DriveClient | null,
  logger: Logger,
): Promise<string | null> {
  logger.dbLog("fetchLogo", "Fetching logo", { site });
  try {
    if (typeof site !== "string" || site.length > 2048) return null;
    let domain = site
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "")
      .toLowerCase()
      .trim();
    if (!domain.includes(".")) domain += ".com";
    if (!validDomain(domain)) {
      logger.warn("fetchLogo", "Rejected invalid domain", { site, domain });
      return null;
    }
    const isPrivateIP = (d: string): boolean => {
      if (
        d === "localhost" ||
        d === "0.0.0.0" ||
        d === "[::1]" ||
        d.includes(":")
      )
        return true;
      const octets = d.split(".");
      if (octets.length >= 4) {
        const [a, b, c, dv] = [
          parseInt(octets[0], 10),
          parseInt(octets[1], 10),
          parseInt(octets[2], 10),
          parseInt(octets[3], 10),
        ];
        if (!isNaN(a) && !isNaN(b) && a === 10) return true;
        if (!isNaN(a) && !isNaN(b) && a === 127) return true;
        if (!isNaN(a) && !isNaN(b) && a === 192 && b === 168) return true;
        if (!isNaN(a) && !isNaN(b) && a === 172 && b >= 16 && b <= 31)
          return true;
        if (!isNaN(a) && !isNaN(b) && a === 169 && b === 254) return true;
        if (!isNaN(a) && a === 100 && b >= 64 && b <= 127) return true;
      }
      if (octets.length !== 4) return false;
      return false;
    };
    if (isPrivateIP(domain)) {
      logger.warn("fetchLogo", "Blocked internal domain", { domain });
      return null;
    }

    // Check cache first
    if (driveClient) {
      const logos = await driveClient.loadLogos();
      const cached = logos.find((l) => l.domain === domain);
      if (cached?.url && cached.url.startsWith("data:")) {
        logger.dbLog("fetchLogo", "Logo from cache", { domain });
        return cached.url;
      }
    }

    const faviconUrl = `https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(domain)}`;
    const imgData = await new Promise<Buffer>((resolve, reject) => {
      const req = https.get(faviconUrl, { timeout: 5000 }, (res) => {
        if (
          (res.statusCode ?? 0) >= 300 &&
          (res.statusCode ?? 0) < 400 &&
          res.headers.location
        ) {
          const redirectUrl = new URL(res.headers.location, faviconUrl);
          if (
            !redirectUrl.hostname.endsWith("google.com") &&
            !redirectUrl.hostname.endsWith("gstatic.com")
          ) {
            logger.warn("fetchLogo", "Blocked redirect to untrusted domain", {
              host: redirectUrl.hostname,
            });
            return reject(new Error("redirect blocked"));
          }
          https
            .get(redirectUrl.toString(), { timeout: 5000 }, (res2) => {
              const chunks: Buffer[] = [];
              res2.on("data", (c) => chunks.push(c as Buffer));
              res2.on("end", () => resolve(Buffer.concat(chunks)));
            })
            .on("error", reject)
            .on("timeout", () => reject(new Error("timeout")));
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

    if (!imgData || imgData.length === 0) {
      logger.warn("fetchLogo", "Empty favicon response", { domain });
      return null;
    }

    let mime = "image/png";
    if (imgData[0] === 0x89 && imgData[1] === 0x50) mime = "image/png";
    else if (imgData[0] === 0xff && imgData[1] === 0xd8) mime = "image/jpeg";
    else if (imgData[0] === 0x47 && imgData[1] === 0x49) mime = "image/gif";
    else if (imgData[0] === 0x3c && imgData[1] === 0x3f) mime = "image/svg+xml";
    else if (imgData.toString("utf8", 0, 4).includes("<svg"))
      mime = "image/svg+xml";
    else if (
      imgData[0] === 0x00 &&
      imgData[1] === 0x00 &&
      imgData[2] === 0x01 &&
      imgData[3] === 0x00
    )
      mime = "image/x-icon";
    else if (
      imgData[0] === 0x52 &&
      imgData[1] === 0x49 &&
      imgData[2] === 0x46 &&
      imgData[3] === 0x46
    )
      mime = "image/webp";

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
  } catch (e: unknown) {
    logger.warn("fetchLogo", "Failed to fetch logo", {
      site,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
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
        const err = e as Error;
        logError("logo:fetch", err);
        return { ok: false };
      }
    }),
  );
}

export { register };
