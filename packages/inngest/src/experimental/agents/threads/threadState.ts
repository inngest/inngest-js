/**
 * @module
 * EXPERIMENTAL: what an agent function writes for `thread.state()`: one
 * record in the thread's KV scope (`__state:<agent>`), one per agent.
 *
 * Only the live run writes the record while it runs, so nothing races it. The
 * run's cleanup writes once more, `idle`, after the run has ended and only if
 * the record is still that run's: a newer run's record is left alone. That
 * guarded write is one read and one write inside a single step; a newer run
 * would have to write between the two to be overwritten, and it rewrites the
 * record on its next status change or turn.
 */

import type { LentRecord } from "../agent/lending.ts";
import {
  type AgentBudget,
  type EffectiveLimits,
  narrowInherited,
} from "../agent/limits.ts";
import {
  decide,
  type Finished,
  fingerprint,
  type LastRun,
  runScore,
  summarize,
  turnInFlight,
  turnOf,
} from "../agent/recovery.ts";
import { type Kv, type KvScopeInstance, typedKey } from "../kv/kv.ts";
import type { AgentTurn } from "../loop/loop.ts";
import {
  type Inflight,
  lastRunRecordKey,
  summaryLength,
  type ThreadRecord,
  threadRecordKey,
} from "./thread.ts";

export { runScore };

const recordKey = (agent: string) => {
  return typedKey<ThreadRecord>(threadRecordKey(agent));
};
const lastRunKey = (agent: string) => {
  return typedKey<LastRun>(lastRunRecordKey(agent));
};

/**
 * Names this process, so a run that continues in another one is noticed.
 */
const bootId = globalThis.crypto.randomUUID();

const emptyRecord = (): ThreadRecord => {
  return { status: "idle", turn: 0, usage: { input: 0, output: 0 } };
};

/**
 * The writes of one run. Each is one KV step.
 */
/**
 * The most status changes a record keeps.
 */
const keptTransitions = 64;

/**
 * The record with the change noted, if `next` changes the status or starts a
 * new run. A record written before changes were kept starts its list with the
 * status it had.
 * @param current The record as it was.
 * @param next The record as it will be.
 * @param at The time of the change, in milliseconds since the epoch.
 */
export const withTransition = (
  current: ThreadRecord,
  next: ThreadRecord,
  at = Date.now(),
): ThreadRecord => {
  if (next.status === current.status && next.runId === current.runId) {
    return next;
  }

  const before = current.transitions ?? [{ status: current.status, at: 0 }];

  return {
    ...next,
    transitions: [...before, { status: next.status, at }].slice(
      -keptTransitions,
    ),
  };
};

export const threadRecorder = (
  /**
   * KV store of the thread state.
   */
  store: Kv,
  /**
   * The agent, as `"appId/functionId"`: the record is its own.
   */
  agent: string,
  /**
   * The live run, stamped on every write.
   */
  runId: string,
  /**
   * Whether the run is the only writer of its record (the ledger KV store).
   */
  single = false,
) => {
  // How many times this run has continued in another process, as the latest
  // write saw it. Every write is a memoized step, so a replay reads the same
  // number at the same point of the body.
  let restarts = 0;

  // Inside a step's callback the run's own thread is not in scope, so a write
  // there names the thread. Elsewhere it is the run's, and the step is named by
  // the scope alone.
  const record = async (
    change: (current: ThreadRecord) => Partial<ThreadRecord>,
    thread?: string,
  ) => {
    const scope = thread ? store.scope("thread", thread) : store.thread;
    const apply = (found: ThreadRecord | undefined) => {
      const current = found ?? emptyRecord();
      const mine = current.runId === runId;
      const moved =
        mine && current.host !== undefined && current.host !== bootId;

      return withTransition(current, {
        ...current,
        ...change(current),
        runId,
        host: bootId,
        restarts: (mine ? (current.restarts ?? 0) : 0) + (moved ? 1 : 0),
      });
    };
    // The run is the only writer of its own record while it lives (one run per
    // agent per thread, and records are per agent), so the ledger, which has no
    // conditional writes, takes a plain read and write where the newest run
    // wins; a store keeps its atomic update.
    let written: ThreadRecord;

    if (single) {
      written = apply(await scope.get(recordKey(agent)));
      await scope.set(recordKey(agent), written);
    } else {
      written = await scope.update(recordKey(agent), apply);
    }

    restarts = written.restarts ?? 0;

    return written;
  };

  return {
    /**
     * Takes in what a turn recorded inside its step, which a replay does not
     * run again: the restarts it saw.
     */
    observe: (recorded: { usage: ThreadRecord["usage"]; restarts: number }) => {
      restarts = recorded.restarts;

      return recorded;
    },

    /**
     * How many times the run has continued in another process: a restart, a
     * deploy or another instance picking it up.
     */
    get restarts() {
      return restarts;
    },

    /**
     * A turn is running. A sub-agent's inherited limits are kept on the
     * record, narrowed over every start, so a later run that a plain message
     * starts has the same limits. The thread's budget, from its own agent's
     * definition, is kept the first time and never replaced.
     */
    running: (
      /**
       * The limits the invoking agent passed down, if any.
       */
      startedWith?: EffectiveLimits,

      /**
       * The message the turn answers, kept until the run waits for the next
       * one: a failed run resends it.
       */
      inflight?: Inflight | null,

      /**
       * The thread's key, when called inside a step's callback.
       */
      thread?: string,

      /**
       * The thread's budget as this run's agent defines it.
       */
      budget?: AgentBudget,

      /**
       * The IDs of the messages this turn takes in, noted for their senders.
       */
      folded?: string[],

      /**
       * The lend the start event carries, kept the first time only: the
       * record names the run that took it first.
       */
      lend?: Omit<LentRecord, "takenBy">,
    ) => {
      return record((current) => {
        const inherited = narrowInherited(current.inherited, startedWith);

        return {
          status: "running",
          // A lend from the parent run the record already names is not taken
          // again; a thread with a key of its own can be lent to by another
          // parent run.
          ...(lend &&
            current.lent?.parentRun !== lend.parentRun && {
              lent: { ...lend, takenBy: runId },
            }),
          ...(inherited && { inherited }),
          ...(current.budget === undefined && budget && { budget }),
          ...(folded &&
            folded.length > 0 && { folded: foldedOf(current, runId, folded) }),
          // `null` clears it: a run that does not begin with a message must
          // not keep the one the run before it left behind.
          ...(inflight === null && { inflight: undefined }),
          ...(inflight && { inflight }),
        };
      }, thread);
    },

    /**
     * The run took in messages without starting a turn (a drain): their IDs
     * are noted for their senders.
     */
    folded: (ids: string[]) => {
      return record((current) => {
        return { folded: foldedOf(current, runId, ids) };
      });
    },

    /**
     * The run waits for its next message.
     */
    waiting: () => {
      return record(() => {
        return { status: "waiting", inflight: undefined };
      });
    },

    /**
     * A wait for the next message ended without one. A thread that was waiting
     * is running again.
     */
    resumed: () => {
      return record((current) => {
        return current.status === "waiting" ? { status: "running" } : {};
      });
    },

    /**
     * A model call finished: its turn number, text and usage.
     */
    turn: (
      /**
       * The loop turn.
       */
      turn: AgentTurn,

      /**
       * The thread's key, when called inside a step's callback.
       */
      thread?: string,
    ) => {
      return record((current) => {
        // The same call again, from a retried step: already taken in.
        const taken = `${runId}/${turn.stepId}`;

        if (current.turnStep === taken) {
          return {};
        }

        return {
          status: "running",
          turnStep: taken,
          turn: turn.turn,
          summary: turn.text
            ? turn.text.slice(0, summaryLength)
            : current.summary,
          usage: {
            input: current.usage.input + turn.usage.input,
            output: current.usage.output + turn.usage.output,
            ...(current.usage.usd !== undefined || turn.usage.usd !== undefined
              ? { usd: (current.usage.usd ?? 0) + (turn.usage.usd ?? 0) }
              : {}),
          },
        };
      }, thread);
    },
  };
};

/**
 * The folded IDs of the record with more added, for the run that adds them.
 */
const foldedOf = (
  current: ThreadRecord,
  runId: string,
  ids: string[],
): NonNullable<ThreadRecord["folded"]> => {
  const same = current.folded?.run === runId ? current.folded.ids : [];

  // A union: the write can run again for a retried step, and a message is
  // noted once.
  return { run: runId, ids: [...new Set([...same, ...ids])] };
};

/**
 * Reads the thread's `lastRun`.
 */
export const readLastRun = (
  /**
   * KV store of the thread state.
   */
  store: Kv,

  /**
   * The agent, as `"appId/functionId"`.
   */
  agent: string,

  /**
   * The thread's key, when called inside a step's callback.
   */
  thread?: string,
): Promise<LastRun | undefined> => {
  return (thread ? store.scope("thread", thread) : store.thread).get(
    lastRunKey(agent),
  );
};

/**
 * Marks the thread idle once `runId` has ended, unless a newer run has written
 * the record since or the thread was stopped.
 */
export const markThreadIdle = async (
  /**
   * KV store of the thread state.
   */
  store: Kv,

  /**
   * The agent, as `"appId/functionId"`.
   */
  agent: string,

  /**
   * Thread key.
   */
  thread: string,

  /**
   * The run that ended.
   */
  runId: string,

  /**
   * Whether the store is the ledger, which has no conditional writes: the
   * record is then read and written plainly, and the newest run wins.
   */
  plain = false,
): Promise<void> => {
  const scope = store.scope("thread", thread);
  const idle = (found: ThreadRecord | undefined) => {
    const current = found ?? emptyRecord();

    return current.runId === runId
      ? withTransition(current, { ...current, status: "idle" as const })
      : current;
  };

  if (plain) {
    const found = await scope.get(recordKey(agent));

    // Only a record this run still owns changes: a newer run's is left alone.
    if (found?.runId === runId) {
      await scope.set(recordKey(agent), idle(found));
    }

    return;
  }

  await scope.update(recordKey(agent), idle);
};

/**
 * Writes how `runId` ended as the thread's `lastRun`, unless a newer run has
 * ended since. Deciding the same run again gives the same record, so a
 * retried step changes nothing. For a failed run with `resume` set, the
 * record also carries the loop guard: see `decide()`.
 * @returns The thread's `lastRun` after the write, and the record the run
 * left behind (to know the turn it was answering).
 */
export const recordEnd = async (
  /**
   * KV store of the thread state.
   */
  store: Kv,

  /**
   * The agent, as `"appId/functionId"`.
   */
  agent: string,

  /**
   * Thread key.
   */
  thread: string,

  /**
   * The run that ended.
   */
  end: {
    /**
     * The run that ended.
     */
    runId: string;

    /**
     * When it ended, in milliseconds since the epoch.
     */
    at: number;

    /**
     * How it ended.
     */
    finished: Finished;

    /**
     * The message that started the run, if it carried one, and whether the
     * run began by answering a message.
     */
    inflight?: Inflight;
    turn: boolean;

    /**
     * Whether a failed turn is resent (recovery on). `undefined`: recovery
     * is off, so the record has no guard.
     */
    resume?: boolean;
  },
  options: {
    /**
     * Whether to write the record. Default: yes. With `false` the record is
     * only worked out and returned.
     */
    persist?: boolean;
  } = {},
) => {
  const scope = store.scope("thread", thread);

  // The record is only read here: it is written by the run and by its
  // cleanup, and the run's ending goes under a key of its own, so none of
  // the writes can lose another's.
  const record = (await scope.get(recordKey(agent))) ?? emptyRecord();
  const decided = (found: LastRun | undefined | null): LastRun => {
    if (
      found &&
      found.runId !== end.runId &&
      runScore(found.runId) > runScore(end.runId)
    ) {
      return found;
    }

    const { finished } = end;
    let next: LastRun = {
      runId: end.runId,
      status: finished.status,
      at: end.at,
    };

    if (finished.status === "failed" && finished.error) {
      const error = summarize(finished.error.message);
      const print = fingerprint(finished.error.name, finished.error.message);
      const turn = turnInFlight(
        record,
        end.runId,
        { inflight: end.inflight, turn: end.turn },
        (x, y) => {
          return runScore(x) < runScore(y);
        },
      );

      next =
        end.resume === undefined
          ? { ...next, error, fingerprint: print }
          : decide(found ?? undefined, {
              runId: end.runId,
              at: end.at,
              error,
              fingerprint: print,
              turn: turnOf(turn.inflight),
              resume: end.resume && turn.resendable,
            }).last;
    }

    return next;
  };

  // With the ledger the ledger stores the record: the caller sends it in
  // `agent/run.ended`.
  const last =
    options.persist === false
      ? decided(await scope.get(lastRunKey(agent)))
      : await scope.update(lastRunKey(agent), decided);

  return { last, record };
};

/**
 * When the run that took a snapshot started. A generation is a run ID, or a
 * run ID and a `.` and a number for a later snapshot of the same run.
 */
export const generationScore = (
  /**
   * The generation.
   */
  generation: string,
): number => {
  return runScore(generation.split(".")[0] ?? generation);
};

/**
 * The sorted index of the runs that saved a snapshot of one of a thread's
 * sandboxes, scored by when the run started. Adding a member is one atomic
 * write that never removes another, so a cleanup that saves late can't move
 * the newest generation back: the newest is read as the highest score. It
 * is an index of its own, not part of the record: the record is rewritten
 * whole by whichever run writes it.
 */
export const sandboxGenerations = (
  /**
   * The thread's KV scope.
   */
  scope: KvScopeInstance,

  /**
   * The agent, as `"appId/functionId"`: threads of two agents may share a key.
   */
  ref: string,

  /**
   * The sandbox's name in the agent's `sandboxes`.
   */
  name: string,
) => {
  return scope.index(`__sandbox:${ref}:${name}`);
};

/**
 * Notes that `generation` took a snapshot of a thread's sandbox.
 */
export const recordSandboxGeneration = async (
  /**
   * The thread's KV scope.
   */
  scope: KvScopeInstance,

  /**
   * The agent, as `"appId/functionId"`.
   */
  ref: string,

  /**
   * The sandbox's name in the agent's `sandboxes`.
   */
  name: string,

  /**
   * The run that took the snapshot.
   */
  generation: string,
): Promise<void> => {
  await sandboxGenerations(scope, ref, name).add(
    generation,
    generationScore(generation),
  );
};

/**
 * The newest run that saved a snapshot of the thread's sandbox.
 */
export const newestSandboxGeneration = async (
  /**
   * The thread's KV scope.
   */
  scope: KvScopeInstance,

  /**
   * The agent, as `"appId/functionId"`.
   */
  ref: string,

  /**
   * The sandbox's name in the agent's `sandboxes`.
   */
  name: string,
): Promise<string | undefined> => {
  const [newest] = await sandboxGenerations(scope, ref, name).range({
    order: "desc",
    limit: 1,
  });

  return newest?.member;
};

/**
 * The thread KV key that says a run's sandbox has finished its skills and
 * setup, so its cleanup may snapshot it. It has the run in its name, so a
 * newer run can't overwrite it before an older run's cleanup reads it, and it
 * is deleted once the run has saved or cleaned up. The `__` prefix hides it
 * from `state().keys`.
 */
export const sandboxReadyKey = (
  /**
   * The agent, as `"appId/functionId"`.
   */
  ref: string,

  /**
   * The sandbox's name in the agent's `sandboxes`.
   */
  name: string,

  /**
   * The run.
   */
  runId: string,
): string => {
  return `__sandbox-ready:${ref}:${name}:${runId}`;
};

/**
 * Whether a message that reaches a thread finds its run busy: the thread was
 * working on a turn when the message arrived. A message that starts a run
 * arrives before the run begins, and one that wakes a waiting run arrives while
 * it waits, so neither counts. The status is the one at the message's time, not
 * the one the record has by the time this is asked.
 */
export const threadBusyFor = async (
  /**
   * KV store of the thread state.
   */
  store: Kv,

  /**
   * The agent, as `"appId/functionId"`.
   */
  agent: string,

  /**
   * Thread key.
   */
  thread: string,

  /**
   * When the message arrived, in milliseconds since the epoch.
   */
  arrivedAt: number | undefined,
): Promise<boolean> => {
  const current = await store.scope("thread", thread).get(recordKey(agent));

  return statusAt(current, arrivedAt) === "running";
};

/**
 * What the thread was doing at a time: the latest recorded change at or before
 * it, `idle` before the first.
 * @param record The thread's record.
 * @param at Milliseconds since the epoch; now when missing.
 */
export const statusAt = (
  record: ThreadRecord | undefined,
  at: number | undefined,
): ThreadRecord["status"] => {
  if (!record) {
    return "idle";
  }

  if (at === undefined) {
    return record.status;
  }

  const before = (record.transitions ?? []).filter((t) => {
    return t.at <= at;
  });

  return (
    before.at(-1)?.status ??
    (record.transitions?.length ? "idle" : record.status)
  );
};

/**
 * What the thread keeps of a sandbox that its last run paused instead of
 * destroying.
 */
export interface PausedSandbox {
  /**
   * The paused sandbox.
   */
  id: string;

  /**
   * The generation (run) that paused it, so a late cleanup of an older run
   * never replaces a newer pause.
   */
  generation: string;
}

/**
 * The thread KV key that holds the thread's paused sandbox of one name. The
 * `__` prefix hides it from `state().keys`.
 */
export const sandboxPausedKey = (
  /**
   * The agent, as `"appId/functionId"`.
   */
  ref: string,

  /**
   * The sandbox's name in the agent's `sandboxes`.
   */
  name: string,
): string => {
  return `__sandbox-paused:${ref}:${name}`;
};

/**
 * Where a thread's shell was left: the directory and the exported environment
 * (and unset names) a command ended with. A thread's next run starts its shell
 * here, when the same sandbox (or its snapshot) comes back.
 */
export interface ShellPlace {
  cwd?: string;
  env: Record<string, string>;
  unset: string[];
}

/**
 * The thread KV key of the shell's place in a sandbox. The `__` prefix hides
 * it from `state().keys`.
 */
export const sandboxShellKey = (
  /**
   * The agent, as `"appId/functionId"`.
   */
  ref: string,

  /**
   * The sandbox's name in the agent's `sandboxes`.
   */
  name: string,
): string => {
  return `__sandbox-shell:${ref}:${name}`;
};
