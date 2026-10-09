/**
 * A stand-in for the platform's event matching, for tests of `waitForEvent`.
 *
 * It models the two properties a wait depends on. A wait is a pause, saved when
 * the executor handles the step, and an event only resumes pauses that exist
 * when it is matched: there is no lookback, so an event sent before the pause
 * was saved is never delivered to it. And a wait that nothing resumes ends with
 * `null` at its timeout, which here is a virtual clock that only moves when
 * every run in flight is blocked, so the test doesn't sleep.
 *
 * @module
 */

import type { EventPayload } from "inngest";

/** The data of an event as a pause's `if` expression sees it as `async`. */
export interface BusEvent {
  name: string;
  data: Record<string, unknown>;
}

interface Pause {
  eventName: string;
  expression: string | undefined;
  deadline: number;
  settle: (event: BusEvent | null) => void;
}

/** How long a duration string like `120s` or `2m` lasts, in milliseconds. */
export const durationMs = (text: string): number => {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(text);

  if (!match) {
    throw new Error(`The bus can't read the duration "${text}"`);
  }

  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
    match[2] as "ms" | "s" | "m" | "h" | "d"
  ];

  return Number(match[1]) * unit;
};

/**
 * Whether an `if` expression holds for an event. Only the shape a CI wait uses
 * is understood, `async.data.<field> == '<value>'`, and any other throws so a
 * test never passes on an expression the bus silently ignored.
 */
export const matches = (
  expression: string | undefined,
  event: BusEvent,
): boolean => {
  if (expression === undefined) {
    return true;
  }

  const parsed =
    /^async\.data\.([A-Za-z_]\w*) == (?:'([^']*)'|"([^"]*)")$/.exec(expression);

  if (!parsed) {
    throw new Error(`The bus can't evaluate "${expression}"`);
  }

  return event.data[parsed[1] as string] === (parsed[2] ?? parsed[3]);
};

export class EventBus {
  /** Every event sent, in order. */
  readonly sent: BusEvent[] = [];

  /** Every pause saved, in order, with how it ended. */
  readonly saved: {
    eventName: string;
    expression: string | undefined;
    ended?: "matched" | "timeout";
  }[] = [];

  private pauses = new Map<Pause, number>();
  private clock = 0;
  private active = 0;
  private blocked = 0;
  private version = 0;

  /** Save a pause, as the executor does when it handles a wait. */
  pause(
    eventName: string,
    expression: string | undefined,
    timeoutMs: number,
  ): Promise<BusEvent | null> {
    const index = this.saved.length;

    this.saved.push({ eventName, expression });

    this.version++;

    return new Promise((resolve) => {
      const pause: Pause = {
        eventName,
        expression,
        deadline: this.clock + timeoutMs,
        settle: (event) => {
          this.pauses.delete(pause);
          this.version++;

          const entry = this.saved[index];

          if (entry) {
            entry.ended = event ? "matched" : "timeout";
          }

          resolve(event);
        },
      };

      this.pauses.set(pause, index);
    });
  }

  /** Send an event: it resumes the pauses that exist now, and no others. */
  send(event: EventPayload): void {
    const sent: BusEvent = {
      name: event.name,
      data: (event.data ?? {}) as Record<string, unknown>,
    };

    this.sent.push(sent);

    for (const pause of [...this.pauses.keys()]) {
      if (pause.eventName === sent.name && matches(pause.expression, sent)) {
        pause.settle(sent);
      }
    }
  }

  /** How many pauses wait right now, whether or not their run still lives. */
  get waiting(): number {
    return this.pauses.size;
  }

  /** A run started. */
  enter(): void {
    this.active++;
    this.version++;
  }

  /** A run ended. */
  leave(): void {
    this.active--;
    this.version++;
    this.check();
  }

  /** Run `wait` while its run can do nothing until something else happens. */
  async blockedOn<T>(wait: () => Promise<T>): Promise<T> {
    this.blocked++;
    this.version++;
    this.check();

    try {
      return await wait();
    } finally {
      this.blocked--;
      this.version++;
    }
  }

  /**
   * When every run is blocked and the state has not moved for a moment, no
   * event can come, so the pause with the nearest deadline times out.
   */
  private check(): void {
    const seen = this.version;

    setTimeout(() => {
      if (
        seen !== this.version ||
        this.active === 0 ||
        this.blocked < this.active
      ) {
        return;
      }

      let next: Pause | undefined;

      for (const pause of this.pauses.keys()) {
        if (!next || pause.deadline < next.deadline) {
          next = pause;
        }
      }

      if (next) {
        this.clock = Math.max(this.clock, next.deadline);
        next.settle(null);
        this.check();
      }
    }, 10);
  }
}
