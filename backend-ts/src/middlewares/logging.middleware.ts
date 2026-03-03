import { STATUS_CODES } from 'http';
import { NextFunction, Request, Response } from 'express';

export function loggingMiddleware(req: Request, res: Response, next: NextFunction) {
  const started = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - started;
    const user = req.userId ? `user:${req.userId}` : 'anonymous';
    const statusText = STATUS_CODES[res.statusCode] ?? '';
    const line = `${new Date().toISOString()} | ${req.method} ${req.originalUrl} | ${res.statusCode} ${statusText} | ${duration}ms | ${user}`;

    if (res.statusCode >= 500) {
      // eslint-disable-next-line no-console
      console.error(line);
    } else if (res.statusCode >= 400) {
      // eslint-disable-next-line no-console
      console.warn(line);
    } else {
      // eslint-disable-next-line no-console
      console.info(line);
    }
  });

  next();
}
