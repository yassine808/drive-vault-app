import type { DriveClient } from "./drive";
import type { TotpItem, Session } from "../types";
import { sanitizeStr, validTotpSecret } from "./validation";

import type Electron from "electron";
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

interface RegisterTotpOptions {
  ipcMain: Electron.IpcMain;
  requireAuth: AuthWrapper;
  requireAuthNoArgs: AuthWrapper;
  driveClient: DriveClient | null;
  getSession: () => Session | null;
  logger: Logger;
  enc: EncFn;
  dec: DecFn;
  logError: LogError;
}

function register(opts: RegisterTotpOptions) {
  const {
    ipcMain,
    requireAuth,
    requireAuthNoArgs,
    driveClient,
    getSession,
    logger,
    enc,
    dec,
    logError,
  } = opts;
  function dbLoadTotp(encKey: string): TotpItem[] {
    logger.dbLog("dbLoadTotp", "Loading TOTP items");
    if (!driveClient) return [];
    const items = driveClient.loadItems("totp");
    return items.map((item) => {
      const decrypted = dec(item.encryptedData, encKey);
      return {
        id: item.id,
        name: (decrypted?.name as string) || "",
        issuer: (decrypted?.issuer as string) || "",
        secret: (decrypted?.secret as string) || "",
        icon: (decrypted?.icon as string) || "🔐",
        sort_order: item.sortOrder,
      };
    });
  }

  function dbSaveTotp(item: TotpItem, encKey: string): string {
    logger.dbLog("dbSaveTotp", "Saving TOTP item", {
      itemId: item?.id,
      name: item?.name,
    });
    if (!driveClient) throw new Error("Drive not initialized");
    const encData = enc(
      {
        name: item.name,
        issuer: item.issuer,
        secret: item.secret,
        icon: item.icon,
      },
      encKey,
    );
    const id = driveClient.saveItem("totp", encData, item.id, item.sort_order);
    logger.dbLog("dbSaveTotp", "TOTP item saved", { itemId: id });
    return id;
  }

  function dbDeleteTotp(id: string): void {
    logger.dbLog("dbDeleteTotp", "Deleting TOTP item", { itemId: id });
    if (!driveClient) throw new Error("Drive not initialized");
    driveClient.permDelete("totp", id);
    logger.dbLog("dbDeleteTotp", "Success", { itemId: id });
  }

  ipcMain.handle(
    "totp:load",
    requireAuthNoArgs(async () => {
      logger.ipcLog("totp:load", "Loading TOTP items");
      try {
        const session = getSession();
        if (!session) throw new Error("No session");
        const items = dbLoadTotp(session.encKey);
        logger.success("totp:load", "TOTP items loaded", {
          count: items.length,
        });
        return { ok: true, items };
      } catch (e: unknown) {
        const err = e as Error;
        logError("totp:load", err);
        return { ok: false, error: err.message };
      }
    }),
  );

  ipcMain.handle(
    "totp:save",
    requireAuth(async (_e, { item }: { item: TotpItem }) => {
      logger.ipcLog("totp:save", "Saving TOTP item", {
        itemId: item?.id,
        name: item?.name,
      });
      try {
        if (!item || typeof item !== "object") {
          logger.warn("totp:save", "Invalid TOTP data");
          return { ok: false, error: "Invalid TOTP data" };
        }
        item.name = sanitizeStr(item.name);
        item.issuer = sanitizeStr(item.issuer);
        if (!validTotpSecret(item.secret)) {
          logger.warn("totp:save", "Invalid TOTP secret");
          return {
            ok: false,
            error: "Invalid TOTP secret (base32: A-Z, 2-7, 16+ chars)",
          };
        }
        const session = getSession();
        if (!session) throw new Error("No session");
        const id = dbSaveTotp(item, session.encKey);
        logger.success("totp:save", "TOTP item saved", {
          itemId: id,
          name: item.name,
        });
        return { ok: true, id };
      } catch (e: unknown) {
        const err = e as Error;
        logError("totp:save", err);
        return { ok: false, error: err.message };
      }
    }),
  );

  ipcMain.handle(
    "totp:delete",
    requireAuth(async (_e, { id }: { id: string }) => {
      logger.ipcLog("totp:delete", "Deleting TOTP item", { itemId: id });
      try {
        dbDeleteTotp(id);
        logger.success("totp:delete", "TOTP item deleted", { itemId: id });
        return { ok: true };
      } catch (e: unknown) {
        const err = e as Error;
        logError("totp:delete", err);
        return { ok: false, error: err.message };
      }
    }),
  );
}

export { register };
