/**
 * @module
 * EXPERIMENTAL: thread handles. A thread is one agent conversation with an
 * address: its key. It spans many runs; messages sent to it wait in its inbox
 * until a run reads them.
 *
 * Sending appends to the inbox store, rings the doorbell of a run that is
 * waiting, and starts a run if none picked the message up. The start event
 * goes to a function with a singleton per thread, so a start that arrives
 * while a run is live is skipped and the message is read from the inbox.
 */
import type { Inngest } from "../Inngest.ts";
import { defaultInboxStore, type InboxStore } from "./inbox.ts";
import { kv as defaultKv, type Kv, type KvHandle } from "./kv.ts";
import { doorbellSignal, inboxStoreKey } from "./subscribe.ts";

/**
 * What a thread's inbox carries.
 */
export interface ThreadMessage {
  /**
   * `"steer"` messages are folded into a running turn; `"user"` messages start
   * the next turn.
   */
  kind: "user" | "steer";
  content: string;
}

/**
 * The event that starts a run for a thread.
 */
export interface ThreadStartEvent {
  name: string;
  data: { thread: string };
  id?: string;
  meta: { sessions: Record<string, string> };
}

/**
 * Builds the event that starts a run for a thread, in the thread's sessions.
 * @param eventName The agent's trigger event.
 * @param key Thread key.
 * @param session Session the thread belongs to. Default: the thread key.
 * @param id Optional event ID, for a start that must happen once.
 */
export function threadStartEvent(
  eventName: string,
  key: string,
  session: string = key,
  id?: string,
): ThreadStartEvent {
  return {
    name: eventName,
    data: { thread: key },
    ...(id ? { id } : {}),
    meta: { sessions: { agent_session: session, agent_thread: key } },
  };
}

/**
 * The event that cancels a thread's live run.
 */
export const threadStopEvent = "agent/thread.stop";

/**
 * The thread KV key that asks the loop to stop.
 */
export const stopFlagKey = "__stop";

/**
 * The thread KV key that names the live run of a thread, set while one runs.
 */
export const liveRunKey = "__run";

export interface ThreadOptions {
  /**
   * The event that triggers the agent function.
   */
  startEvent: string;

  /**
   * Session the thread belongs to. Default: the thread key.
   */
  session?: string;

  /**
   * Inbox store. Default: Redis at `INNGEST_EXPERIMENTAL_KV_URL`.
   */
  store?: InboxStore;

  /**
   * KV store holding the thread state. Default: Redis at
   * `INNGEST_EXPERIMENTAL_KV_URL`.
   */
  kv?: Kv;

  /**
   * Doorbell retries, in milliseconds between tries. Default covers about
   * three seconds, longer than the gap between a reader seeing an empty
   * inbox and its wait being registered.
   */
  doorbellDelays?: number[];
}

export interface ThreadHandle {
  key: string;
  session: string;

  /**
   * Sends a message that starts the next turn.
   */
  send(message: string): Promise<{ seq: number }>;

  /**
   * Sends a message to fold into the turn that is running.
   */
  steer(message: string): Promise<{ seq: number }>;

  /**
   * Stops the thread. `"nextTurn"` lets the running model call finish and
   * stops before the next; `"now"` also cancels the live run. It does nothing
   * when no run is live.
   */
  stop(options: { when: "now" | "nextTurn" }): Promise<void>;

  /**
   * The thread's KV scope.
   */
  state(): Promise<Record<string, unknown>>;
}

const defaultDelays = [50, 100, 200, 400, 800, 1600];

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * The thread's KV scope, readable outside a function.
 * @param client Inngest client.
 * @param key Thread key.
 * @param kv KV store. Default: Redis at `INNGEST_EXPERIMENTAL_KV_URL`.
 */
export function threadKv(
  client: Inngest.Any,
  key: string,
  kv: Kv = defaultKv,
): KvHandle {
  return kv.at("thread", {
    env: client.env ?? "default",
    app: client.id,
    thread: key,
  });
}

/**
 * EXPERIMENTAL: Gets the handle of a thread.
 * @param client Inngest client.
 * @param key Thread key, the thread's address.
 * @param options Start event and overrides.
 */
export function getThread(
  client: Inngest.Any,
  key: string,
  options: ThreadOptions,
): ThreadHandle {
  const session = options.session ?? key;
  const store = () => {
    return options.store ?? defaultInboxStore();
  };
  const storeKey = inboxStoreKey(client.id, key);
  const delays = options.doorbellDelays ?? defaultDelays;

  async function deliver(message: ThreadMessage) {
    const seq = await store().append(storeKey, message);

    for (const delay of [0, ...delays]) {
      if (delay) {
        await sleep(delay);
      }

      const rung = await client.sendSignal({
        signal: doorbellSignal(client.id, key),
        data: { seq },
      });
      if (rung.runId) {
        return { seq };
      }

      if ((await store().cursors(storeKey)).acked >= seq) {
        return { seq };
      }
    }

    // No waiting run took it: start one (a live run skips this by singleton
    // and reads the message from the inbox itself).
    await client.send(threadStartEvent(options.startEvent, key, session));

    return { seq };
  }

  return {
    key,
    session,
    send(message) {
      return deliver({ kind: "user", content: message });
    },
    steer(message) {
      return deliver({ kind: "steer", content: message });
    },
    async stop({ when }) {
      const threadState = threadKv(client, key, options.kv);

      // A stop asks a running thread to stop. With no live run there is
      // nothing to stop, and a flag left behind would stop the next run.
      if (!(await threadState.get(liveRunKey))) {
        return;
      }

      await threadState.set(stopFlagKey, { when });

      if (when === "now") {
        await client.send({ name: threadStopEvent, data: { thread: key } });
      }
    },
    async state() {
      const all = await threadKv(client, key, options.kv).all();

      return Object.fromEntries(
        Object.entries(all).filter(([name]) => {
          return !name.startsWith("__");
        }),
      );
    },
  };
}
