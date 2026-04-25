export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(event: string, data?: Record<string, unknown>): void;
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
  error(event: string, data?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

/** Simple console logger. Replace with pino in production composition. */
export class ConsoleLogger implements Logger {
  constructor(private readonly bindings: Record<string, unknown> = {}) {}

  private write(level: LogLevel, event: string, data?: Record<string, unknown>) {
    const entry = {
      level,
      time: new Date().toISOString(),
      event,
      ...this.bindings,
      ...data,
    };
    if (level === 'error' || level === 'warn') {
      console.error(JSON.stringify(entry));
    } else {
      console.log(JSON.stringify(entry));
    }
  }

  debug(event: string, data?: Record<string, unknown>) { this.write('debug', event, data); }
  info(event: string, data?: Record<string, unknown>)  { this.write('info',  event, data); }
  warn(event: string, data?: Record<string, unknown>)  { this.write('warn',  event, data); }
  error(event: string, data?: Record<string, unknown>) { this.write('error', event, data); }

  child(bindings: Record<string, unknown>): Logger {
    return new ConsoleLogger({ ...this.bindings, ...bindings });
  }
}
