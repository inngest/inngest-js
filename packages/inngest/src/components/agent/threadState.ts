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
import { randomUUID } from "node:crypto";
import { type Kv, type KvScopeInstance, kvKey } from "./kv.ts";
import { type EffectiveLimits, narrowInherited } from "./limits.ts";
import type { AgentTurn } from "./loop.ts";
import {
  decide,
  type Finished,
  fingerprint,
  type LastRun,
  summarize,
  turnInFlight,
  turnOf,
} from "./recovery.ts";
import { scoreThisStep } from "./scores.ts";
import {
  lastRunRecordKey,
  summaryLength,
  type ThreadRecord,
  threadRecordKey,
} from "./thread.ts";

const recordKey = kvKey<ThreadRecord>(threadRecordKey);
const lastRunKey = kvKey<LastRun>(lastRunRecordKey);

/**
 * Names this process, so a run that continues in another one is noticed.
 */
const bootId = randomUUID();

const emptyRecord = (): ThreadRecord => {
  return { status: "idle", turn: 0, usage: { input: 0, output: 0 } };
};

/**
 * The writes of one run. Each is one KV step.
 */
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
  // How many times this run has continued in another process, as the latest
  // write saw it. Every write is a memoized step, so a replay reads the same
  // number at the same point of the body.
  let restarts = 0;

  const record = async (
    change: (current: ThreadRecord) => Partial<ThreadRecord>,
  ) => {
    const written = await store.thread.update(recordKey, (found) => {
      const current = found ?? emptyRecord();
      const mine = current.runId === runId;
      const moved =
        mine && current.host !== undefined && current.host !== bootId;

      return {
        ...current,
        ...change(current),
        runId,
        host: bootId,
        restarts: (mine ? (current.restarts ?? 0) : 0) + (moved ? 1 : 0),
      };
    });

    restarts = written.restarts ?? 0;

    return written;
  };

  return {
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
     * starts has the same limits.
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
      inflight?: { content?: string } | null,
    ) => {
      return record((current) => {
        const inherited = narrowInherited(current.inherited, startedWith);

        return {
          status: "running",
          ...(inherited && { inherited }),
          // `null` clears it: a run that does not begin with a message must
          // not keep the one the run before it left behind.
          ...(inflight === null && { inflight: undefined }),
          ...(inflight && { inflight }),
        };
      });
    },

    /**
     * The run waits for its next message. A thread that honored a stop stays
     * stopped until a message runs it.
     */
    waiting: () => {
      return record((current) => {
        return current.status === "stopped"
          ? {}
          : { status: "waiting", inflight: undefined };
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

        return { status: "stopped", inflight: undefined };
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
/**
 * Reads the thread's `lastRun`.
 */
export const readLastRun = (
  /**
   * KV store of the thread state.
   */
  store: Kv,
): Promise<LastRun | undefined> => {
  return store.thread.get(lastRunKey);
};

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
      ? { ...current, status: "idle" as const }
      : current;
  });
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
    content?: string;
    turn: boolean;

    /**
     * Whether a failed turn is resent (recovery on). `undefined`: recovery
     * is off, so the record has no guard.
     */
    resume?: boolean;
  },
) => {
  const scope = store.scope("thread", thread);

  // The record is only read here: it is written by the run and by its
  // cleanup, and the run's ending goes under a key of its own, so none of
  // the writes can lose another's.
  const record = (await scope.get(recordKey)) ?? emptyRecord();
  const last = await scope.update(lastRunKey, (found) => {
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
        { content: end.content, turn: end.turn },
        (x, y) => {
          return runScore(x) < runScore(y);
        },
      );

      next =
        end.resume === undefined
          ? { ...next, error, fingerprint: print }
          : decide(found, {
              runId: end.runId,
              at: end.at,
              error,
              fingerprint: print,
              turn: turnOf(turn.content),
              resume: end.resume && turn.resendable,
            }).last;
    }

    return next;
  });

  return { last, record };
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
