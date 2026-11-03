/**
 * @module
 * EXPERIMENTAL: the thread ledger, which keeps thread state with no KV store.
 *
 * One internal function per app (`agents-thread-ledger`) holds the resolved
 * state of a thread in its own run, one live run per thread key. The protocol
 * is plain events:
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
 * - `agent/thread.handover { thread, version, state, last }`: starts a fresh
 *   ledger run carrying the state when the old one nears Inngest's step limit.
 * - `agent/thread.ended { thread, runId, last, required?, notice? }`: a run of
 *   the thread ended. The thread's `<id>-finished` function sends it from the
 *   executor's `inngest/function.finished`, which names the run and its
 *   trigger event but not the thread, so that function is the one place that
 *   knows both. The ledger records `last` as the thread's `__lastRun` (the
 *   next run's `previousRun`) and, when the run was started by `start_agent`,
 *   sends the starter its `agent/finished` with `missing`: the owed reports
 *   (`required`) that are not in the `__reports` record the run kept in this
 *   thread's state as it sent them.
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
 *   its state to a fresh run: that is the only planned end.
 * - Each write costs the writer one step and the ledger two, so a ledger hands
 *   over after roughly 400 writes. A state past 128 KB refuses writes.
 * - A write that reaches the ledger between its last read and its handover is
 *   lost.
 */

import { createDefer } from "../../../components/DeferredFunction.ts";
import type { Inngest } from "../../../components/Inngest.ts";
import type { InngestFunction } from "../../../components/InngestFunction.ts";
import { inboxOpenedPromise } from "../../../components/inbox/Inbox.ts";
import {
  eventType,
  staticSchema,
} from "../../../components/triggers/triggers.ts";
import { type AgentFinishedData, agentFinished } from "../inbox/events.ts";
import type { Json } from "../json.ts";

/**
 * The thread-state key of the reports an agent's run has sent, which the run
 * writes as it sends them. It is the agent's own: two agents may share a thread
 * key. The ledger reads it when the run ends, to tell the starter which owed
 * reports never came. The `__` prefix hides it from `state().keys`.
 * @param agent The agent, as `"appId/functionId"`.
 */
export const reportsRecordKey = (agent: string): string => {
  return `__reports:${agent}`;
};

/**
 * What `reportsRecordKey` holds: the run, and the reports it has sent.
 */
export interface ReportsRecord {
  run: string;
  sent: string[];
}

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
 * One write to a thread's state.
 */
export type ThreadChange =
  | { op: "set"; key: string; value: Json; exp?: number }
  | { op: "setIfAbsent"; key: string; value: Json; exp?: number }
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
       * Sent by the ledger, never by a writer: replaces a copy's state after
       * a handover reached a run that had already started empty. `last` is
       * the last `seq` applied for each writer.
       */
      op: "reset";
      state: ThreadLedgerState;
      last: Record<string, number>;
    };

/**
 * The data of `agent/thread.write`.
 */
export type ThreadWriteData = {
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
export type ThreadReadData = {
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
};

/**
 * The data of `agent/thread.state`, the answer to a read.
 */
export type ThreadStateData = ThreadReadData & {
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
 * The data of `agent/thread.handover`.
 */
export type ThreadHandoverData = {
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
 * The data of `agent/thread.ended`.
 */
export type ThreadEndedData = {
  /**
   * The ledger's address: the hash of the thread's KV scope instance.
   */
  thread: string;

  /**
   * The app.
   */
  app: string;

  /**
   * The agent, as `"appId/functionId"`: whose `__reports` record to read.
   */
  agent: string;

  /**
   * The run that ended.
   */
  runId: string;

  /**
   * The reports the run owed, by name.
   */
  required?: string[];

  /**
   * The `agent/finished` to send the starter, for a run `start_agent` began,
   * complete except for `missing`.
   */
  notice?: AgentFinishedData;
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
export const threadHandover = eventType("agent/thread.handover", {
  schema: staticSchema<ThreadHandoverData>(),
});
export const threadEnded = eventType("agent/thread.ended", {
  schema: staticSchema<ThreadEndedData>(),
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

const quoted = (value: string): string => {
  return JSON.stringify(value);
};

/**
 * The ledger of an app: a function per thread key whose run holds the thread's
 * state. Served with the app's agents.
 */
export const createLedgerFunctions = (
  client: Inngest.Any,
): InngestFunction.Any[] => {
  // Runs after a ledger run ends and starts the next one with the state.
  const handoverFn = createDefer(
    client,
    { id: "agents-thread-ledger-handover" },
    async ({ event, step }) => {
      await step.sendEvent(
        "handover",
        threadHandover.create(event.data as ThreadHandoverData),
      );
    },
  );

  const ledger = client.createFunction(
    {
      id: "agents-thread-ledger",
      retries: 0,
      optimizeParallelism: false,
      triggers: [
        threadWrite.name,
        threadRead.name,
        threadHandover.name,
        threadEnded.name,
      ].map((event) => {
        // A ledger function belongs to one app and takes only its events.
        return { event, if: `event.data.app == ${quoted(client.id)}` };
      }),
      singleton: { key: "event.data.thread", mode: "skip" },
    },
    async ({ event, step, defer, logger }) => {
      const start = event as unknown as {
        id?: string;
        name: string;
        data: Record<string, unknown>;
      };
      const thread = String(start.data.thread);
      const app = String(start.data.app);
      const limit = handoverAt();
      const mine = `async.data.thread == ${quoted(thread)} && async.data.app == ${quoted(app)}`;

      let state = emptyThreadState();
      let version = 0;

      // The last `seq` applied for each writer, and writes that came ahead of
      // their turn.
      const last = new Map<string, number>();
      const held = new Map<string, ThreadWriteData>();
      const seen = new Set<string>();
      let steps = 0;

      if (start.name === threadHandover.name) {
        const carried = start.data as unknown as ThreadHandoverData;

        state = carried.state;
        version = carried.version;

        for (const [writer, seq] of Object.entries(carried.last)) {
          last.set(writer, seq);
        }
      }

      // A run that started from a write or a read has not seen the state the
      // run before it left, which a handover brings. Until then it keeps what
      // it applies, to replay it on top of that state.
      let based = start.name === threadHandover.name;
      const applied: ThreadWriteData[] = [];
      const appliedMax = 500;

      logger.info(
        { thread, started: start.name, version, based },
        "thread ledger run started",
      );

      await using sub = step.subscribe("ledger", [
        {
          event: threadHandover.name,
          if: mine,
        },
        {
          event: threadWrite.name,
          if: mine,
        },
        {
          event: threadRead.name,
          if: mine,
        },
        {
          event: threadEnded.name,
          if: mine,
        },
      ]);

      await inboxOpenedPromise(sub);
      steps += 1;

      const out: Array<
        ReturnType<
          | typeof threadChanged.create
          | typeof threadStateReply.create
          | typeof agentFinished.create
        >
      > = [];

      const apply = (write: ThreadWriteData, now: number) => {
        last.set(write.runId, write.seq);

        const next = structuredClone(state);

        if (!applyChange(next, write.change, now)) {
          // A conditional write that did not apply: the writer is told what the
          // key holds, and nothing changes.
          const key = (write.change as { key: string }).key;

          out.push(
            threadChanged.create({
              ...write,
              version,
              conflict: { current: liveKey(state, key, now)?.v ?? null },
            }),
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
            threadChanged.create({
              ...write,
              version,
              rejected: overLimitMessage(thread, size),
            }),
          );

          return;
        }

        state = next;
        version += 1;

        if (!based && applied.length < appliedMax) {
          applied.push(write);
        }

        out.push(threadChanged.create({ ...write, version }));
      };

      // A run of the thread ended: the run's own `__lastRun` was written by
      // the function that saw it end. The ledger tells the starter of a
      // `start_agent` run what it owed and never sent.
      const end = (ended: ThreadEndedData) => {
        if (ended.notice) {
          const raw = liveKey(
            state,
            reportsRecordKey(ended.agent),
            Date.now(),
          )?.v;
          const sent = (typeof raw === "string" ? JSON.parse(raw) : raw) as
            | ReportsRecord
            | undefined;
          const have = new Set(sent?.run === ended.runId ? sent.sent : []);

          out.push(
            agentFinished.create(
              {
                ...ended.notice,
                missing: (ended.required ?? []).filter((name) => {
                  return !have.has(name);
                }),
              },
              {
                id: `finished-${ended.runId}`,
                meta: {
                  sessions: {
                    agent_session: ended.notice.thread,
                    agent_thread: ended.notice.thread,
                  },
                },
              },
            ),
          );
        }
      };

      // Takes in one message: a write goes in order or is held, a read is
      // answered, an end is recorded.
      const take = (message: {
        id?: string;
        name: string;
        data: unknown;
      }): void => {
        if (message.id) {
          if (seen.has(message.id)) {
            return;
          }

          seen.add(message.id);
        }

        if (message.name === threadHandover.name) {
          const carried = message.data as ThreadHandoverData;

          if (based) {
            return;
          }

          based = true;
          state = carried.state;
          version = carried.version;

          for (const [writer, seq] of Object.entries(carried.last)) {
            last.set(writer, Math.max(last.get(writer) ?? 0, seq));
          }

          // What this run applied before the handover came goes on top.
          for (const write of applied) {
            const next = structuredClone(state);

            applyChange(next, write.change, Date.now());

            if (stateSize(next) <= threadStateLimit) {
              state = next;
              version += 1;
            }
          }

          applied.length = 0;
          version += 1;
          out.push(
            threadChanged.create({
              thread,
              app,
              runId: "ledger",
              seq: 0,
              version,
              change: { op: "reset", state, last: Object.fromEntries(last) },
            }),
          );

          return;
        }

        if (message.name === threadEnded.name) {
          end(message.data as ThreadEndedData);

          return;
        }

        if (message.name === threadRead.name) {
          const data = message.data as ThreadReadData;

          out.push(
            threadStateReply.create({
              thread,
              app,
              runId: data.runId,
              version,
              state,
              seq: last.get(data.runId) ?? 0,
            }),
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

        apply(write, Date.now());
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
              apply(write, Date.now());
              moved = true;
            }
          }
        }
      };

      take(start);
      release(false);

      let batchN = 0;

      while (true) {
        if (out.length > 0) {
          batchN += 1;
          steps += 1;
          await step.sendEvent(`out:${batchN}`, [...out]);
          out.length = 0;
        }

        // Near the limit the ledger hands over to a fresh run. A write that
        // reaches it between its last read and its end is lost: the known gap
        // of a message sent after a handler returned.
        if (steps + 3 >= limit) {
          logger.info(
            { thread, version, steps },
            "thread ledger nears the step limit and hands over",
          );
          defer("handover", {
            function: handoverFn,
            data: {
              thread,
              app,
              version,
              state,
              last: Object.fromEntries(last),
            } satisfies ThreadHandoverData,
          });

          return { thread, version, handover: true };
        }

        const batch =
          held.size > 0
            ? await sub.nextBatch({ timeout: gapWaitMs })
            : await sub.nextBatch();

        steps += 1;

        if (batch === undefined) {
          return { thread, version };
        }

        if (batch === null) {
          release(true);
          continue;
        }

        for (const message of batch) {
          take(message as { id?: string; name: string; data: unknown });
        }

        release(false);
      }
    },
  );

  return [ledger, handoverFn as unknown as InngestFunction.Any];
};
