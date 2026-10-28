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

import { createDefer } from "../DeferredFunction.ts";
import { getAsyncCtxSync, runWithAsyncCtx } from "../execution/als.ts";
import { agentHook, type Inngest } from "../Inngest.ts";
import type { InngestFunction } from "../InngestFunction.ts";
import { kv as defaultKv, type Kv } from "./kv.ts";
import { registerFunctions } from "./register.ts";
import type { InboxMessage, Subscription } from "./subscribe.ts";
import {
  agentMessageEvent,
  agentStopEvent,
  getThread,
  type ThreadHandle,
  type ThreadMessage,
} from "./thread.ts";
import {
  compileTriggers,
  messageOf,
  singletonKey,
  type ThreadKeyConfig,
  type ThreadTriggerEvent,
} from "./threadTrigger.ts";

export interface AgentFunctionConfig extends ThreadKeyConfig {
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
function threadInbox(
  inbox: Subscription<RawEvent>,
  toMessage: (raw: RawEvent) => ThreadMessage,
): {
  inbox: Subscription<ThreadMessage>;
  handled: (message: InboxMessage<ThreadMessage>) => void;
  flush: () => Promise<void>;
} {
  // The event each message was made from, to ack and put it back as it came.
  const raws = new WeakMap<object, InboxMessage<RawEvent>>();

  function unwrap(message: InboxMessage<RawEvent> | null) {
    if (!message) {
      return null;
    }

    const unwrapped = {
      seq: message.seq,
      data: toMessage(message.data),
      source: message.source,
    };
    raws.set(unwrapped, message);

    return unwrapped;
  }

  function rawOf(message: InboxMessage<ThreadMessage>) {
    return (
      raws.get(message) ?? {
        seq: message.seq,
        data: { name: "", data: message.data },
      }
    );
  }

  // Messages the current turn handled. They are acked when the turn is over:
  // when the agent asks for its next message, or the body returns. A run that
  // fails or is cancelled mid-turn leaves them unacked, so the executor hands
  // them to the thread's next run.
  let pending: InboxMessage<ThreadMessage>[] = [];

  function handled(message: InboxMessage<ThreadMessage>) {
    pending.push(message);
  }

  // The executor counts acks as consecutive from 1, so a message is only
  // acked once every message before it has been: a handled steer that sits
  // behind a message put back for the next turn waits for that turn.
  let nextToAck = 1;

  async function flush() {
    pending = pending
      .filter((message) => {
        return message.seq >= 1;
      })
      .sort((a, b) => {
        return a.seq - b.seq;
      });

    while (pending[0] && pending[0].seq === nextToAck) {
      const message = pending.shift() as InboxMessage<ThreadMessage>;
      nextToAck += 1;
      await inbox.ack(rawOf(message));
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
        await inbox.ack(rawOf(message));
      },
      putBack(messages) {
        inbox.putBack(messages.map(rawOf));
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

/**
 * An event as the subscription saves it.
 */
interface RawEvent {
  id?: string;
  name: string;
  data: unknown;
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
  const triggers = compileTriggers(config.id, config);
  const threadExpression = singletonKey(triggers);

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
        ...triggers.map((trigger) => {
          return trigger.if
            ? { event: trigger.event, if: trigger.if }
            : { event: trigger.event };
        }),
      ],
      singleton: { key: threadExpression, mode: "skip" },
      cancelOn: [
        {
          event: agentStopEvent,
          if: `event.data.agent == ${quote(ref)} && event.data.thread == async.data.thread`,
        },
        // A cancel expression cannot call functions, so only a thread key that
        // is a plain path of the trigger can be matched against a stop.
        ...triggers.flatMap((trigger) => {
          return trigger.thread.path
            ? [
                {
                  event: agentStopEvent,
                  if: `async.data.agent == ${quote(ref)} && ${trigger.thread.path} == async.data.thread`,
                },
              ]
            : [];
        }),
      ],
    },
    async ({ event, step, defer, runId }) => {
      // The thread a run belongs to comes from its trigger: a message names it,
      // any other trigger event gives it by the expression of its trigger.
      const found = triggers.find((t) => {
        return t.event === event.name;
      });
      const data = found
        ? messageOf(ref, found, event as unknown as ThreadTriggerEvent)
        : (event.data as ThreadMessage);
      const session = found?.session?.key(event);

      // Run-scoped KV keys end with the run, whichever way it ends.
      defer("kv-cleanup", { function: cleanup, data: { runId } });

      const thread = getThread(client, ref, data.thread, {
        session,
        kv: config.kv,
      });

      // Opened first, so the gap in which a message could be missed is the few
      // milliseconds between the run starting and this op.
      const subscription = await step.subscribe<RawEvent>("inbox", {
        events: [
          {
            event: agentMessageEvent,
            if: `async.data.agent == ${quote(ref)} && async.data.thread == ${quote(data.thread)}`,
          },
          ...triggers.map((trigger) => {
            const own = `(${trigger.thread.asAsync}) == ${quote(data.thread)}`;

            return {
              event: trigger.event,
              if: trigger.asyncIf ? `(${trigger.asyncIf}) && ${own}` : own,
            };
          }),
        ],
      });
      subscription.putBack([
        {
          seq: 0,
          data: { id: event.id, name: event.name, data: event.data },
        },
      ]);

      function runBody() {
        return body({
          event: { name: event.name, data } as AgentBodyContext["event"],
          thread,
          inbox,
          control,
        });
      }

      let stopRequested = false;
      const { inbox, handled, flush } = threadInbox(
        subscription,
        function toMessage(raw) {
          const trigger = triggers.find((t) => {
            return t.event === raw.name;
          });

          return trigger
            ? messageOf(ref, trigger, raw as unknown as ThreadTriggerEvent)
            : (raw.data as ThreadMessage);
        },
      );

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

      // The KV scopes of the thread and session come from the trigger, which
      // for an event of `on` does not carry them.
      const als = getAsyncCtxSync();
      const result = await (als?.execution
        ? runWithAsyncCtx(
            {
              ...als,
              execution: {
                ...als.execution,
                agent: { thread: thread.key, session: thread.session },
              },
            },
            runBody,
          )
        : runBody());

      // The body returned: the last turn is over.
      await flush();

      return result;
    },
  );

  // Serving the app serves both, whether or not the app lists them.
  registerFunctions(client, [fn, cleanup]);

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
