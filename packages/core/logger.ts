/**
 * ESSENTIAL - Social Media Super Agent
 * packages/core/logger.ts
 *
 * Structured JSON-line logger with levels and child loggers (traceId
 * binding). One JSON object per line - greppable, machine-parseable, and
 * compatible with every log aggregator (Datadog, CloudWatch, Loki).
 *
 * Owner: E. Patricia Rogers - Unmatched Logistics LLC
 * Constraint: code-native only. No secrets in source.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface LogFields {
  readonly [key: string]: unknown;
}

export class Logger {
  constructor(
    private readonly level: LogLevel = 'info',
    private readonly sink: (line: string) => void = (line) => console.log(line),
    private readonly base: LogFields = {},
  ) {}

  debug(msg: string, fields: LogFields = {}): void {
    this.write('debug', msg, fields);
  }
  info(msg: string, fields: LogFields = {}): void {
    this.write('info', msg, fields);
  }
  warn(msg: string, fields: LogFields = {}): void {
    this.write('warn', msg, fields);
  }
  error(msg: string, fields: LogFields = {}): void {
    this.write('error', msg, fields);
  }

  /** Bind extra fields (e.g. traceId) to every line of the child logger. */
  child(fields: LogFields): Logger {
    return new Logger(this.level, this.sink, { ...this.base, ...fields });
  }

  private write(level: LogLevel, msg: string, fields: LogFields): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const line = JSON.stringify({
      level,
      ts: new Date().toISOString(),
      msg,
      ...this.base,
      ...fields,
    });
    this.sink(line);
  }
}

export function createLogger(level?: LogLevel): Logger {
  return new Logger(level ?? 'info');
}

export function parseLogLevel(value: string | undefined): LogLevel {
  const v = value?.toLowerCase();
  if (v === 'debug' || v === 'warn' || v === 'error') return v;
  return 'info';
}
