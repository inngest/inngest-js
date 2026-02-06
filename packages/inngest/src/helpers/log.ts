import { getAsyncCtxSync } from "../components/execution/als.ts";
import { DefaultLogger, type Logger } from "../middleware/logger.ts";

const defaultLogger = new DefaultLogger();
let globalLogger: Logger | undefined;

export function setGlobalLogger(logger: Logger): void {
  globalLogger = logger;
}

export interface StructuredLogMessage {
  message: string;
  code?: string;
  explanation?: string;
  action?: string;
  docs?: string;
}

export function formatLogMessage(opts: StructuredLogMessage): string {
  return [
    opts.message,
    opts.explanation,
    opts.action && `To fix: ${opts.action}`,
    opts.docs && `See: ${opts.docs}`,
    opts.code && `[${opts.code}]`,
  ]
    .filter(Boolean)
    .join(" ");
}

export function getLogger(): Logger {
  const ctx = getAsyncCtxSync();
  // `logger` is added to the context by the built-in logger middleware at
  // runtime, so it's not part of the static Context type.
  const fnCtx = ctx?.execution?.ctx as { logger?: Logger } | undefined;

  if (fnCtx?.logger) {
    return fnCtx.logger;
  }

  return globalLogger ?? defaultLogger;
}
