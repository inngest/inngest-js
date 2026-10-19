/**
 * The one error the CLI throws on purpose: something the user has to fix,
 * with the fix and, for a process that died, the end of its log.
 *
 * @module
 */

export class SetupError extends Error {
  /** What to do about it, shown under the message. */
  readonly fix?: string;

  /** The last lines of the log of the process that failed. */
  readonly logTail?: string;

  constructor(
    message: string,
    details: { fix?: string; logTail?: string } = {},
  ) {
    super(message);

    this.name = "SetupError";

    if (details.fix) {
      this.fix = details.fix;
    }

    if (details.logTail) {
      this.logTail = details.logTail;
    }
  }
}
