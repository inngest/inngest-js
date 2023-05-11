import { LogArg } from "../helpers/types";

// Based on https://datatracker.ietf.org/doc/html/rfc5424#autoid-11
// it's pretty reasonable to expect a logger to have the following interfaces
// available.
export interface ILogger {
  info(...args: LogArg[]): void;
  warn(...args: LogArg[]): void;
  error(...args: LogArg[]): void;
  debug(...args: LogArg[]): void;
}
