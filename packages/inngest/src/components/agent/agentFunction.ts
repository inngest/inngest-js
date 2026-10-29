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

import { internalEvents } from "../../helpers/consts.ts";
import { createDefer } from "../DeferredFunction.ts";
import { getAsyncCtxSync, runWithAsyncCtx } from "../execution/als.ts";
import { type Inngest, internalLoggerSymbol } from "../Inngest.ts";
import type { InngestFunction } from "../InngestFunction.ts";
import { step } from "../InngestStepTools.ts";
import type { SandboxTools } from "../sandbox/tools.ts";
import {
  type Channel,
  createReporter,
  parseWithAsync,
  type ReportConfigValue,
  type Reporter,
} from "./channels.ts";
import {
  type ConfigValue,
  type LazySandbox,
  openSandboxes,
  resolveConfigValue,
  resolveSandboxes,
  type SandboxesConfig,
  type SandboxToolNames,
  type SandboxToolsOf,
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
  getThread,
  type ThreadHandle,
  type ThreadMessage,
  type ThreadRequests,
  type TriggerEvent,
} from "./thread.ts";
import { listThreads, type ThreadList } from "./threadList.ts";
import {
  cleanupThreadSandbox,
  type ThreadSandboxCleanup,
  threadSandboxOwner,
} from "./threadSandboxes.ts";
import { markThreadIdle, threadRecorder } from "./threadState.ts";
import {
  type CompiledTrigger,
  compileTriggers,
  dataProblem,
  messageOf,
  schemaProblem,
  singletonKey,
  type ThreadKeyConfig,
  type ThreadTriggerEvent,
  type ThreadTriggers,
} from "./threadTrigger.ts";

export interface AgentFunctionConfig<
  TOn = ThreadTriggers,
  TEvent = TriggerEvent,
  TRequest = unknown,
  TReply = unknown,
  TSandboxes extends SandboxToolNames = SandboxToolNames,
> extends ThreadKeyConfig<TOn> {
  /**
   * The function ID. The agent is addressed as `"<appId>/<id>"`.
   */
  id: string;

  /**
   * KV store for thread state. Default: Redis at `INNGEST_EXPERIMENTAL_KV_URL`.
   */
  kv?: Kv;

  /**
   * The types of the requests other threads send this agent with
   * `handle.request()`: schemas for what they ask and what you reply. They
   * type `payload` of a `"request"` message, `message.reply()`, and
   * `request()` on the handle from `agent.thread()`, which also checks its
   * payload against `request`. `reply()` checks its data against `reply`.
   */
  requests?: ThreadRequests<TRequest, TReply>;

  /**
   * The sandboxes this agent may use, by name: definitions made with
   * `sandbox()`, or `{ sandbox, start }`. A sandbox is created by the first
   * tool call that needs it (`start: "lazy"`, the default), or as soon as the
   * run begins (`"eager"`). Either the object or a `start` may be a function
   * of `{ event }`; it re-runs on every replay, so it must be pure. A sandbox
   * belongs to the thread: it is restored from the thread's newest snapshot
   * when first used and snapshotted when the run ends, whichever way, then
   * destroyed. Only files survive between runs.
   */
  sandboxes?: SandboxesConfig<AgentConfigContext<TEvent>, TSandboxes>;

  /**
   * The destinations of progress and asks, by name: channels made with
   * `defineChannel()` or a helper such as `slack.channel(event)`. The object
   * may be a function of `{ event }`, so a channel can be chosen from the
   * trigger; it re-runs on every replay, so it must be pure.
   */
  channels?: ConfigValue<Record<string, Channel>, AgentConfigContext>;

  /**
   * Where `report()` posts when it is not told: a channel name, a channel,
   * or a list of them. Default: the channel named `main`, if there is one.
   * May be a function of `{ event }`.
   */
  report?: ReportConfigValue<AgentConfigContext>;

  /**
   * What this agent may start and spend: `depth` (default 1, so it may start
   * sub-agents and they may not), `spawn`, `mayCall` and `budget`. Sub-agents
   * inherit the limits narrowed. `agent.invoke()` refuses a call the limits
   * do not allow, but only `agent.invoke()`: a raw `step.invoke` or
   * `sendEvent` to another agent bypasses them. `budget` is not automatic:
   * spread `control` into `agent.loop()`, or that loop runs unbudgeted.
   */
  limits?: AgentLimits;
}

/**
 * What a config function receives.
 */
export interface AgentConfigContext<TEvent = TriggerEvent> {
  event: { name: string; data: ThreadMessage<TEvent> };
}

/**
 * What the body gets, besides the usual function context.
 */
export interface AgentBodyContext<
  TEvent = TriggerEvent,
  TRequest = unknown,
  TReply = unknown,
  TSandboxes extends SandboxToolNames = SandboxToolNames,
> {
  event: { name: string; data: ThreadMessage<TEvent, TRequest> };
  thread: ThreadHandle<TRequest, TReply>;

  /**
   * The agent's sandboxes, by name. Nothing is created until a call needs it,
   * except `start: "eager"` ones, which are already being created.
   */
  sandboxes: { [K in keyof TSandboxes & string]: LazySandbox };

  /**
   * Every sandbox's tools, named `<sandbox>_<tool>` (`work_run`). Spread into
   * the `tools` of `agent.loop()`.
   */
  sandboxTools: SandboxToolsOf<TSandboxes>;

  /**
   * The agent's channels, by name, as the config resolved them for this run.
   */
  channels: Record<string, Channel>;

  /**
   * Posts progress to the agent's channels. See `Reporter`.
   */
  report: Reporter;

  /**
   * Messages sent to the thread, one per delivery, in order. The first is the
   * event that started the run (`seq` 0).
   */
  inbox: ThreadInbox<TEvent, TRequest, TReply>;

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
export interface ThreadInboxMessage<
  TEvent = TriggerEvent,
  TRequest = unknown,
  TReply = unknown,
> extends InboxMessage<ThreadMessage<TEvent, TRequest>> {
  /**
   * Answers a request: sends `data` to the thread that asked. It is a step,
   * and it throws for a message that is not a `"request"`.
   * @param data The reply.
   */
  reply(data: TReply): Promise<void>;
}

/**
 * The thread's inbox: a subscription whose messages can reply.
 */
export interface ThreadInbox<
  TEvent = TriggerEvent,
  TRequest = unknown,
  TReply = unknown,
> extends Omit<
      Subscription<ThreadMessage<TEvent, TRequest>>,
      "next" | "poll" | "close" | typeof Symbol.asyncIterator
    >,
    AsyncIterable<ThreadInboxMessage<TEvent, TRequest, TReply>> {
  next(): Promise<ThreadInboxMessage<TEvent, TRequest, TReply> | null>;
  poll(): Promise<ThreadInboxMessage<TEvent, TRequest, TReply> | null>;

  /**
   * Ends the subscription. See `Subscription.close()`: it only ends the
   * subscription, and a message that arrives afterwards is dropped.
   * @returns The messages that were saved but not read.
   */
  close(): Promise<ThreadInboxMessage<TEvent, TRequest, TReply>[]>;
}

/**
 * The body of an agent. `TEvent` is the events of its `on` triggers and
 * `TOutput` what it returns.
 */
export type AgentBody<
  TEvent = TriggerEvent,
  TOutput = unknown,
  TRequest = unknown,
  TReply = unknown,
  TSandboxes extends SandboxToolNames = SandboxToolNames,
> = (
  context: AgentBodyContext<TEvent, TRequest, TReply, TSandboxes>,
) => Promise<TOutput>;

export interface AgentFunction<
  TInput = Record<string, unknown>,
  TOutput = unknown,
  TRequest = unknown,
  TReply = unknown,
> {
  /**
   * Types only: what `agent.invoke(thisAgent, input)` takes and returns. The
   * input is the data of the agent's `invoke()` trigger; the output is what
   * its body returns.
   */
  readonly "~types"?: { input: TInput; output: TOutput };

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
  thread(key: string, session?: string): ThreadHandle<TRequest, TReply>;

  /**
   * The agent's threads.
   */
  threads: ThreadList;
}

/**
 * The messages whose drop was already logged, so a replay does not log it
 * again.
 */
const warned = new Set<string>();

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
  problemOf: (raw: RawEvent, started: boolean) => Promise<string | undefined>,
  client: Inngest.Any,
  recorder: Pick<ReturnType<typeof threadRecorder>, "waiting" | "running">,
  log: { warn: (message: string) => void },
  runId: string,
  replySchema?: ThreadRequests["reply"],
): {
  inbox: ThreadInbox;
} {
  // The event each message was made from, to put it back as it came.
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
      name: message.name,
      data,
      async reply(answer) {
        if (data.kind !== "request" || !data.replyTo) {
          throw new Error(
            "This message is not a request: only a request has a reply.",
          );
        }

        const checked = replySchema
          ? await parseWithAsync(replySchema, answer, "message.reply() data")
          : answer;

        await step.run(`reply:${message.seq}`, async () => {
          await client.sendSignal({
            signal: data.replyTo,
            data: checked,
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
        name: message.name,
        data: { name: message.name, data: message.data },
      }
    );
  }

  let delivered = 0;

  // An event that breaks its trigger's schema never starts a run in core, so
  // it does not reach a live one either: it is dropped. The event that started
  // the run was checked by core, except for the payload of a request, which
  // core does not see.
  async function skipped(raw: InboxMessage<RawEvent>) {
    const problem = await problemOf(raw.data, raw.seq < 1);
    if (!problem) {
      return false;
    }

    warnOnce(raw, problem);

    return true;
  }

  // The drop is decided again when the run replays, and the handler's logger
  // is quiet while a run replays, so the warning goes to the client's own
  // logger once per message and process.
  function warnOnce(raw: InboxMessage<RawEvent>, problem: string) {
    const id = `${runId}:${raw.data.id ?? raw.seq}`;
    if (warned.has(id)) {
      return;
    }

    // Forget the oldest drop once there are many, so the set stays small.
    if (warned.size >= 1000) {
      warned.delete(warned.values().next().value as string);
    }

    warned.add(id);
    log.warn(
      `Dropped ${raw.data.name} from the inbox: it breaks its schema (${problem}).`,
    );
  }

  async function next() {
    if (delivered > 0) {
      await recorder.waiting();
    }

    for (;;) {
      const raw = await inbox.next();
      if (!raw) {
        return null;
      }

      if (await skipped(raw)) {
        continue;
      }

      const message = unwrap(raw) as ThreadInboxMessage;

      delivered += 1;

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
    inbox: {
      next,
      async poll() {
        for (;;) {
          const raw = await inbox.poll();
          if (!raw) {
            return null;
          }

          if (!(await skipped(raw))) {
            return unwrap(raw);
          }
        }
      },
      putBack(messages) {
        inbox.putBack(messages.map(rawOf));
      },
      async close() {
        const unread = await inbox.close();
        const kept: ThreadInboxMessage[] = [];

        for (const message of unread) {
          if (!(await skipped(message))) {
            kept.push(unwrap(message) as ThreadInboxMessage);
          }
        }

        return kept;
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
    async ({ event, step }) => {
      const { runId, thread, sandbox } = event.data as {
        runId: string;
        thread?: string;
        sandbox?: ThreadSandboxCleanup;
      };

      // A sandbox the run created and did not close: save it for the
      // thread's next run and destroy it.
      if (sandbox && thread) {
        await cleanupThreadSandbox({
          client: client as unknown as Parameters<
            typeof cleanupThreadSandbox
          >[0]["client"],
          ref,
          thread,
          runId,
          scope: store.scope("thread", thread),
          sandbox,
          run: (id, fn) => {
            return step.run(id, fn) as ReturnType<typeof fn>;
          },
        });

        return;
      }

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
          return trigger.fnTrigger;
        }),
      ],
      singleton: { key: threadExpression, mode: "skip" },
    },
    async ({ event, step, defer, runId, logger }) => {
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
        requests: config.requests,
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
            // An invoked agent is told its limits in the event's own data.
            (
              (found?.event === internalEvents.FunctionInvoked
                ? event.data
                : data) as Record<string, unknown>
            )._agent,
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
            ...triggers
              .filter((trigger) => {
                return trigger.listen;
              })
              .map((trigger) => {
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
            name: event.name,
            data: { id: event.id, name: event.name, data: event.data },
          },
        ]);

        const bindings = await resolveSandboxes(config.sandboxes, {
          event: event as unknown as AgentConfigContext["event"],
        });
        const opened =
          Object.keys(bindings).length > 0
            ? openSandboxes(
                bindings,
                stepSandboxes(step),
                {
                  event: event as unknown as AgentConfigContext["event"],
                  client: client as unknown as SkillsRuntime["client"],
                  agent: ref,
                  run: (id, fn) => {
                    return step.run(id, fn) as ReturnType<typeof fn>;
                  },
                  sendEvent: (id, payload) => {
                    return step.sendEvent(id, payload);
                  },
                },
                threadSandboxOwner({
                  client: client as unknown as SkillsRuntime["client"],
                  ref,
                  thread: data.thread,
                  runId,
                  scope: store.thread,
                  warn: (data, message) => {
                    logger.warn(data, message);
                  },
                  run: (id, fn) => {
                    return step.run(id, fn) as ReturnType<typeof fn>;
                  },
                  defer: (id, sandbox) => {
                    return defer(id, {
                      function: cleanup,
                      data: { runId, thread: data.thread, sandbox },
                    });
                  },
                }),
              )
            : {};

        const configContext = {
          event: event as unknown as AgentConfigContext["event"],
        };
        const channels = await resolveConfigValue(
          config.channels ?? {},
          configContext,
        );
        const report = createReporter(
          channels,
          config.report === undefined
            ? undefined
            : await resolveConfigValue(config.report, configContext),
          (id, run) => {
            return step.run(id, run);
          },
        );

        let stopRequested = false;
        const { inbox } = threadInbox(
          subscription,
          function toMessage(raw) {
            const trigger = triggers.find((t) => {
              return t.event === raw.name;
            });

            return trigger
              ? messageOf(ref, trigger, raw as unknown as ThreadTriggerEvent)
              : (raw.data as ThreadMessage);
          },
          async function problemOf(raw, started) {
            // A request's payload is checked against `requests`, which core
            // does not know. The asker gets no reply, so it times out: the
            // same as for any event that breaks its schema.
            if (raw.name === agentMessageEvent) {
              const data = raw.data as ThreadMessage;

              return data.kind === "request" && config.requests
                ? dataProblem(config.requests.request, data.payload)
                : undefined;
            }

            if (started) {
              return undefined;
            }

            return schemaProblem(
              triggers.filter((t) => {
                return t.event === raw.name;
              }),
              raw,
            );
          },
          client,
          recorder,
          client[internalLoggerSymbol],
          runId,
          config.requests?.reply,
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
              } else if (kind === "stop") {
                stopRequested = true;
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
        // a failed eager start nothing used never replaces the body's own error.
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
            channels,
            report,
            inbox,
            control,
          });

          // The last thread work is done: end the subscription before the
          // sandboxes close. A second close, from the scope exit, does nothing.
          await inbox.close();
        } catch (error) {
          await closeAll();

          throw error;
        }

        const rejected = await closeAll();

        // The body succeeded, so an eager sandbox nothing used that failed to
        // create is a warning, not a failed run.
        if (rejected) {
          logger.warn(
            `An unused eager sandbox failed to create: ${
              rejected.reason instanceof Error
                ? rejected.reason.message
                : String(rejected.reason)
            }`,
          );
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
      return getThread(client, ref, key, {
        session,
        kv: config.kv,
        requests: config.requests,
      });
    },
    threads: {
      list(options) {
        return listThreads(client, ref, options, (key, session) => {
          return getThread(client, ref, key, {
            session,
            kv: config.kv,
            requests: config.requests,
          });
        });
      },
    },
  };
}
