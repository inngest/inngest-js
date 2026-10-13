/**
 * @module
 * EXPERIMENTAL: Tools that code running inside a sandbox can call.
 *
 * A tool is a function in your app. Sandbox code calls it by name, and the
 * call runs here, in your function, as a durable step with your credentials.
 * This module holds the parts that don't touch a sandbox: the `tool()` helper,
 * name validation, and turning a request from the sandbox into a checked call.
 * `toolRunner.ts` moves the requests and replies.
 *
 * Everything that arrives from the sandbox is untrusted. Tool names must be own
 * keys of the `tools` object, and arguments are checked for shape and size
 * here, on the host, before a step is created.
 */
import type { StandardSchemaV1 } from "@standard-schema/spec";

import { type SandboxDuration, SandboxValidationError } from "./types.ts";

/**
 * The most a request line from the sandbox may weigh.
 */
export const maxToolRequestBytes = 256 * 1024;

/**
 * The most a reply to the sandbox may weigh.
 */
export const maxToolReplyBytes = 1024 * 1024;

const toolNamePattern = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * Names the sandbox-side `tools` object can't carry, because the JavaScript
 * stub treats them specially.
 */
const reservedToolNames = new Set(["then", "constructor", "prototype"]);

const textEncoder = new TextEncoder();

export const toolKind = "inngest/sandbox.tool" as const;

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

type MaybePromise<T> = T | Promise<T>;

type ToolInputOf<TInput extends StandardSchemaV1 | undefined> =
  TInput extends StandardSchemaV1
    ? StandardSchemaV1.InferOutput<TInput>
    : never;

type ToolResultOf<TOutput extends StandardSchemaV1 | undefined> =
  TOutput extends StandardSchemaV1
    ? StandardSchemaV1.InferInput<TOutput>
    : unknown;

/**
 * A tool declared with `tool()`.
 */
export interface SandboxTool {
  readonly kind: typeof toolKind;
  readonly description?: string;
  readonly input?: StandardSchemaV1;
  readonly output?: StandardSchemaV1;
  readonly run: (...args: never[]) => unknown;
}

/**
 * A plain function takes positional JSON arguments. A `tool()` can declare an
 * `input` schema, which makes the call take named arguments.
 */
export type SandboxToolEntry = SandboxTool | ((...args: never[]) => unknown);

export type SandboxTools = Record<string, SandboxToolEntry>;

export interface SandboxToolOptions {
  /**
   * The longest one wait step blocks before a fresh one continues. It is a
   * ceiling, not a delay: a wait ends the moment the process exits or a tool
   * is called. Default 20s.
   */
  waitWindow?: SandboxDuration;

  /**
   * How long one tool may run before its step fails. Default 30s.
   */
  toolTimeout?: SandboxDuration;

  /**
   * Tool calls allowed in one command before it is stopped. Default 100.
   */
  maxCalls?: number;

  /**
   * Tool calls run at once, up to 8, which is also the default.
   */
  concurrency?: number;
}

/**
 * The options `commands.run` takes to give sandbox code tools.
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

export interface ToolDefinition<
  TInput extends StandardSchemaV1 | undefined,
  TOutput extends StandardSchemaV1 | undefined,
> {
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
      ) => MaybePromise<ToolResultOf<TOutput>>
    : (...args: never[]) => unknown;
}

/**
 * EXPERIMENTAL: Declares a tool that sandbox code can call.
 *
 * @example
 * ```ts
 * import { tool } from "inngest/experimental";
 * import { z } from "zod";
 *
 * const getCustomer = tool({
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
export const tool = <
  TInput extends StandardSchemaV1 | undefined = undefined,
  TOutput extends StandardSchemaV1 | undefined = undefined,
>(
  definition: ToolDefinition<TInput, TOutput>,
): SandboxTool => {
  return {
    kind: toolKind,
    ...(definition.description !== undefined && {
      description: definition.description,
    }),
    ...(definition.input !== undefined && { input: definition.input }),
    ...(definition.output !== undefined && { output: definition.output }),
    run: definition.run as SandboxTool["run"],
  };
};

const isTool = (entry: SandboxToolEntry): entry is SandboxTool => {
  return typeof entry === "object" && entry !== null && entry.kind === toolKind;
};

/**
 * Checks the tools you declared. Returns their names.
 */
export const validateTools = (tools: SandboxTools): string[] => {
  const names = Object.keys(tools);

  for (const name of names) {
    if (!toolNamePattern.test(name) || reservedToolNames.has(name)) {
      throw new SandboxValidationError(
        `Invalid tool name "${name}": use letters, digits and underscores, starting with a letter, up to 64 characters`,
      );
    }

    const entry = tools[name];
    if (typeof entry !== "function" && !(entry && isTool(entry))) {
      throw new SandboxValidationError(
        `Tool "${name}" must be a function or the result of tool()`,
      );
    }
  }

  return names;
};

export interface ToolRequest {
  seq: number;
  tool: string;
  args: unknown[];
  kwargs?: Record<string, unknown>;
}

/**
 * Parses one line of the request log. Returns `undefined` for anything that
 * isn't a request, which is skipped.
 */
export const parseToolRequest = (line: string): ToolRequest | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }

  const candidate = parsed as Record<string, unknown>;
  const { id, tool: name, args, kwargs } = candidate;

  if (
    typeof id !== "number" ||
    !Number.isSafeInteger(id) ||
    id < 1 ||
    typeof name !== "string" ||
    name.length > 128 ||
    !Array.isArray(args)
  ) {
    return undefined;
  }

  const kwargsAreValid =
    kwargs === undefined ||
    (typeof kwargs === "object" && kwargs !== null && !Array.isArray(kwargs));
  if (!kwargsAreValid) {
    return undefined;
  }

  return {
    seq: id,
    tool: name,
    args,
    ...(kwargs !== undefined && { kwargs: kwargs as Record<string, unknown> }),
  };
};

export type ResolvedCall =
  | { ok: true; name: string; entry: SandboxToolEntry; args: unknown[] }
  | { ok: false; error: string };

const issuesMessage = (issues: readonly StandardSchemaV1.Issue[]): string => {
  return issues
    .slice(0, 5)
    .map((issue) => {
      const path = issue.path
        ?.map((segment) => {
          return String(typeof segment === "object" ? segment.key : segment);
        })
        .join(".");

      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
};

/**
 * Checks a request against the declared tools: the name, the size, and the
 * shape of the arguments. A request that fails comes back as an error to send
 * to the sandbox, and no step is created for it.
 */
export const resolveToolCall = async (
  tools: SandboxTools,
  request: ToolRequest,
  line: string,
): Promise<ResolvedCall> => {
  if (textEncoder.encode(line).byteLength > maxToolRequestBytes) {
    return {
      ok: false,
      error: `Request is larger than ${maxToolRequestBytes} bytes`,
    };
  }

  if (!Object.hasOwn(tools, request.tool)) {
    return {
      ok: false,
      error: `Unknown tool: ${request.tool.slice(0, 64)}`,
    };
  }

  const entry = tools[request.tool];
  if (!entry) {
    return { ok: false, error: `Unknown tool: ${request.tool.slice(0, 64)}` };
  }

  if (!isTool(entry) || !entry.input) {
    if (request.kwargs && Object.keys(request.kwargs).length > 0) {
      return {
        ok: false,
        error: `${request.tool} takes positional arguments only`,
      };
    }

    return { ok: true, name: request.tool, entry, args: request.args };
  }

  const named = request.kwargs ?? request.args[0];
  const argumentCount = request.kwargs
    ? request.args.length + 1
    : request.args.length;
  if (argumentCount !== 1) {
    return {
      ok: false,
      error: `${request.tool} takes one set of named arguments`,
    };
  }

  const result = await entry.input["~standard"].validate(named);
  if (result.issues) {
    return {
      ok: false,
      error: `Invalid arguments for ${request.tool}: ${issuesMessage(result.issues)}`,
    };
  }

  return { ok: true, name: request.tool, entry, args: [result.value] };
};

/**
 * Runs a resolved call. Throws when the tool throws, times out, or returns
 * something its `output` schema rejects.
 */
export const invokeTool = async (
  call: Extract<ResolvedCall, { ok: true }>,
  ctx: SandboxToolContext,
): Promise<unknown> => {
  const entry = call.entry;
  const run = (isTool(entry) ? entry.run : entry) as (
    ...args: unknown[]
  ) => unknown;
  const value = await run(...call.args, ...(isTool(entry) ? [ctx] : []));

  if (isTool(entry) && entry.output) {
    const result = await entry.output["~standard"].validate(value);
    if (result.issues) {
      throw new SandboxValidationError(
        `${call.name} returned an invalid result: ${issuesMessage(result.issues)}`,
      );
    }

    return result.value;
  }

  return value;
};
