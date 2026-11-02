/**
 * @module
 * EXPERIMENTAL: the agent function, an Inngest function whose body owns its
 * loop and reads a durable inbox. It adds what a plain function lacks for a
 * conversation that spans runs:
 *
 * - a singleton per thread, so there is never more than one live run per thread;
 * - `inbox`, a `step.subscribe()` inbox of the thread's messages, whose first message
 *   is the event that started the run;
 * - `control`, which spreads into `agent.loop()` so a running turn takes
 *   steering messages.
 *
 * The inbox closes when the body returns. Messages it saved but the body never
 * read are discarded, and a message that arrives after that, while the thread's
 * singleton is still in effect, is dropped: it neither starts a new run nor
 * reaches the finished one. The gap is small (the time between the body
 * returning and the run ending), and nothing is re-sent at run end.
 */

import type { StandardSchemaV1 } from "@standard-schema/spec";
import { createDefer } from "../../../components/DeferredFunction.ts";
import {
  type AgentBridge,
  getAsyncCtxSync,
  runWithAsyncCtx,
} from "../../../components/execution/als.ts";
import {
  type Inngest,
  internalLoggerSymbol,
} from "../../../components/Inngest.ts";
import { internalQuietOptimizeParallelism } from "../../../components/InngestFunction.ts";
import { step } from "../../../components/InngestStepTools.ts";
import {
  type Inbox,
  inboxOpenedPromise,
  type UntypedInboxMessage,
} from "../../../components/inbox/Inbox.ts";
import { NonRetriableError } from "../../../components/NonRetriableError.ts";
import { addEventIs } from "../../../components/triggers/triggers.ts";
import { internalEvents } from "../../../helpers/consts.ts";
import { compileKey, toAsync } from "../cel.ts";
import { cardOf } from "../discovery/discovery.ts";
import { createBodyInboxTools } from "../inbox/bodyInboxTools.ts";
import { agentMessage } from "../inbox/events.ts";
import {
  eventNameOf,
  inboxFilter,
  inflightOf,
  missingThreadFilter,
  ownEvents,
  quote,
  type RawEvent,
  resentAs,
  threadInbox,
} from "../inbox/threadInbox.ts";
import { kv } from "../kv/kv.ts";
import type {
  AgentContentBlock,
  AgentEvent,
  AgentInput,
  AgentTurn,
} from "../loop/loop.ts";
import { agent, defaultFormat } from "../loop/loop.ts";
import { createAgentScores } from "../loop/scores.ts";
import {
  openSandboxes,
  resolveSandboxes,
  sandboxTools,
  stepSandboxes,
} from "../sandboxes/defs.ts";
import { openRunSandboxes } from "../sandboxes/runSandboxes.ts";
import {
  cleanupThreadSandbox,
  type ThreadSandboxCleanup,
  threadSandboxOwner,
} from "../sandboxes/threadSandboxes.ts";
import {
  agentMessageEvent,
  agentSteerEvent,
  getThread,
  type ThreadRecord,
  threadSessions,
} from "../threads/thread.ts";
import {
  markThreadIdle,
  readLastRun,
  recordEnd,
  runScore,
  threadRecorder,
} from "../threads/threadState.ts";
import {
  compileTriggers,
  dataProblem,
  schemaProblem,
  singletonKey,
} from "../threads/threadTrigger.ts";
import { createCleanupFunction, createFinishedFunction } from "./auxiliary.ts";
import { createControl } from "./control.ts";
import { invokeDepthOf } from "./invoke.ts";
import {
  budgetReason,
  narrowInherited,
  narrowLimits,
  readInheritedLimits,
  registerLimits,
} from "./limits.ts";
import { functionOptions } from "./options.ts";
import { type AgentRecovery, finishedOf, turnInFlight } from "./recovery.ts";
import { createRunFields, idleMs } from "./runField.ts";
import { startData, startInflight, triggerOf } from "./startEvent.ts";
import { traceWarning } from "./traceWarning.ts";
import type {
  AgentBody,
  AgentBodyContext,
  AgentFunction,
  AgentFunctionConfig,
  AgentMessage,
  InboxSource,
  OpenedInbox,
} from "./types.ts";

/**
 * The prompt of a loop call: an input as it is, or a batch of events formatted
 * and joined.
 */
const promptOf = (
  prompt: AgentInput | readonly AgentEvent[],
  format: ((event: AgentEvent) => string | AgentContentBlock[]) | undefined,
): AgentInput => {
  if (
    typeof prompt === "string" ||
    !Array.isArray(prompt) ||
    !prompt.every((item) => {
      return (
        typeof item === "object" &&
        item !== null &&
        typeof (item as unknown as AgentEvent).name === "string"
      );
    })
  ) {
    return prompt as AgentInput;
  }

  return (prompt as unknown as readonly AgentEvent[])
    .map((event) => {
      const formatted = (format ?? defaultFormat)(event);

      return typeof formatted === "string"
        ? formatted
        : JSON.stringify(formatted);
    })
    .join("\n\n");
};

// The SDK's own marker for the option: no deprecation warning for agents.
const quietOptimizeParallelism = { [internalQuietOptimizeParallelism]: true };

/**
 * Defines an agent function. Use `createAgents(client).agent()`.
 */
export function createAgentFunction(
  /**
   * Inngest client.
   */
  client: Inngest.Any,

  /**
   * Function ID and KV store.
   */
  config: AgentFunctionConfig,

  /**
   * Your loop. Read `inbox`, call `agent.loop()` with `control`. Without one
   * the run takes its trigger, posts nothing and ends with output `undefined`.
   */
  body: AgentBody = async () => {
    return undefined;
  },
): AgentFunction {
  const ref = `${client.id}/${config.id}`;
  const triggers = compileTriggers(config.id, config);
  const threadExpression = singletonKey(triggers);

  const store = kv;
  const scoring = config.scores ?? true;

  // A dollar budget with no price would count every call as free and never stop.
  if (config.limits?.budget?.usd !== undefined && !config.limits.price) {
    throw new Error(
      `Agent "${config.id}" sets limits.budget.usd without limits.price: add the price of a model call, or the budget would never be spent.`,
    );
  }

  const cleanup = createCleanupFunction(client, config, ref, store);
  const finished = createFinishedFunction(client, config, ref, store, triggers);

  const fn = client.createFunction(
    {
      ...functionOptions(config),
      id: config.id,

      // An agent's reads wake it as soon as a message lands, and a reader left
      // waiting beside its work never holds the run back.
      optimizeParallelism: false,
      ...(quietOptimizeParallelism as object),
      triggers: [
        ...[agentMessageEvent, agentSteerEvent].map((name) => {
          return { event: name, if: `event.data.agent == ${quote(ref)}` };
        }),
        ...triggers.map((trigger) => {
          return trigger.fnTrigger;
        }),
      ],
      singleton: { key: threadExpression, mode: "skip" },
    },
    async (ctx) => {
      const { event, step, defer, runId, logger } = ctx;
      const { events: _events, ...functionContext } = ctx;

      // The thread a run belongs to comes from its trigger: a message names it,
      // any other trigger event gives it by the expression of its trigger.
      const found = triggers.find((t) => {
        return t.event === event.name;
      });
      const data = startData(ref, found, event);
      // Read by `agent.loop()` once the body's inbox exists.
      const bridge: AgentBridge = {};

      // Run-scoped KV keys end with the run, whichever way it ends.
      defer("kv-cleanup", {
        function: cleanup,
        data: { runId, thread: data.thread },
      });

      const thread = getThread(client, ref, data.thread);

      // The KV scopes of the thread and session come from the trigger, which
      // for an event of `triggers` does not carry them: the whole run reads them
      // from here.
      async function main() {
        // Writes what `thread.state()` shows. One step per change.
        const recorder = threadRecorder(store, runId);

        // What a sub-agent inherited is kept on its thread, so a later run that
        // a plain message starts has the same limits.
        const passed = readInheritedLimits(
          // An invoked agent is told its limits in the event's own data.
          (
            (found?.event === internalEvents.FunctionInvoked
              ? event.data
              : data) as Record<string, unknown>
          )._agent,
        );
        // A run that began with the start as separate KV steps replays them
        // as they were: the KV steps are numbered by how many came before, so
        // folding the start would shift every later one.
        const startedBefore =
          getAsyncCtxSync()?.execution?.stepAnswer?.("kv.update:thread:__state")
            .found === true;
        const startWith = async (inStep?: string) => {
          return {
            started: await recorder.running(
              passed,
              startInflight(found, event) ?? null,
              inStep,
            ),
            previousRun: (await readLastRun(store, inStep)) ?? null,
          };
        };

        // How the run before this one ended is a key of its own, read apart
        // from the record. Both are KV calls inside one step, so the start
        // costs one step; the write is safe to repeat if the step is retried.
        const begun = startedBefore
          ? await startWith()
          : await step.run(
              { id: "thread:start", name: "Thread state" },
              async () => {
                // The warning rides on this step's metadata, so it is written
                // once and costs no step.
                if (data.fresh) {
                  traceWarning(
                    logger,
                    "thread.fresh",
                    `${event.name} has nothing at its thread path${found ? ` (${found.thread.source})` : ""}, so it started a thread of its own.`,
                  );
                }

                return startWith(thread.key);
              },
            );
        const started = begun.started as ThreadRecord;
        const previousRun = begun.previousRun ?? undefined;

        recorder.observe({
          usage: started.usage,
          restarts: started.restarts ?? 0,
        });

        // Limits apply to the agents this run starts and to the loop's budget.
        // The usage is the thread's so far, and each turn adds to it.
        const instance = getAsyncCtxSync()?.execution?.instance;

        if (!instance) {
          throw new Error("An agent must run inside an Inngest function");
        }

        const limits = registerLimits(
          instance,
          // The thread's kept limits, and the dollar budget of this start.
          narrowLimits(
            config.limits,
            narrowInherited(started.inherited, passed),
          ),
          { ...started.usage },
        );

        // A dollar budget handed down by a parent can't carry the parent's
        // price (a function), so an agent without its own would count every
        // call as free and never stop.
        // A budget that is already 0 (a malformed one is read as 0) stops the
        // run before a call, so only a budget with dollars left needs it.
        if ((limits.limits.budget?.usd ?? 0) > 0 && !config.limits?.price) {
          throw new NonRetriableError(
            `Agent "${config.id}" has a dollar budget (limits.budget.usd, set by its own limits or inherited from the agent that started it) but no limits.price: give it a limits.price.`,
          );
        }

        // What each inbox source's events are checked against, by the name of
        // the source's event.
        const sourceSchemas = new Map<string, StandardSchemaV1>();

        // The thread key of each source's events, by the name of the event.
        const sourceKeys = new Map<
          string,
          { source: string; key: (event: unknown) => string | undefined }
        >();

        const noteSource = (source: InboxSource) => {
          const expression = source.thread ?? config.thread;

          if (expression) {
            sourceKeys.set(eventNameOf(source.event), {
              source: expression,
              key: compileKey(expression).key,
            });
          }

          const schema =
            typeof source.event === "object" ? source.event.schema : undefined;

          if (schema) {
            sourceSchemas.set(
              eventNameOf(source.event),
              schema as StandardSchemaV1,
            );
          }
        };

        for (const source of config.inbox ?? []) {
          noteSource(source);
        }

        // Opened first, so the gap in which a message could be missed is the few
        // milliseconds between the run starting and this op.
        // Closed when the run's work is done, whichever way it ends. That only
        // ends the inbox.
        await using subscription = step.subscribe("inbox", [
          ...ownEvents.map((name) => {
            return {
              event: name,
              if: `async.data.agent == ${quote(ref)} && async.data.thread == ${quote(data.thread)}`,
            };
          }),
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
          ...(config.inbox ?? []).flatMap((source) => {
            const missing = missingThreadFilter(source, config.thread);

            return [
              {
                event: eventNameOf(source.event),
                if: inboxFilter(source, data.thread, config.thread),
              },
              ...(missing === undefined
                ? []
                : [{ event: eventNameOf(source.event), if: missing }]),
            ];
          }),
        ]);

        await inboxOpenedPromise(subscription);

        // The inboxes the model opened, by the name it gave them. They end with
        // the run, whichever way it ends, before the thread's own inbox.
        const named = new Map<string, OpenedInbox>();
        await using _named = {
          async [Symbol.asyncDispose]() {
            for (const open of [...named.values()]) {
              if (!open.inbox.closed) {
                await open.inbox.close();
              }
            }
          },
        };

        // A plain agent (no `invoke()` trigger) that `step.invoke` started with
        // `{ agent, thread, text }` reads that as the `agent/message` it is.
        const invokedAsMessage =
          !found && (event.name as string) === internalEvents.FunctionInvoked;
        const { _agent: _told, ...invokedData } = (event.data ?? {}) as Record<
          string,
          unknown
        >;

        // The event that started the run is the inbox's first message, made
        // from the run's own state: it costs no step. The inbox can receive it
        // too, when it was sent just before the inbox opened: it is read once.
        // What the SDK told an invoked agent in `_agent` is not the caller's
        // input.
        const told = "_agent" in ((event.data ?? {}) as object);
        const startMessage = addEventIs({
          id: event.id ?? "",
          name: invokedAsMessage ? agentMessageEvent : event.name,
          data: invokedAsMessage
            ? invokedData
            : told
              ? invokedData
              : event.data,
          ts: event.ts ?? 0,
          user: {},
        }) as unknown as UntypedInboxMessage;

        // The event the handler gets is that message: exactly the event sent,
        // or, for a run that recovery resumed, the event of the run that failed.
        const runEvent = resentAs(startMessage);

        // The run's time-varying fields are read once, here, at its start.
        const fields = createRunFields({
          event: runEvent as unknown as AgentBodyContext["event"],
          thread: { key: data.thread },
        });

        const { opened, closeAll } = await openRunSandboxes({
          config,
          client,
          ref,
          context: fields.context,
          thread: data.thread,
          runId,
          store,
          step,
          logger,
          defer,
          cleanup,
        });

        const agentScores = createAgentScores(client);

        const idle = await idleMs(fields, config.idle);

        const { inbox, view, steering } = threadInbox(
          {
            inbox: subscription as unknown as Inbox<UntypedInboxMessage>,
          },
          async function problemOf(raw, started) {
            if (ownEvents.includes(raw.name)) {
              return undefined;
            }

            // An event of an inbox source with nothing at its thread path
            // reaches no thread.
            const keyed = sourceKeys.get(raw.name);

            if (keyed && keyed.key(raw) === undefined) {
              return `it has nothing at its thread path (${keyed.source}), so it reaches no thread`;
            }

            // An event of an inbox source is checked against its event type.
            const sourceSchema = sourceSchemas.get(raw.name);

            if (sourceSchema) {
              return dataProblem(sourceSchema, raw.data ?? {});
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
          recorder,
          client[internalLoggerSymbol],
          runId,
          startMessage,
          idle,
        );

        const control = createControl({
          config,
          steering,
          named,
          limits,
          scoring,
          recorder,
          threadKey: thread.key,
        });

        // `agent.loop()` steers through the inbox unless it is given
        // its own.
        bridge.control = control;

        const listenTools = createBodyInboxTools({
          config,
          view,
          named,
          noteSource,
          step,
          thread: data.thread,
        });

        let result: unknown;

        try {
          result = await body({
            ...functionContext,
            logger,

            // Slot: event. What started the run, exactly as sent.
            event: runEvent as unknown as AgentBodyContext["event"],
            depth: invokeDepthOf(
              event as unknown as { data?: Record<string, unknown> },
            ),

            // Slot: me. The handle to the run's own thread.
            me: { key: data.thread },

            // Slot: sandboxes. The agent's sandboxes and their tools.
            sandboxes: opened,
            sandboxTools: sandboxTools(opened),

            // Slot: inbox. The thread's messages and how the run before this
            // one ended.
            inbox,
            previousRun,
            get restarts() {
              return recorder.restarts;
            },

            // Slot: score. The agent's own scores.
            scores: agentScores,
            score: (name: string, value: number | boolean) => {
              return agentScores.score(name, value);
            },

            // Slot: loop. `agent.loop()` with the model's inbox tools added.
            loop: (prompt, loopOptions) => {
              return agent.loop({
                ...loopOptions,
                prompt: promptOf(prompt, loopOptions.format),
                tools: { ...listenTools, ...loopOptions.tools },
              });
            },

            // Slot: control. What `agent.loop()` takes: steering, budget,
            // turns. Replaced by `loop` as the loops are rebuilt.
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
      return als?.execution
        ? runWithAsyncCtx(
            {
              ...als,
              execution: {
                ...als.execution,
                ...(found ? { agent: { thread: thread.key } } : {}),
                agentBridge: bridge,
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
    finished,
    ref,
    card: cardOf(client.id, config.id, fn, {
      card: config.card,
      description: config.description,
    }),
    thread(key) {
      return getThread(client, ref, key);
    },
  };
}
