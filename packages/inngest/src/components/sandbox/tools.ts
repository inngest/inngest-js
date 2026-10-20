/**
 * @module
 * EXPERIMENTAL: Tools that code running inside a sandbox can call.
 *
 * A tool is a function in your app. Sandbox code calls it by name, and the
 * call runs here, in your function, as a durable step with your credentials.
 * This module holds the parts that don't touch a sandbox: the `tool.step()`
 * and `tool.group()` helpers, name validation, and turning a request from the sandbox into a
 * checked call. `toolRunner.ts` moves the requests and replies.
 *
 * Everything that arrives from the sandbox is untrusted. Tool names must be own
 * keys of the `tools` object, and arguments are checked for shape and size
 * here, on the host, before a step is created.
 */
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { z } from "zod/v3";
import * as z4 from "zod/v4";

import { internalEvents } from "../../helpers/consts.ts";
import { InngestFunction } from "../InngestFunction.ts";
import { InngestFunctionReference } from "../InngestFunctionReference.ts";
import { step } from "../InngestStepTools.ts";
import { EventType } from "../triggers/triggers.ts";
import { type SandboxDuration, SandboxValidationError } from "./types.ts";

/**
 * The most a request line from the sandbox may weigh.
 */
export const maxToolRequestBytes = 256 * 1024;

/**
 * The most a reply to the sandbox may weigh.
 */
export const maxToolReplyBytes = 1024 * 1024;

// "then" would make the JavaScript `tools` object look like a promise.
const toolNamePattern = /^(?!then$)[A-Za-z][A-Za-z0-9_]{0,63}$/;

export const byteLength = (text: string): number => {
  return new TextEncoder().encode(text).byteLength;
};

/**
 * What a tool receives besides its arguments.
 */
export interface SandboxToolContext {
  /**
   * Aborts when the tool times out.
   */
  signal: AbortSignal;

  /**
   * Stable across retries of the same call. Pass it to APIs that deduplicate
   * writes, so a retry doesn't send the same Slack message twice.
   */
  idempotencyKey: string;
}

type ToolInputOf<TInput extends StandardSchemaV1 | undefined> =
  TInput extends StandardSchemaV1
    ? StandardSchemaV1.InferOutput<TInput>
    : never;

type ToolResultOf<TOutput extends StandardSchemaV1 | undefined> =
  TOutput extends StandardSchemaV1
    ? StandardSchemaV1.InferInput<TOutput>
    : unknown;

/**
 * A tool declared with `tool.step()` or `tool.group()`.
 */
export interface SandboxTool {
  readonly description?: string;
  readonly group?: boolean;
  readonly input?: StandardSchemaV1;
  readonly output?: StandardSchemaV1;
  readonly run: (...args: never[]) => unknown;
}

/**
 * A plain function takes positional JSON arguments. A `tool.step()` can declare
 * an `input` schema, which makes the call take named arguments. An Inngest
 * function, or a reference to one, is invoked with the named arguments as its
 * event data.
 */
export type SandboxToolEntry =
  | SandboxTool
  | ((...args: never[]) => unknown)
  | InngestFunction.Any
  | InngestFunctionReference.Any;

export type SandboxTools = Record<string, SandboxToolEntry>;

export interface SandboxToolOptions {
  /**
   * The longest one wait step blocks before a fresh one continues. It is a
   * ceiling, not a delay: a wait ends soon after the process exits or a tool
   * is called. Default 20s.
   */
  waitWindow?: SandboxDuration;

  /**
   * How long one `tool.step()` may run before its step fails. Default 30s.
   */
  toolTimeout?: SandboxDuration;

  /**
   * Tool calls allowed in one command before it is stopped. Default 100.
   */
  maxCalls?: number;
}

/**
 * The options that give sandbox code tools.
 */
export interface SandboxToolsOptions {
  /**
   * Functions the code can call as `tools.name(...)`. In Python,
   * `from inngest_tools import tools`. In Node, `require("inngest_tools")`.
   * With no tools, nothing changes and nothing extra is sent.
   *
   * Every call is a durable step: it is retried and memoized like any other,
   * and a tool that still fails raises a `ToolError` the code can catch. When
   * `timeout` is not set, a command with tools can run for 5 minutes.
   */
  tools?: SandboxTools;
  toolOptions?: SandboxToolOptions;
}

export type SandboxToolsRequest = SandboxToolsOptions & {
  tools: SandboxTools;
};

export interface ToolDefinition<
  TInput extends StandardSchemaV1 | undefined,
  TOutput extends StandardSchemaV1 | undefined,
> {
  /**
   * What the tool does, for the people reading the code.
   */
  description?: string;

  /**
   * Any Standard Schema. With it, sandbox code calls the tool with named
   * arguments (`tools.getCustomer(id="cus_1")`) and a bad call gets a
   * `ToolError` back without running anything. Without it the tool takes
   * positional JSON values.
   */
  input?: TInput;

  /**
   * Any Standard Schema. A result that doesn't match fails the tool step.
   */
  output?: TOutput;

  run: TInput extends StandardSchemaV1
    ? (
        input: ToolInputOf<TInput>,
        ctx: SandboxToolContext,
      ) => ToolResultOf<TOutput> | Promise<ToolResultOf<TOutput>>
    : (
        ...args: never[]
      ) => ToolResultOf<TOutput> | Promise<ToolResultOf<TOutput>>;
}

/**
 * EXPERIMENTAL: Declares a tool that sandbox code can call.
 * `tool.step()` runs its body as one durable step.
 *
 * @example
 * ```ts
 * import { tool } from "inngest/experimental";
 * import { z } from "zod";
 *
 * const getCustomer = tool.step({
 *   input: z.object({ id: z.string() }),
 *   run: async ({ id }) => {
 *     return db.customers.find(id);
 *   },
 * });
 *
 * await sandbox.commands.run("analyse", "python3 analyse.py", {
 *   tools: { getCustomer },
 * });
 * ```
 */
export const tool = {
  step: <
    TInput extends StandardSchemaV1 | undefined = undefined,
    TOutput extends StandardSchemaV1 | undefined = undefined,
  >(
    definition: ToolDefinition<TInput, TOutput>,
  ): SandboxTool => {
    return definition as SandboxTool;
  },

  /**
   * EXPERIMENTAL: Declares a tool whose body is a group of steps. Instead of
   * running as one durable step, `run` can use the global `step`
   * (`import { step } from "inngest"`) to run steps, invoke functions, send
   * events and wait for events. Each call's steps are scoped to that call.
   *
   * @example
   * ```ts
   * const refund = tool.group({
   *   input: z.object({ orderId: z.string() }),
   *   run: async ({ orderId }) => {
   *     const result = await step.invoke("refund", {
   *       function: refundFn,
   *       data: { orderId },
   *     });
   *
   *     await step.sendEvent("notify", { name: "order/refunded", data: result });
   *
   *     return result;
   *   },
   * });
   * ```
   */
  group: <
    TInput extends StandardSchemaV1 | undefined = undefined,
    TOutput extends StandardSchemaV1 | undefined = undefined,
  >(
    definition: ToolDefinition<TInput, TOutput>,
  ): SandboxTool => {
    return { ...definition, group: true } as SandboxTool;
  },
};

/**
 * The schema of the data a function takes, when its triggers say: that of its
 * `invoke()` trigger, or of its only event trigger with a schema.
 */
const triggerSchema = (
  fn: InngestFunction.Any,
): StandardSchemaV1 | undefined => {
  const triggers: { event?: unknown; schema?: StandardSchemaV1 }[] =
    fn.opts.triggers ?? [];
  const typed = triggers
    .map((trigger) => {
      return {
        event: trigger.event,
        schema:
          trigger.schema ??
          (trigger.event instanceof EventType
            ? trigger.event.schema
            : undefined),
      };
    })
    .filter((trigger) => {
      return trigger.schema;
    });
  const invoked = typed.find((trigger) => {
    return trigger.event === internalEvents.FunctionInvoked;
  });

  return (invoked ?? (typed.length === 1 ? typed[0] : undefined))?.schema;
};

/**
 * An Inngest function as a tool: a group whose only step invokes it with the
 * call's named arguments. The input is checked against the function's trigger
 * when that has a schema; otherwise it's any record, and a tool that wants
 * more declares it with `tool.group()`.
 */
const functionTool = (
  fn: InngestFunction.Any | InngestFunctionReference.Any,
): SandboxTool => {
  return {
    group: true,
    input:
      (fn instanceof InngestFunction ? triggerSchema(fn) : undefined) ??
      z4.record(z4.string(), z4.unknown()),
    run: (data: Record<string, unknown>) => {
      return step.invoke("invoke", { function: fn, data });
    },
  } as SandboxTool;
};

const toTool = (entry: SandboxToolEntry): SandboxTool => {
  if (typeof entry === "function") {
    return { run: entry };
  }

  return entry instanceof InngestFunction ||
    entry instanceof InngestFunctionReference
    ? functionTool(entry)
    : entry;
};

/**
 * Checks the names of the tools you declared.
 */
export const validateTools = (tools: SandboxTools): void => {
  for (const name of Object.keys(tools)) {
    if (!toolNamePattern.test(name)) {
      throw new SandboxValidationError(
        `Invalid tool name "${name}": use letters, digits and underscores, starting with a letter, up to 64 characters`,
      );
    }
  }
};

const eventSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("call"),
    id: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    tool: z.string().max(128),
    args: z.array(z.unknown()),
    kwargs: z.record(z.unknown()).optional(),
  }),
  z.object({
    op: z.literal("exit"),
    code: z.number().int(),
    stdout: z.string(),
    stderr: z.string(),
  }),
]);

/**
 * An event the host reads from the sandbox: a request, or the command's exit
 * with its output.
 */
export type ToolEvent = z.infer<typeof eventSchema>;

export type ToolRequest = Extract<ToolEvent, { op: "call" }>;

/**
 * Parses one line of the log. Returns `undefined` for anything that isn't an
 * event the host reads (its own replies, for one), which is skipped.
 */
export const parseToolEvent = (line: string): ToolEvent | undefined => {
  try {
    const parsed = eventSchema.safeParse(JSON.parse(line));

    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

const issuesMessage = (issues: readonly StandardSchemaV1.Issue[]): string => {
  return issues
    .slice(0, 5)
    .map((issue) => {
      const path = issue.path
        ?.map((part) => {
          return String(typeof part === "object" ? part.key : part);
        })
        .join(".");

      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
};

/**
 * Checks a request against the declared tools: the name, the size, and the
 * shape of the arguments. A request that fails comes back as an error to send
 * to the sandbox, and no step is created for it. Otherwise it comes back as the
 * call to run.
 */
export const resolveToolCall = async (
  tools: SandboxTools,
  request: ToolRequest,
  line: string,
) => {
  const { tool: name, args } = request;
  const entry = Object.hasOwn(tools, name) ? tools[name] : undefined;
  const kwargs = Object.keys(request.kwargs ?? {}).length
    ? request.kwargs
    : undefined;

  if (byteLength(line) > maxToolRequestBytes) {
    return { error: `Request is larger than ${maxToolRequestBytes} bytes` };
  }

  if (!entry) {
    return { error: `Unknown tool: ${name.slice(0, 64)}` };
  }

  const definition = toTool(entry);
  const run = definition.run as (...values: unknown[]) => unknown;
  let values = args;

  if (definition.input) {
    if (args.length + (kwargs ? 1 : 0) > 1) {
      return { error: `${name} takes one set of named arguments` };
    }

    // A call with nothing passed is an empty set of named arguments.
    const result = await definition.input["~standard"].validate(
      kwargs ?? (args.length ? args[0] : {}),
    );
    if (result.issues) {
      return {
        error: `Invalid arguments for ${name}: ${issuesMessage(result.issues)}`,
      };
    }

    values = [result.value];
  } else if (kwargs) {
    return { error: `${name} takes positional arguments only` };
  }

  return {
    group: definition.group === true,
    invoke: async (ctx: SandboxToolContext) => {
      // A plain function takes positional values and no context.
      const value = await run(
        ...values,
        ...(typeof entry === "function" ? [] : [ctx]),
      );
      if (!definition.output) {
        return value;
      }

      const result = await definition.output["~standard"].validate(value);
      if (result.issues) {
        throw new SandboxValidationError(
          `${name} returned an invalid result: ${issuesMessage(result.issues)}`,
        );
      }

      return result.value;
    },
  };
};

/**
 * A tool in the shape model APIs take.
 */
export interface ToolJsonDefinition {
  name: string;
  description?: string;

  /**
   * JSON Schema of the arguments. A tool without an `input` schema takes any
   * object.
   */
  input_schema: Record<string, unknown>;

  /**
   * JSON Schema of the result, only for a tool that declares an `output`.
   */
  output_schema?: Record<string, unknown>;
}

type JsonSchemaProvider = {
  jsonSchema?: {
    input: (options: { target: string }) => Record<string, unknown>;
  };
};

const toJsonSchema = (
  name: string,
  schema: StandardSchemaV1,
): Record<string, unknown> => {
  const provider = schema["~standard"] as JsonSchemaProvider;
  if (provider.jsonSchema) {
    return provider.jsonSchema.input({ target: "draft-2020-12" });
  }

  if ("_zod" in schema) {
    return z4.toJSONSchema(schema as unknown as z4.ZodType);
  }

  throw new SandboxValidationError(
    `Tool "${name}" has a schema that can't be turned into JSON Schema: use Zod 4 or a library that implements Standard JSON Schema`,
  );
};

/**
 * EXPERIMENTAL: The definitions to hand to a model so it can call `tools`:
 * each tool's name, description and JSON Schema, in the shape Anthropic's
 * `tools` parameter takes (`{ name, description, input_schema }`).
 *
 * For OpenAI, map each one to
 * `{ type: "function", name, description, parameters: input_schema }`. A tool
 * that declares an `output` also gets an `output_schema`, which model APIs
 * don't accept, so leave it out when sending.
 *
 * Schemas come from Zod 4 or any library that implements Standard JSON
 * Schema. Other Standard Schema libraries throw, since the standard can only
 * validate.
 *
 * @example
 * ```ts
 * import { toolDefinitions } from "inngest/experimental";
 *
 * const tools = { getCustomer };
 *
 * await anthropic.messages.create({
 *   model,
 *   max_tokens: 1024,
 *   messages,
 *   tools: toolDefinitions(tools),
 * });
 * ```
 */
export const toolDefinitions = (tools: SandboxTools): ToolJsonDefinition[] => {
  validateTools(tools);

  return Object.entries(tools).map(([name, entry]) => {
    const { description, input, output } = toTool(entry);

    return {
      name,
      ...(description !== undefined && { description }),
      input_schema: input ? toJsonSchema(name, input) : { type: "object" },
      ...(output && { output_schema: toJsonSchema(name, output) }),
    };
  });
};
