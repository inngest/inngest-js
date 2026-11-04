/**
 * @module
 * EXPERIMENTAL: the agent function, an Inngest function whose body owns its
 * loop and reads a durable inbox. It adds what a plain function lacks for a
 * conversation that spans runs:
 *
 * - a singleton per thread, so there is never more than one live run per thread;
 * - `inbox`, a `step.subscribe()` inbox of the thread's messages, whose first message
 *   is the event that started the run;
 * - `loop`, the model-and-tools loop wired to the thread's inbox and budget, so
 *   a running turn takes the messages that arrive meanwhile.
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
import type { SourceLocation } from "../../../components/sandbox/callSite.ts";
import {
  hostOfSharedTool,
  isSharedTool,
  type SandboxTool,
  type SandboxTools,
} from "../../../components/sandbox/tools.ts";
import { addEventIs } from "../../../components/triggers/triggers.ts";
import { internalEvents } from "../../../helpers/consts.ts";
import type { Logger } from "../../../middleware/logger.ts";
import { compileKey, toAsync } from "../cel.ts";
import { cardToolsOf } from "../discovery/cardTools.ts";
import { cardOf, validateDiscoveryList } from "../discovery/discovery.ts";
import { sharedToolsFor } from "../discovery/sharedTools.ts";
import { answerQuestion } from "../inbox/answer.ts";
import { createBodyInboxTools } from "../inbox/bodyInboxTools.ts";
import { agentGroupJoined, agentMessage } from "../inbox/events.ts";
import { QuestionBook } from "../inbox/questionBook.ts";
import {
  codeReportTool,
  flushOwes,
  handleAddressKey,
  isReportMessage,
  owesRecord,
  type ReportBook,
  reportSenderProblem,
  reportsOf,
  reportTool,
  sendReport,
} from "../inbox/reports.ts";
import { senderFrom } from "../inbox/sender.ts";
import {
  eventNameOf,
  inboxFilter,
  inflightOf,
  isOwnEvent,
  missingThreadFilter,
  ownEvents,
  ownInboxFilter,
  ownTriggerFilter,
  quote,
  type RawEvent,
  resentAs,
  threadInbox,
} from "../inbox/threadInbox.ts";
import type { Json } from "../json.ts";
import { kv, usesLedger } from "../kv/kv.ts";
import {
  type AgentHandlerLoop,
  type AgentLoop,
  type AgentLoopOptions,
  type AgentModel,
  addTools,
  buildHandlerLoop,
  isAgentModel,
} from "../loop/loop.ts";
import { createAgentScore } from "../loop/scores.ts";
import {
  agentSandbox,
  type LentMachine,
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
  collectSkills,
  createSkillTools,
  type Skill,
  type SkillSources,
  skillsPrompt,
} from "../skills/skills.ts";
import { closeThreadCopies } from "../threads/ledgerClient.ts";
import {
  agentFinishedEvent,
  agentMessageEvent,
  agentQuestionEvent,
  agentRecoverEvent,
  type ThreadRecord,
  threadHandle,
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
import { agentToolsFor, codeAgentTools, waitTool } from "./agentTools.ts";
import { createCleanupFunction, createFinishedFunction } from "./auxiliary.ts";
import { childWait, openChildren, settleChild } from "./children.ts";
import { nextCount } from "./executionCounter.ts";
import {
  messageGrantProblem,
  noteRenewal,
  proofOf,
  registerGrant,
  renewalOfExecution,
  renewedUntil,
  startGrantOf,
} from "./grant.ts";
import {
  lendIsOpen,
  lendOf,
  lentEndedNote,
  lentToolNames,
  parentEndedCancel,
} from "./lending.ts";
import {
  type AgentBudget,
  budgetReason,
  narrowInherited,
  narrowLimits,
  registerLimits,
} from "./limits.ts";
import { createLoopWiring } from "./loopWiring.ts";
import { functionOptions } from "./options.ts";
import { finishedOf, turnInFlight } from "./recovery.ts";
import { groupOf, taggedKeyAddress } from "./relations.ts";
import {
  createRunFields,
  idleMs,
  type RunField,
  type RunFieldContext,
  type RunFields,
  resolveRunField,
} from "./runField.ts";
import { senderOf } from "./sender.ts";
import { startData, startInflight, triggerOf } from "./startEvent.ts";
import { invokeDepthOf, startThread } from "./startThread.ts";
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
 * The handler of an agent with a `model` and no handler of its own: each batch
 * goes to the model through the loop, and the final answer is the run's
 * output.
 */
const defaultModelBody: AgentBody<{ model: AgentModel }> = async ({
  inbox,
  loop,
}) => {
  let answer: unknown;

  for await (const batch of inbox.batches()) {
    const result = await loop(batch);

    answer = result.text;
  }

  // A run opened through a handle waits for the children it started, up to a
  // bound. When the bound is reached with some still running, the model gets
  // one last turn that names them, and its answer is the run's output.
  const execution = getAsyncCtxSync()?.execution;
  const running = execution ? openChildren(execution.instance) : [];

  if (execution?.agentBridge?.handleOpened && running.length > 0) {
    const result = await loop(
      `These agents are still running, so their results are not in yet: ${running.join(", ")}. Answer with what you have and say which agents are still running.`,
    );

    answer = result.text;
  }

  return answer;
};

/**
 * The loop of one run, made from the agent's definition: its `model`, `system`
 * and `tools` (read once, at the start of the run) and the options of its
 * `loop` field. A `loop` field that is a whole loop replaces it.
 */
const createHandlerLoop = async (options: {
  client: Inngest.Any;
  logger: Logger;
  config: AgentFunctionConfig;
  fields: RunFields<RunFieldContext>;
  listenTools: Record<string, unknown>;
  skills: readonly Skill[];

  /**
   * The names of tools a parent lent this thread that are over, so the model
   * is told not to call them.
   */
  lentEnded?: string[];
}): Promise<AgentHandlerLoop> => {
  const { client, logger, config, fields, listenTools, skills, lentEnded } =
    options;

  if (typeof config.loop === "function") {
    const swapped = config.loop as AgentLoop;

    return Object.assign(swapped, {
      with() {
        throw new Error(
          "`loop.with()` is not available when the agent's `loop` is a whole loop of its own",
        );
      },
    }) as unknown as AgentHandlerLoop;
  }

  const written = await fields.get(
    "system",
    config.system as RunField<string | undefined>,
  );
  const system =
    skills.length > 0 || lentEnded
      ? [
          written,
          skills.length > 0 ? skillsPrompt(skills) : undefined,
          lentEnded ? lentEndedNote(lentEnded) : undefined,
        ]
          .filter(Boolean)
          .join("\n\n")
      : written;
  const tools = await fields.get(
    "tools",
    config.tools as RunField<SandboxTools | undefined>,
  );

  // A function that is not marked as a model is a function of the run's start.
  // A model function someone forgot to mark gets called with `{ event, thread }`
  // instead of a request: say so, rather than fail inside it.
  const unmarked = `Agent "${config.id}": its \`model\` is a function not marked as a model, so it was called with \`{ event, thread }\` and didn't return a model. Wrap a model function in \`agentModel()\`, or return a model from the function`;
  let model: AgentModel | undefined;

  if (config.model && isAgentModel(config.model)) {
    model = config.model;
  } else if (config.model) {
    let made: unknown;

    try {
      made = await fields.get("model", config.model as RunField<unknown>);
    } catch (error) {
      throw new Error(unmarked, { cause: error });
    }

    if (made !== undefined && typeof made !== "function") {
      throw new Error(unmarked);
    }

    model = made as AgentModel | undefined;
  }

  if (!model) {
    return (() => {
      throw new Error(
        `Agent "${config.id}" has no \`model\`, so it has no loop: set \`model\` in its definition`,
      );
    }) as unknown as AgentHandlerLoop;
  }

  const own = {
    ...agentToolsFor(config.discovery),
    ...listenTools,
    ...(skills.length > 0 && createSkillTools(skills)),
    // Ends the turn on purpose. A tool of the agent's own named `wait` wins.
    ...(!(tools && Object.hasOwn(tools, "wait")) && { wait: waitTool }),
  } as SandboxTools;
  // Shared tools the definition lists are called through their hosted
  // function; the others `discovery.tools` allows are added beside them.
  const listed = new Set(
    Object.values(tools ?? {}).flatMap((entry) => {
      const host = isSharedTool(entry) ? hostOfSharedTool(entry) : undefined;

      return isSharedTool(entry) && host ? [`${host}/${entry.id}`] : [];
    }),
  );
  const shared = await sharedToolsFor(client, config.discovery, {
    taken: new Set([...Object.keys(own), ...Object.keys(tools ?? {})]),
    listed,
    logger,
  });

  return buildHandlerLoop({
    // `format` and `steer` are typed with the agent's own messages on the
    // definition; the loop hands them those same messages, with `is()`.
    ...(config.loop as Omit<AgentLoopOptions, "model">),
    model,
    ...(system !== undefined && { system }),
    tools: addTools(addTools(own, shared), tools),
  }) as unknown as AgentHandlerLoop;
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
   * Your handler. Read `inbox` and call `loop`. Without one, an agent with a
   * `model` runs each batch through the loop and its final answer is the run's
   * output; an agent without a `model` ends with output `undefined`.
   */
  bodyOrDefault?: AgentBody<{ model: AgentModel }>,

  /**
   * Where the agent was defined.
   */
  source?: SourceLocation,
): AgentFunction {
  // Skills given as a value are known now: a clash is an error here, and
  // the card lists them.
  const definedSkills =
    typeof config.skills === "function" || config.skills === undefined
      ? []
      : collectSkills(config.skills);
  if (config.discovery) {
    validateDiscoveryList(config.id, "agents", config.discovery.agents);
    validateDiscoveryList(config.id, "tools", config.discovery.tools);
  }

  // A source written as just an event is placed by the agent's `thread`.
  const inboxSources = (config.inbox ?? []).map((source): InboxSource => {
    if (typeof source !== "string" && "event" in source) {
      return source as InboxSource;
    }

    if (!config.thread) {
      throw new Error(
        `Agent "${config.id}" has an inbox source (${eventNameOf(source)}) with no \`thread\` or \`if\` of its own and no agent-level \`thread\` to place it: set \`thread\` on the agent or on the source`,
      );
    }

    return { event: source, thread: config.thread };
  });
  const body: AgentBody<{ model: AgentModel }> =
    bodyOrDefault ?? (config.model ? defaultModelBody : async () => undefined);
  const ref = `${client.id}/${config.id}`;
  const triggers = compileTriggers(config.id, config);
  const threadExpression = singletonKey(triggers);

  // The KV is a configured store, else the ledger. The ledger keeps its own
  // steps and cannot be written inside a step's callback, so a run on it does
  // its thread bookkeeping between steps.
  const store = kv;
  const onLedger = () => {
    return usesLedger(client.id);
  };

  const cleanup = createCleanupFunction(client, config, ref, store, onLedger);
  const finished = createFinishedFunction(
    client,
    config,
    ref,
    store,
    triggers,
    onLedger,
  );

  const fn = client.createFunction(
    {
      ...functionOptions(config),
      id: config.id,

      // A child started attached ends with its parent's run.
      cancelOn: [...(config.cancelOn ?? []), parentEndedCancel],

      // An agent's reads wake it as soon as a message lands, and a reader left
      // waiting beside its work never holds the run back.
      optimizeParallelism: false,
      ...(quietOptimizeParallelism as object),
      triggers: [
        ...ownEvents.map((name) => {
          // A `quiet` message is for a live run only: it never starts one.
          return {
            event: name,
            if: ownTriggerFilter(name, ref),
          };
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

      // A message names its thread, and the thread's key can carry tags that
      // prove relations (parent, child, peer). A key a start made for another
      // agent is not this agent's thread: running under it would borrow its
      // reach.
      if (!found) {
        const owner = taggedKeyAddress(data.thread);

        if (owner !== undefined && owner !== ref) {
          throw new NonRetriableError(
            `The thread ${data.thread} belongs to ${owner}, not to ${ref}`,
          );
        }
      }
      // Read by `agent.loop()` once the body's inbox exists.
      const questions = new QuestionBook();
      const bridge: AgentBridge = {
        questions,
        codeTools: codeAgentTools(config.discovery),
      };

      // Run-scoped KV keys end with the run, whichever way it ends, and the
      // thread is marked idle.
      defer("kv-cleanup", {
        function: cleanup,
        data: { runId, thread: data.thread },
      });

      const thread = threadHandle(client, ref, data.thread);

      // The KV scopes of the thread and session come from the trigger, which
      // for an event of `triggers` does not carry them: the whole run reads them
      // from here.
      async function main() {
        // Opened before anything else the run does, the thread start included
        // (on the ledger that is a subscription, a read and a write, which can
        // take a second or more). A message that arrives before this op matches
        // no inbox, and the thread's singleton skips it as a trigger, so it is
        // lost: the gap is kept to the run's first request. Everything the
        // sources need is known from the trigger. The open is awaited here so
        // the thread start does not share a request with it.
        // Closed when the run's work is done, whichever way it ends. That only
        // ends the inbox.
        await using subscription = step.subscribe("inbox", [
          ...ownEvents.map((name) => {
            return {
              event: name,
              if: ownInboxFilter(name, ref, data.thread),
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
          // A thread in a group hears of each new member. It is an inbox
          // source of its own: the event never starts a run.
          ...(groupOf(data.thread) === undefined
            ? []
            : [
                {
                  event: agentGroupJoined.name,
                  if: `async.data.group == ${quote(groupOf(data.thread) as string)} && async.data.thread != ${quote(data.thread)}`,
                },
              ]),
          ...inboxSources.flatMap((source) => {
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

        // Writes what `thread.state()` shows. One step per change.
        const recorder = threadRecorder(store, ref, runId, onLedger());

        // The grant a start carries, checked: a start that claims a starter
        // but has no valid grant fails for good, so limits, report routes and
        // lends only come from a signed grant. What a sub-agent inherited is
        // kept on its thread, so a later run that a plain message starts has
        // the same limits.
        const startGrant = startGrantOf(client, event, data.thread);
        const passed = startGrant?.limits;
        // The thread's budget as this agent defines it, read before the start
        // so the first run can keep it on the thread.
        const ownBudget =
          config.budget === undefined
            ? undefined
            : await resolveRunField(config.budget as RunField<AgentBudget>, {
                event: event as unknown as AgentBodyContext["event"],
                thread: { key: data.thread },
              });
        // What the start event lends, with its signature checked before the
        // thread records anything. Whether the thread may use it is decided
        // once the record is written.
        const claim = lendOf(client, event, data.thread, startGrant);
        const startWith = async (inStep?: string) => {
          return {
            started: await recorder.running(
              passed,
              startInflight(found, event) ?? null,
              inStep,
              ownBudget,
              undefined,
              claim && {
                parentRun: claim.parentRun,
                tools: lentToolNames(claim.machines),
              },
            ),
            previousRun: (await readLastRun(store, ref, inStep)) ?? null,
          };
        };

        // How the run before this one ended is a key of its own, read apart
        // from the record. Both are KV calls inside one step, so the start
        // costs one step; the write is safe to repeat if the step is retried.
        // The ledger cannot be written inside a step, so a run on it makes the
        // same two KV calls between steps, and reads the ledger once, here.
        const begun = onLedger()
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

        if (onLedger() && data.fresh) {
          traceWarning(
            logger,
            "thread.fresh",
            `${event.name} has nothing at its thread path${found ? ` (${found.thread.source})` : ""}, so it started a thread of its own.`,
          );
        }

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

        if (startGrant) {
          registerGrant(instance, startGrant);
        }

        const limits = registerLimits(
          instance,
          // The thread's kept limits.
          narrowLimits(
            config.limits,
            narrowInherited(started.inherited, passed),
            {
              appId: client.id,
              ...(config.discovery && {
                agents: config.discovery.agents,
                tools: config.discovery.tools,
              }),
            },
          ),
          { ...started.usage },
          started.budget,
        );

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

        for (const source of inboxSources) {
          noteSource(source);
        }

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
        // `{ agent, thread, content }` reads that as the `agent/message` it is.
        const invokedAsMessage =
          !found && (event.name as string) === internalEvents.FunctionInvoked;
        const { from: _told, ...invokedData } = (event.data ?? {}) as Record<
          string,
          unknown
        >;

        // The event that started the run is the inbox's first message, made
        // from the run's own state: it costs no step. The inbox can receive it
        // too, when it was sent just before the inbox opened: it is read once.
        // What the SDK told an invoked agent in `from` is not the caller's
        // input, except for an `agent/message`, whose `from` is its sender.
        const told =
          (event.name as string) === internalEvents.FunctionInvoked &&
          "from" in ((event.data ?? {}) as object);
        const startMessage = addEventIs({
          id: event.id ?? "",
          name: invokedAsMessage ? agentMessageEvent : event.name,
          data: invokedAsMessage ? event.data : told ? invokedData : event.data,
          ts: event.ts ?? 0,
          user: {},
        }) as unknown as UntypedInboxMessage;

        // The event the handler gets is that message: exactly the event sent,
        // or, for a run that recovery resumed, the event of the run that failed.
        const runEvent = resentAs(startMessage);

        // A `start()` of an agent with an `invoke()` trigger sends its input as
        // a message, so core did not check it against the trigger's schema: the
        // child does, here, for every caller. A bad input fails the run for
        // good, so `result()` throws it and recovery never resends it.
        if (
          !found &&
          (runEvent.name as string) === internalEvents.FunctionInvoked
        ) {
          const problem = await schemaProblem(
            triggers.filter((trigger) => {
              return trigger.event === internalEvents.FunctionInvoked;
            }),
            runEvent,
          );

          if (problem) {
            throw new NonRetriableError(
              `The input breaks the schema of ${ref}: ${problem}`,
            );
          }
        }

        // The run's time-varying fields are read once, here, at its start.
        const fields = createRunFields({
          event: runEvent as unknown as AgentBodyContext["event"],
          thread: { key: data.thread },
        });

        // The run's skills: shown to the model, and their files placed in the
        // first sandbox it can use.
        const runSkills = collectSkills(
          (await fields.get(
            "skills",
            (config.skills ?? []) as RunField<SkillSources>,
          )) ?? [],
        );

        // A lend is signed for its parent run and this thread, and has no
        // clock: it lasts as long as the parent's run, whose end cancels this
        // one. The thread's record decides whether this run may use it (the
        // first run of the start message, or a recovery's resend); any other
        // message gets none, and its model is told the lent tools are gone.
        const lent =
          claim && lendIsOpen(claim, started.lent, runId)
            ? claim.machines
            : undefined;
        const lentEnded =
          !lent && started.lent ? started.lent.tools : undefined;

        const { opened, closeAll, toolsOnly } = await openRunSandboxes({
          skills: runSkills,
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
          lent,
        });

        const agentScore = createAgentScore(client);

        bridge.score = agentScore.score;

        // A run opened through a handle (`start()`, `message()`, `ask()`, or a
        // model's agent tools) has a sender, and ends once it has answered and
        // nothing is unread, unless the agent sets `idle`: then, like a run a
        // trigger started, it waits `idle` for more, keeping its sandboxes.
        // The start message is checked as well as the run's event: a typed
        // start (an `invoke()` trigger) is handed to the handler as the typed
        // input, which has no sender, but the message that carried it did.
        const openedByHandle = [runEvent, startMessage].some((candidate) => {
          return (
            (candidate.name === agentMessageEvent ||
              candidate.name === agentQuestionEvent) &&
            (candidate.data as { from?: unknown } | undefined)?.from !==
              undefined
          );
        });
        const idle =
          openedByHandle && config.idle === undefined
            ? 0
            : await idleMs(fields, config.idle);

        bridge.handleOpened = openedByHandle;

        // The starter keeps what each child it started owes in its own thread
        // state: a report that comes is noted, and a child's `agent/finished`
        // is given the `missing` that follows from the two. Nothing the
        // sender wrote in `missing` is believed.
        const owes = owesRecord(kv.thread, ref);
        const owesChecked = new WeakSet<object>();
        const noteOwed = async (raw: UntypedInboxMessage) => {
          const as = resentAs(raw);

          try {
            // What a child owes, noted while sandbox code started it.
            await flushOwes(instance, owes);

            if (isReportMessage(as)) {
              const child = (as as { from?: { key?: unknown } }).from?.key;

              if (typeof child === "string") {
                await owes.received(child, as.name);
              }

              return;
            }

            if (as.name === agentFinishedEvent && !owesChecked.has(raw)) {
              owesChecked.add(raw);

              const data = as.data as {
                from?: { key?: unknown };
                missing?: string[];
              };
              const missing =
                typeof data.from?.key === "string"
                  ? await owes.missing(data.from.key)
                  : undefined;

              if (missing === undefined) {
                delete data.missing;
              } else {
                data.missing = missing;
              }
            }
          } catch (error) {
            logger.warn(
              { error: error instanceof Error ? error.message : String(error) },
              "could not read or write what a started child owes",
            );
          }
        };

        const { inbox, view } = threadInbox(
          {
            inbox: subscription as unknown as Inbox<UntypedInboxMessage>,
          },
          async function problemOf(raw, started) {
            // A report is taken only from a thread this thread started: the
            // `from` of an event is whatever its sender wrote, and the key's
            // tag is what proves it. Anything else is dropped.
            const presented = resentAs(raw as UntypedInboxMessage);
            const senderProblem = reportSenderProblem(
              client,
              data.thread,
              presented,
            );

            if (senderProblem) {
              return senderProblem;
            }

            // A message that relies on its sender's grant carries a proof
            // made for this very message; a message from the thread that
            // started this one may renew this run's grant.
            if (
              !started &&
              (presented.name === agentMessageEvent ||
                presented.name === agentQuestionEvent)
            ) {
              const grantProblem = messageGrantProblem(
                client,
                presented,
                data.thread,
              );

              if (grantProblem) {
                return grantProblem;
              }

              const renew = (
                presented.data as {
                  from?: { key?: unknown };
                  "::agents"?: { renew?: unknown };
                }
              )?.["::agents"]?.renew;

              if (renew && startGrant) {
                const until = renewedUntil(
                  client,
                  startGrant,
                  renew,
                  (presented.data as { from?: { key?: unknown } }).from?.key,
                );

                if (until !== undefined) {
                  noteRenewal(
                    instance,
                    renew as { until: number; sig: string },
                  );
                }
              }
            }

            await noteOwed(raw as UntypedInboxMessage);

            if (isOwnEvent(raw.name)) {
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
          {
            open: () => {
              return openChildren(instance);
            },
            settle: (key) => {
              settleChild(instance, key);
            },
            wait: () => {
              return childWait.ms;
            },
          },
          (from) => {
            return senderFrom(client, from);
          },
          (question, given) => {
            // Marked first: a question that code answered costs the model no
            // turn, and the model cannot answer it again.
            questions.markReplied(question.data.id);

            return answerQuestion(client, question, given);
          },
          (data) => {
            questions.receive(data);
          },
          // Only the default body reads in the background: a handler of the
          // agent's own does exactly what it says with the inbox.
          bodyOrDefault === undefined && config.model
            ? {
                sleep: (id, ms) => {
                  return step.sleep(id, ms);
                },
              }
            : undefined,
        );

        // What the run owes: the reports its start event carries, and which of
        // them it has sent.
        const reportSpec = reportsOf(
          { name: event.name, data: event.data },
          startGrant,
        );
        const reportBook: ReportBook | undefined = reportSpec && {
          spec: reportSpec,
          sent: new Set(),
          ...(startGrant && {
            proof: (id: string, target: string) => {
              return proofOf(
                client,
                startGrant,
                id,
                target,
                renewalOfExecution(instance),
              );
            },
          }),
        };

        bridge.reports = reportBook;

        // Code in a `runCode` can send the run's reports too.
        if (reportBook) {
          bridge.codeTools = {
            ...bridge.codeTools,
            report: codeReportTool(reportBook) as unknown as SandboxTool,
          };
        }

        // The loop reads this when it runs, inside the agent, whichever way
        // the app made it.
        bridge.wiring = createLoopWiring({
          reports: reportBook,
          config,
          inbox,
          view,
          named,
          limits,
          recorder,
          threadKey: thread.key,
          questions,
          ...(startMessage.id && { triggerId: startMessage.id }),
          // History is remembered unless `remember` is off.
          remember:
            (await fields.get(
              "remember",
              config.remember as RunField<boolean | undefined>,
            )) !== false,
          agent: ref,
          recordInStep: !onLedger(),
        });

        const listenTools = createBodyInboxTools({
          config,
          view,
          named,
          noteSource,
          step,
          thread: data.thread,
        });

        const handlerLoop = await createHandlerLoop({
          client,
          logger,
          config,
          fields,
          skills: runSkills,
          lentEnded,
          listenTools: {
            ...sandboxTools(opened),
            ...listenTools,
            ...(reportBook && { report: reportTool(reportBook) }),
          },
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
            me: {
              key: data.thread,
              ...{ [handleAddressKey]: { agent: ref, thread: data.thread } },
              report: async (
                type: { name: string; schema?: StandardSchemaV1 },
                reported: Record<string, unknown>,
              ) => {
                if (!reportBook) {
                  throw new Error(
                    "This run was not started with reports, so it has none to send.",
                  );
                }

                await sendReport(
                  reportBook,
                  type.name,
                  reported,
                  async (value) => {
                    const checked =
                      await type.schema?.["~standard"].validate(value);

                    return checked?.issues
                      ?.map((issue) => {
                        return issue.message;
                      })
                      .join("; ");
                  },
                );
              },
              message: async (content: Json) => {
                const execution = getAsyncCtxSync()?.execution;

                if (!execution) {
                  throw new Error("me.message() must be called inside the run");
                }

                await step.sendEvent(
                  `me:${data.thread}:message:${nextCount(execution.instance, "me.message")}`,
                  agentMessage.create(
                    {
                      agent: ref,
                      thread: data.thread,
                      content,
                      from: senderOf(execution),
                    },
                    { meta: { sessions: threadSessions(data.thread) } },
                  ),
                );
              },
            },

            // Slot: sandboxes. The agent's sandboxes and their tools.
            sandboxes: Object.fromEntries(
              Object.entries(opened)
                .filter(([name]) => {
                  // A machine lent for its tools only is not the code's.
                  return !toolsOnly.has(name);
                })
                .map(([name, lazy]) => {
                  return [name, agentSandbox(lazy)];
                }),
            ) as unknown as AgentBodyContext["sandboxes"],

            // Slot: inbox. The thread's messages and how the run before this
            // one ended.
            inbox,
            previousRun,
            get restarts() {
              return recorder.restarts;
            },

            // Slot: score. The run's own scores.
            score: agentScore.score,

            // Slot: loop. The agent's own loop: its model, system and tools,
            // with the model's `inbox_listen` and `inbox_close` among them.
            loop: handlerLoop,
          });

          // The last thread work is done: end the inbox. The thread-state
          // copies stay until the sandboxes have closed, since closing them
          // touches thread state (a second close, from the scope exit, does
          // nothing).
          await flushOwes(instance, owes).catch(() => undefined);
          await inbox.close();

          // A score the handler did not await is still written.
          await agentScore.flush();
        } catch (error) {
          await closeThreadCopies(instance).catch(() => undefined);
          await closeAll();

          throw error;
        }

        const rejected = await closeAll();

        await closeThreadCopies(instance);

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
                agent: { thread: thread.key, ref },
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
      ...(source && { source }),
      tools: cardToolsOf(config),
      skills: definedSkills.map((skill) => {
        return { name: skill.name, description: skill.description };
      }),
    }),
    thread(key) {
      return threadHandle(client, ref, key);
    },
    id: config.id,
    address: ref,
    start(input, options) {
      return startThread(
        {
          client,
          id: config.id,
          address: ref,
          typed: triggers.some((trigger) => {
            return trigger.event === internalEvents.FunctionInvoked;
          }),
          ...(options?.thread !== undefined && { thread: options.thread }),
          ...(options?.group !== undefined && { group: options.group }),
          ...(options?.reports && { reports: options.reports }),
        },
        input,
        options,
      );
    },
  };
}
