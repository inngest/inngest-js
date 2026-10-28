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
import type { Kv } from "./kv.ts";
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
    await store.thread.update<ThreadRecord>(threadRecordKey, (found) => {
      const current = found ?? emptyRecord();

      return { ...current, ...change(current), runId };
    });
  };

  return {
    /**
     * A turn is running.
     */
    running: () => {
      return record(() => {
        return { status: "running" };
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
