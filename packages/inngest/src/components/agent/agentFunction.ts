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
import { agentHook, type Inngest } from "../Inngest.ts";
import type { InngestFunction } from "../InngestFunction.ts";
import { step } from "../InngestStepTools.ts";
import { kv as defaultKv, type Kv } from "./kv.ts";
import type { AgentTurn } from "./loop.ts";
import { registerFunctions } from "./register.ts";
import type { InboxMessage, Subscription } from "./subscribe.ts";
import {
  agentMessageEvent,
  agentStopEvent,
  getThread,
  summaryLength,
  type ThreadHandle,
  type ThreadMessage,
  type ThreadRecord,
  threadRecordKey,
} from "./thread.ts";
import { listThreads, type ThreadList } from "./threadList.ts";

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
  inbox: ThreadInbox;

  /**
   * Spread into `agent.loop()`: `steer` folds steering messages that arrived
   * during a turn into the next model call, and `stop` ends the loop when a
   * stop message arrived. Messages that start the next turn stay in the inbox.
   * `onTurn` records the turn, the usage and a summary for
   * `thread.state()`: if you pass your own `onTurn`, put `...control` first
   * and call `control.onTurn(turn)` from yours.
   */
  control: {
    steer: () => Promise<string[]>;
    stop: () => Promise<boolean>;
    onTurn: (turn: AgentTurn) => Promise<void>;
  };
}

/**
 * A message of the thread's inbox. A `"request"` message from another
 * thread's `handle.request()` is answered with `reply()`.
 */
export interface ThreadInboxMessage extends InboxMessage<ThreadMessage> {
  /**
   * Answers a request: sends `data` to the thread that asked. It is a step.
   * @param data The reply.
   */
  reply(data: unknown): Promise<void>;
}

/**
 * The thread's inbox: a subscription whose messages can reply.
 */
export interface ThreadInbox extends AsyncIterable<ThreadInboxMessage> {
  next(): Promise<ThreadInboxMessage | null>;
  poll(): Promise<ThreadInboxMessage | null>;
  ack(message: InboxMessage<ThreadMessage>): Promise<void>;
  putBack(messages: InboxMessage<ThreadMessage>[]): void;
  close: Subscription<ThreadMessage>["close"];
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

  /**
   * The agent's threads.
   */
  threads: ThreadList;
}

/**
 * The thread's view of its subscription: messages are the `data` of the
 * events, and stop messages are skipped, because while the agent waits for its
 * next message there is nothing to stop.
 * @param inbox The subscription to the thread's events.
 * @param client Inngest client, to send replies.
 * @param mark Records the thread's status: `"waiting"` before the agent waits
 * for a message after the first, `"running"` once one is delivered.
 */
function threadInbox(
  inbox: Subscription<{ data: ThreadMessage }>,
  client: Inngest.Any,
  mark: (status: "waiting" | "running") => Promise<void>,
): {
  inbox: ThreadInbox;
  handled: (message: InboxMessage<ThreadMessage>) => void;
  flush: () => Promise<void>;
} {
  function unwrap(
    message: InboxMessage<{ data: ThreadMessage }> | null,
  ): ThreadInboxMessage | null {
    if (!message) {
      return null;
    }

    const data = message.data.data;

    return {
      seq: message.seq,
      data,
      async reply(answer) {
        if (!data.replyTo) {
          throw new Error(
            "This message is not a request: only a request has a reply.",
          );
        }

        await step.run(`reply:${message.seq}`, async () => {
          await client.sendSignal({
            signal: data.replyTo as string,
            data: answer,
          });
        });
      },
    };
  }

  let delivered = 0;

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
      await inbox.ack({ seq: message.seq, data: { data: message.data } });
    }
  }

  async function next() {
    await flush();

    if (delivered > 0) {
      await mark("waiting");
    }

    for (;;) {
      const message = unwrap(await inbox.next());
      if (!message) {
        return null;
      }

      delivered += 1;
      handled(message);

      // While the agent waits for its next message there is nothing to stop.
      if (message.data.kind !== "stop") {
        if (delivered > 1) {
          await mark("running");
        }

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

function emptyRecord(): ThreadRecord {
  return { status: "idle", turn: 0, usage: { input: 0, output: 0 } };
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

  const store = config.kv ?? defaultKv;

  const cleanup = createDefer(
    client,
    { id: `${config.id}-cleanup` },
    async ({ event }) => {
      const { runId, thread } = event.data as {
        runId: string;
        thread?: string;
      };

      // Each KV call is its own step.
      await store.scope("run", runId).clear();

      // The run is over, so the thread is idle, unless a newer run has already
      // taken over the record or the thread honored a stop request.
      if (thread) {
        await store
          .scope("thread", thread)
          .update<ThreadRecord>(threadRecordKey, (found) => {
            const current = found ?? emptyRecord();

            return current.runId === runId && current.status !== "stopped"
              ? { ...current, status: "idle" }
              : current;
          });
      }
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
      defer("kv-cleanup", {
        function: cleanup,
        data: { runId, thread: data.thread },
      });

      const thread = getThread(client, ref, data.thread, { kv: config.kv });

      // Writes what `thread.state()` shows. One step per change.
      async function record(
        change: (current: ThreadRecord) => Partial<ThreadRecord>,
      ) {
        await store.thread.update<ThreadRecord>(threadRecordKey, (found) => {
          const current = found ?? emptyRecord();

          return { ...current, ...change(current), runId };
        });
      }

      await record(() => {
        return { status: "running" };
      });

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
      const { inbox, handled, flush } = threadInbox(
        subscription,
        client,
        (status) => {
          // A thread that honored a stop stays stopped until a message runs it.
          return record((current) => {
            return status === "waiting" && current.status === "stopped"
              ? {}
              : { status };
          });
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

          if (requested) {
            await record(() => {
              return { status: "stopped" };
            });
          }

          return requested;
        },
        async onTurn(turn: AgentTurn) {
          await record((current) => {
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
    threads: {
      list(options) {
        return listThreads(client, ref, options, (key, session) => {
          return getThread(client, ref, key, { session, kv: config.kv });
        });
      },
    },
  };
}

// `client.agent()` is defined on the client; this gives it its implementation
// once this module is loaded (the client cannot import it without a cycle).
agentHook.create = createAgentFunction;
