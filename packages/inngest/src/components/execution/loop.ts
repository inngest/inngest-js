import { type DurationInput, durationToMs } from "../../helpers/duration.ts";
import { stringify, timeStr } from "../../helpers/strings.ts";
import { NonRetriableError } from "../NonRetriableError.ts";
import {
  EventType,
  type EventTypeWithAnySchema,
} from "../triggers/triggers.ts";

/**
 * an fsm is a loop that cannot subscribe to events.  the executor runs both
 * kinds the same way.
 */
export type LoopKind = "loop" | "fsm";

/**
 * what started a loop run.
 */
export type LoopInputKind = "event" | "subscription" | "wake" | "tick";

/**
 * the `loop` block of a run request.  the executor sends it again on every
 * request of the run.  `state` is null until the first commit.
 */
export interface LoopRequest {
  state?: unknown;
  version: number;
  key: string;
  input: {
    kind: string;
    id?: string;
  };
}

/**
 * `id` is the wake id or the subscription id for those two kinds.  `key` is
 * the value of the loop key expression for this instance.  `version` is the
 * state version the run loaded.
 */
export interface LoopInput {
  kind: LoopInputKind;
  id?: string;
  key: string;
  version: number;
}

/**
 * the data of a `LoopReturn` opcode.  `version` is the version from the
 * request, sent back unchanged, and the executor rejects the commit when the
 * stored version moved.  durations are strings such as "30s".
 */
export interface LoopReturnData {
  state: unknown;
  version: number;
  wake?: {
    id: string;
    after: string;
  };
  end: boolean;
  subscribe?: LoopSubscription[];
  unsubscribe?: string[];
}

interface LoopSubscription {
  id: string;
  event: string;
  if?: string;
  ttl?: string;
}

export interface LoopSubscribeOptions {
  /**
   * the name of the event to subscribe to.
   */
  event: string | EventTypeWithAnySchema<string>;

  /**
   * a CEL expression over the event.  the instance runs only for an event
   * that matches.
   */
  if?: string;

  /**
   * how long the subscription lives.  the server default applies when this is
   * not set.
   */
  ttl?: DurationInput;
}

/**
 * the calls an fsm handler makes to say what happens after the run.  the
 * calls are collected during the run and sent once, when the handler
 * returns.  a handler that throws sends none of them.
 */
export interface FSMTools {
  /**
   * runs the instance again after the duration.  that run has `input.kind`
   * set to "wake" and `input.id` set to `id`.  the last call in a run wins.
   */
  wake(id: string, after: DurationInput): void;

  /**
   * ends the instance after this run.  the server deletes the state, the
   * subscriptions, and the timers of the instance.  a wake from the same run
   * is dropped.
   */
  end(): void;
}

/**
 * the calls a loop handler makes to say what happens after the run.
 */
export interface LoopTools extends FSMTools {
  /**
   * runs the instance again when an event matches.  that run has `input.kind`
   * set to "subscription" and `input.id` set to `id`.  the last call for an
   * id in a run wins.
   */
  subscribe(id: string, options: LoopSubscribeOptions): void;

  /**
   * removes the subscription with the id.
   */
  unsubscribe(id: string): void;
}

/**
 * the step opcodes a loop handler cannot use, with the name in the error
 * text.  each one parks the run, and a parked run holds the loop key, so no
 * other input for the key can run.
 */
export const loopRejectedOps: Readonly<Record<string, string>> = {
  Sleep: "step.sleep",
  WaitForEvent: "step.waitForEvent",
  WaitForSignal: "step.waitForSignal",
};

/**
 * LoopRun holds the state and the collected loop calls of one request of a
 * loop run.  the engine sends `result()` in the `LoopReturn` opcode when the
 * handler returns.
 */
export class LoopRun {
  public readonly state: unknown;
  public readonly input: LoopInput;
  public readonly tools: LoopTools;

  private readonly kind: LoopKind;
  private readonly fnId: string;
  private readonly request: LoopRequest | undefined;
  private readonly isInStep: () => boolean;

  private wake: LoopReturnData["wake"];
  private ended = false;
  private readonly subscriptions = new Map<string, LoopSubscription>();
  private readonly unsubscriptions = new Set<string>();

  constructor(opts: {
    kind: LoopKind;
    fnId: string;
    initialState: unknown;
    request: LoopRequest | undefined;

    /**
     * returns true while a `step.run()` callback is running.
     */
    isInStep: () => boolean;
  }) {
    this.kind = opts.kind;
    this.fnId = opts.fnId;
    this.request = opts.request;
    this.isInStep = opts.isInStep;

    const committed = opts.request?.state;
    this.state =
      committed === null || committed === undefined
        ? JSON.parse(JSON.stringify(opts.initialState))
        : committed;

    this.input = {
      kind: (opts.request?.input.kind ?? "event") as LoopInputKind,
      key: opts.request?.key ?? "",
      version: opts.request?.version ?? 0,
    };
    if (opts.request?.input.id) {
      this.input.id = opts.request.input.id;
    }

    this.tools = {
      wake: (id, after) => this.addWake(id, after),
      end: () => this.addEnd(),
      subscribe: (id, options) => this.addSubscribe(id, options),
      unsubscribe: (id) => this.addUnsubscribe(id),
    };
  }

  /**
   * a loop run without a `loop` block has no state to work on.  the run
   * fails without retry, because a retry gets the same request.
   */
  public assertRequest(): void {
    if (!this.request) {
      throw new NonRetriableError(
        `loop function "${this.fnId}" was invoked without a loop block`,
      );
    }
  }

  /**
   * returns the `LoopReturn` data for the state the handler left.  the state
   * is copied through JSON, so the data is what the server stores.  the
   * subscribe entries and unsubscribe ids are sorted by id.
   */
  public result(state: unknown): LoopReturnData {
    const data: LoopReturnData = {
      state: state === undefined ? null : JSON.parse(stringify(state)),
      version: this.input.version,
      end: this.ended,
    };

    if (this.wake && !this.ended) {
      data.wake = { ...this.wake };
    }

    if (this.subscriptions.size > 0) {
      data.subscribe = [...this.subscriptions.values()].sort((a, b) =>
        compare(a.id, b.id),
      );
    }

    if (this.unsubscriptions.size > 0) {
      data.unsubscribe = [...this.unsubscriptions].sort(compare);
    }

    return data;
  }

  private addWake(id: string, after: DurationInput): void {
    this.assertInHandlerBody("loop.wake");
    assertId("loop.wake", id);

    this.wake = {
      id,
      after: duration("loop.wake", "a duration", after),
    };
  }

  private addEnd(): void {
    this.assertInHandlerBody("loop.end");
    this.ended = true;
  }

  private addSubscribe(id: string, options: LoopSubscribeOptions): void {
    this.assertInHandlerBody("loop.subscribe");
    if (this.kind === "fsm") {
      throw new NonRetriableError(
        "loop.subscribe called in an fsm.  an fsm cannot subscribe to events",
      );
    }
    assertId("loop.subscribe", id);

    const event =
      options?.event instanceof EventType ? options.event.name : options?.event;
    if (typeof event !== "string" || event === "") {
      throw new NonRetriableError("loop.subscribe requires a non-empty event");
    }

    const subscription: LoopSubscription = {
      id,
      event,
    };
    if (options.if) {
      subscription.if = options.if;
    }
    if (options.ttl !== undefined) {
      subscription.ttl = duration("loop.subscribe", "a ttl", options.ttl);
    }

    this.unsubscriptions.delete(id);
    this.subscriptions.set(id, subscription);
  }

  private addUnsubscribe(id: string): void {
    this.assertInHandlerBody("loop.unsubscribe");
    if (this.kind === "fsm") {
      throw new NonRetriableError(
        "loop.unsubscribe called in an fsm.  an fsm has no subscriptions",
      );
    }
    assertId("loop.unsubscribe", id);

    this.subscriptions.delete(id);
    this.unsubscriptions.add(id);
  }

  /**
   * a memoized step does not run its callback again.  a loop call made in
   * the callback is lost on the next request of the run, so the call fails
   * the step.
   */
  private assertInHandlerBody(name: string): void {
    if (this.isInStep()) {
      throw new NonRetriableError(
        `${name} called inside a step.  call it from the handler body`,
      );
    }
  }
}

function assertId(name: string, id: unknown): asserts id is string {
  if (typeof id !== "string" || id === "") {
    throw new NonRetriableError(`${name} requires a non-empty id`);
  }
}

/**
 * converts a duration to the string form the server parses, such as "30s"
 * or "1h30m".
 */
function duration(name: string, what: string, input: DurationInput): string {
  let milliseconds: number;
  try {
    milliseconds = durationToMs(input);
  } catch {
    throw new NonRetriableError(`${name} requires ${what} above zero`);
  }

  return timeStr(milliseconds);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
