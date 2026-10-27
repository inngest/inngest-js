/**
 * @module
 * EXPERIMENTAL: the agent function, an Inngest function whose body owns its
 * loop and reads a durable inbox. It adds what a plain function lacks for a
 * conversation that spans runs:
 *
 * - a singleton per thread, so there is never more than one live run per thread;
 * - `inbox`, a `step.subscribe()` of the thread's messages, whose first message
 *   is the event that started the run;
 * - `control`, which spreads into `agent.loop()` so a running turn takes
 *   steering messages and a stop request.
 *
 * Messages that reach the run but are never read are handed to the thread's
 * next run by the executor when the run ends, so a message that arrives as a
 * run finishes is not lost.
 *
 * The public name of this entry point is not settled; it is exported from
 * `index.ts` in one line.
 */

import type { ClientOptions } from "../../types.ts";
import { createDefer } from "../DeferredFunction.ts";
import { agentHook, type Inngest } from "../Inngest.ts";
import type { InngestFunction } from "../InngestFunction.ts";
import { kv as defaultKv, type Kv } from "./kv.ts";
import type { InboxMessage, Subscription } from "./subscribe.ts";
import {
  agentMessageEvent,
  agentStopEvent,
  getThread,
  type ThreadHandle,
  type ThreadMessage,
} from "./thread.ts";

export interface AgentFunctionConfig {
  /**
   * The function ID. The agent is addressed as `"<appId>/<id>"`.
   */
  id: string;

  /**
   * KV store for thread state. Default: Redis at `INNGEST_EXPERIMENTAL_KV_URL`.
   */
  kv?: Kv;
}

/**
 * What the body gets, besides the usual function context.
 */
export interface AgentBodyContext {
  event: { name: string; data: ThreadMessage };
  thread: ThreadHandle;

  /**
   * Messages sent to the thread, one per delivery, in order. The first is the
   * event that started the run (`seq` 0).
   */
  inbox: Subscription<ThreadMessage>;

  /**
   * Spread into `agent.loop()`: `steer` folds steering messages that arrived
   * during a turn into the next model call, and `stop` ends the loop when a
   * stop message arrived. Messages that start the next turn stay in the inbox.
   */
  control: {
    steer: () => Promise<string[]>;
    stop: () => Promise<boolean>;
  };
}

export type AgentBody = (context: AgentBodyContext) => Promise<unknown>;

export interface AgentFunction {
  /**
   * The function that runs the body.
   */
  fn: InngestFunction.Any;

  /**
   * Runs after every run of `fn` ends, whichever way, and removes the run's
   * run-scoped KV keys.
   */
  cleanup: InngestFunction.Any;

  /**
   * Both functions, ready to pass to `serve()`.
   */
  functions: InngestFunction.Any[];

  /**
   * The agent's address, `"<appId>/<functionId>"`.
   */
  ref: string;

  /**
   * The handle of a thread of this agent.
   * @param key Thread key.
   * @param session Session the thread belongs to. Default: the thread key.
   */
  thread(key: string, session?: string): ThreadHandle;
}

/**
 * The thread's view of its subscription: messages are the `data` of the
 * events, and stop messages are skipped, because while the agent waits for its
 * next message there is nothing to stop.
 * @param inbox The subscription to the thread's events.
 */
function threadInbox(inbox: Subscription<{ data: ThreadMessage }>): {
  inbox: Subscription<ThreadMessage>;
  handled: (message: InboxMessage<ThreadMessage>) => void;
  flush: () => Promise<void>;
} {
  function unwrap(message: InboxMessage<{ data: ThreadMessage }> | null) {
    return message ? { seq: message.seq, data: message.data.data } : null;
  }

  // Messages the current turn handled. They are acked when the turn is over:
  // when the agent asks for its next message, or the body returns. A run that
  // fails or is cancelled mid-turn leaves them unacked, so the executor hands
  // them to the thread's next run.
  let pending: InboxMessage<ThreadMessage>[] = [];

  function handled(message: InboxMessage<ThreadMessage>) {
    pending.push(message);
  }

  async function flush() {
    const done = pending.sort((a, b) => {
      return a.seq - b.seq;
    });
    pending = [];

    for (const message of done) {
      await inbox.ack({ seq: message.seq, data: { data: message.data } });
    }
  }

  async function next() {
    await flush();

    for (;;) {
      const message = unwrap(await inbox.next());
      if (!message) {
        return null;
      }

      handled(message);

      // While the agent waits for its next message there is nothing to stop.
      if (message.data.kind !== "stop") {
        return message;
      }
    }
  }

  return {
    handled,
    flush,
    inbox: {
      next,
      async poll() {
        return unwrap(await inbox.poll());
      },
      async ack(message) {
        await inbox.ack({ seq: message.seq, data: { data: message.data } });
      },
      putBack(messages) {
        inbox.putBack(
          messages.map((message) => {
            return { seq: message.seq, data: { data: message.data } };
          }),
        );
      },
      close() {
        return inbox.close();
      },
      [Symbol.asyncIterator]() {
        return {
          async next() {
            const message = await next();
            if (!message) {
              return { done: true, value: undefined };
            }

            return { done: false, value: message };
          },
        };
      },
    },
  };
}

function quote(value: string) {
  return JSON.stringify(value);
}

/**
 * EXPERIMENTAL: Defines an agent function.
 * @param client Inngest client.
 * @param config Function ID and KV store.
 * @param body Your loop. Read `inbox`, call `agent.loop()` with `control`.
 */
export function createAgentFunction(
  client: Inngest.Any,
  config: AgentFunctionConfig,
  body: AgentBody,
): AgentFunction {
  const ref = `${client.id}/${config.id}`;

  const cleanup = createDefer(
    client,
    { id: `${config.id}-cleanup` },
    async ({ event }) => {
      // The KV call is its own step.
      await (config.kv ?? defaultKv)
        .scope("run", (event.data as { runId: string }).runId)
        .clear();
    },
  );

  const fn = client.createFunction(
    {
      id: config.id,
      triggers: [
        {
          event: agentMessageEvent,
          // A stop message never starts a run, so stopping an idle thread
          // does nothing.
          if: `event.data.agent == ${quote(ref)} && event.data.kind != "stop"`,
        },
      ],
      singleton: { key: "event.data.thread", mode: "skip" },
      cancelOn: [
        {
          event: agentStopEvent,
          if: `event.data.agent == ${quote(ref)} && event.data.thread == async.data.thread`,
        },
      ],
    },
    async ({ event, step, defer, runId }) => {
      const data = event.data as ThreadMessage;

      // Run-scoped KV keys end with the run, whichever way it ends.
      defer("kv-cleanup", { function: cleanup, data: { runId } });

      const thread = getThread(client, ref, data.thread, { kv: config.kv });

      // Opened first, so the gap in which a message could be missed is the few
      // milliseconds between the run starting and this op.
      const subscription = await step.subscribe<{ data: ThreadMessage }>(
        "inbox",
        {
          event: agentMessageEvent,
          if: `async.data.agent == ${quote(ref)} && async.data.thread == ${quote(data.thread)}`,
        },
      );
      subscription.putBack([{ seq: 0, data: { data } }]);

      let stopRequested = false;
      const { inbox, handled, flush } = threadInbox(subscription);

      const control = {
        async steer() {
          const lines: string[] = [];
          const waiting: InboxMessage<ThreadMessage>[] = [];

          // Read everything that has arrived: steering messages and stops
          // apply to the turn that is running; messages for the next turn
          // keep their place in the inbox.
          for (;;) {
            const message = await inbox.poll();
            if (!message) {
              break;
            }

            const kind = message.data.kind;
            if (kind === "steer") {
              lines.push(message.data.content ?? "");
              handled(message);
            } else if (kind === "stop") {
              stopRequested = true;
              handled(message);
            } else {
              waiting.push(message);
            }
          }
          inbox.putBack(waiting);

          return lines;
        },
        async stop() {
          const requested = stopRequested;
          stopRequested = false;

          return requested;
        },
      };

      const result = await body({
        event: event as unknown as AgentBodyContext["event"],
        thread,
        inbox,
        control,
      });

      // The body returned: the last turn is over.
      await flush();

      return result;
    },
  );

  return {
    fn,
    cleanup,
    functions: [fn, cleanup],
    ref,
    thread(key, session) {
      return getThread(client, ref, key, { session, kv: config.kv });
    },
  };
}

// `client.agent()` is defined on the client; this gives it its implementation
// once this module is loaded (the client cannot import it without a cycle).
agentHook.create = createAgentFunction;
