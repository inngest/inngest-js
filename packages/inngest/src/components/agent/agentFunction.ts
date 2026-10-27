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
import type { Inngest } from "../Inngest.ts";
import type { InngestFunction } from "../InngestFunction.ts";
import type { Kv } from "./kv.ts";
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
 * A view of the inbox that skips stop messages: while the agent is waiting
 * for its next message there is nothing to stop.
 * @param inbox The thread subscription.
 */
function withoutStops(
  inbox: Subscription<ThreadMessage>,
): Subscription<ThreadMessage> {
  async function next() {
    for (;;) {
      const message = await inbox.next();
      if (!message || message.data.kind !== "stop") {
        return message;
      }
    }
  }

  return {
    ...inbox,
    next,
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
    async ({ event, step }) => {
      const data = event.data as ThreadMessage;
      const thread = getThread(client, ref, data.thread, { kv: config.kv });

      // Opened first, so the gap in which a message could be missed is the few
      // milliseconds between the run starting and this op.
      const subscription = await step.subscribe<ThreadMessage>("inbox", {
        event: agentMessageEvent,
        if: `async.data.agent == ${quote(ref)} && async.data.thread == ${quote(data.thread)}`,
      });
      subscription.putBack({ seq: 0, data });

      let stopRequested = false;
      const inbox = withoutStops(subscription);

      const control = {
        async steer() {
          const lines: string[] = [];

          for (;;) {
            const message = await inbox.poll();
            if (!message) {
              break;
            }

            const kind = message.data.kind;
            if (kind === "steer") {
              lines.push(message.data.content ?? "");
            } else if (kind === "stop") {
              stopRequested = true;
            } else {
              // A message for the next turn is not ours to fold in.
              inbox.putBack(message as InboxMessage<ThreadMessage>);
              break;
            }
          }

          return lines;
        },
        async stop() {
          const requested = stopRequested;
          stopRequested = false;

          return requested;
        },
      };

      return body({
        event: event as unknown as AgentBodyContext["event"],
        thread,
        inbox,
        control,
      });
    },
  );

  return {
    fn,
    ref,
    thread(key, session) {
      return getThread(client, ref, key, { session, kv: config.kv });
    },
  };
}
