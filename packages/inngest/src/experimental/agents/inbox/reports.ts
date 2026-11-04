/**
 * @module
 * EXPERIMENTAL: typed reports. A report is a message a started agent sends
 * back, defined once with `agentReport(name, schema)` and shared across the
 * repo like an `eventType()`. The starter says what the child owes and to
 * whom with the `reports` start option; the routing travels in the start
 * event, as JSON Schema and thread addresses, so a child found by discovery
 * needs no prior knowledge of the types.
 *
 * A report is delivered to a thread directly, as `agent/report/<name>`, like
 * `agent/message`. The child checks the data against the schema when it
 * sends, and evaluates each destination's `if` itself, so one report goes to
 * every destination whose `if` passes.
 */

import type { StandardSchemaV1 } from "@standard-schema/spec";
import { z } from "zod/v4";
import { getAsyncCtxSync } from "../../../components/execution/als.ts";
import type { Inngest } from "../../../components/Inngest.ts";
import { step } from "../../../components/InngestStepTools.ts";
import { toolErrorOf } from "../../../components/sandbox/toolError.ts";
import {
  type AgentTool,
  toJsonSchema,
  tool,
} from "../../../components/sandbox/tools.ts";
import {
  EventType,
  eventType,
  staticSchema,
} from "../../../components/triggers/triggers.ts";
import { nextCount } from "../agent/executionCounter.ts";
import { grantNames, relationOf } from "../agent/relations.ts";
import { senderOf } from "../agent/sender.ts";
import { compileExpression, MissingPathError } from "../cel.ts";
import { checkAgainstSchema } from "../discovery/inputCheck.ts";
import type { Json, JsonSchema } from "../json.ts";
import { type Kv, typedKey } from "../kv/kv.ts";
import type { SenderData } from "./events.ts";

/**
 * The start of every report event's name.
 */
export const reportEventPrefix = "agent/report/";

/**
 * The name a report travels under. Triggers and inbox subscriptions match an
 * event by its exact name, so every report is sent as this one event, with its
 * type in the data, and the receiver's inbox shows it as `agent/report/<type>`.
 */
export const reportWireEvent = "agent/report";

/**
 * What is wrong with a report's data for the report type it is read as, or
 * `undefined` when it fits (or the type has no schema to check). The check is
 * the type's own Standard Schema, run synchronously: a schema that answers
 * asynchronously cannot vouch for data here, so its data does not fit.
 */
export const reportDataProblem = (
  type: { name: string; schema?: unknown },
  data: unknown,
): string | undefined => {
  const standard = (type.schema as StandardSchemaV1 | undefined)?.["~standard"];

  if (!standard) {
    return undefined;
  }

  let result: ReturnType<typeof standard.validate>;

  try {
    result = standard.validate(data);
  } catch (error) {
    return `${type.name} data could not be checked: ${String(error)}`;
  }

  if (result instanceof Promise) {
    // Settled so a rejection is not unhandled.
    result.catch(() => {});

    return `${type.name} data cannot be checked synchronously, so it is not taken as that report`;
  }

  return result.issues
    ? `${type.name} data breaks its schema: ${result.issues
        .map((issue) => {
          return issue.message;
        })
        .join("; ")}`
    : undefined;
};

/**
 * Why a message is not a report this thread can take, or `undefined` when it
 * is not a report or comes from a thread this one started, or one whose
 * start granted this thread (a signed routing table the report carries). The `from` of an
 * event is whatever its sender wrote; the tag in the sender's thread key is
 * what proves this thread started it.
 * @param client The client, whose signing key checks the tag.
 * @param thread The receiving thread's key.
 * @param message The message, as `resentAs` shows it.
 */
export const reportSenderProblem = (
  client: Inngest.Any,
  thread: string,
  message: { name: string; from?: unknown; grant?: unknown },
): string | undefined => {
  if (!isReportEvent(message.name)) {
    return undefined;
  }

  const key = (message.from as { key?: unknown } | undefined)?.key;

  return typeof key === "string" &&
    (relationOf(client, thread, key)?.relation === "child" ||
      grantNames(
        client,
        key,
        message.grant,
        thread,
        message.name.slice(reportEventPrefix.length),
      ))
    ? undefined
    : "its sender is not a thread this thread started, so it is not a report this thread can take";
};

/**
 * Whether an event is a report.
 */
export const isReportEvent = (name: string): boolean => {
  return name.startsWith(reportEventPrefix);
};

/**
 * The key a thread handle carries its agent's address under, so a report can
 * be routed to it. Present on `agent.thread(key)`, `me`, the handle `start()`
 * returns and `msg.from`.
 */
export const handleAddressKey: unique symbol = Symbol.for(
  "inngest.agents.handleAddress",
);

/**
 * What can receive a report: a thread handle (`me`, `agent.thread(key)`, a
 * started thread, an agent's `msg.from`).
 */
export type ReportTarget = {
  readonly key: string;
  message(content: Json): PromiseLike<unknown>;
};

/**
 * The agent and thread a handle points at, or `undefined` for a handle that
 * is not an agent's thread.
 */
export const addressOfHandle = (
  handle: unknown,
): { agent: string; thread: string } | undefined => {
  const given = handle as {
    key?: unknown;
    address?: unknown;
    [handleAddressKey]?: { agent: string; thread: string };
  } | null;

  if (typeof given !== "object" || given === null) {
    return undefined;
  }

  if (given[handleAddressKey]) {
    return given[handleAddressKey];
  }

  return typeof given.address === "string" && typeof given.key === "string"
    ? { agent: given.address, thread: given.key }
    : undefined;
};

/**
 * Where a report goes: a thread of an agent, and the condition for it.
 */
export type ReportDestination = {
  agent: string;
  thread: string;

  /**
   * A CEL condition over the report, `async.data` being the report's data.
   */
  if?: string;
};

/**
 * What a run was started to owe, by report type, as it travels in the start
 * event: the JSON Schema the child checks the data against, where each
 * report goes, and whether it is owed.
 */
export type ReportSpec = Record<
  string,
  { schema?: JsonSchema; required?: true; to: ReportDestination[] }
>;

/**
 * The key of `data` that holds everything the SDK needs to route a report, so
 * the rest of `data` is the user's own. In a CEL expression it is read as
 * `event.data["::agents"].thread`, since a dot cannot reach it. A report whose
 * data already has the key is refused when it is sent.
 */
export const routingKey = "::agents";

/**
 * The routing of a report event, under `routingKey` in its data.
 */
export type ReportRouting = {
  agent: string;
  thread: string;

  /**
   * The report's type name.
   */
  type: string;
  from?: SenderData;

  /**
   * The routing the starter signed for the sender, so a receiver that did
   * not start the sender can tell it was named.
   */
  grant?: { to: Record<string, ReportDestination[]>; sig: string };
};

/**
 * The data of a report event as it is sent: the report's own data with the
 * routing under `routingKey`. Nothing else is added to the user's data.
 */
export type ReportEnvelope = Record<string, unknown> & {
  "::agents": ReportRouting;
};

/**
 * The routing of a report event, or `undefined` when its data carries none.
 * @param data The event's data.
 */
export const routingOf = (
  data: unknown,
): Partial<ReportRouting> | undefined => {
  const given = (data as Record<string, unknown> | undefined)?.[routingKey];

  return typeof given === "object" && given !== null
    ? (given as Partial<ReportRouting>)
    : undefined;
};

/**
 * The report's own data: the event's data without the routing.
 * @param data The event's data.
 */
export const withoutRouting = (data: unknown): Record<string, unknown> => {
  const { [routingKey]: _routing, ...own } = (data ?? {}) as Record<
    string,
    unknown
  >;

  return own;
};

/**
 * Options of `report.to()`.
 */
export interface ReportToOptions {
  /**
   * A CEL condition over the report, written like the `if` of an inbox
   * source: `async.data` is the report's data. The report goes to this
   * destination only when it is true.
   */
  if?: string;
}

/**
 * EXPERIMENTAL: a report type, made with `agentReport()`, with the routing a
 * starter lists in its `reports` start option.
 */
export class AgentReport<
  TName extends string = string,
  TSchema extends StandardSchemaV1<Record<string, unknown>> = StandardSchemaV1<
    Record<string, unknown>
  >,
> extends EventType<`agent/report/${TName}`, TSchema> {
  /**
   * The report's type name, without the `agent/report/` of its event name.
   */
  readonly type: TName;

  constructor(type: TName, schema: TSchema) {
    super({
      name: `${reportEventPrefix}${type}` as `agent/report/${TName}`,
      schema,
    });
    this.type = type;
  }

  /**
   * Sends this report to the threads given, when `options.if` passes. With no
   * thread it goes to the thread that started the agent.
   * @param args The thread handles (`me`, `agent.thread(key)`), then optionally the options.
   */
  to(
    ...args: (ReportTarget | ReportToOptions)[]
  ): AgentReportRoute<TName, TSchema> {
    const last = args.at(-1);
    const hasOptions =
      last !== undefined &&
      typeof last === "object" &&
      !("key" in last) &&
      !("message" in last);
    const targets = (hasOptions ? args.slice(0, -1) : args) as ReportTarget[];

    return makeRoute(
      this,
      targets,
      hasOptions ? (last as ReportToOptions) : {},
      false,
    );
  }

  /**
   * Marks this report owed: the agent may not finish before it has sent one.
   * It goes to the thread that started the agent.
   */
  required(): AgentReportRoute<TName, TSchema> {
    return makeRoute(this, [], {}, true);
  }
}

/**
 * EXPERIMENTAL: one line of a start's `reports` list: a report type with
 * where it goes and whether it is owed. Made by `report.to()` and
 * `report.required()`.
 */
export interface AgentReportRoute<
  TName extends string = string,
  TSchema extends StandardSchemaV1<Record<string, unknown>> = StandardSchemaV1<
    Record<string, unknown>
  >,
> {
  readonly report: AgentReport<TName, TSchema>;
  readonly targets: readonly ReportTarget[];
  readonly if?: string;
  readonly owed: boolean;

  /**
   * Marks this report type owed.
   */
  required(): AgentReportRoute<TName, TSchema>;
}

const makeRoute = <
  TName extends string,
  TSchema extends StandardSchemaV1<Record<string, unknown>>,
>(
  report: AgentReport<TName, TSchema>,
  targets: readonly ReportTarget[],
  options: ReportToOptions,
  owed: boolean,
): AgentReportRoute<TName, TSchema> => {
  if (options.if !== undefined) {
    toReportCondition(options.if);
  }

  return {
    report,
    targets,
    ...(options.if !== undefined && { if: options.if }),
    owed,
    required() {
      return makeRoute(report, targets, options, true);
    },
  };
};

/**
 * EXPERIMENTAL: defines a typed report a started agent can send back. Its
 * event is `agent/report/<name>`, so `msg.is(report)` narrows a message and
 * `msg.data` is typed by the schema. Define it once and share it, like an
 * `eventType()`.
 *
 * The starter lists the reports the child owes in `start()`'s `reports`
 * option, with `report.to(...)` and `report.required()`.
 * @param name The report's name.
 * @param schema A Standard Schema of its data, such as a zod object.
 * @example
 * ```ts
 * const milestone = agentReport("milestone", z.object({ reached: z.string() }));
 *
 * await em.start({ brief }, { reports: [milestone.to(me), milestone.required()] });
 * ```
 */
export const agentReport = <
  const TName extends string,
  TSchema extends StandardSchemaV1<Record<string, unknown>>,
>(
  name: TName,
  schema: TSchema,
): AgentReport<TName, TSchema> => {
  if (name === "" || name.includes("*")) {
    throw new Error(
      `agentReport("${name}"): a report name is not empty and has no "*".`,
    );
  }

  return new AgentReport(name, schema);
};

/**
 * The `if` of a destination as a check on the report: `async` reads as the
 * report event, as in an inbox source's `if`. Throws for an expression the SDK
 * cannot read.
 */
const toReportCondition = (source: string) => {
  const swapped = source
    .split(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/)
    .map((piece, index) => {
      return index % 2 === 1
        ? piece
        : piece.replace(/(?<![\w.])async(?=\s*\.)/g, "event");
    })
    .join("");

  return compileExpression(swapped);
};

/**
 * Whether a destination's `if` passes for a report's data. A path the data
 * lacks is false.
 */
export const conditionPasses = (
  source: string | undefined,
  name: string,
  data: unknown,
): boolean => {
  if (source === undefined) {
    return true;
  }

  try {
    return toReportCondition(source).evaluate({ name, data }) === true;
  } catch (error) {
    if (error instanceof MissingPathError) {
      return false;
    }

    throw error;
  }
};

/**
 * Makes the `reports` of a start into what travels in the start event. The
 * lines of one report type merge: every destination is kept and the type is
 * owed when any line says so. A line with no thread goes to `starter`.
 * @param routes The `reports` option.
 * @param starter The thread that starts the agent, when it is an agent's.
 */
export const resolveReports = (
  routes: readonly AgentReportRoute[],
  starter: { agent: string; thread: string } | undefined,
): ReportSpec => {
  const spec: ReportSpec = {};

  for (const route of routes) {
    const type = route.report.type;
    let schema: JsonSchema | undefined;

    try {
      schema = toJsonSchema(type, route.report.schema) as JsonSchema;
    } catch {
      // A schema that cannot become JSON Schema is not checked by the child
      // beyond being an object.
      schema = { type: "object" };
    }

    const entry = spec[type] ?? { schema, to: [] };

    spec[type] = entry;
    const where =
      route.targets.length === 0
        ? [starter]
        : route.targets.map((target) => {
            return addressOfHandle(target);
          });

    for (const place of where) {
      if (!place) {
        throw new Error(
          route.targets.length === 0
            ? `The report "${type}" has no thread to go to: it was started by a function that is not an agent, so name a thread with ${type}.to(thread).`
            : `The report "${type}" is sent to a handle that is not an agent's thread. Use \`me\` or \`agent.thread(key)\`.`,
        );
      }

      entry.to.push({
        agent: place.agent,
        thread: place.thread,
        ...(route.if !== undefined && { if: route.if }),
      });
    }

    if (route.owed) {
      entry.required = true;
    }
  }

  return spec;
};

/**
 * The reports a run was started with and which it has sent. The routing is
 * read from the start event; the sent types are the run's own: each report
 * goes out in a step the run runs again on a replay, so the set is rebuilt.
 */
export interface ReportBook {
  readonly spec: ReportSpec;
  readonly sent: Set<string>;

  /**
   * The signature of the routing in `spec`, from the start event.
   */
  readonly grantSig?: string;
}

/**
 * The thread-state key of what an agent's runs on a thread expect of the
 * children they started with `start_agent`. It is the agent's own: two agents
 * may share a thread key. The `__` prefix hides it from `state().keys`.
 * @param agent The agent, as `"appId/functionId"`.
 */
export const owesKey = (agent: string): string => {
  return `__owes:${agent}`;
};

/**
 * What a starter expects of each child it started with owed reports, by the
 * child's thread key: the report types owed, and those that came.
 */
export type Owes = Record<string, { required: string[]; got: string[] }>;

/**
 * What the starter of children with owed reports keeps in its thread state: it
 * set the owed reports and receives them, so when a child's `agent/finished`
 * arrives it knows which never came. It is a plain set of a record the starter
 * alone writes.
 * @param thread The starter's thread state.
 * @param agent The starter, as `"appId/functionId"`.
 */
export const owesRecord = (thread: Kv["thread"], agent: string) => {
  const key = typedKey<Owes>(owesKey(agent));
  const change = async (edit: (owes: Owes) => boolean) => {
    const owes = structuredClone((await thread.get(key)) ?? {}) as Owes;

    if (edit(owes)) {
      await thread.set(key, owes);
    }
  };

  return {
    /**
     * Notes the report types a child just started owes.
     */
    async expect(child: string, required: string[]) {
      if (required.length === 0) {
        return;
      }

      await change((owes) => {
        owes[child] = { required, got: [] };

        return true;
      });
    },

    /**
     * Notes that a report of `type` came from `child`, if the child owes any.
     */
    async received(child: string, type: string) {
      await change((owes) => {
        const entry = owes[child];

        if (!entry || entry.got.includes(type)) {
          return false;
        }

        entry.got.push(type);

        return true;
      });
    },

    /**
     * What `child` owed and never sent, when it ended, or `undefined` when it
     * owed nothing. The child is forgotten.
     */
    async missing(child: string): Promise<string[] | undefined> {
      let missing: string[] | undefined;

      await change((owes) => {
        const entry = owes[child];

        if (!entry) {
          return false;
        }

        missing = entry.required.filter((type) => {
          return !entry.got.includes(type);
        });
        delete owes[child];

        return true;
      });

      return missing;
    },
  };
};

/**
 * What a run noted that a child owes while it was inside a step's callback,
 * where thread state cannot be written. Written once the run is outside a
 * step again, by `flushOwes`.
 */
const pendingOwes = new WeakMap<
  object,
  { child: string; required: string[] }[]
>();

/**
 * Notes what a started child owes. Outside a step it is written at once;
 * inside one (a tool that sandbox code called) it waits in the run until the
 * next `flushOwes`, which the run does before it reads what a child sent and
 * before it ends.
 * @param instance The run's execution instance.
 * @param inStep Whether the caller is inside a step's callback.
 * @param owes The starter's record.
 * @param child The child's thread key.
 * @param required The report types the child owes.
 */
export const noteOwes = async (
  instance: object,
  inStep: boolean,
  owes: ReturnType<typeof owesRecord>,
  child: string,
  required: string[],
): Promise<void> => {
  if (required.length === 0) {
    return;
  }

  if (inStep) {
    const list = pendingOwes.get(instance) ?? [];

    list.push({ child, required });
    pendingOwes.set(instance, list);

    return;
  }

  await owes.expect(child, required);
};

/**
 * Writes what `noteOwes` kept while the run was inside a step.
 * @param instance The run's execution instance.
 * @param owes The starter's record.
 */
export const flushOwes = async (
  instance: object,
  owes: ReturnType<typeof owesRecord>,
): Promise<void> => {
  const list = pendingOwes.get(instance);

  if (!list || list.length === 0) {
    return;
  }

  pendingOwes.delete(instance);

  for (const { child, required } of list) {
    await owes.expect(child, required);
  }
};

/**
 * The signature of the routing a start event carries for its reports, if any.
 * @param start The event that started the run, as saved.
 */
export const reportsSigOf = (start: {
  name: string;
  data?: unknown;
}): string | undefined => {
  const data = start.data as
    | { from?: SenderData; event?: { data?: { from?: SenderData } } }
    | undefined;
  const from =
    start.name === "agent/recover" ? data?.event?.data?.from : data?.from;

  return from?.reports_sig;
};

/**
 * The reports a start event carries, if it carries any.
 * @param start The event that started the run, as saved.
 */
export const reportsOf = (start: {
  name: string;
  data?: unknown;
}): ReportSpec | undefined => {
  const data = start.data as
    | { from?: SenderData; event?: { data?: { from?: SenderData } } }
    | undefined;
  const from =
    start.name === "agent/recover" ? data?.event?.data?.from : data?.from;
  const reports = from?.reports;

  return reports && Object.keys(reports).length > 0 ? reports : undefined;
};

/**
 * The types a start spec marks owed, in the order they were listed.
 * @param spec The reports a run was started with.
 */
export const requiredReports = (spec: ReportSpec | undefined): string[] => {
  return Object.entries(spec ?? {})
    .filter(([, entry]) => {
      return entry.required === true;
    })
    .map(([type]) => {
      return type;
    });
};

/**
 * The types the run still owes, in the order they were listed: the run knows
 * what it sent.
 */
export const owedReports = async (
  book: ReportBook | undefined,
): Promise<string[]> => {
  return requiredReports(book?.spec).filter((type) => {
    return !book?.sent.has(type);
  });
};

/**
 * What the loop tells the model that tries to finish while it owes a report.
 */
export const owedReminder = (types: string[]): string => {
  return `You still owe a ${types.join(" and a ")} report. Send it with the report tool before you finish.`;
};

/**
 * Checks and sends one report from the running agent: every destination of
 * its type whose `if` passes gets an `agent/report/<type>` event. It throws
 * with a message the sender can read when the type is not allowed or the data
 * breaks the schema, and then nothing is sent.
 * @param book The run's reports.
 * @param type The report's type name.
 * @param data The report's data.
 * @param check Checks the data against the schema; gives the problem, if any.
 */
export const sendReport = async (
  book: ReportBook,
  type: string,
  data: unknown,
  check?: (data: unknown) => Promise<string | undefined> | string | undefined,
): Promise<void> => {
  const entry = book.spec[type];

  if (!entry) {
    throw new Error(
      `"${type}" is not a report this run may send. Allowed: ${Object.keys(book.spec).join(", ")}.`,
    );
  }

  if (
    typeof data === "object" &&
    data !== null &&
    Object.hasOwn(data, routingKey)
  ) {
    throw new Error(
      `The ${type} report was not sent: its data has a "${routingKey}" field, which the SDK reserves for routing. Send it again without that field.`,
    );
  }

  const problem = check
    ? await check(data)
    : entry.schema
      ? checkAgainstSchema(entry.schema, data, "data")
      : undefined;

  if (problem) {
    throw new Error(
      `The ${type} report was not sent: ${problem}. Send it again with data that fits ${JSON.stringify(entry.schema ?? {})}.`,
    );
  }

  const execution = getAsyncCtxSync()?.execution;

  if (!execution) {
    throw new Error("A report must be sent inside an Inngest function");
  }

  const name = `${reportEventPrefix}${type}`;
  const from = senderOf(execution);
  const destinations = entry.to.filter((destination) => {
    return conditionPasses(destination.if, name, data);
  });

  book.sent.add(type);

  if (destinations.length === 0) {
    return;
  }

  const n = nextCount(execution.instance, "report");
  const event = eventType(reportWireEvent, {
    schema: staticSchema<ReportEnvelope>(),
  });

  await step.sendEvent(
    `report:${type}:${n}`,
    destinations.map((destination) => {
      return event.create(
        {
          ...(data as Record<string, unknown>),
          [routingKey]: {
            agent: destination.agent,
            thread: destination.thread,
            type,
            from,
            ...(book.grantSig !== undefined && {
              grant: {
                to: Object.fromEntries(
                  Object.entries(book.spec).map(([name, spec]) => {
                    return [name, spec.to];
                  }),
                ),
                sig: book.grantSig,
              },
            }),
          },
        } as ReportEnvelope,
        {
          meta: {
            sessions: {
              agent_session: destination.thread,
              agent_thread: destination.thread,
            },
          },
        },
      );
    }),
  );
};

/**
 * What the model reads about the `report` tool: the types it may send and
 * the schema of each.
 */
const reportDescription = (spec: ReportSpec): string => {
  const lines = Object.entries(spec).map(([type, entry]) => {
    return `- ${type}${entry.required ? " (owed: you must send it before you finish)" : ""}: data ${JSON.stringify(entry.schema ?? { type: "object" })}`;
  });

  return `Sends a typed report to the agents that are waiting for it. Give the report's type and its data. A report whose data does not fit its schema is refused and you can send it again. The types you may send:\n${lines.join("\n")}`;
};

/**
 * The `report({ type, data })` tool a model gets when its run was started
 * with reports. It chooses only the type and the data, never where the
 * report goes.
 */
export const reportTool = (book: ReportBook): AgentTool => {
  return tool({
    id: "report",
    description: reportDescription(book.spec),
    group: true,
    input: z.object({
      type: z.string().describe("The report's type."),
      data: z.any().describe("The report's data, fitting its schema."),
    }),
    run: async ({ type, data }: { type: string; data: unknown }) => {
      try {
        await sendReport(book, type, data);
      } catch (error) {
        return toolErrorOf(
          error instanceof Error ? error.message : String(error),
        );
      }

      return { ok: true as const };
    },
  }) as unknown as AgentTool;
};
