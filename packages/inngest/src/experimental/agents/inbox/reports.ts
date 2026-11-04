/**
 * @module
 * EXPERIMENTAL: typed reports. A report is a message a started agent sends
 * back. Its type is an ordinary `eventType()`, shared across the repo like any
 * other event type: the starter says what the child owes and to whom with the
 * `reports` start option, and the child sends one with `me.report(type, data)`
 * or its model's `report` tool. The routing travels in the start event: the
 * JSON Schema of each type, and the destinations inside the signed grant, so a
 * child found by discovery needs no prior knowledge of the types.
 *
 * A report is delivered to a thread directly, as an `agent/report` event with
 * its routing under `data["::agents"]`, and the thread's inbox shows it as an
 * event with the report type's own name, so `msg.is(milestone)` narrows it.
 * The child checks the data against the schema when it sends, and evaluates
 * each destination's `if` itself, so one report goes to every destination whose
 * `if` passes.
 */

import type { StandardSchemaV1 } from "@standard-schema/spec";
import hashjs from "hash.js";
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
  eventType,
  staticSchema,
} from "../../../components/triggers/triggers.ts";
import { nextCount } from "../agent/executionCounter.ts";
import {
  type Grant,
  grantEnded,
  proofIsValid,
  verifyGrant,
  type WireGrant,
} from "../agent/grant.ts";
import { relationOf } from "../agent/relations.ts";
import { senderOf } from "../agent/sender.ts";
import { compileExpression, MissingPathError } from "../cel.ts";
import { checkAgainstSchema } from "../discovery/inputCheck.ts";
import type { Json, JsonSchema } from "../json.ts";
import { type Kv, typedKey } from "../kv/kv.ts";
import type { SenderData } from "./events.ts";
import { handleAddressKey } from "./handleAddressKey.ts";

/**
 * The name a report travels under. Triggers and inbox subscriptions match an
 * event by its exact name, so every report is sent as this one event, with its
 * type in the data, and the receiver's inbox shows it under the type's own name.
 */
export const reportWireEvent = "agent/report";

/**
 * Whether a name may not be a report type: an event name of the agent layer or
 * the platform would be taken for that event once a report carried it.
 */
export const reservedReportType = (type: string): boolean => {
  return (
    type === "" ||
    type.includes("*") ||
    type.startsWith("agent/") ||
    type.startsWith("inngest/")
  );
};

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
 * Whether an inbox message is a report: one the inbox showed under its type's
 * name, with its routing in `report`.
 */
export const isReportMessage = (message: unknown): boolean => {
  return (
    typeof message === "object" &&
    message !== null &&
    typeof (message as { report?: unknown }).report === "object" &&
    (message as { report?: unknown }).report !== null
  );
};

/**
 * Why a message is not a report this thread can take, or `undefined` when it
 * is not a report or comes from a thread this one started (the tag in the
 * sender's thread key proves it), or from one whose grant names this thread
 * as a destination of this type, with a proof made for this event. The `from`
 * of an event is whatever its sender wrote.
 * @param client The client, whose signing key checks the tag and the grant.
 * @param thread The receiving thread's key.
 * @param message The message, as `resentAs` shows it.
 */
export const reportSenderProblem = (
  client: Inngest.Any,
  thread: string,
  message: {
    id?: string;
    ts?: number;
    name: string;
    from?: unknown;
    report?: { grant?: unknown; pop?: unknown };
  },
): string | undefined => {
  if (!isReportMessage(message)) {
    return undefined;
  }

  const key = (message.from as { key?: unknown } | undefined)?.key;

  if (typeof key === "string") {
    if (relationOf(client, thread, key)?.relation === "child") {
      return undefined;
    }

    const grant = verifyGrant(client, message.report?.grant, key);

    if (
      grant &&
      proofIsValid(client, grant, message.id, thread, message.report?.pop) &&
      !grantEnded(grant, message.ts) &&
      grant.rep.some((route) => {
        return route.thread === thread && route.type === message.name;
      })
    ) {
      return undefined;
    }
  }

  return "its sender is not a thread this thread started, or one whose start granted it, so it is not a report this thread can take";
};

export { handleAddressKey };

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
   * The grant the sender holds and a proof made for this event, so a receiver
   * that did not start the sender can tell the starter named it.
   */
  grant?: WireGrant;
  pop?: string;
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
 * What a report line needs of an event type: a name, and a schema when its
 * data is checked. Any `eventType()` fits.
 */
export type ReportEventType = {
  readonly name: string;
  readonly schema?: unknown;
};

/**
 * EXPERIMENTAL: one line of a start's `reports` list in its full form: a
 * report event type, where it goes and whether it is owed.
 */
export interface AgentReportRoute<
  TEvent extends ReportEventType = ReportEventType,
> {
  /**
   * The report's event type, such as `milestone = eventType("milestone", ...)`.
   * Its name is the report's type.
   */
  event: TEvent;

  /**
   * The threads the report goes to (`me`, `agent.thread(key)`). Default: the
   * thread that started the agent.
   */
  to?: ReportTarget | readonly ReportTarget[];

  /**
   * A CEL condition over the report, written like the `if` of an inbox
   * source: `async.data` is the report's data. The report goes to these
   * destinations only when it is true.
   */
  if?: string;

  /**
   * Whether the report is owed: the agent's loop reminds its model before it
   * may finish.
   */
  required?: boolean;
}

/**
 * EXPERIMENTAL: a line of a start's `reports` list: an event type alone (it
 * goes back to the thread that started the agent and is not owed), or an
 * `AgentReportRoute`.
 */
export type AgentReportLine = ReportEventType | AgentReportRoute;

const routeOf = (line: AgentReportLine): AgentReportRoute => {
  return typeof (line as { event?: unknown }).event === "object" &&
    (line as { event?: unknown }).event !== null
    ? (line as AgentReportRoute)
    : { event: line as ReportEventType };
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
 * What a start carries of its reports beside the grant: the JSON Schema of
 * each type the child checks its data against, and whether it is owed. Where
 * each goes is in the signed grant.
 */
export type ReportSchemas = Record<
  string,
  { schema?: JsonSchema; required?: true }
>;

/**
 * The part of a resolved spec that travels beside the grant.
 * @param spec The resolved reports.
 */
export const schemasOf = (spec: ReportSpec): ReportSchemas => {
  return Object.fromEntries(
    Object.entries(spec).map(([type, entry]) => {
      return [
        type,
        {
          ...(entry.schema && { schema: entry.schema }),
          ...(entry.required && { required: true as const }),
        },
      ];
    }),
  );
};

/**
 * The routes of a resolved spec, as a grant names them.
 * @param spec The resolved reports.
 */
export const routesOf = (
  spec: ReportSpec,
): { type: string; agent: string; thread: string; if?: string }[] => {
  return Object.entries(spec).flatMap(([type, entry]) => {
    return entry.to.map((place) => {
      return {
        type,
        agent: place.agent,
        thread: place.thread,
        ...(place.if !== undefined && { if: place.if }),
      };
    });
  });
};

/**
 * Makes the `reports` of a start into what the start event routes. The
 * lines of one report type merge: every destination is kept and the type is
 * owed when any line says so. A line with no thread goes to `starter`.
 * @param lines The `reports` option.
 * @param starter The thread that starts the agent, when it is an agent's.
 */
export const resolveReports = (
  lines: readonly AgentReportLine[],
  starter: { agent: string; thread: string } | undefined,
): ReportSpec => {
  const spec: ReportSpec = {};

  for (const line of lines) {
    const route = routeOf(line);
    const type = route.event.name;

    if (reservedReportType(type)) {
      throw new Error(
        `The report type "${type}" is reserved: a report's event name is not empty, has no "*" and does not start with "agent/" or "inngest/".`,
      );
    }

    if (route.if !== undefined) {
      toReportCondition(route.if);
    }

    let schema: JsonSchema | undefined;

    try {
      schema = (
        route.event.schema === undefined
          ? { type: "object" }
          : toJsonSchema(type, route.event.schema as StandardSchemaV1)
      ) as JsonSchema;
    } catch {
      // A schema that cannot become JSON Schema is not checked by the child
      // beyond being an object.
      schema = { type: "object" };
    }

    const entry = spec[type] ?? { schema, to: [] };

    spec[type] = entry;

    const targets =
      route.to === undefined
        ? []
        : Array.isArray(route.to)
          ? (route.to as readonly ReportTarget[])
          : [route.to as ReportTarget];
    const where =
      targets.length === 0
        ? [starter]
        : targets.map((target) => {
            return addressOfHandle(target);
          });

    for (const place of where) {
      if (!place) {
        throw new Error(
          targets.length === 0
            ? `The report "${type}" has no thread to go to: it was started by a function that is not an agent, so name a thread with \`to\`.`
            : `The report "${type}" is sent to a handle that is not an agent's thread. Use \`me\` or \`agent.thread(key)\`.`,
        );
      }

      entry.to.push({
        agent: place.agent,
        thread: place.thread,
        ...(route.if !== undefined && { if: route.if }),
      });
    }

    if (route.required) {
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
   * Makes what a report to `target` carries so its receiver can tell the
   * starter granted it: the run's grant and a proof for this event.
   */
  readonly proof?: (
    id: string,
    target: string,
  ) => { grant: WireGrant; pop: string };
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
 * The reports a start event owes, as a run reads them: the schemas the start
 * carries and the routes of its verified grant. A type the grant routes
 * nowhere has no destination, and a type only the grant names is not checked
 * against a schema.
 * @param start The event that started the run, as saved.
 * @param grant The grant the start carried, verified.
 */
export const reportsOf = (
  start: { name: string; data?: unknown },
  grant: Grant | undefined,
): ReportSpec | undefined => {
  const data = start.data as
    | { from?: SenderData; event?: { data?: { from?: SenderData } } }
    | undefined;
  const from =
    start.name === "agent/recover" ? data?.event?.data?.from : data?.from;
  const schemas = from?.reports ?? {};
  const types = new Set([
    ...Object.keys(schemas),
    ...(grant?.rep ?? []).map((route) => {
      return route.type;
    }),
  ]);
  const spec: ReportSpec = {};

  for (const type of types) {
    if (reservedReportType(type)) {
      continue;
    }

    spec[type] = {
      ...(schemas[type]?.schema && { schema: schemas[type]?.schema }),
      ...(schemas[type]?.required && { required: true as const }),
      to: (grant?.rep ?? [])
        .filter((route) => {
          return route.type === type;
        })
        .map((route) => {
          return {
            agent: route.agent,
            thread: route.thread,
            ...(route.if !== undefined && { if: route.if }),
          };
        }),
    };
  }

  return Object.keys(spec).length > 0 ? spec : undefined;
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
 * @param key Names this send for good, for a caller whose steps already sit
 * under an ID of their own (a `runCode` call): the step is `report:<type>`
 * under it and the events are named by the key, not by a count of the run's
 * reports.
 */
export const sendReport = async (
  book: ReportBook,
  type: string,
  data: unknown,
  check?: (data: unknown) => Promise<string | undefined> | string | undefined,
  key?: string,
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

  const name = type;
  const from = senderOf(execution);
  const destinations = entry.to.filter((destination) => {
    return conditionPasses(destination.if, name, data);
  });

  book.sent.add(type);

  if (destinations.length === 0) {
    return;
  }

  const n = key ?? nextCount(execution.instance, "report");
  const event = eventType(reportWireEvent, {
    schema: staticSchema<ReportEnvelope>(),
  });

  await step.sendEvent(
    key === undefined ? `report:${type}:${n}` : `report:${type}`,
    destinations.map((destination, index) => {
      // The ID is the event's own, so a proof can be made for it.
      const id = `report:${execution.ctx.runId}.${n}.${index}`;

      return event.create(
        {
          ...(data as Record<string, unknown>),
          [routingKey]: {
            agent: destination.agent,
            thread: destination.thread,
            type,
            from,
            ...book.proof?.(id, destination.thread),
          },
        } as ReportEnvelope,
        {
          id,
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

/**
 * EXPERIMENTAL: the `report({ type, data })` tool sandbox code gets in a
 * `runCode` when the run owes reports. It checks and sends a report exactly as
 * the model's `report` tool does. Each call runs under the step ID of its own
 * `runCode` call, and its events are named by that call, so a script that
 * reports several times, in a loop or across waits, sends each report once.
 */
export const codeReportTool = (book: ReportBook): AgentTool => {
  return tool({
    id: "report",
    description: reportDescription(book.spec),
    group: true,
    input: z.object({
      type: z.string().describe("The report's type."),
      data: z.any().describe("The report's data, fitting its schema."),
    }),
    run: async (
      { type, data }: { type: string; data: unknown },
      context: { idempotencyKey: string },
    ) => {
      const key = hashjs
        .sha256()
        .update(context.idempotencyKey)
        .digest("hex")
        .slice(0, 16);

      try {
        await sendReport(book, type, data, undefined, key);
      } catch (error) {
        return toolErrorOf(
          error instanceof Error ? error.message : String(error),
        );
      }

      return { ok: true as const };
    },
  }) as unknown as AgentTool;
};
