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
import type { Kv, KvScopeInstance } from "./kv.ts";
import { type EffectiveLimits, narrowInherited } from "./limits.ts";
import type { AgentTurn } from "./loop.ts";
import { summaryLength, type ThreadRecord, threadRecordKey } from "./thread.ts";

const emptyRecord = (): ThreadRecord => {
  return { status: "idle", turn: 0, usage: { input: 0, output: 0 } };
};

/**
 * The writes of one run. Each is one KV step.
 * @param store KV store of the thread state.
 * @param runId The live run, stamped on every write.
 */
export const threadRecorder = (store: Kv, runId: string) => {
  const record = async (
    change: (current: ThreadRecord) => Partial<ThreadRecord>,
  ) => {
    return store.thread.update<ThreadRecord>(threadRecordKey, (found) => {
      const current = found ?? emptyRecord();

      return { ...current, ...change(current), runId };
    });
  };

  return {
    /**
     * A turn is running. A sub-agent's inherited limits are kept on the
     * record, narrowed over every start, so a later run that a plain message
     * starts has the same limits.
     * @param startedWith The limits the invoking agent passed down, if any.
     */
    running: (startedWith?: EffectiveLimits) => {
      return record((current) => {
        const inherited = narrowInherited(current.inherited, startedWith);

        return { status: "running", ...(inherited && { inherited }) };
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
     * The thread honored a stop request.
     */
    stopped: () => {
      return record(() => {
        return { status: "stopped" };
      });
    },

    /**
     * A model call finished: its turn number, text and usage.
     * @param turn The loop turn.
     */
    turn: (turn: AgentTurn) => {
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
 * @param store KV store of the thread state.
 * @param thread Thread key.
 * @param runId The run that ended.
 */
export const markThreadIdle = async (
  store: Kv,
  thread: string,
  runId: string,
): Promise<void> => {
  await store
    .scope("thread", thread)
    .update<ThreadRecord>(threadRecordKey, (found) => {
      const current = found ?? emptyRecord();

      return current.runId === runId && current.status !== "stopped"
        ? { ...current, status: "idle" }
        : current;
    });
};

/**
 * The thread KV key holding the generation of the newest snapshot of one of
 * the thread's sandboxes. It is a key of its own, not part of the record: the
 * record is rewritten whole by whichever run writes it, and a cleanup may save
 * a snapshot after a newer run has started. The `__` prefix hides it from
 * `state().keys`.
 * @param ref The agent, as `"appId/functionId"`: threads of two agents may share a key.
 * @param name The sandbox's name in the agent's `sandboxes`.
 */
export const sandboxGenerationKey = (ref: string, name: string): string => {
  return `__sandbox:${ref}:${name}`;
};

/**
 * Notes that `generation` is the newest snapshot of a thread's sandbox. A
 * generation is a run ID, which sorts by time, so an older one (a cleanup of
 * a run that a newer run has overtaken) never replaces a newer one, and
 * writing the same one twice changes nothing.
 * @param scope The thread's KV scope.
 * @param ref The agent, as `"appId/functionId"`.
 * @param name The sandbox's name in the agent's `sandboxes`.
 * @param generation The run that took the snapshot.
 */
export const recordSandboxGeneration = async (
  scope: KvScopeInstance,
  ref: string,
  name: string,
  generation: string,
): Promise<void> => {
  await scope.update<string>(sandboxGenerationKey(ref, name), (found) => {
    return found && found >= generation ? found : generation;
  });
};
