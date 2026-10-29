/**
 * @module
 * EXPERIMENTAL: what an agent function writes for `thread.state()`: one
 * record in the thread's KV scope (`__state`).
 *
 * Only the live run writes the record while it runs, so nothing races it. The
 * run's cleanup writes once more, `idle`, after the run has ended and only if
 * the record is still that run's: a newer run's record is left alone. That
 * guarded write is one read and one write inside a single step; a newer run
 * would have to write between the two to be overwritten, and it rewrites the
 * record on its next status change or turn.
 */
import { type Kv, type KvScopeInstance, kvKey } from "./kv.ts";
import { type EffectiveLimits, narrowInherited } from "./limits.ts";
import type { AgentTurn } from "./loop.ts";
import { scoreThisStep } from "./scores.ts";
import { summaryLength, type ThreadRecord, threadRecordKey } from "./thread.ts";

const recordKey = kvKey<ThreadRecord>(threadRecordKey);

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
   * The live run, stamped on every write.
   */
  runId: string,
  /**
   * Whether the stop is scored `agent.stopped` on its own step.
   */
  scores = false,
) => {
  const record = async (
    change: (current: ThreadRecord) => Partial<ThreadRecord>,
  ) => {
    return store.thread.update(recordKey, (found) => {
      const current = found ?? emptyRecord();

      return withTransition(current, {
        ...current,
        ...change(current),
        runId,
      });
    });
  };

  return {
    /**
     * A turn is running. A sub-agent's inherited limits are kept on the
     * record, narrowed over every start, so a later run that a plain message
     * starts has the same limits.
     */
    running: (
      /**
       * The limits the invoking agent passed down, if any.
       */
      startedWith?: EffectiveLimits,
    ) => {
      return record((current) => {
        const inherited = narrowInherited(current.inherited, startedWith);

        return {
          status: "running",
          ...(inherited && { inherited }),
        };
      });
    },

    /**
     * The run waits for its next message. A thread that honored a stop stays
     * stopped until a message runs it.
     */
    waiting: () => {
      return record((current) => {
        return current.status === "stopped" ? {} : { status: "waiting" };
      });
    },

    /**
     * A wait for the next message ended without one. A thread that was waiting
     * is running again; one that honored a stop stays stopped.
     */
    resumed: () => {
      return record((current) => {
        return current.status === "waiting" ? { status: "running" } : {};
      });
    },

    /**
     * The thread honored a stop request.
     */
    stopped: () => {
      return record(() => {
        if (scores) {
          scoreThisStep("agent.stopped", 1);
        }

        return { status: "stopped" };
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
    ) => {
      return record((current) => {
        return {
          status: "running",
          turn: turn.turn,
          summary: turn.text
            ? turn.text.slice(0, summaryLength)
            : current.summary,
          usage: {
            input: current.usage.input + turn.usage.input,
            output: current.usage.output + turn.usage.output,
          },
        };
      });
    },
  };
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
   * Thread key.
   */
  thread: string,

  /**
   * The run that ended.
   */
  runId: string,
): Promise<void> => {
  await store.scope("thread", thread).update(recordKey, (found) => {
    const current = found ?? emptyRecord();

    return current.runId === runId && current.status !== "stopped"
      ? withTransition(current, { ...current, status: "idle" as const })
      : current;
  });
};

const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * When a run started, from its ID: run IDs are ULIDs, whose first ten
 * characters are a millisecond timestamp. Anything else scores 0.
 */
export const runScore = (
  /**
   * The run ID.
   */
  runId: string,
): number => {
  let score = 0;

  for (const char of runId.slice(0, 10).toUpperCase()) {
    const digit = crockford.indexOf(char);

    if (digit < 0) {
      return 0;
    }

    score = score * 32 + digit;
  }

  return score;
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
    runScore(generation),
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
   * Thread key.
   */
  thread: string,

  /**
   * When the message arrived, in milliseconds since the epoch.
   */
  arrivedAt: number | undefined,
): Promise<boolean> => {
  const current = await store.scope("thread", thread).get(recordKey);

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
