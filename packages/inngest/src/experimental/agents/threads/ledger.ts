/**
 * @module
 * EXPERIMENTAL: the thread ledger, which keeps thread state with no KV store.
 *
 * Two internal functions per app keep a thread's state. `agents-thread-ledger`
 * is a supervisor, one live run per thread key (a singleton that skips): it is
 * started by the first message for a thread and then lives for as long as the
 * thread's ledger does, invoking `agents-thread-ledger-run` to hold the
 * resolved state in its run. Because the supervisor never ends between two
 * ledger runs, a message cannot start a second, empty ledger while the state
 * is moving from one run to the next. The protocol is plain events:
 *
 * - `agent/thread.write { thread, runId, seq, change }`: a write. Every live
 *   run that holds a copy of the thread subscribes to it, and so does the
 *   ledger. There is no echo: each copy and the ledger resolve the writes they
 *   receive with the same rule (`ThreadResolver`).
 * - `agent/thread.read { thread, runId }`: asks for the resolved state. The
 *   ledger answers with `agent/thread.state { thread, runId, state, last }`.
 * - Handover: when a ledger run nears Inngest's step limit it returns its
 *   state (`ThreadHandoverData`) to the function that invoked it, which
 *   invokes the next run with it. No event carries a handover, so none can be
 *   skipped, dropped or reach a run that is not listening.
 * - `agent/thread.ready { thread, app, epoch, last }`: sent once a ledger run's
 *   subscription is open, with the last `seq` it applied for each writer. A
 *   reader whose `agent/thread.read` may have reached no live ledger asks again
 *   when it hears this, and a writer sends again the writes the ledger lacks
 *   (those with a `seq` past its entry in `last`).
 * - `agent/run.ended { thread, app, agent, runId, last }`: a run of the
 *   thread ended. The agent's `<id>-finished` function sends it, with the
 *   record of how the run ended. The ledger stores `last` as the thread's
 *   `__lastRun:<agent>` (the next run's `previousRun`) and does nothing else
 *   with it.
 *
 * The ledger only reads its inbox and stores. It never decides for anyone,
 * echoes, wakes a thread or sends an agent message.
 *
 * The rule every copy and the ledger apply to writes:
 *
 * - A run's own writes apply in its `seq` order: a later one is held until the
 *   earlier arrives. (A writer outside any run, named `ext-...`, is not held:
 *   its writes apply as they come.)
 * - Across writers, for one key, the later write wins, ordered by the event's
 *   `ts` (the time Inngest recorded the event on receipt, not the sender's
 *   clock), then the writer's run ID, then `seq`. A deleted key keeps a
 *   tombstone with its stamp, so a write that arrives late and is older than
 *   the delete does not bring the key back. `clear` is a stamp too.
 * - A write that would take the state past its size limit is refused by
 *   everyone.
 *
 * Because every copy applies the same rule to the same writes, copies converge
 * with the ledger, and a value never goes backwards for a key. Thread state is
 * a shared whiteboard everyone sees with a small lag: it is eventually
 * consistent, not a lock.
 *
 * Every event of the protocol is signed with the environment's signing key and
 * the signer's app ID (`by` and `sig` in its data). The ledger and the copies
 * drop an event with no valid signature, so a model or a holder of only an
 * event key cannot write, read or answer. Different apps of one environment
 * may write one thread's state; the signature is what they all need.
 *
 * A ledger run that took over by handover starts by sending `agent/thread.ready`
 * with the `seq` it holds for each writer. A writer sends again the writes it
 * made that the ledger did not apply, marked with the time they were first
 * recorded (`at`) so a late resend does not change which write is later.
 *
 * The ledger is storage behind `ledgerKvAdapter()`, the default KV store: it
 * keeps the keys and sorted indexes of one KV scope instance. Its address is
 * that instance's hash (`kvHash`), carried as `thread` in every event, so a
 * thread, an app and an environment each have a ledger. Events also carry the
 * `app` they belong to: a ledger function belongs to one app, so a
 * ledger is shared by the functions of one app only (`kv.env` included).
 *
 * Limits, which hold for every ledger:
 *
 * - Nothing here is durable outside the ledger's run. A ledger run waits for
 *   its next message for as long as the platform lets a run wait; it ends if it
 *   is cancelled or the platform ends it, and then its state is gone (the next
 *   message starts an empty ledger, and live writers send again what they
 *   hold). Near Inngest's step limit it hands over its state to the next run,
 *   through the supervisor that invoked it: that is the only planned end. The
 *   supervisor spends one step per run.
 * - Each write costs the writer one step and the ledger at most one (it takes
 *   in a batch of writes with one), so a ledger hands over after roughly 900
 *   writes. A state past 128 KB refuses writes.
 * - A write that reaches the ledger between its last read and its handover is
 *   sent again by its writer when the next ledger run's `agent/thread.ready`
 *   arrives. A writer that is not a run (a script) has no copy and cannot, and
 *   a run that ends before it hears the next ready cannot either, so such a
 *   write can be lost.
 */

import type { Inngest } from "../../../components/Inngest.ts";
import type { InngestFunction } from "../../../components/InngestFunction.ts";
import { inboxOpenedPromise } from "../../../components/inbox/Inbox.ts";
import {
  eventType,
  invoke,
  staticSchema,
} from "../../../components/triggers/triggers.ts";
import type { LastRun } from "../agent/recovery.ts";
import { ledgerDataIsSigned, signLedgerData } from "../agent/relations.ts";
import type { Json } from "../json.ts";
import { lastRunRecordKey } from "./thread.ts";

/**
 * The most a thread's resolved state may hold, as serialized JSON. Thread
 * state is for small data. It also keeps every event the ledger sends well
 * under the size an event may have.
 */
export const threadStateLimit = 128 * 1024;

/**
 * When a write happened, for ordering: the event's `ts`, the writer's run ID
 * and the writer's `seq`.
 */
export type Stamp = [ts: number, runId: string, seq: number];

/**
 * One key of a thread's state. A deleted key stays as a tombstone (`del`) so a
 * late, older write does not bring it back.
 */
export interface ThreadKey {
  v?: Json;

  /**
   * The time the key expires, in milliseconds since the epoch.
   */
  exp?: number;
  at: Stamp;
  del?: true;
}

/**
 * One member of a sorted index, with the same tombstone rule as a key.
 */
export interface ThreadMember {
  s?: number;
  at: Stamp;
  del?: true;
}

/**
 * The resolved state of one thread: its keys and its sorted indexes.
 */
export interface ThreadLedgerState {
  /**
   * The keys.
   */
  keys: Record<string, ThreadKey>;

  /**
   * The sorted indexes: member to score.
   */
  indexes: Record<string, Record<string, ThreadMember>>;

  /**
   * The stamp of the latest `clear`: nothing older than it is state.
   */
  cleared?: Stamp;
}

/**
 * What every event of the protocol carries: who signed it and the signature
 * (see `signLedgerData`). Events a signer made have both; one without them is
 * dropped.
 */
export type LedgerSigned = {
  by?: string;
  sig?: string;
};

/**
 * One write to a thread's state.
 */
export type ThreadChange =
  | {
      op: "set";
      key: string;
      value: Json;
      /**
       * How long the key lives, in seconds. Whoever applies the write turns it
       * into `exp` with the write's time, so every copy agrees.
       */
      ttl?: number;
      exp?: number;
    }
  | { op: "delete"; key: string }
  | { op: "clear" }
  | { op: "indexAdd"; index: string; member: string; score: number }
  | { op: "indexRemove"; index: string; member: string };

/**
 * The data of `agent/thread.write`.
 */
export type ThreadWriteData = LedgerSigned & {
  /**
   * The ledger's address: the hash of the KV scope instance it keeps.
   */
  thread: string;

  /**
   * The app whose ledger function takes the event.
   */
  app: string;

  /**
   * The writer: a run's ID, or a name starting with `ext-` for a write from
   * outside a run.
   */
  runId: string;

  /**
   * The writer's count of its writes, from 1.
   */
  seq: number;

  /**
   * The write.
   */
  change: ThreadChange;

  /**
   * Set on a write sent again: the `ts` Inngest recorded when the write was
   * first sent, so the resend orders where the first send would have.
   */
  at?: number;

  /**
   * Set on a write sent again: the lowest `seq` the writer still holds. The
   * ones before it cannot be sent, so a ledger that never saw them goes on
   * from here instead of holding every later write for them.
   */
  from?: number;
};

/**
 * The data of `agent/thread.read`.
 */
export type ThreadReadData = LedgerSigned & {
  /**
   * The ledger's address.
   */
  thread: string;

  /**
   * The app whose ledger function takes the event.
   */
  app: string;

  /**
   * The run that asks, which the answer is addressed to.
   */
  runId: string;

  /**
   * The asker's count of its reads, which the answer carries back, so an
   * answer to an earlier read is not taken for the answer to this one.
   */
  n?: number;
};

/**
 * The data of `agent/thread.state`, the answer to a read.
 */
export type ThreadStateData = ThreadReadData & {
  /**
   * The ledger run that answers.
   */
  epoch: string;

  /**
   * The resolved state.
   */
  state: ThreadLedgerState;

  /**
   * The last `seq` the state includes for each writer.
   */
  last: Record<string, number>;
};

/**
 * What one ledger run hands the next when it nears the step limit. It goes
 * through the supervisor's invocation, not through an event. The name is only
 * what the signature covers.
 */
export type ThreadHandoverData = LedgerSigned & {
  /**
   * The ledger's address.
   */
  thread: string;

  /**
   * The app.
   */
  app: string;

  /**
   * How many writes the state has taken in. Informational.
   */
  version: number;

  /**
   * The resolved state.
   */
  state: ThreadLedgerState;

  /**
   * The last `seq` applied for each writer, so a resent write is not applied
   * twice.
   */
  last: Record<string, number>;
};

/**
 * The data of `agent/thread.ready`: a ledger run's subscription is open.
 */
export type ThreadReadyData = LedgerSigned & {
  thread: string;
  app: string;
  epoch: string;

  /**
   * The last `seq` the ledger holds for each writer: a writer sends again
   * what is past its own entry.
   */
  last: Record<string, number>;

  /**
   * The run whose request started this ledger run and is answered in the same
   * batch, so that run need not ask again.
   */
  answered?: string;
};

/**
 * The data of `agent/run.ended`.
 */
export type RunEndedData = LedgerSigned & {
  /**
   * The ledger's address: the hash of the thread's KV scope instance.
   */
  thread: string;

  /**
   * The app.
   */
  app: string;

  /**
   * The agent, as `"appId/functionId"`: whose `__lastRun` to store.
   */
  agent: string;

  /**
   * The run that ended.
   */
  runId: string;

  /**
   * How the run ended: the thread's `lastRun` for the agent from now on.
   */
  last: LastRun;
};

export const threadWrite = eventType("agent/thread.write", {
  schema: staticSchema<ThreadWriteData>(),
});
export const threadRead = eventType("agent/thread.read", {
  schema: staticSchema<ThreadReadData>(),
});
export const threadStateReply = eventType("agent/thread.state", {
  schema: staticSchema<ThreadStateData>(),
});

const handoverName = "agent/thread.handover";

/**
 * What the supervisor invokes a ledger run with: the message that started the
 * thread's ledger (the first run) or the state the run before it handed over.
 */
export type LedgerRunInput = {
  start?: {
    id?: string;
    name: string;
    ts?: number;
    data: Record<string, unknown>;
  };
  carried?: ThreadHandoverData;
};

/**
 * What a ledger run returns to the supervisor: with `handover` the run hit the
 * step limit and the next one takes over.
 */
export type LedgerRunResult = {
  thread: string;
  version: number;
  handover?: ThreadHandoverData;
};
export const threadReady = eventType("agent/thread.ready", {
  schema: staticSchema<ThreadReadyData>(),
});
export const runEnded = eventType("agent/run.ended", {
  schema: staticSchema<RunEndedData>(),
});

/**
 * An empty thread state.
 */
export const emptyThreadState = (): ThreadLedgerState => {
  return { keys: {}, indexes: {} };
};

/**
 * The size of a state as serialized JSON, in bytes.
 */
export const stateSize = (state: ThreadLedgerState): number => {
  return new TextEncoder().encode(JSON.stringify(state)).length;
};

/**
 * The message of the error a write past the size limit throws.
 */
export const overLimitMessage = (thread: string, size: number): string => {
  return `Ledger state of "${thread}" would be ${size} bytes, past the limit of ${threadStateLimit} bytes. The ledger KV store is for small data: keep less in it, or configure a store adapter with createAgents(client, { store }).`;
};

/**
 * Orders two stamps: negative when `a` is earlier.
 */
export const compareStamps = (a: Stamp, b: Stamp): number => {
  if (a[0] !== b[0]) {
    return a[0] < b[0] ? -1 : 1;
  }

  if (a[1] !== b[1]) {
    return a[1] < b[1] ? -1 : 1;
  }

  return a[2] === b[2] ? 0 : a[2] < b[2] ? -1 : 1;
};

/**
 * The value of a key, if it is set and has not expired.
 */
export const liveKey = (
  state: ThreadLedgerState,
  key: string,
  now: number,
): { v: Json } | undefined => {
  const found = Object.hasOwn(state.keys, key) ? state.keys[key] : undefined;

  return found &&
    !found.del &&
    found.v !== undefined &&
    (found.exp === undefined || found.exp > now)
    ? { v: found.v }
    : undefined;
};

/**
 * The change with its `ttl` turned into an `exp` from `now`.
 * @param change The change.
 * @param now The time, in milliseconds since the epoch.
 */
export const resolveTtl = (change: ThreadChange, now: number): ThreadChange => {
  if (change.op === "set" && "ttl" in change) {
    const { ttl, ...rest } = change;

    return ttl === undefined ? rest : { ...rest, exp: now + ttl * 1000 };
  }

  return change;
};

/**
 * Applies a change to a state, in place, if it is later than what the state
 * holds for what it touches. Applying the same write again changes nothing.
 * @param state The state.
 * @param change The change, with its `ttl` already resolved.
 * @param at The write's stamp.
 */
export const applyChange = (
  state: ThreadLedgerState,
  change: ThreadChange,
  at: Stamp,
): void => {
  const covered = state.cleared && compareStamps(at, state.cleared) <= 0;

  switch (change.op) {
    case "set": {
      const found = Object.hasOwn(state.keys, change.key)
        ? state.keys[change.key]
        : undefined;

      if (covered || (found && compareStamps(found.at, at) >= 0)) {
        return;
      }

      state.keys[change.key] = {
        v: change.value,
        ...(change.exp !== undefined && { exp: change.exp }),
        at,
      };
      return;
    }
    case "delete": {
      const found = Object.hasOwn(state.keys, change.key)
        ? state.keys[change.key]
        : undefined;

      if (covered || (found && compareStamps(found.at, at) >= 0)) {
        return;
      }

      state.keys[change.key] = { del: true, at };
      return;
    }
    case "clear": {
      if (covered) {
        return;
      }

      state.cleared = at;

      for (const [key, found] of Object.entries(state.keys)) {
        if (compareStamps(found.at, at) < 0) {
          delete state.keys[key];
        }
      }

      for (const [index, members] of Object.entries(state.indexes)) {
        for (const [member, found] of Object.entries(members)) {
          if (compareStamps(found.at, at) < 0) {
            delete members[member];
          }
        }

        if (Object.keys(members).length === 0) {
          delete state.indexes[index];
        }
      }

      return;
    }
    case "indexAdd":
    case "indexRemove": {
      const members = Object.hasOwn(state.indexes, change.index)
        ? state.indexes[change.index]
        : undefined;
      const found =
        members && Object.hasOwn(members, change.member)
          ? members[change.member]
          : undefined;

      if (covered || (found && compareStamps(found.at, at) >= 0)) {
        return;
      }

      const target = members ?? {};

      state.indexes[change.index] = target;
      target[change.member] =
        change.op === "indexAdd" ? { s: change.score, at } : { del: true, at };
      return;
    }
  }
};

/**
 * Whether a writer's writes are applied in `seq` order. A writer outside any
 * run has no count a lost write could be waiting on, so its writes are not.
 */
const isOrdered = (runId: string): boolean => {
  return !runId.startsWith("ext-");
};

/**
 * A write the resolver refused for taking the state past its size limit.
 */
export type Refused = { write: ThreadWriteData; size: number };

/**
 * The one rule every copy and the ledger resolve writes with: a writer's own
 * writes apply in `seq` order (a later one waits for the earlier), and across
 * writers the later write of a key wins by (event `ts`, writer, `seq`).
 */
export class ThreadResolver {
  state: ThreadLedgerState;

  /**
   * The time of the latest event taken in. Expiry is judged by it, so a
   * replay reaches the same state.
   */
  clock: number;

  /**
   * The last `seq` applied for each writer.
   */
  readonly last = new Map<string, number>();

  /**
   * How many writes have been applied.
   */
  applied = 0;

  private readonly held = new Map<
    string,
    { write: ThreadWriteData; ts: number }
  >();

  constructor(
    init: {
      state?: ThreadLedgerState;
      last?: Record<string, number>;
      clock?: number;
      applied?: number;
    } = {},
  ) {
    this.state = init.state ?? emptyThreadState();
    this.clock = init.clock ?? 0;
    this.applied = init.applied ?? 0;

    for (const [writer, seq] of Object.entries(init.last ?? {})) {
      this.last.set(writer, seq);
    }
  }

  /**
   * Takes in a write the event stream delivered.
   * @param write The write.
   * @param eventTs The event's `ts`: when Inngest recorded it.
   * @returns The writes refused for size, this one or one it released.
   */
  take(write: ThreadWriteData, eventTs: number | undefined): Refused[] {
    const ts = write.at ?? eventTs ?? this.clock;

    this.clock = Math.max(this.clock, eventTs ?? 0);

    if (!isOrdered(write.runId)) {
      return this.apply(write, ts);
    }

    // A writer that sent again says what it no longer holds: go on from there.
    if (
      write.from !== undefined &&
      (this.last.get(write.runId) ?? 0) < write.from - 1
    ) {
      this.last.set(write.runId, write.from - 1);
    }

    const done = this.last.get(write.runId) ?? 0;

    if (write.seq <= done) {
      return [];
    }

    if (write.seq !== done + 1) {
      this.held.set(`${write.runId}:${write.seq}`, { write, ts });

      return [];
    }

    return [...this.apply(write, ts), ...this.release()];
  }

  /**
   * The writes taken in that wait for an earlier one of their writer.
   */
  get waiting(): number {
    return this.held.size;
  }

  private release(): Refused[] {
    const refused: Refused[] = [];
    let moved = true;

    while (moved) {
      moved = false;

      for (const [key, found] of [...this.held.entries()]) {
        const done = this.last.get(found.write.runId) ?? 0;

        if (found.write.seq <= done) {
          this.held.delete(key);
        } else if (found.write.seq === done + 1) {
          this.held.delete(key);
          refused.push(...this.apply(found.write, found.ts));
          moved = true;
        }
      }
    }

    return refused;
  }

  private apply(write: ThreadWriteData, ts: number): Refused[] {
    if (isOrdered(write.runId)) {
      this.last.set(write.runId, write.seq);
    }

    const next = structuredClone(this.state);

    applyChange(next, resolveTtl(write.change, ts), [
      ts,
      write.runId,
      write.seq,
    ]);

    const size = stateSize(next);

    if (size > threadStateLimit) {
      return [{ write, size }];
    }

    this.state = next;
    this.applied += 1;

    return [];
  }
}

/**
 * How many steps a ledger run may use before it hands over to a fresh run.
 * Inngest ends a run at 1,000 steps. `INNGEST_EXPERIMENTAL_LEDGER_STEP_LIMIT`
 * shortens it, for tests.
 */
const handoverAt = (): number => {
  const given =
    typeof process === "undefined"
      ? undefined
      : Number(process.env.INNGEST_EXPERIMENTAL_LEDGER_STEP_LIMIT);

  return given && given > 0 ? given : 900;
};

/**
 * How long the supervisor waits for a ledger run, which waits for its next
 * message for as long as the platform lets a run wait.
 */
const invokeTimeout = "365d";

const quoted = (value: string): string => {
  return JSON.stringify(value);
};

/**
 * The apps (by ID) whose ledger functions were made in this process, which is
 * what `agents.functions()` does. A run of an app that is not in it would wait
 * for a ledger no function serves.
 */
const ledgerApps = new Set<string>();

/**
 * Whether this process made the ledger functions of an app (it called
 * `agents.functions()`), so a run's first use of the ledger can tell a missing
 * ledger from a slow one with no timer.
 * @param app The app ID.
 */
export const ledgerIsServed = (app: string): boolean => {
  return ledgerApps.has(app);
};

type Message = {
  id?: string;
  name: string;
  ts?: number;
  data: unknown;
};

/**
 * How often a ledger request that failed is tried again. The thread's state
 * lives only in the ledger run, so a run that fails loses it, and the next
 * read starts a ledger from empty state: a live run's record is gone until
 * that run next touches thread state, and `thread.stop()` finds no run to
 * cancel. A request fails when the app cannot be reached, which a deploy or a
 * restart causes, so the ledger rides that out instead of failing at once.
 * Its steps are memoized, so a retry repeats nothing.
 */
const ledgerRetries = 10;

/**
 * The ledger of an app: a function per thread key whose run holds the thread's
 * state. Served with the app's agents.
 */
export const createLedgerFunctions = (
  client: Inngest.Any,
): InngestFunction.Any[] => {
  ledgerApps.add(client.id);

  // Holds the state of one thread in its run and returns it to the supervisor
  // near the step limit.
  const run = client.createFunction(
    {
      id: "agents-thread-ledger-run",
      retries: ledgerRetries,
      optimizeParallelism: false,
      triggers: [invoke(staticSchema<LedgerRunInput>())],
    },
    async ({ event, step, logger, runId }) => {
      const input = event.data as unknown as LedgerRunInput;
      const origin = input.carried ?? input.start?.data;

      if (!origin) {
        return { thread: "", version: 0 } satisfies LedgerRunResult;
      }

      const thread = String(origin.thread);
      const app = String(origin.app);
      const limit = handoverAt();
      const mine = `async.data.thread == ${quoted(thread)} && async.data.app == ${quoted(app)}`;

      // This run's name, so a reader can tell which ledger run answered.
      const epoch = runId;

      const signed = <T extends Record<string, unknown>>(
        name: string,
        data: T,
      ) => {
        return signLedgerData(client, name, data);
      };

      // An event with no valid signature is dropped.
      const valid = (message: { name: string; data: unknown }): boolean => {
        if (ledgerDataIsSigned(client, message.name, message.data)) {
          return true;
        }

        logger.warn(
          { thread, event: message.name },
          "dropped a ledger event with no valid signature",
        );

        return false;
      };

      const seen = new Set<string>();
      let steps = 0;

      // A run that takes over carries the state the run before it left.
      const carried =
        input.carried && valid({ name: handoverName, data: input.carried })
          ? input.carried
          : undefined;
      const start = carried ? undefined : input.start;
      const resolver = new ThreadResolver({
        state: carried?.state,
        last: carried?.last,
        applied: carried?.version,
        clock: input.start?.ts ?? 0,
      });

      logger.info(
        {
          thread,
          started: carried ? "handover" : start?.name,
          version: resolver.applied,
          epoch,
        },
        "thread ledger run started",
      );

      await using sub = step.subscribe("ledger", [
        {
          event: threadWrite.name,
          if: mine,
        },
        {
          event: threadRead.name,
          if: mine,
        },
        {
          event: runEnded.name,
          if: mine,
        },
      ]);

      await inboxOpenedPromise(sub);
      steps += 1;

      const out: Array<
        ReturnType<typeof threadStateReply.create | typeof threadReady.create>
      > = [];

      const resolve = (write: ThreadWriteData, ts: number | undefined) => {
        for (const refused of resolver.take(write, ts)) {
          logger.warn(
            {
              thread,
              writer: refused.write.runId,
              size: refused.size,
              limit: threadStateLimit,
            },
            "thread write refused: the state would pass its size limit",
          );
        }
      };

      // Takes in one message: a write is resolved, a read is answered, the end
      // of a run is stored.
      const take = (message: Message): void => {
        if (!valid(message)) {
          return;
        }

        if (message.id) {
          if (seen.has(message.id)) {
            return;
          }

          seen.add(message.id);
        }

        if (message.name === runEnded.name) {
          // Stored as the agent's `__lastRun` and nothing else: what to do
          // about the end is for the agents to say.
          const ended = message.data as RunEndedData;

          resolve(
            {
              thread,
              app,
              runId: "ledger",
              seq: (resolver.last.get("ledger") ?? 0) + 1,
              change: {
                op: "set",
                key: lastRunRecordKey(ended.agent),
                value: JSON.stringify(ended.last),
              },
            },
            message.ts,
          );

          return;
        }

        if (message.name === threadRead.name) {
          const data = message.data as ThreadReadData;

          out.push(
            threadStateReply.create(
              signed(threadStateReply.name, {
                thread,
                app,
                runId: data.runId,
                n: data.n,
                epoch,
                state: resolver.state,
                last: Object.fromEntries(resolver.last),
              }),
            ),
          );

          return;
        }

        resolve(message.data as ThreadWriteData, message.ts);
      };

      if (start) {
        take(start);
      }

      // Tells readers whose read may have found no live ledger that this one
      // is listening, and writers which of their writes it holds. After the
      // answer to the read that started this run, so that reader does not ask
      // twice.
      out.push(
        threadReady.create(
          signed(threadReady.name, {
            thread,
            app,
            epoch,
            last: Object.fromEntries(resolver.last),
            ...(start?.name === threadRead.name && {
              answered: String(start.data.runId),
            }),
          }),
        ),
      );

      let batchN = 0;

      while (true) {
        if (out.length > 0) {
          batchN += 1;
          steps += 1;
          await step.sendEvent(`out:${batchN}`, [...out]);
          out.length = 0;
        }

        // Near the limit the ledger hands its state back to the supervisor,
        // which invokes the next run with it. A write that reaches no run
        // between the two is sent again by its writer when the next run's
        // `agent/thread.ready` arrives.
        if (steps + 3 >= limit) {
          logger.info(
            { thread, version: resolver.applied, steps },
            "thread ledger nears the step limit and hands over",
          );

          return {
            thread,
            version: resolver.applied,
            handover: signed(handoverName, {
              thread,
              app,
              version: resolver.applied,
              state: resolver.state,
              last: Object.fromEntries(resolver.last),
            }) satisfies ThreadHandoverData,
          } satisfies LedgerRunResult;
        }

        const batch = await sub.nextBatch();

        steps += 1;

        if (batch === undefined || batch === null) {
          return {
            thread,
            version: resolver.applied,
          } satisfies LedgerRunResult;
        }

        for (const message of batch) {
          take(message as Message);
        }
      }
    },
  );

  // The supervisor: one live run per thread, started by the first message for
  // it. It invokes a ledger run and, when that hands over, the next one with the
  // state, so the thread always has a live run and no message can start a
  // second ledger from empty state while the state moves on.
  const ledger = client.createFunction(
    {
      id: "agents-thread-ledger",
      retries: ledgerRetries,
      triggers: [threadWrite.name, threadRead.name, runEnded.name].map(
        (event) => {
          // A ledger function belongs to one app and takes only its events.
          return { event, if: `event.data.app == ${quoted(client.id)}` };
        },
      ),
      singleton: { key: "event.data.thread", mode: "skip" },
    },
    async ({ event, step }) => {
      const first = event as unknown as {
        id?: string;
        name: string;
        ts?: number;
        data: Record<string, unknown>;
      };
      let input: LedgerRunInput = {
        start: {
          id: first.id,
          name: first.name,
          ts: first.ts,
          data: first.data,
        },
      };

      for (let generation = 1; ; generation++) {
        const result = (await step.invoke(`run:${generation}`, {
          function: run,
          data: input as Record<string, unknown>,
          timeout: invokeTimeout,
        })) as LedgerRunResult;

        if (!result.handover) {
          return result;
        }

        input = { carried: result.handover };
      }
    },
  );

  return [ledger, run as unknown as InngestFunction.Any];
};
