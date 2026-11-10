/**
 * @module
 * EXPERIMENTAL: the protocol between a thread run and the agent runs of its
 * thread.
 *
 * A thread run is long-lived, is the **only writer** to its thread's state, it
 * holds **every** subscription, and it holds the thread's log. An agent run is
 * short-lived: it obtains state when it starts, keeps an inbox of forwards
 * while it works, and ends when its inbox is empty.
 *
 * **Forwards are advisory; the thread's log is authoritative.** If a forward is
 * lost - dropped by a singleton skip, arriving while an agent run is between
 * reads, anything - the agent is *late, not wrong*, because the thread still
 * holds the entry and the agent reconciles against the log on its next read
 * (every read hands back everything the thread holds that no agent has taken
 * up, and so does the state a forward carries). That property is why nothing
 * here needs compare-and-keep-max, strict ordering, or non-independent
 * compaction.
 *
 * **"Late, not wrong" is a claim about the log, not about any one answer.** An
 * answer given while the log is still converging can be incomplete, on the
 * atomic path as much as on the one where a forward carries the state: that is
 * ordinary concurrency and not a property of either. What is guaranteed is
 * that nothing the log holds is lost to a run that reads it. Read as a promise
 * about replies it would be the wrong promise.
 *
 * Of the three things an agent run does, only the read waits:
 *
 * - **Read** is request/response and rare (once, at the start of a run). It is
 *   a `waitForSignal` and a `sendEvent` issued together, so the executor
 *   registers the wait before the send executes and no arriving write can
 *   reach the agent by neither route.
 * - **Write** is one event, fire and forget. No ack, no wait, no retry.
 * - **Listen** is one event. The thread subscribes and records it; the
 *   model-facing tool waits only so that it can tell the model the
 *   subscription is in place.
 *
 * Accepted gaps, stated here because they are properties of this protocol
 * rather than bugs in it:
 *
 * - **4MB.** A thread's whole log travels on the rollover event. Past 4MB the
 *   event is rejected and the thread is lost. There is no store to spill to.
 * - A write to a thread with **no live run** reaches nothing, and nobody is
 *   told.
 * - **Permanent failure of a thread run loses the log since the last
 *   rollover**, including the case where an agent was told its write landed
 *   and is later handed state without it.
 * - **Dormancy.** Nothing re-animates a thread nobody is asking after.
 */

import {
  eventType,
  staticSchema,
} from "../../../components/triggers/triggers.ts";
import type { AgentRouting } from "../inbox/events.ts";
import { quote } from "../inbox/threadInbox.ts";

/**
 * One arrival the thread holds: the event as it came, with the position the
 * thread gave it.
 */
export interface ThreadEntry {
  /**
   * The position in the thread's log, from 1.
   */
  seq: number;
  id?: string;
  name: string;
  data: unknown;
  ts: number;
}

/**
 * A subscription the thread holds beyond the agent's own `inbox` sources: one
 * the agent asked for while it ran. The thread re-establishes it after a
 * rollover, because `step.subscribe()` is forward-only.
 */
export interface ThreadListen {
  event: string;

  /**
   * A CEL filter, already resolved against the thread: what the thread
   * subscribes with.
   */
  if?: string;

  /**
   * What the model (or handler) asked for, as it asked, for the record.
   */
  asked?: string;
}

/**
 * Everything one thread holds. It travels whole: to an agent run as the answer
 * to its read, and to the next generation of the thread run on a rollover.
 *
 * This is a log with a shape over it, not a key-value store, and nothing in
 * the public surface describes it as one.
 */
export interface ThreadSnapshot {
  /**
   * Which generation of the thread run holds it. 0 is the first.
   */
  gen: number;

  /**
   * The position of the last entry appended, so a generation that starts with
   * an empty log still counts from where the last one stopped.
   */
  seq: number;

  /**
   * The log: every arrival, in the one order the single writer gave them.
   */
  entries: ThreadEntry[];

  /**
   * The highest position an agent run confirmed it had taken up. Entries past
   * it are what a read hands back, which is how a lost forward costs latency
   * rather than data.
   */
  taken: number;

  /**
   * What `kv.thread` holds, as the handle's own encoding. Sugar over the log:
   * a `get` reads what the agent already has, a `set` sends a write here.
   */
  keys: Record<string, ThreadKeyValue>;

  /**
   * Indexes `kv.thread`'s index calls keep, by index name.
   */
  indexes?: Record<string, Record<string, number>>;

  /**
   * The subscriptions asked for at runtime, re-established on every rollover.
   */
  listens: ThreadListen[];

  /**
   * The ids of the writes applied, newest last and bounded by
   * `rememberedWrites`. The log is keyed on them: a write that reaches the
   * thread twice is applied once.
   */
  writes?: string[];

  /**
   * Whether the thread started with nothing handed to it. A fresh thread says
   * so rather than looking like one whose history was lost.
   */
  fresh: boolean;
}

/**
 * One value `kv.thread` holds: the JSON text, and when it expires if it does.
 */
export interface ThreadKeyValue {
  v: string;
  exp?: number;
}

/**
 * How many write ids a thread remembers, so a write that arrives twice is
 * applied once. Bounded, because the log travels whole on a rollover: a
 * re-delivery older than this is no longer in flight anywhere.
 */
export const rememberedWrites = 256;

/**
 * An empty thread, which says that it is empty.
 */
export const emptySnapshot = (): ThreadSnapshot => {
  return {
    gen: 0,
    seq: 0,
    entries: [],
    taken: 0,
    keys: {},
    listens: [],
    fresh: true,
  };
};

/**
 * Applies one write to the state. The only writer, so there is nothing to
 * reconcile against.
 */
export const applyThreadWrite = (
  state: ThreadSnapshot,
  op: ThreadWriteOp,
): void => {
  switch (op.kind) {
    case "set": {
      const value: ThreadKeyValue = {
        v: op.value,
        ...(op.exp !== undefined && { exp: op.exp }),
      };

      state.keys[op.key] = value;

      return;
    }
    case "delete":
      delete state.keys[op.key];

      return;
    case "clear":
      state.keys = {};
      state.indexes = {};

      return;
    case "index.add": {
      state.indexes ??= {};
      state.indexes[op.index] ??= {};

      const members = state.indexes[op.index];

      if (members) {
        members[op.member] = op.score;
      }

      return;
    }
    case "index.remove":
      delete state.indexes?.[op.index]?.[op.member];

      return;
    case "take":
      // Monotonic because one writer applies it, not because anything compares.
      state.taken = Math.max(state.taken, op.seq);
  }
};

/**
 * What an agent run's read asks for: the thread's state, sent back as a signal
 * so the answer reaches this run and no other.
 */
export type ThreadReadData = AgentRouting & {
  /**
   * The signal the answer is sent on. It names the run, so two runs reading at
   * once get their own answers.
   */
  signal: string;

  /**
   * The event that started the agent run, when the agent was started by
   * something other than a forward (a typed `invoke()` start, say). The thread
   * appends it to the log, because it never saw it: the agent did.
   */
  arrival?: { id?: string; name: string; data: unknown };

  /**
   * The run doing the reading, for the trace.
   */
  run?: string;
};

/**
 * One change to what `kv.thread` holds. A write event carries a list of them,
 * so a run that wrote twice between steps costs one event.
 */
export type ThreadWriteOp =
  | { kind: "set"; key: string; value: string; exp?: number }
  | { kind: "delete"; key: string }
  | { kind: "clear" }
  | { kind: "index.add"; index: string; member: string; score: number }
  | { kind: "index.remove"; index: string; member: string }
  /**
   * The agent confirming it has taken up the log to this position, so a later
   * read does not hand those entries back again.
   *
   * It is fire and forget like every other write, and it fails in the right
   * direction: a `take` that is lost means the next run is handed those
   * entries again, which is duplication rather than loss, and write ids make
   * the duplication harmless.
   */
  | { kind: "take"; seq: number };

/**
 * What a write carries: fire and forget, one event, no ack.
 */
export type ThreadWriteData = AgentRouting & {
  /**
   * What identifies this write, so the log can be keyed on it and a write that
   * arrives twice is applied once.
   *
   * It must be a **pure function of durable values** - the run and a count of
   * the writes that run has made - because a replay has to derive the same id.
   * A module-level counter broke this once and turned 12 writes into 50 events.
   */
  id: string;
  ops: ThreadWriteOp[];
  run?: string;
};

/**
 * What a listen asks for: one subscription, and the signal to answer on once
 * the thread has recorded it.
 */
export type ThreadListenData = AgentRouting & {
  listen: ThreadListen;

  /**
   * Drop the subscription rather than add it. The thread forgets it and
   * re-establishes the rest.
   */
  remove?: true;

  /**
   * The signal sent once the thread has recorded the listen. A listen without
   * one is fire and forget like a write.
   */
  signal?: string;

  run?: string;
};

/**
 * What a forward carries: the batch of entries that arrived, as one event. It
 * is a trigger on the agent function under a per-thread singleton in `skip`
 * mode, so it either starts a run or reaches the live one through its inbox,
 * and if it is lost at that boundary the agent is late rather than wrong.
 */
export type ThreadForwardData = AgentRouting & {
  gen: number;
  events: ThreadEntry[];

  /**
   * The thread's state, when it is small enough to travel. A run this forward
   * STARTS uses it and skips the read entirely; a run already live ignores it,
   * because it has state of its own that is newer.
   *
   * It is attached opportunistically because the thread cannot know which of
   * the two it will be: the singleton decides that after the event is sent. The
   * size cap is what keeps the 4MB cliff on the rollover alone - a forward that
   * always carried the state would risk rejection, which would turn a lost
   * forward from "late" into "never".
   */
  state?: ThreadSnapshot;
};

/**
 * The largest state that travels on a forward. Well under the 4MB event limit,
 * because a forward must never be rejected: a thread past this keeps sending
 * forwards without state and the agent falls back to a read.
 */
export const forwardStateLimit = 256 * 1024;

/**
 * A thread ending on purpose. The state is meant to be gone.
 */
export type ThreadDoneData = AgentRouting & {
  reason?: string;
};

/**
 * A thread run giving up: **a distinct event from a deliberate ending**, so no
 * failure path can borrow the ending that the loss checks exempt.
 */
export type ThreadLostData = AgentRouting & {
  generation: number;
  why: string;
};

/*
 * WHY THE NAMES ARE `agent/thread.*` AND NOT `agent/thread.*`
 *
 * The ledger (`threads/ledger.ts`) already owns `agent/thread.read`,
 * `agent/thread.write`, `agent/thread.ready`, `agent/thread.state` and
 * `agent/thread.handover`, and its functions trigger on them. Two protocols
 * sharing a name cross-trigger each other's functions, so these take the
 * longer names until the ledger is retired behind the thread run, at which
 * point they take the plain ones. They are not arbitrary and they are not
 * waiting to be tidied.
 *
 * Every name is declared here and nowhere else: a send, a trigger or a filter
 * names one of these event types rather than writing the string again, so the
 * rename is one edit.
 */

/**
 * EXPERIMENTAL: an agent run asking its thread for state.
 */
export const threadRead = eventType("agent/thread.read", {
  schema: staticSchema<ThreadReadData>(),
});

/**
 * EXPERIMENTAL: an agent run writing to its thread. Fire and forget.
 */
export const threadWrite = eventType("agent/thread.write", {
  schema: staticSchema<ThreadWriteData>(),
});

/**
 * EXPERIMENTAL: an agent run asking its thread to subscribe to something.
 */
export const threadListen = eventType("agent/thread.listen", {
  schema: staticSchema<ThreadListenData>(),
});

/**
 * EXPERIMENTAL: a thread forwarding what arrived to its agent.
 */
export const threadForward = eventType("agent/thread.forward", {
  schema: staticSchema<ThreadForwardData>(),
});

/**
 * EXPERIMENTAL: a thread ending on purpose.
 */
export const threadDone = eventType("agent/thread.done", {
  schema: staticSchema<ThreadDoneData>(),
});

/**
 * EXPERIMENTAL: a thread run giving up. Never the done path.
 */
export const threadLost = eventType("agent/thread.lost", {
  schema: staticSchema<ThreadLostData>(),
});

/**
 * The events of the protocol that are addressed to a thread run.
 */
export const threadControlEvents: string[] = [
  threadRead.name,
  threadWrite.name,
  threadListen.name,
  threadDone.name,
];

/**
 * Whether an event is one of the protocol's own.
 */
export const isThreadControl = (name: string): boolean => {
  return (
    threadControlEvents.includes(name) ||
    name === threadForward.name ||
    name === threadLost.name
  );
};

/**
 * The filter that ties one of the protocol's events to one agent and thread.
 * @param ref The agent, as `"appId/functionId"`.
 * @param thread The thread key.
 */
export const threadFilter = (ref: string, thread: string): string => {
  return `event.data.agent == ${quote(ref)} && event.data.thread == ${quote(thread)}`;
};

/**
 * The filter that ties one of the protocol's events to one agent, whichever
 * thread it names: what a thread run triggers on, since the thread key comes
 * from the event.
 * @param ref The agent, as `"appId/functionId"`.
 */
export const threadAgentFilter = (ref: string): string => {
  return `event.data.agent == ${quote(ref)}`;
};

/**
 * The signal one agent run's read is answered on.
 * @param ref The agent, as `"appId/functionId"`.
 * @param thread The thread key.
 * @param runId The run doing the reading.
 */
export const readSignal = (
  ref: string,
  thread: string,
  runId: string,
): string => {
  return `agents/read:${ref}:${thread}:${runId}`;
};

/**
 * The signal a listen is acknowledged on.
 * @param ref The agent, as `"appId/functionId"`.
 * @param thread The thread key.
 * @param runId The run asking.
 * @param nth Which listen of that run this is.
 */
export const listenSignal = (
  ref: string,
  thread: string,
  runId: string,
  nth: number,
): string => {
  return `agents/listen:${ref}:${thread}:${runId}:${nth}`;
};

/**
 * The generation key of one generation of a thread run: what its singleton is
 * keyed on, so a live predecessor does not block its successor.
 * @param thread The thread key.
 * @param generation The generation number.
 */
export const generationKey = (thread: string, generation: number): string => {
  return `${thread}#${generation}`;
};

/**
 * THE SPLIT THAT MATTERS: which of these events may be a TRIGGER of the thread
 * run, and which may only be subscribed to.
 *
 * An event that triggers the thread function can START one. So an event that a
 * thread run itself sends, and that another thread run would be triggered by,
 * can drive an unbounded series of runs: run A sends it, it starts run B, run B
 * sends it, and so on. The log stays correct the whole time - there is no wrong
 * state and nothing in the event stream that looks like an error - and the only
 * symptom is run volume. Model-checked, and it ran to the bound.
 *
 * So anything a thread run sends to ANOTHER thread run belongs in
 * `subscribedOnly` and must never be added to the trigger list. If you are
 * adding an event here, that is the question to answer first.
 */
export const threadRunTriggers: readonly string[] = [
  threadRead.name,
  threadWrite.name,
  threadListen.name,
  threadDone.name,
];

/**
 * The protocol's events that a thread run subscribes to and is NEVER triggered
 * by. See `threadRunTriggers` for why the distinction is load-bearing.
 */
export const threadRunSubscribedOnly: readonly string[] = [
  threadForward.name,
  threadLost.name,
];

/**
 * Every event name of the protocol, in one place. Read these rather than
 * writing the strings again: see the note above about the rename that is
 * coming when the ledger is retired.
 */
export const threadRunEventNames = {
  read: threadRead.name,
  write: threadWrite.name,
  listen: threadListen.name,
  forward: threadForward.name,
  done: threadDone.name,
  lost: threadLost.name,
} as const;
