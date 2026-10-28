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
 * The inbox closes when the body returns. Messages it saved but the body never
 * read are discarded, and a message that arrives after that, while the thread's
 * singleton is still in effect, is dropped: it neither starts a new run nor
 * reaches the finished one. The gap is small (the time between the body
 * returning and the run ending), and nothing is re-sent at run end.
 */

import { createDefer } from "../DeferredFunction.ts";
import { getAsyncCtxSync, runWithAsyncCtx } from "../execution/als.ts";
import type { Inngest } from "../Inngest.ts";
import type { InngestFunction } from "../InngestFunction.ts";
import { step } from "../InngestStepTools.ts";
import type { SandboxTools } from "../sandbox/tools.ts";
import {
  type LazySandbox,
  openSandboxes,
  resolveSandboxes,
  type SandboxesConfig,
  sandboxTools,
  stepSandboxes,
} from "./defs.ts";
import { kv as defaultKv, type Kv } from "./kv.ts";
import {
  type AgentLimits,
  budgetReason,
  narrowInherited,
  narrowLimits,
  readInheritedLimits,
  registerLimits,
} from "./limits.ts";
import type { AgentTurn } from "./loop.ts";
import type { SkillsRuntime } from "./skills.ts";
import type { InboxMessage, Subscription } from "./subscribe.ts";
import {
  agentMessageEvent,
  agentStopEvent,
  getThread,
  type ThreadHandle,
  type ThreadMessage,
} from "./thread.ts";
import { listThreads, type ThreadList } from "./threadList.ts";
import { markThreadIdle, threadRecorder } from "./threadState.ts";
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

  /**
   * The sandboxes this agent may use, by name: definitions made with
   * `sandbox()`, or `{ sandbox, start }`. A sandbox is created by the first
   * tool call that needs it (`start: "lazy"`, the default), or as soon as the
   * run begins (`"eager"`). Either the object or a `start` may be a function
   * of `{ event }`; it re-runs on every replay, so it must be pure. The run
   * destroys what it created when the body returns.
   */
  sandboxes?: SandboxesConfig<AgentConfigContext>;

  /**
   * What this agent may start and spend: `depth` (default 1, so it may start
   * sub-agents and they may not), `spawn`, `mayCall` and `budget`. Sub-agents
   * inherit the limits narrowed. `agent.invoke()` refuses a call the limits
   * do not allow; spread `control` into `agent.loop()` to stop on `budget`.
   */
  limits?: AgentLimits;
}

/**
 * What a config function receives.
 */
export interface AgentConfigContext {
  event: { name: string; data: ThreadMessage };
}

/**
 * What the body gets, besides the usual function context.
 */
export interface AgentBodyContext {
  event: { name: string; data: ThreadMessage };
  thread: ThreadHandle;

  /**
   * The agent's sandboxes, by name. Nothing is created until a call needs it,
   * except `start: "eager"` ones, which are already being created.
   */
  sandboxes: Record<string, LazySandbox>;

  /**
   * Every sandbox's tools, named `<sandbox>_<tool>` (`work_run`). Spread into
   * the `tools` of `agent.loop()`.
   */
  sandboxTools: SandboxTools;

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
    budget: () => string | undefined;
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
export interface ThreadInbox
  extends Omit<
      Subscription<ThreadMessage>,
      "next" | "poll" | "close" | typeof Symbol.asyncIterator
    >,
    AsyncIterable<ThreadInboxMessage> {
  next(): Promise<ThreadInboxMessage | null>;
  poll(): Promise<ThreadInboxMessage | null>;

  /**
   * Ends the subscription. See `Subscription.close()`: it only ends the
   * subscription, and a message that arrives afterwards is dropped.
   * @returns The messages that were saved but not read.
   */
  close(): Promise<ThreadInboxMessage[]>;
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
 * @param recorder Records the thread's status: `waiting()` before the agent
 * waits for a message after the first, `running()` once one is delivered.
 */
function threadInbox(
  inbox: Subscription<RawEvent>,
  toMessage: (raw: RawEvent) => ThreadMessage,
  client: Inngest.Any,
  recorder: Pick<ReturnType<typeof threadRecorder>, "waiting" | "running">,
): {
  inbox: ThreadInbox;
  handled: (message: InboxMessage<ThreadMessage>) => void;
  flush: () => Promise<void>;
} {
  // The event each message was made from, to ack and put it back as it came.
  const raws = new WeakMap<object, InboxMessage<RawEvent>>();

  function unwrap(
    message: InboxMessage<RawEvent> | null,
  ): ThreadInboxMessage | null {
    if (!message) {
      return null;
    }

    const data = toMessage(message.data);
    const unwrapped: ThreadInboxMessage = {
      seq: message.seq,
      data,
      source: message.source,
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

  let delivered = 0;

  // Messages the current turn handled. They are acked when the turn is over:
  // when the agent asks for its next message, or the body returns. A run that
  // fails or is cancelled mid-turn leaves them unacked.
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

    if (delivered > 0) {
      await recorder.waiting();
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
          await recorder.running();
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
        await inbox.ack(rawOf(message));
      },
      putBack(messages) {
        inbox.putBack(messages.map(rawOf));
      },
      async close() {
        const unread = await inbox.close();

        return unread.map((message) => {
          return unwrap(message) as ThreadInboxMessage;
        });
      },
      async [Symbol.asyncDispose]() {
        await inbox[Symbol.asyncDispose]();
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
 * Defines an agent function. Use `createAgents(client).agent()`.
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

      if (thread) {
        await markThreadIdle(store, thread, runId);
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
                  if: `event.name == ${quote(trigger.event)} && async.data.agent == ${quote(ref)} && ${trigger.thread.path} == async.data.thread`,
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
      defer("kv-cleanup", {
        function: cleanup,
        data: { runId, thread: data.thread },
      });

      const thread = getThread(client, ref, data.thread, {
        session,
        kv: config.kv,
      });

      // The KV scopes of the thread and session come from the trigger, which
      // for an event of `on` does not carry them: the whole run reads them
      // from here.
      async function main() {
        // Writes what `thread.state()` shows. One step per change.
        const recorder = threadRecorder(store, runId);

        // What a sub-agent inherited is kept on its thread, so a later run that
        // a plain message starts has the same limits.
        const started = await recorder.running(
          readInheritedLimits(
            (data as unknown as Record<string, unknown>)._agent,
          ),
        );

        // Limits apply to what `agent.invoke()` starts and to the loop's budget.
        // The usage is the thread's so far, and each turn adds to it.
        const instance = getAsyncCtxSync()?.execution?.instance;

        if (!instance) {
          throw new Error("An agent must run inside an Inngest function");
        }

        const limits = registerLimits(
          instance,
          narrowLimits(config.limits, started.inherited),
          { ...started.usage },
        );

        // Opened first, so the gap in which a message could be missed is the few
        // milliseconds between the run starting and this op.
        // Closed when the run's work is done, whichever way it ends. That only
        // ends the subscription.
        await using subscription = await step.subscribe<RawEvent>("inbox", {
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

        const bindings = await resolveSandboxes(config.sandboxes, {
          event: event as unknown as AgentConfigContext["event"],
        });
        const opened =
          Object.keys(bindings).length > 0
            ? openSandboxes(bindings, stepSandboxes(step), {
                event,
                client: client as unknown as SkillsRuntime["client"],
                run: (id, fn) => {
                  return step.run(id, fn) as ReturnType<typeof fn>;
                },
                sendEvent: (id, payload) => {
                  return step.sendEvent(id, payload);
                },
              })
            : {};

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
          client,
          recorder,
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
              await recorder.stopped();
            }

            return requested;
          },
          budget() {
            return budgetReason(limits);
          },
          async onTurn(turn: AgentTurn) {
            const next = await recorder.turn(turn);

            limits.used = { ...next.usage };
          },
        };

        // Closes every sandbox. Returns the first failure instead of throwing, so
        // a failed eager start nothing used is raised but never in place of the
        // body's own error.
        const closeAll = async () => {
          const closed = await Promise.allSettled(
            Object.values(opened).map((handle) => {
              return handle.close();
            }),
          );

          return closed.find((outcome) => {
            return outcome.status === "rejected";
          });
        };
        let result: unknown;

        try {
          result = await body({
            event: { ...event, data } as AgentBodyContext["event"],
            thread,
            sandboxes: opened,
            sandboxTools: sandboxTools(opened),
            inbox,
            control,
          });

          // The body returned: the last turn is over.
          await flush();

          // The last thread work is done: end the subscription before the
          // sandboxes close. A second close, from the scope exit, does nothing.
          await inbox.close();
        } catch (error) {
          await closeAll();

          throw error;
        }

        const rejected = await closeAll();

        if (rejected) {
          throw rejected.reason;
        }

        return result;
      }

      const als = getAsyncCtxSync();

      // A run started by a message keeps what its trigger carries.
      return als?.execution && found
        ? runWithAsyncCtx(
            {
              ...als,
              execution: {
                ...als.execution,
                agent: { thread: thread.key, session: thread.session },
              },
            },
            main,
          )
        : main();
    },
  );

  return {
    fn,
    cleanup,
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
