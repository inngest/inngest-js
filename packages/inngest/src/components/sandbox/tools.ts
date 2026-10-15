/**
 * @module
 * EXPERIMENTAL: Tools that code running inside a sandbox can call.
 *
 * A tool is a function in your app. Sandbox code calls it by name, and the
 * call runs here, in your function, as a durable step with your credentials.
 * This module holds the parts that don't touch a sandbox: the options, name
 * validation, and turning a request from the sandbox into a checked call.
 * `toolRunner.ts` moves the requests and replies.
 *
 * Everything that arrives from the sandbox is untrusted. Tool names must be own
 * keys of the `tools` object, and requests are checked for size here, on the
 * host, before a step is created.
 */
import { z } from "zod/v3";

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
 * A function the sandbox code can call. It takes positional JSON arguments.
 */
export type SandboxTools = Record<string, (...args: never[]) => unknown>;

export interface SandboxToolOptions {
  /**
   * The longest one wait step blocks before a fresh one continues. It is a
   * ceiling, not a delay: a wait ends soon after the process exits or a tool
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

/**
 * Checks a request against the declared tools: the name, the size, and the
 * arguments. A request that fails comes back as an error to send to the
 * sandbox, and no step is created for it. Otherwise it comes back as the call
 * to run.
 */
export const resolveToolCall = (
  tools: SandboxTools,
  request: ToolRequest,
  line: string,
) => {
  const { tool: name, args } = request;
  const run = Object.hasOwn(tools, name) ? tools[name] : undefined;

  if (byteLength(line) > maxToolRequestBytes) {
    return { error: `Request is larger than ${maxToolRequestBytes} bytes` };
  }

  if (!run) {
    return { error: `Unknown tool: ${name.slice(0, 64)}` };
  }

  if (Object.keys(request.kwargs ?? {}).length) {
    return { error: `${name} takes positional arguments only` };
  }

  return {
    invoke: async () => {
      return (run as (...values: unknown[]) => unknown)(...args);
    },
  };
};
