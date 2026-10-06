/**
 * The error for anything the user has to fix before a run can start: a missing
 * config, a port, a binary. The session turns it into a `setup-error` event.
 *
 * @module
 */

export class SetupError extends Error {
  /** What to do about it, such as a config snippet or a command. */
  readonly fix?: string;
  /** The end of the app's or Dev Server's log, when one of them failed. */
  readonly logTail?: string;
  /** Whether running guided setup again could fix it, because `ci` is wrong. */
  readonly reconfigurable: boolean;

  constructor(
    message: string,
    details: { fix?: string; logTail?: string; reconfigurable?: boolean } = {},
  ) {
    super(message);

    this.name = "SetupError";
    this.fix = details.fix;
    this.logTail = details.logTail;
    this.reconfigurable = details.reconfigurable ?? false;
  }
}
