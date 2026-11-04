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
 * - `agent/thread.write { thread, runId, seq, change }`: a write. `seq`
 *   numbers the writes of one writer, because delivery order is not
 *   guaranteed. The ledger applies a writer's writes in `seq` order and gives
 *   each applied write the thread's next `version`.
 * - `agent/thread.changed { thread, version, runId, seq, change }`: what the
 *   ledger sends for each applied write. Every live run that holds a copy of
 *   the thread receives it through an inbox filtered by thread and applies
 *   changes in version order.
 * - `agent/thread.read { thread, runId }`: asks for the resolved state. The
 *   ledger answers with `agent/thread.state { thread, runId, version, state,
 *   seq }`.
 * - Handover: when a ledger run nears Inngest's step limit it returns its
 *   state (`ThreadHandoverData`) to the function that invoked it, which
 *   invokes the next run with it. No event carries a handover, so none can be
 *   skipped, dropped or reach a run that is not listening.
 * - `agent/thread.ready { thread, app, epoch }`: sent once a ledger run's
 *   subscription is open. A reader whose `agent/thread.read` may have reached
 *   no live ledger asks again when it hears this.
 * - `agent/run.ended { thread, app, agent, runId, last }`: a run of the
 *   thread ended. The agent's `<id>-finished` function sends it, with the
 *   record of how the run ended. The ledger stores `last` as the thread's
 *   `__lastRun:<agent>` (the next run's `previousRun`) and does nothing else
 *   with it.
 *
 * The ledger only stores. It never decides for anyone, resends, wakes a
 * thread or sends an agent message: `agent/finished` and its `missing` are the
 * business of the agents, not of the ledger.
 *
 * Every event of the protocol is signed with the environment's signing key and
 * the signer's app ID (`by` and `sig` in its data). The ledger and the copies
 * drop an event with no valid signature, so a model or a holder of only an
 * event key cannot write, read or answer. Different apps of one environment
 * may write one thread's state; the signature is what they all need.
 *
 * Every ledger run has an `epoch`, its run ID, which `agent/thread.changed`,
 * `agent/thread.state` and `agent/thread.ready` carry. A copy that sees a
 * different epoch than its own reloads with one read, because a ledger that
 * started over restarts the versions. A ledger run that took over by handover
 * starts by sending a `reset` change: the state and, for each writer, the last
 * `seq` it applied. A writer that hears a `reset` sends again the writes it
 * made that the ledger did not apply.
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
 *   message starts an empty ledger). Near Inngest's step limit it hands over
 *   its state to the next run, through the supervisor that invoked it: that is
 *   the only planned end. The supervisor spends one step per run, so a thread
 *   keeps its ledger for about 400,000 writes.
 * - Each write costs the writer one step and the ledger two, so a ledger hands
 *   over after roughly 400 writes. A state past 128 KB refuses writes.
 * - A write that reaches the ledger between its last read and its handover is
 *   sent again by its writer when the next ledger run's `reset` arrives. A
 *   writer that is not a run (a script) or never reads or syncs has no copy
 *   and cannot, so such a write can be lost.
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
 * The resolved state of one thread: its keys and its sorted indexes.
 */
export interface ThreadLedgerState {
  /**
   * The keys. `exp` is the time the key expires, in milliseconds since the
   * epoch.
   */
  keys: Record<string, { v: Json; exp?: number }>;

  /**
   * The sorted indexes: member to score.
   */
  indexes: Record<string, Record<string, number>>;
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
       * How long the key lives, in seconds. The ledger turns it into `exp`
       * with the time of the write event, so every copy agrees.
       */
      ttl?: number;
      exp?: number;
    }
  | {
      op: "setIfAbsent";
      key: string;
      value: Json;
      ttl?: number;
      exp?: number;
    }
  | {
      /**
       * Deletes the key only when its live value is `expected`. The ledger
       * says whether it did.
       */
      op: "casDelete";
      key: string;
      expected: Json;
    }
  | {
      /**
       * Replaces the key only when its live value is `expected` (`null`:
       * the key is absent). The ledger says whether it did.
       */
      op: "cas";
      key: string;
      expected: Json | null;
      value: Json;
    }
  | { op: "delete"; key: string }
  | { op: "clear" }
  | { op: "indexAdd"; index: string; member: string; score: number }
  | { op: "indexRemove"; index: string; member: string }
  | {
      /**
       * Sent by the ledger, never by a writer: tells every copy the state a
       * run took over by handover holds. `last` is the last `seq` applied for
       * each writer.
       */
      op: "reset";
      state: ThreadLedgerState;
      last: Record<string, number>;
    };

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
};

/**
 * The data of `agent/thread.changed`.
 */
export type ThreadChangedData = ThreadWriteData & {
  /**
   * The ledger run that applied the write. A copy that sees another epoch
   * than the one it holds reloads.
   */
  epoch: string;

  /**
   * The thread's version after this change. Starts at 1 and rises by one for
   * each applied write.
   */
  version: number;

  /**
   * Set when the ledger refused the write, so the writer drops its own copy
   * of it. A refused write does not change the version.
   */
  rejected?: string;

  /**
   * Set when a conditional write (`setIfAbsent`, `cas`) did not apply because
   * the key was not as the writer expected. `current` is the key's live value
   * then (`null`: absent). A refused write does not change the version.
   */
  conflict?: { current: Json | null };
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
   * The version the state is at.
   */
  version: number;

  /**
   * The resolved state.
   */
  state: ThreadLedgerState;

  /**
   * The last `seq` of the asking run's writes that the state includes.
   */
  seq: number;
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
   * The version the state is at.
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
export const threadChanged = eventType("agent/thread.changed", {
  schema: staticSchema<ThreadChangedData>(),
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
 * The value of a key, if it is set and has not expired.
 */
export const liveKey = (
  state: ThreadLedgerState,
  key: string,
  now: number,
): { v: Json } | undefined => {
  const found = Object.hasOwn(state.keys, key) ? state.keys[key] : undefined;

  return found && (found.exp === undefined || found.exp > now)
    ? found
    : undefined;
};

/**
 * The change with its `ttl` turned into an `exp` from `now`.
 * @param change The change.
 * @param now The time, in milliseconds since the epoch.
 */
export const resolveTtl = (change: ThreadChange, now: number): ThreadChange => {
  if ((change.op === "set" || change.op === "setIfAbsent") && "ttl" in change) {
    const { ttl, ...rest } = change;

    return ttl === undefined ? rest : { ...rest, exp: now + ttl * 1000 };
  }

  return change;
};

/**
 * Applies a change to a state, in place.
 * @param state The state.
 * @param change The change.
 * @param now The time, in milliseconds since the epoch.
 * @returns Whether it applied. Only a conditional change (`setIfAbsent`,
 * `cas`) can be refused.
 */
export const applyChange = (
  state: ThreadLedgerState,
  change: ThreadChange,
  now: number,
): boolean => {
  switch (change.op) {
    case "set":
      state.keys[change.key] = {
        v: change.value,
        ...(change.exp !== undefined && { exp: change.exp }),
      };
      return true;
    case "setIfAbsent":
      if (!liveKey(state, change.key, now)) {
        state.keys[change.key] = {
          v: change.value,
          ...(change.exp !== undefined && { exp: change.exp }),
        };

        return true;
      }

      return false;
    case "cas": {
      const live = liveKey(state, change.key, now);

      if ((live?.v ?? null) !== change.expected) {
        return false;
      }

      state.keys[change.key] = { v: change.value };

      return true;
    }
    case "casDelete": {
      if (liveKey(state, change.key, now)?.v !== change.expected) {
        return false;
      }

      delete state.keys[change.key];

      return true;
    }
    case "delete":
      delete state.keys[change.key];
      return true;
    case "clear":
      state.keys = {};
      state.indexes = {};
      return true;
    case "indexAdd": {
      const members = Object.hasOwn(state.indexes, change.index)
        ? state.indexes[change.index]
        : undefined;

      const target = members ?? {};

      state.indexes[change.index] = target;
      target[change.member] = change.score;
      return true;
    }
    case "indexRemove": {
      const members = state.indexes[change.index];

      if (members) {
        delete members[change.member];

        if (Object.keys(members).length === 0) {
          delete state.indexes[change.index];
        }
      }

      return true;
    }
    default:
      return true;
  }
};

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
 * How long the ledger holds a write that arrived ahead of an earlier one from
 * the same writer, in milliseconds, before it applies the writes it has and
 * moves past the gap.
 */
const gapWaitMs = 5000;

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
      retries: 0,
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

      // This run's name for the copies: a copy that sees another one reloads.
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

      let state = emptyThreadState();
      let version = 0;

      // The time of the latest event taken in. Expiry is judged by it, so a
      // replay of the run reaches the same state.
      let clock = input.start?.ts ?? 0;

      // The last `seq` applied for each writer, and writes that came ahead of
      // their turn.
      const last = new Map<string, number>();
      const held = new Map<string, ThreadWriteData>();
      const seen = new Set<string>();
      let steps = 0;

      // A run that takes over carries the state the run before it left, and
      // says so to the copies with a `reset`.
      const carried =
        input.carried && valid({ name: handoverName, data: input.carried })
          ? input.carried
          : undefined;
      const start = carried ? undefined : input.start;

      if (carried) {
        state = carried.state;
        version = carried.version;

        for (const [writer, seq] of Object.entries(carried.last)) {
          last.set(writer, seq);
        }
      }

      logger.info(
        {
          thread,
          started: carried ? "handover" : start?.name,
          version,
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
        ReturnType<
          | typeof threadChanged.create
          | typeof threadStateReply.create
          | typeof threadReady.create
        >
      > = [];

      const changedOf = (
        write: ThreadWriteData,
        extra: Partial<ThreadChangedData>,
      ) => {
        return threadChanged.create(
          signed(threadChanged.name, {
            thread,
            app,
            runId: write.runId,
            seq: write.seq,
            change: write.change,
            epoch,
            version,
            ...extra,
          }),
        );
      };

      const apply = (write: ThreadWriteData) => {
        last.set(write.runId, write.seq);

        const change = resolveTtl(write.change, clock);
        const next = structuredClone(state);

        if (!applyChange(next, change, clock)) {
          // A conditional write that did not apply: the writer is told what the
          // key holds, and nothing changes.
          const key = (change as { key: string }).key;

          out.push(
            changedOf(
              { ...write, change },
              { conflict: { current: liveKey(state, key, clock)?.v ?? null } },
            ),
          );

          return;
        }

        const size = stateSize(next);

        if (size > threadStateLimit) {
          logger.warn(
            { thread, size, limit: threadStateLimit },
            "thread write refused: the state would pass its size limit",
          );
          out.push(
            changedOf(
              { ...write, change },
              { rejected: overLimitMessage(thread, size) },
            ),
          );

          return;
        }

        state = next;
        version += 1;

        out.push(changedOf({ ...write, change }, {}));
      };

      const resetOf = () => {
        return threadChanged.create(
          signed(threadChanged.name, {
            thread,
            app,
            runId: "ledger",
            seq: 0,
            epoch,
            version,
            change: {
              op: "reset" as const,
              state,
              last: Object.fromEntries(last),
            },
          }),
        );
      };

      // Takes in one message: a write goes in order or is held, a read is
      // answered, the end of a run is stored.
      const take = (message: {
        id?: string;
        name: string;
        ts?: number;
        data: unknown;
      }): void => {
        if (!valid(message)) {
          return;
        }

        if (message.id) {
          if (seen.has(message.id)) {
            return;
          }

          seen.add(message.id);
        }

        if (typeof message.ts === "number") {
          clock = Math.max(clock, message.ts);
        }

        if (message.name === runEnded.name) {
          // Stored as the agent's `__lastRun` and nothing else: what to do
          // about the end is for the agents to say.
          const ended = message.data as RunEndedData;

          apply({
            thread,
            app,
            runId: "ledger",
            seq: (last.get("ledger") ?? 0) + 1,
            change: {
              op: "set",
              key: lastRunRecordKey(ended.agent),
              value: JSON.stringify(ended.last),
            },
          });

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
                version,
                state,
                seq: last.get(data.runId) ?? 0,
              }),
            ),
          );

          return;
        }

        const write = message.data as ThreadWriteData;
        const done = last.get(write.runId) ?? 0;

        if (write.seq <= done) {
          return;
        }

        if (write.seq !== done + 1) {
          held.set(`${write.runId}:${write.seq}`, write);

          return;
        }

        apply(write);
      };

      // Applies held writes whose turn has come; with `force`, also the ones
      // that are still ahead of a gap, in order.
      const release = (force: boolean) => {
        let moved = true;

        while (moved) {
          moved = false;

          for (const [key, write] of [...held.entries()].sort(
            ([, a], [, b]) => {
              return a.seq - b.seq;
            },
          )) {
            const done = last.get(write.runId) ?? 0;

            if (write.seq <= done) {
              held.delete(key);
            } else if (write.seq === done + 1 || force) {
              held.delete(key);
              apply(write);
              moved = true;
            }
          }
        }
      };

      // A ledger that took over by handover tells every copy what it holds and
      // which writes of theirs it applied.
      if (carried) {
        version += 1;
        out.push(resetOf());
      } else if (start) {
        take(start);
        release(false);
      }

      // Tells readers whose read may have found no live ledger that this one
      // is listening. After the answer to the read that started this run, so
      // that reader does not ask twice.
      out.push(
        threadReady.create(
          signed(threadReady.name, {
            thread,
            app,
            epoch,
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
        // `reset` arrives.
        if (steps + 3 >= limit) {
          logger.info(
            { thread, version, steps },
            "thread ledger nears the step limit and hands over",
          );

          return {
            thread,
            version,
            handover: signed(handoverName, {
              thread,
              app,
              version,
              state,
              last: Object.fromEntries(last),
            }) satisfies ThreadHandoverData,
          } satisfies LedgerRunResult;
        }

        const batch =
          held.size > 0
            ? await sub.nextBatch({ timeout: gapWaitMs })
            : await sub.nextBatch();

        steps += 1;

        if (batch === undefined) {
          return { thread, version } satisfies LedgerRunResult;
        }

        if (batch === null) {
          release(true);
          continue;
        }

        for (const message of batch) {
          take(
            message as {
              id?: string;
              name: string;
              ts?: number;
              data: unknown;
            },
          );
        }

        release(false);
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
      retries: 0,
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
