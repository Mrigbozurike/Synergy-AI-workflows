/**
 * Structured JSON logger. One line per event, always with requestId/traceId
 * when available, so logs can be joined to traces and metrics.
 * No dependency: stdout JSON is what every log shipper expects.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogSink = (line: string) => void;

export class Logger {
  constructor(
    private readonly level: LogLevel = 'info',
    private readonly base: Record<string, unknown> = {},
    private readonly sink: LogSink = (l) => process.stdout.write(l + '\n'),
  ) {}

  child(fields: Record<string, unknown>): Logger {
    return new Logger(this.level, { ...this.base, ...fields }, this.sink);
  }

  debug(msg: string, fields?: Record<string, unknown>) {
    this.emit('debug', msg, fields);
  }
  info(msg: string, fields?: Record<string, unknown>) {
    this.emit('info', msg, fields);
  }
  warn(msg: string, fields?: Record<string, unknown>) {
    this.emit('warn', msg, fields);
  }
  error(msg: string, fields?: Record<string, unknown>) {
    this.emit('error', msg, fields);
  }

  private emit(level: LogLevel, msg: string, fields?: Record<string, unknown>) {
    if (ORDER[level] < ORDER[this.level]) return;
    const rec = { ts: new Date().toISOString(), level, msg, ...this.base, ...redact(fields ?? {}) };
    this.sink(JSON.stringify(rec));
  }
}

const SECRET_KEYS = /(api[_-]?key|authorization|token|secret|mnemonic|seed)/i;

/** Never log credentials, even if a caller passes them by accident. */
export function redact(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = SECRET_KEYS.test(k) ? '[redacted]' : v;
  }
  return out;
}

export const silentLogger = new Logger('error', {}, () => {});
