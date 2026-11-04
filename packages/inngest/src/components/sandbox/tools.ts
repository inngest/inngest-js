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
import type { AgentCardConfig } from "../../experimental/agents/discovery/discovery.ts";
import { toolScore } from "../../experimental/agents/loop/scores.ts";
import { internalEvents } from "../../helpers/consts.ts";
import type { Jsonify } from "../../helpers/jsonify.ts";
import type { Logger } from "../../middleware/logger.ts";
import type { Context } from "../../types.ts";
import { getAsyncCtxSync } from "../execution/als.ts";
import { InngestFunction } from "../InngestFunction.ts";
import { InngestFunctionReference } from "../InngestFunctionReference.ts";
import { step } from "../InngestStepTools.ts";
import { EventType } from "../triggers/triggers.ts";
import { callSite, rememberToolSource } from "./callSite.ts";
import { isInternalTool } from "./internalTool.ts";
import { McpServer, mcp } from "./mcp.ts";
import { type SandboxShim, shim } from "./shims.ts";
import type { ToolBinary } from "./toolBinary.ts";
import { isToolError, type ToolErrorResult } from "./toolError.ts";
import {
  type Sandbox,
  type SandboxDuration,
  type SandboxHandle,
  SandboxValidationError,
} from "./types.ts";

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
export interface SandboxToolContext<TSandbox = Sandbox> {
  /**
   * Aborts when the tool times out.
   */
  signal: AbortSignal;

  /**
   * Stable across retries of the same call. Pass it to APIs that deduplicate
   * writes, so a retry doesn't send the same Slack message twice.
   */
  idempotencyKey: string;

  /**
   * The ID of the run that is calling.
   */
  runId: string;

  /**
   * Records a score: a finite number or a boolean, under a name that doesn't
   * start with `agent.`. It is the same function as the handler's `score`, so
   * a tool needs no Inngest client. Inside a tool step it rides on the step's
   * result, so it is written once however often the run replays. A tool made
   * with `tool.group()` has no step of its own: in an agent run its score is
   * a memoized step, also written once. Best effort: a score the server
   * refuses logs a warning and the run goes on.
   */
  score(name: string, value: number | boolean): Promise<void>;

  /**
   * The sandbox the tool works on, for reading and writing its files and
   * running commands.
   *
   * A tool listed on a sandbox (`sandbox({ tools })`) always has it, whether
   * the model or sandbox code calls it. In `tool.group()` it is the durable
   * `SandboxHandle`: its calls are memoized steps with scoped IDs. In
   * `tool.step()` it is the raw `Sandbox`, set when sandbox code calls the
   * tool; calls on it aren't steps of their own, they belong to the step that
   * answers the call, so a retry repeats them.
   *
   * A tool listed on an agent's `tools` has none when the model calls it, and
   * the calling sandbox (a `tool.step()` only) when sandbox code does.
   */
  sandbox?: TSandbox;
}

/**
 * A JSON Schema written out by hand, for a tool whose schema you already have
 * as JSON (such as one a user defines). It describes an object. The tool gets
 * the model's arguments as they come, without them being checked against it.
 */
export type JsonSchemaObject = { type: "object"; [key: string]: unknown };

export type ToolInput = StandardSchemaV1 | JsonSchemaObject;

const isStandardSchema = (input: ToolInput): input is StandardSchemaV1 => {
  return "~standard" in input;
};

type ToolInputOf<TInput extends ToolInput | undefined> =
  TInput extends StandardSchemaV1
    ? StandardSchemaV1.InferOutput<TInput>
    : TInput extends JsonSchemaObject
      ? Record<string, unknown>
      : never;

export {
  isToolError,
  type ToolErrorResult,
  toolErrorOf,
} from "./toolError.ts";

type ToolResultOf<TOutput extends StandardSchemaV1 | undefined> =
  TOutput extends StandardSchemaV1
    ? StandardSchemaV1.InferInput<TOutput>
    : unknown;

/**
 * What `run` returns, by whether the tool has an `output` schema: the schema's
 * input type, or whatever `run` gives (`TReturn`, inferred from the body).
 */
type ToolRunReturn<
  TOutput extends StandardSchemaV1 | undefined,
  TReturn,
> = TOutput extends StandardSchemaV1
  ?
      | (ToolResultOf<TOutput> | ToolErrorResult)
      | Promise<ToolResultOf<TOutput> | ToolErrorResult>
  : TReturn | Promise<TReturn>;

/**
 * What a model passes to a tool: its input schema's output, or an empty
 * object when it has none.
 */
export type ToolCallInput<TInput extends ToolInput | undefined> =
  TInput extends ToolInput ? ToolInputOf<TInput> : Record<string, never>;

/**
 * What a tool hands back after its output schema checked it, or `unknown`
 * when it has none.
 */
export type ToolCallResult<
  TOutput extends StandardSchemaV1 | undefined,
  TReturn = unknown,
> = TOutput extends StandardSchemaV1
  ? StandardSchemaV1.InferOutput<TOutput>
  : // Without a schema the output is the JSON `run`'s return comes back as: a
    // tool error is not a value of the output.
    unknown extends TReturn
    ? unknown
    : Jsonify<Exclude<Awaited<TReturn>, ToolErrorResult>>;

/**
 * A tool declared with `tool.step()` or `tool.group()`. `TInput` and
 * `TOutput` are what the model passes and what the tool gives back, which
 * `agent.loop()` uses to type its tool runs.
 */
export type ToolCallContext = Omit<SandboxToolContext, "runId" | "score"> & {
  /**
   * The ID of the run that is calling, when the caller knows it. Otherwise
   * the running function's.
   */
  runId?: string;
};

export interface SandboxTool<TInput = unknown, TOutput = unknown> {
  readonly description?: string;
  readonly displayName?: string | ((input: never) => string);
  readonly group?: boolean;
  /**
   * @internal Only for tools made by the SDK (`internalTool`): `"none"`
   * answers inline, storing nothing.
   */
  readonly memo?: "none";
  readonly input?: ToolInput;
  readonly output?: StandardSchemaV1;
  readonly run: (...args: never[]) => unknown;

  /**
   * Set by `tool.group({ waits: true })`.
   */
  readonly waits?: boolean;

  /**
   * Marks the tool's results as text from outside, so the model reads them
   * as data. `true`, or a function of the input that gives the source label.
   * Set on every tool of an MCP server.
   */
  readonly untrusted?: true | ((input: never) => string);

  /**
   * Carries `TInput` and `TOutput` for the compiler. It is never set.
   */
  readonly "~types"?: { input: TInput; output: TOutput };
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
  | InngestFunctionReference.Any
  | McpServer;

export type SandboxTools = Record<string, SandboxToolEntry>;

/**
 * What a model passes to the tool `TEntry`; `unknown` for an entry that
 * isn't a typed tool (a plain function or an Inngest function).
 */
export type ToolInputType<TEntry> = TEntry extends SandboxTool<
  infer TInput,
  unknown
>
  ? TInput
  : TEntry extends (...args: infer TArgs) => unknown
    ? // A plain function takes the model's input object as its one argument.
      TArgs extends [infer TFirst, ...unknown[]]
      ? TFirst
      : Record<string, never>
    : unknown;

/**
 * What the tool `TEntry` gives back: the output of a typed tool, or what a
 * plain function returns, once awaited.
 */
export type ToolOutputType<TEntry> = TEntry extends SandboxTool<
  unknown,
  infer TOutput
>
  ? TOutput
  : TEntry extends (...args: never[]) => infer TResult
    ? Awaited<TResult>
    : unknown;

export interface SandboxToolOptions {
  /**
   * The longest one wait step blocks before a fresh one continues. It is a
   * ceiling, not a delay: a wait ends soon after the process exits or a tool
   * is called. Default 20s, or 60s for a command that may run past five minutes. At most 240s.
   */
  waitWindow?: SandboxDuration;

  /**
   * How long one tool call, or one shim handler, may run before its step
   * fails. Default 30s.
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

  /**
   * EXPERIMENTAL: Programs on `PATH` that call a handler in your app, made
   * with `tool.shim()`, and nothing else. See `shims.ts`. Count as tools for
   * the command's limits.
   */
  shims?: readonly SandboxShim[];
}

export type SandboxToolsRequest = SandboxToolsOptions & {
  tools: SandboxTools;

  /**
   * The binary handler shims need, put into the sandbox before the command.
   */
  binary?: ToolBinary;

  /**
   * What the process runs in place of the operation's command: the command
   * wrapped in its shims. The operation keeps the user's command, which is
   * what the trace shows.
   */
  command?: string[];

  /**
   * The command's own timeout, which may pass the five minutes one exec can
   * wait: the command is a process and steps follow it in windows.
   */
  timeoutMs?: number;
};

export interface ToolDefinition<
  TInput extends ToolInput | undefined,
  TOutput extends StandardSchemaV1 | undefined,
  TReturn = unknown,
  TSandbox = Sandbox,
> {
  /**
   * What the tool does, for the people reading the code.
   */
  description?: string;

  /**
   * Marks the tool's results as text from outside: when the model reads one,
   * the SDK wraps it in `<untrusted>` tags, so the model treats it as data and
   * not as instructions. Sandbox code calling the tool gets the plain result.
   * `true`, or a function of the input that gives the source label.
   */
  untrusted?: true | ((input: ToolInputOf<TInput>) => string);

  /**
   * What the tool's step is called in a trace, such as `Look up: cus_1`. A
   * function gets the call's arguments. Default: the tool's name.
   */
  displayName?: string | ((input: ToolInputOf<TInput>) => string);

  /**
   * Any Standard Schema, or a JSON Schema object. With it, sandbox code calls
   * the tool with named arguments (`tools.getCustomer(id="cus_1")`) and, with
   * a Standard Schema, a bad call gets a `ToolError` back without running
   * anything. Without it the tool takes positional JSON values.
   */
  input?: TInput;

  /**
   * Any Standard Schema. A result that doesn't match fails the tool step.
   */
  output?: TOutput;

  run: TInput extends ToolInput
    ? (
        input: ToolInputOf<TInput>,
        ctx: SandboxToolContext<TSandbox>,
      ) => ToolRunReturn<TOutput, TReturn>
    : (
        input: Record<string, never>,
        ctx: SandboxToolContext<TSandbox>,
      ) => ToolRunReturn<TOutput, TReturn>;
}

/**
 * What a group tool that may wait for a long time declares on top of the rest.
 */
export interface WaitingToolDefinition<
  TInput extends ToolInput | undefined,
  TOutput extends StandardSchemaV1 | undefined,
  TReturn = unknown,
  TSandbox = Sandbox,
> extends ToolDefinition<TInput, TOutput, TReturn, TSandbox> {
  /**
   * The tool may wait for longer than a command may run (sleep, wait for an
   * event, wait for a person). A call to it suspends the code that made it:
   * its process exits, the body runs here as steps with no command running,
   * and the command starts again with every earlier call answered from a
   * journal. The code must make the same calls in the same order each time it
   * runs, so it reads clocks and randomness through tools. Use it in a command
   * that runs one interpreter, such as a script: a shell running several
   * would replay the same journal in each.
   */
  waits?: boolean;
}

/**
 * EXPERIMENTAL: What a shared tool's `run` receives besides its input: the
 * function context of the run that hosts it, so it has the usual step tools.
 */
export type SharedToolContext = Pick<
  Context.Any,
  "step" | "runId" | "event" | "attempt"
> & { logger: Logger };

/**
 * EXPERIMENTAL: What `tool.shared()` takes.
 */
export interface SharedToolDefinition<
  TInput extends StandardSchemaV1,
  TOutput extends StandardSchemaV1 | undefined,
  TReturn = unknown,
> {
  /**
   * The ID of the function that hosts the tool, and the second half of its
   * address `"<app>/<id>"`.
   */
  id: string;

  /**
   * What the tool does. It is the card's description unless `card` sets one,
   * and the description the model reads.
   */
  description?: string;

  /**
   * Any Standard Schema that describes an object. It becomes the schema of
   * the hosted function's `invoke()` trigger, so callers in other apps are
   * checked against it.
   */
  input: TInput;

  /**
   * Any Standard Schema. A result that doesn't match fails the call.
   */
  output?: TOutput;

  /**
   * What the tool's card says: `description`, `tags`, `share`, `owner`,
   * `effects` and `speed`. The defaults are those of an agent's card.
   */
  card?: AgentCardConfig;

  /**
   * Marks the tool's results as text from outside, like `tool()`'s
   * `untrusted`.
   */
  untrusted?: true | ((input: ToolInputOf<TInput>) => string);

  /**
   * What the tool's step is called in a trace. Default: the tool's name.
   */
  displayName?: string | ((input: ToolInputOf<TInput>) => string);

  /**
   * Runs in the hosting app, in a function of its own, with that app's
   * secrets. Every call is one run of that function.
   */
  run: (
    input: ToolInputOf<TInput>,
    ctx: SharedToolContext,
  ) => ToolRunReturn<TOutput, TReturn>;
}

/**
 * EXPERIMENTAL: A tool made with `tool.shared()`: hosted by one app and
 * callable from others. List it in `createAgents(client, { tools })` to host
 * it. List it in an agent's `tools` to call it like any tool.
 */
export interface SharedTool<TInput = unknown, TOutput = unknown>
  extends SandboxTool<TInput, TOutput> {
  readonly kind: "inngest/shared-tool";
  readonly id: string;
  readonly card?: AgentCardConfig;

  /**
   * `"<app>/<id>"`, once an app hosts the tool. Reading it earlier throws.
   * It lets the tool stand in `discovery.tools` like an imported agent.
   */
  readonly address: string;
}

/**
 * Whether `entry` was made with `tool.shared()`.
 */
export const isSharedTool = (entry: unknown): entry is SharedTool => {
  return (
    typeof entry === "object" &&
    entry !== null &&
    (entry as { kind?: unknown }).kind === "inngest/shared-tool"
  );
};

/**
 * The app that hosts each shared tool, set when `createAgents(client, { tools })`
 * lists it.
 */
const sharedHosts = new WeakMap<object, string>();

/**
 * Records that `appId` hosts `shared`.
 */
export const hostSharedTool = (shared: SharedTool, appId: string): void => {
  sharedHosts.set(shared, appId);
};

/**
 * The app that hosts `shared`, once `createAgents` has listed it.
 */
export const hostOfSharedTool = (shared: SharedTool): string | undefined => {
  return sharedHosts.get(shared);
};

/**
 * A tool that calls the function `functionId` of app `appId` as a durable step
 * and gives back its result. A shared tool supplies its description, schema
 * and labels; a discovered tool has only what its card says.
 */
export const invokeHostedTool = (options: {
  appId: string;
  functionId: string;
  description?: string;
  input?: ToolInput;
  untrusted?: SandboxTool["untrusted"];
  displayName?: SandboxTool["displayName"];
}): SandboxTool => {
  const target = new InngestFunctionReference({
    appId: options.appId,
    functionId: options.functionId,
  });

  return {
    group: true,
    ...(options.description !== undefined && {
      description: options.description,
    }),
    input: options.input ?? z4.record(z4.string(), z4.unknown()),
    ...(options.untrusted && { untrusted: options.untrusted }),
    ...(options.displayName && { displayName: options.displayName }),
    run: (data: Record<string, unknown>) => {
      return step.invoke("invoke", { function: target, data });
    },
  } as SandboxTool;
};

/**
 * EXPERIMENTAL: `tool.step()` declares a tool that sandbox code can call. It
 * runs its body as one durable step.
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
const toolMethods = {
  step: <
    TInput extends ToolInput | undefined = undefined,
    TOutput extends StandardSchemaV1 | undefined = undefined,
    TReturn = unknown,
  >(
    definition: ToolDefinition<TInput, TOutput, TReturn>,
  ): SandboxTool<ToolCallInput<TInput>, ToolCallResult<TOutput, TReturn>> => {
    return rememberToolSource(definition, callSite());
  },

  /**
   * EXPERIMENTAL: A tool one app hosts and other apps' agents discover and
   * call, so an app can post to X or charge a card without knowing how.
   * List it in `createAgents(client, { tools })`: `agents.functions()` then
   * serves it as a function with an `invoke()` trigger built from `input`,
   * and its card is announced with the agents' cards (kind `"tool"`, address
   * `"<app>/<id>"`). Each call is a run of that function in the hosting app,
   * where its secrets are.
   *
   * Listed in an agent's `tools`, it is called like any tool: the call
   * invokes the hosted function as a durable step and returns the result in
   * the same turn. Other apps' agents get it through `discovery.tools`.
   *
   * @example
   * ```ts
   * export const postToX = tool.shared({
   *   id: "post-to-x",
   *   input: z.object({ text: z.string() }),
   *   card: { description: "Posts to X as Acme", tags: ["social"], share: "team", effects: "write" },
   *   run: async ({ text }, { step }) => {
   *     return await step.run("post", () => x.post(text));
   *   },
   * });
   *
   * createAgents(inngest, { tools: [postToX] });
   * ```
   */
  shared: <
    TInput extends StandardSchemaV1,
    TOutput extends StandardSchemaV1 | undefined = undefined,
    TReturn = unknown,
  >(
    definition: SharedToolDefinition<TInput, TOutput, TReturn>,
  ): SharedTool<ToolCallInput<TInput>, ToolCallResult<TOutput, TReturn>> => {
    if (!definition.id || definition.id.includes("/")) {
      throw new SandboxValidationError(
        `Shared tool id "${definition.id}" must be a non-empty function ID without "/"`,
      );
    }

    const made = { ...definition, kind: "inngest/shared-tool" as const };
    const source = callSite();

    // Like an agent's `address`: it names the tool in `discovery.tools`.
    // It exists once an app hosts the tool.
    Object.defineProperty(made, "address", {
      enumerable: false,
      get: () => {
        const appId = sharedHosts.get(made);

        if (!appId) {
          throw new SandboxValidationError(
            `The shared tool "${definition.id}" has no address yet: list it in createAgents(client, { tools }) in its app first, or name another app's tool by its "app/id" address`,
          );
        }

        return `${appId}/${definition.id}`;
      },
    });

    return rememberToolSource(
      Object.freeze(made) as unknown as SharedTool<
        ToolCallInput<TInput>,
        ToolCallResult<TOutput, TReturn>
      >,
      source,
    );
  },

  /**
   * EXPERIMENTAL: Declares a program that stands in for the real one inside a
   * sandbox command. Pass it in `shims` on `commands.run()` or `$`. When
   * code runs the program, the handler runs here, in your app, and decides
   * what happens: `run()` the real program (as called, or with another
   * `argv`, extra `env` or `stdin`), `reply()` with an exit code and
   * output, or `refuse()`. The handler gets the `sandbox`, so it can do work
   * that needs a credential in your app and reply with the result. See
   * `shims.ts`.
   *
   * `tool.shim.config()` exposes plain settings to the sandbox.
   *
   * @example
   * ```ts
   * const terraform = tool.shim("terraform", ({ argv, run, refuse }) => {
   *   return argv[0] === "apply"
   *     ? refuse("apply goes through a pull request")
   *     : run();
   * });
   *
   * await sandbox.$({ shims: [terraform] }).sh`terraform plan`;
   * ```
   */
  shim,

  /**
   * EXPERIMENTAL: A remote MCP server as tools. Put the handle in
   * `agent.loop({ tools: { hex } })` and the model sees the server's tools
   * as `hex_<tool>`. For a sandbox's `run_code`, use
   * `sandbox.tools.runCode.with({ tools: await hex.tools() })`. Each call is a
   * durable step that reads the credential inside the call.
   *
   * @example
   * ```ts
   * const hex = tool.mcp({
   *   id: "hex",
   *   url: "https://app.hex.tech/mcp",
   *   auth: { bearer: secret("HEX_TOKEN") },
   *   tools: ["create_thread", "get_thread"],
   * });
   *
   * await agent.loop({ model, prompt, tools: { hex } });
   * ```
   */
  mcp,

  /**
   * EXPERIMENTAL: Declares a tool whose body is a group of steps. Instead of
   * running as one durable step, `run` can use the global `step`
   * (`import { step } from "inngest"`) to run steps, invoke functions, send
   * events and wait for events. Each call's steps are scoped to that call.
   *
   * Listed on a sandbox, the tool's `context.sandbox` is that sandbox's
   * durable `SandboxHandle`, for the model's calls and sandbox code's alike.
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
    TInput extends ToolInput | undefined = undefined,
    TOutput extends StandardSchemaV1 | undefined = undefined,
    TReturn = unknown,
  >(
    definition: WaitingToolDefinition<TInput, TOutput, TReturn, SandboxHandle>,
  ): SandboxTool<ToolCallInput<TInput>, ToolCallResult<TOutput, TReturn>> => {
    return rememberToolSource({ ...definition, group: true }, callSite());
  },
};

/**
 * A tool defined with `tool()`: a tool for an agent, which runs in your
 * function as one durable step per call.
 */
export interface AgentTool<TInput = unknown, TOutput = unknown>
  extends SandboxTool<TInput, TOutput> {
  readonly kind: "inngest/tool";

  /**
   * The name the tool is listed under, when you gave one. In a `tools` record
   * the key names the tool, whatever this is.
   */
  readonly id?: string;
}

export interface AgentToolDefinition<
  TInput extends ToolInput | undefined,
  TOutput extends StandardSchemaV1 | undefined,
  TReturn = unknown,
> extends WaitingToolDefinition<TInput, TOutput, TReturn> {
  /**
   * The tool's name for a list of tools without keys (`agentTools()`). Optional:
   * in a `tools` record the key names the tool. Letters, digits and
   * underscores, starting with a letter, up to 64 characters.
   */
  id?: string;

  /**
   * Runs `run` as a group of steps instead of one step, so it can use the
   * global `step` (see `tool.group()`).
   */
  group?: boolean;
}

const defineTool = <
  TInput extends ToolInput | undefined = undefined,
  TOutput extends StandardSchemaV1 | undefined = undefined,
  TReturn = unknown,
>(
  definition: AgentToolDefinition<TInput, TOutput, TReturn>,
): AgentTool<ToolCallInput<TInput>, ToolCallResult<TOutput, TReturn>> => {
  if (definition.id !== undefined) {
    validateTools({ [definition.id]: definition });
  }

  if (definition.waits && !definition.group) {
    throw new SandboxValidationError(
      `Tool "${definition.id}" sets waits, which needs group: true: a tool that waits runs as a group of steps`,
    );
  }

  return rememberToolSource(
    Object.freeze({ ...definition, kind: "inngest/tool" as const }),
    callSite(),
  );
};

/**
 * EXPERIMENTAL: Defines a tool for an agent. It runs in your function, where
 * your clients and secrets are, and each call is a durable step. Define it at
 * module scope and name it in an agent's `tools`. `tool.step()` and
 * `tool.group()` declare tools for code in a sandbox.
 *
 * @example
 * ```ts
 * export const getOrg = tool({
 *   id: "getOrg",
 *   input: z.object({ slug: z.string() }),
 *   run: async ({ slug }) => {
 *     return orgs.find(slug);
 *   },
 * });
 * ```
 */
export const tool = Object.assign(defineTool, toolMethods);

/**
 * The schema of the data a function takes, when its triggers say: that of its
 * `invoke()` trigger, or of its only event trigger with a schema.
 */
export const triggerSchema = (
  fn: InngestFunction.Any,

  /**
   * Take only the schema of an `invoke()` trigger, never that of another
   * event.
   */
  invokeOnly = false,
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
    const name =
      trigger.event instanceof EventType ? trigger.event.name : trigger.event;

    return name === internalEvents.FunctionInvoked;
  });

  return (invoked ?? (!invokeOnly && typed.length === 1 ? typed[0] : undefined))
    ?.schema;
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
  if (entry instanceof McpServer) {
    throw new SandboxValidationError(
      "This tools record can't expand an MCP server here; spread its tools instead: { ...(await server.tools()) }",
    );
  }

  if (typeof entry === "function") {
    return { run: entry };
  }

  if (isSharedTool(entry)) {
    const appId = sharedHosts.get(entry);

    if (!appId) {
      throw new SandboxValidationError(
        `The shared tool "${entry.id}" is not hosted by any app in this process: list it in createAgents(client, { tools }) in its app, or reach it from another app with discovery.tools`,
      );
    }

    return invokeHostedTool({
      appId,
      functionId: entry.id,
      description: entry.description ?? entry.card?.description,
      input: entry.input,
      untrusted: entry.untrusted,
      displayName: entry.displayName,
    });
  }

  return entry instanceof InngestFunction ||
    entry instanceof InngestFunctionReference
    ? functionTool(entry)
    : entry;
};

/**
 * Whether a call to `name` suspends the code that made it. An unknown name
 * doesn't: the call gets its error like any other.
 */
export const callWaits = (tools: SandboxTools, name: string): boolean => {
  return (
    Object.hasOwn(tools, name) &&
    toTool(tools[name] as SandboxToolEntry).waits === true
  );
};

/**
 * Wraps a tool listed on a sandbox so that it acts on that machine: a
 * `tool.group()` gets `handle` as `context.sandbox`, whoever calls it, and
 * `name` (the sandbox's key) is added to its description. Other entries (plain
 * functions, Inngest functions, MCP servers, `tool.step()`, and tools the SDK
 * built) are returned as they are. Called when a sandbox is opened for a run.
 */
export const bindSandbox = (
  entry: SandboxToolEntry,
  handle: SandboxHandle,
  name?: string,
): SandboxToolEntry => {
  if (
    typeof entry !== "object" ||
    entry === null ||
    entry instanceof McpServer ||
    entry instanceof InngestFunction ||
    entry instanceof InngestFunctionReference ||
    isSharedTool(entry) ||
    isInternalTool(entry) ||
    typeof (entry as SandboxTool).run !== "function"
  ) {
    return entry;
  }

  const bound = entry as SandboxTool;
  const run = bound.run as (...args: unknown[]) => unknown;
  const note = name === undefined ? "" : `Works on the \`${name}\` sandbox.`;
  const description = [bound.description, note].filter(Boolean).join(" ");
  const result = {
    ...bound,
    ...(description && { description }),
    ...(bound.group === true && {
      // The context is the last argument, after the call's values.
      run: (...args: unknown[]) => {
        const ctx = args.pop() as SandboxToolContext;

        return run(...args, { ...ctx, sandbox: handle });
      },
    }),
  } as SandboxTool;
  const live = liveDescriptions.get(bound);

  if (live) {
    liveDescriptions.set(result, () => {
      return [live(), note].filter(Boolean).join(" ");
    });
  }

  return result;
};

/**
 * Tools whose description is made when the model's tool list is, inside the
 * run, because it names what that run gives them (`runCode` lists the tools
 * its code can call). Internal.
 */
export const liveDescriptions = new WeakMap<object, () => string>();

/**
 * A JSON Schema type as a short TypeScript-like type.
 */
const shortType = (schema: unknown): string => {
  const node = (schema ?? {}) as {
    type?: unknown;
    enum?: unknown[];
    items?: unknown;
    anyOf?: unknown[];
  };

  if (Array.isArray(node.enum)) {
    return node.enum
      .map((value) => {
        return JSON.stringify(value);
      })
      .join(" | ");
  }

  if (Array.isArray(node.anyOf)) {
    return node.anyOf.map(shortType).join(" | ");
  }

  if (node.type === "array") {
    return `${shortType(node.items)}[]`;
  }

  if (node.type === "integer") {
    return "number";
  }

  return typeof node.type === "string" ? node.type : "any";
};

/**
 * One line that says how code calls a tool: `tools.name({ a: string, b?:
 * number })` and the first sentence of its description. Internal.
 * @param name The name the tool is listed under.
 * @param entry The tool.
 */
export const toolSignature = (
  name: string,
  entry: SandboxToolEntry,
): string => {
  let args = "";
  let about = "";

  try {
    const { description, input } = toTool(entry);
    const schema = (
      !input
        ? { type: "object" }
        : isStandardSchema(input)
          ? toJsonSchema(name, input)
          : input
    ) as { properties?: Record<string, unknown>; required?: string[] };
    const required = new Set(schema.required ?? []);

    args = Object.entries(schema.properties ?? {})
      .map(([key, value]) => {
        return `${key}${required.has(key) ? "" : "?"}: ${shortType(value)}`;
      })
      .join(", ");
    about = description?.split(/(?<=\.)\s/)[0] ?? "";
  } catch {
    // A tool whose schema can't be shown is still listed by name.
  }

  return `tools.${name}(${args ? `{ ${args} }` : ""})${about ? `: ${about}` : ""}`;
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
    h: z.string().max(64).optional(),
  }),
  z.object({ op: z.literal("yielded") }),
  z.object({ op: z.literal("replayed") }),
  z.object({
    op: z.literal("exit"),
    code: z.number().int(),
    stdout: z.string(),
    stderr: z.string(),
    stdoutBytes: z.number().int().nonnegative().optional(),
    stderrBytes: z.number().int().nonnegative().optional(),
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

export const issuesMessage = (
  issues: readonly StandardSchemaV1.Issue[],
): string => {
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
  options: {
    /**
     * The model is calling: its input object is the one positional argument
     * of a plain function. Sandbox code keeps passing positional values.
     */
    fromModel?: boolean;
  } = {},
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
    const named = kwargs ?? (args.length ? args[0] : {});

    if (isStandardSchema(definition.input)) {
      const result = await definition.input["~standard"].validate(named);
      if (result.issues) {
        return {
          error: `Invalid arguments for ${name}: ${issuesMessage(result.issues)}`,
        };
      }

      values = [result.value];
    } else {
      values = [named];
    }
  } else if (options.fromModel) {
    // The model's input object is the one argument, empty when it sent none.
    values = [kwargs ?? {}];
  } else if (kwargs) {
    return { error: `${name} takes positional arguments only` };
  } else if (args.length === 0 && typeof entry !== "function") {
    // A tool with no input schema, called with nothing, gets an empty object.
    values = [{}];
  }

  const { displayName } = definition;
  const label = definition.untrusted;

  return {
    group: definition.group === true,
    displayName:
      typeof displayName === "function"
        ? (displayName as (input: unknown) => string)(values[0])
        : displayName,
    memo:
      isInternalTool(entry) && definition.memo === "none" ? "none" : undefined,

    /**
     * Set when the tool's results are text from outside: the model reads them
     * wrapped, with this source label if there is one.
     */
    untrusted:
      label === undefined
        ? undefined
        : {
            source:
              typeof label === "function"
                ? label(values[0] as never)
                : undefined,
          },
    invoke: async (given: ToolCallContext) => {
      const ctx: SandboxToolContext = {
        ...given,
        runId: given.runId ?? getAsyncCtxSync()?.execution?.ctx.runId ?? "",
        score: toolScore,
      };
      // A plain function takes positional values and no context.
      const value = await run(
        ...values,
        ...(typeof entry === "function" ? [] : [ctx]),
      );
      if (!definition.output || isToolError(value)) {
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
   * JSON Schema of the arguments, which always describes an object. A tool
   * without an `input` schema takes any object.
   */
  input_schema: { type: "object"; [key: string]: unknown };
}

type JsonSchemaProvider = {
  jsonSchema?: {
    input: (options: { target: string }) => Record<string, unknown>;
  };
};

export const toJsonSchema = (
  name: string,
  schema: StandardSchemaV1,
): ToolJsonDefinition["input_schema"] => {
  const provider = schema["~standard"] as JsonSchemaProvider;
  let json: Record<string, unknown>;

  if (provider.jsonSchema) {
    json = provider.jsonSchema.input({ target: "draft-2020-12" });
  } else if ("_zod" in schema) {
    json = z4.toJSONSchema(schema as unknown as z4.ZodType);
  } else {
    throw new SandboxValidationError(
      `Tool "${name}" has a schema that can't be turned into JSON Schema: use Zod 4 or a library that implements Standard JSON Schema`,
    );
  }

  if (json.type !== "object") {
    throw new SandboxValidationError(
      `Tool "${name}" has an input schema that isn't an object: models call tools with named arguments`,
    );
  }

  return { ...json, type: "object" };
};

/**
 * EXPERIMENTAL: The definitions to hand to a model so it can call `tools`:
 * each tool's name, description and JSON Schema, in the shape Anthropic's
 * `tools` parameter takes (`{ name, description, input_schema }`).
 *
 * For OpenAI, map each one to
 * `{ type: "function", name, description, parameters: input_schema }`.
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
    const { input } = toTool(entry);
    const description =
      (typeof entry === "object" && entry !== null
        ? liveDescriptions.get(entry)?.()
        : undefined) ?? toTool(entry).description;

    return {
      name,
      ...(description !== undefined && { description }),
      input_schema: !input
        ? { type: "object" }
        : isStandardSchema(input)
          ? toJsonSchema(name, input)
          : input,
    };
  });
};
