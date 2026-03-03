export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  msg: string;
  [key: string]: unknown;
}

export interface LoggerOptions {
  output?: (entry: LogEntry) => void;
  minLevel?: LogLevel;
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface Logger {
  debug(fields: Record<string, unknown>, msg: string): void;
  info(fields: Record<string, unknown>, msg: string): void;
  warn(fields: Record<string, unknown>, msg: string): void;
  error(fields: Record<string, unknown>, msg: string): void;
}

function defaultOutput(entry: LogEntry): void {
  console.error(JSON.stringify(entry));
}

export function createLogger(options?: LoggerOptions): Logger {
  const output = options?.output ?? defaultOutput;
  const minLevel = options?.minLevel ?? (process.env.LOG_LEVEL as LogLevel | undefined) ?? "debug";

  function log(level: LogLevel, fields: Record<string, unknown>, msg: string): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[minLevel]) return;
    output({
      timestamp: new Date().toISOString(),
      level,
      msg,
      ...fields,
    });
  }

  return {
    debug: (fields, msg) => log("debug", fields, msg),
    info: (fields, msg) => log("info", fields, msg),
    warn: (fields, msg) => log("warn", fields, msg),
    error: (fields, msg) => log("error", fields, msg),
  };
}
