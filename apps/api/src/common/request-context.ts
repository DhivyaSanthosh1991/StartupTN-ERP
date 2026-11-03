import { AsyncLocalStorage } from 'async_hooks';
import type { NextFunction, Request, Response } from 'express';

interface Ctx {
  ip: string | null;
}

const storage = new AsyncLocalStorage<Ctx>();

/** Lets deep services (the audit log) know the caller's IP without threading it through every call. */
export function requestContextMiddleware(req: Request, _res: Response, next: NextFunction) {
  storage.run({ ip: req.ip ?? null }, next);
}

export const currentIp = (): string | null => storage.getStore()?.ip ?? null;
