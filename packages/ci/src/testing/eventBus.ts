/**
 * A stand-in for the platform's event matching, for tests of `waitForEvent`
 * and of the functions events start.
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

/** An event as a pause's `if` expression sees it as `async`. */
export interface BusEvent {
  name: string;
  data: Record<string, unknown>;
}

interface Pause {
  name: string;
  expression: string | undefined;
  deadline: number;
  settle: (event: BusEvent | null) => void;
}

const unitMs = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

/** How long a duration like `120s` or `15m` lasts, in milliseconds. */
export const durationMs = (text: string): number => {
  const [, amount, unit] = /^(\d+)(ms|s|m|h)$/.exec(text) ?? [];

  if (!amount || !unit) {
    throw new Error(`The bus can't read the duration "${text}"`);
  }

  return Number(amount) * unitMs[unit as keyof typeof unitMs];
};

/**
 * Whether an `if` expression holds for an event. Only the shape a CI wait uses
 * is understood, `async.data.<field> == '<value>'`, and any other throws so a
 * test never passes on an expression the bus silently ignored.
 */
const matches = (expression: string | undefined, event: BusEvent): boolean => {
  if (expression === undefined) {
    return true;
  }

  const parsed = /^async\.data\.(\w+) == '([^']*)'$/.exec(expression);

  if (!parsed) {
    throw new Error(`The bus can't evaluate "${expression}"`);
  }

  return event.data[parsed[1] as string] === parsed[2];
};

export class EventBus {
  /** Every event sent, in order. */
  readonly sent: BusEvent[] = [];

  /** How each wait ended, in order: by an event, or by running out of time. */
  readonly ended: ("matched" | "timeout")[] = [];

  /** How many requests a function skipped, since a run of it held its singleton. */
  skipped = 0;

  /** Told of every event sent, as the functions an event triggers are. */
  onSend: ((event: BusEvent) => void) | undefined;

  private spawned = new Set<Promise<unknown>>();
  private pauses = new Set<Pause>();
  private clock = 0;
  private active = 0;
  private blocked = 0;
  private version = 0;

  /**
   * Save a pause, as the executor does when it handles a wait. `drop` removes
   * it unanswered, as the executor does when its run completes.
   */
  pause(
    name: string,
    expression: string | undefined,
    timeoutMs: number,
  ): { event: Promise<BusEvent | null>; drop: () => void } {
    this.version++;

    let saved: Pause | undefined;

    const event = new Promise<BusEvent | null>((resolve) => {
      const pause: Pause = {
        name,
        expression,
        deadline: this.clock + timeoutMs,
        settle: (event) => {
          this.pauses.delete(pause);
          this.ended.push(event ? "matched" : "timeout");
          this.version++;

          resolve(event);
        },
      };

      saved = pause;
      this.pauses.add(pause);
    });

    return {
      event,
      drop: () => {
        if (saved) {
          this.pauses.delete(saved);
          this.version++;
        }
      },
    };
  }

  /** How many pauses are saved and unanswered. */
  get waiting(): number {
    return this.pauses.size;
  }

  /** Send an event: it resumes the pauses that exist now, and no others. */
  send(event: EventPayload): void {
    const sent = {
      name: event.name,
      data: (event.data ?? {}) as BusEvent["data"],
    };

    this.sent.push(sent);
    this.onSend?.(sent);

    for (const pause of [...this.pauses]) {
      if (pause.name === sent.name && matches(pause.expression, sent)) {
        pause.settle(sent);
      }
    }
  }

  /** Keep a run an event started, so the test that sent it can wait for it. */
  spawn(run: Promise<unknown>): void {
    const tracked = run.catch(() => {
      return undefined;
    });

    this.spawned.add(tracked);

    void tracked.then(() => {
      this.spawned.delete(tracked);
    });
  }

  /** Wait until every run an event started has ended, including those they start. */
  async drain(): Promise<void> {
    while (this.spawned.size > 0) {
      await Promise.all([...this.spawned]);
    }
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

      const [next] = [...this.pauses].sort((a, b) => {
        return a.deadline - b.deadline;
      });

      if (next) {
        this.clock = Math.max(this.clock, next.deadline);
        next.settle(null);
        this.check();
      }
    }, 10);
  }
}
