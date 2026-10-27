/**
 * @module
 * EXPERIMENTAL: thread handles. A thread is one agent conversation with an
 * address: its key. It spans many runs.
 *
 * Everything sent to a thread is an event (`agent/message`), so messages show
 * up in the event stream, can be inspected and shared like any other event, and
 * start a run when none is live: the agent function has a singleton per
 * thread, so a message sent while a run is live is skipped as a trigger and
 * reaches the run through its subscription instead.
 */
import type { Inngest } from "../Inngest.ts";
import { kv as defaultKv, type Kv, type KvScopeInstance } from "./kv.ts";

/**
 * The event every thread message is sent as.
 */
export const agentMessageEvent = "agent/message";

/**
 * The event that cancels a thread's live run.
 */
export const agentStopEvent = "agent/thread.stop";

/**
 * What a thread message event carries in `data`.
 */
export interface ThreadMessage {
  /**
   * The agent, as `"appId/functionId"`.
   */
  agent: string;

  /**
   * The thread key.
   */
  thread: string;

  /**
   * `"user"` messages start the next turn; `"steer"` messages are folded into
   * the turn that is running; `"stop"` asks the thread to stop. A stop never
   * starts a run, so stopping an idle thread does nothing.
   */
  kind: "user" | "steer" | "stop";
  content?: string;

  /**
   * For `"stop"`: `"nextTurn"` lets the running model call finish.
   */
  when?: "nextTurn";
}

export interface ThreadOptions {
  /**
   * Session the thread belongs to. Default: the thread key.
   */
  session?: string;

  /**
   * KV store holding the thread state. Default: Redis at
   * `INNGEST_EXPERIMENTAL_KV_URL`.
   */
  kv?: Kv;
}

export interface ThreadHandle {
  /**
   * The agent, as `"appId/functionId"`.
   */
  agent: string;
  key: string;
  session: string;

  /**
   * Sends a message that starts the next turn (and a run, if none is live).
   */
  send(message: string): Promise<void>;

  /**
   * Sends a message to fold into the turn that is running.
   */
  steer(message: string): Promise<void>;

  /**
   * Stops the thread. `"nextTurn"` lets the running model call finish and
   * stops before the next; `"now"` cancels the live run. It does nothing when
   * no run is live.
   */
  stop(options: { when: "now" | "nextTurn" }): Promise<void>;

  /**
   * The thread's KV scope.
   */
  state(): Promise<Record<string, unknown>>;
}

/**
 * The session metadata of a thread's events.
 * @param key Thread key.
 * @param session Session the thread belongs to. Default: the thread key.
 */
export function threadSessions(
  key: string,
  session: string = key,
): Record<string, string> {
  return { agent_session: session, agent_thread: key };
}

/**
 * The thread KV scope of a client, readable outside a function.
 * @param client Inngest client.
 * @param key Thread key.
 * @param kv KV store. Default: Redis at `INNGEST_EXPERIMENTAL_KV_URL`.
 */
export function threadKv(
  client: Inngest.Any,
  key: string,
  kv: Kv = defaultKv,
): KvScopeInstance {
  return kv.with(client).scope("thread", key);
}

/**
 * EXPERIMENTAL: Gets the handle of a thread.
 * @param client Inngest client.
 * @param agent The agent, as `"appId/functionId"`.
 * @param key Thread key, the thread's address.
 * @param options Session and KV overrides.
 */
export function getThread(
  client: Inngest.Any,
  agent: string,
  key: string,
  options: ThreadOptions = {},
): ThreadHandle {
  const session = options.session ?? key;

  async function post(message: ThreadMessage) {
    await client.send({
      name: agentMessageEvent,
      data: message,
      meta: { sessions: threadSessions(key, session) },
    });
  }

  return {
    agent,
    key,
    session,
    async send(message) {
      await post({ agent, thread: key, kind: "user", content: message });
    },
    async steer(message) {
      await post({ agent, thread: key, kind: "steer", content: message });
    },
    async stop({ when }) {
      if (when === "now") {
        await client.send({
          name: agentStopEvent,
          data: { agent, thread: key },
        });

        return;
      }

      await post({ agent, thread: key, kind: "stop", when });
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
