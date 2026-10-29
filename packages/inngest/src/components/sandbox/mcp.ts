/**
 * @module
 * EXPERIMENTAL: `tool.mcp()`, a remote MCP server as tools. The server's
 * tools appear to the model (and to sandbox code) as ordinary tools named
 * `<name>_<tool>`. Each call runs here, in your function, as one durable step
 * with the credential read inside that step, so the credential never reaches
 * the model, a sandbox, a step output or a trace.
 *
 * The tool list is read once per run, in a step, so a replay sees the list
 * the model saw. A failure after the request was sent is not retried for a
 * tool that may change things: the model is told the outcome is unknown and
 * decides. Tools the server marks `readOnlyHint` or `idempotentHint` retry.
 */
import { durationToMs } from "../../helpers/duration.ts";
import { version } from "../../version.ts";
import { step } from "../InngestStepTools.ts";
import {
  type McpCallResult,
  McpClient,
  McpOutcomeUnknownError,
  McpProtocolError,
  type McpToolInfo,
} from "./mcpClient.ts";
import { isSecret, type Secret } from "./secret.ts";
import { toolErrorOf } from "./toolError.ts";
import type { SandboxTool, SandboxTools } from "./tools.ts";
import { type SandboxDuration, SandboxValidationError } from "./types.ts";

/**
 * The most a result may weigh before it is stored in a step: the start and
 * end are kept.
 */
export const maxMcpResultBytes = 256 * 1024;

const maxDescriptionLength = 1000;
const defaultCallTimeout = "60s";
const listTimeoutMs = 15_000;

/**
 * How a server is told who you are. `bearer` sends `Authorization: Bearer`;
 * `headers` sends the headers you name. Values may be `secret()`s, which are
 * read inside the call.
 */
export type McpAuth =
  | { bearer: string | Secret }
  | { headers: Record<string, string | Secret> };

export interface McpServerOptions {
  /**
   * The name that prefixes the server's tools when you call `tools()`. In
   * `agent.loop({ tools: { hex } })` the key (`hex`) is the name instead.
   */
  id?: string;

  /**
   * The server's Streamable HTTP endpoint. Must be `https:`, or `http:` for
   * localhost. Redirects are not followed.
   */
  url: string;

  /**
   * Credentials. Default none.
   */
  auth?: McpAuth;

  /**
   * Only these tools, by the server's names. Default all of them. A name the
   * server doesn't have throws when the tools are listed.
   */
  tools?: string[];

  /**
   * The longest one call may take. Default 60s.
   */
  timeout?: SandboxDuration;

  /**
   * A `fetch` to use instead of the global one, for tests.
   */
  fetch?: typeof fetch;
}

/**
 * What the list step stores: the server's tools, trimmed. Holds no credential.
 */
export interface McpListing {
  tools: McpToolInfo[];
}

const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

const validateOptions = (options: McpServerOptions): void => {
  let url: URL;

  try {
    url = new URL(options.url);
  } catch {
    throw new SandboxValidationError(
      `tool.mcp() needs a full url: "${options.url}" is not one`,
    );
  }

  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && localHosts.has(url.hostname))
  ) {
    throw new SandboxValidationError(
      `tool.mcp() url must be https (http is only allowed for localhost): ${url.origin}`,
    );
  }

  if (url.username || url.password) {
    throw new SandboxValidationError(
      "tool.mcp() url must not hold credentials: use auth",
    );
  }
};

const resolveAuth = async (auth: McpAuth | undefined) => {
  const headers: Record<string, string> = {};
  const secrets: string[] = [];
  const read = async (value: string | Secret): Promise<string> => {
    const text = isSecret(value) ? await value.value() : value;

    secrets.push(text);

    return text;
  };

  if (auth && "bearer" in auth) {
    headers.authorization = `Bearer ${await read(auth.bearer)}`;
  } else if (auth) {
    for (const [name, value] of Object.entries(auth.headers)) {
      headers[name.toLowerCase()] = await read(value);
    }
  }

  return { headers, secrets };
};

const encoder = new TextEncoder();

const byteLength = (text: string): number => {
  return encoder.encode(text).byteLength;
};

/**
 * Keeps the start and end of `text` and says how much is missing.
 */
const clip = (text: string): string => {
  const total = byteLength(text);

  if (total <= maxMcpResultBytes) {
    return text;
  }

  const keep = Math.floor(maxMcpResultBytes / 4);

  return `${text.slice(0, keep)}\n[truncated ${total - 2 * keep} bytes]\n${text.slice(-keep)}`;
};

const textOf = (result: McpCallResult): string => {
  return (result.content ?? [])
    .map((block) => {
      return block.type === "text" && typeof block.text === "string"
        ? block.text
        : "";
    })
    .filter(Boolean)
    .join("\n");
};

/**
 * What a tool call gives back: `structuredContent` if the server sent it, a
 * single text block as a string, otherwise the blocks, with image and audio
 * data replaced by their size. `isError` becomes an error result.
 */
export const mapMcpResult = (result: McpCallResult): unknown => {
  if (result.isError) {
    return toolErrorOf(clip(textOf(result) || "The tool failed"));
  }

  let value: unknown;

  if (result.structuredContent !== undefined) {
    value = result.structuredContent;
  } else {
    const blocks = result.content ?? [];

    if (blocks.length === 1 && blocks[0]?.type === "text") {
      value = blocks[0].text ?? "";
    } else {
      value = blocks.map((block) => {
        if (typeof block.data === "string") {
          const { data, ...rest } = block;

          return {
            ...rest,
            bytes: Math.floor((data.length * 3) / 4),
          };
        }

        return block;
      });
    }
  }

  if (typeof value === "string") {
    return clip(value);
  }

  const json = JSON.stringify(value) ?? "null";

  return byteLength(json) <= maxMcpResultBytes ? value : clip(json);
};

const sanitise = (name: string): string => {
  return name.replace(/[-.]/g, "_");
};

/**
 * EXPERIMENTAL: A remote MCP server, made with `tool.mcp()`. Put it in
 * `agent.loop({ tools: { hex } })`, or get its tools as a plain record with
 * `await hex.tools()`.
 */
export class McpServer {
  readonly url: string;
  readonly id?: string;
  readonly #options: McpServerOptions;
  readonly #client: McpClient;
  readonly #timeoutMs: number;

  constructor(options: McpServerOptions) {
    validateOptions(options);

    this.url = options.url;
    this.id = options.id;
    this.#options = options;
    this.#timeoutMs = durationToMs(options.timeout ?? defaultCallTimeout, {
      name: "tool.mcp() timeout",
    });
    this.#client = new McpClient({
      url: options.url,
      fetch: options.fetch,
      clientVersion: version,
      auth: () => {
        return resolveAuth(options.auth);
      },
    });
  }

  /**
   * The server's tools as a plain record named `<name>_<tool>`, for
   * `sandbox.tools.code({ tools })` or to wrap single tools. The list is
   * read in a step. `name` is the prefix; default the `id` option.
   */
  async tools(name: string | undefined = this.id): Promise<SandboxTools> {
    if (name === undefined) {
      throw new SandboxValidationError(
        "tools() needs a name: pass one, or give tool.mcp() an id",
      );
    }

    const listing = await step.run(
      { id: `mcp:${name}:list`, name: `List ${name} tools` },
      () => {
        return this["~list"]();
      },
    );

    return this["~build"](name, listing);
  }

  /**
   * @internal Reads the tool list from the server.
   */
  async "~list"(): Promise<McpListing> {
    const found = await this.#client.listTools({ timeoutMs: listTimeoutMs });

    return {
      tools: found.map((info) => {
        return {
          name: info.name,
          ...(info.description !== undefined && {
            description: info.description.slice(0, maxDescriptionLength),
          }),
          inputSchema: {
            ...(info.inputSchema ?? {}),
            type: "object" as const,
          },
          ...(info.annotations && {
            annotations: {
              readOnlyHint: info.annotations.readOnlyHint,
              idempotentHint: info.annotations.idempotentHint,
              destructiveHint: info.annotations.destructiveHint,
            },
          }),
        };
      }),
    };
  }

  /**
   * @internal Makes the tools of a listing, named `<name>_<tool>`.
   */
  "~build"(name: string, listing: McpListing): SandboxTools {
    const allowed = this.#options.tools;
    const known = new Set(
      listing.tools.map((info) => {
        return info.name;
      }),
    );

    for (const wanted of allowed ?? []) {
      if (!known.has(wanted)) {
        throw new SandboxValidationError(
          `MCP server "${name}" has no tool "${wanted}". It offers: ${[...known].join(", ") || "none"}`,
        );
      }
    }

    const built: SandboxTools = {};

    for (const info of listing.tools) {
      if (allowed && !allowed.includes(info.name)) {
        continue;
      }

      const key = `${name}_${sanitise(info.name)}`;

      if (Object.hasOwn(built, key)) {
        throw new SandboxValidationError(
          `Two tools of MCP server "${name}" are named "${key}" once "-" and "." become "_"`,
        );
      }

      built[key] = {
        ...(info.description !== undefined && {
          description: info.description,
        }),
        input: info.inputSchema,
        run: (input: Record<string, unknown>, ctx) => {
          return this.#call(info, input, ctx);
        },
      } as SandboxTool;
    }

    return built;
  }

  async #call(
    info: McpToolInfo,
    input: Record<string, unknown>,
    ctx: { signal: AbortSignal; idempotencyKey: string },
  ): Promise<unknown> {
    const repeatable =
      info.annotations?.readOnlyHint === true ||
      info.annotations?.idempotentHint === true;

    try {
      return mapMcpResult(
        await this.#client.callTool(info.name, input, {
          signal: ctx.signal,
          timeoutMs: this.#timeoutMs,
          idempotencyKey: ctx.idempotencyKey,
        }),
      );
    } catch (error) {
      if (error instanceof McpOutcomeUnknownError && !repeatable) {
        return toolErrorOf(
          `Outcome unknown: ${info.name} was sent but no answer came back (${error.message}). It may have taken effect: check before calling it again.`,
        );
      }

      if (error instanceof McpProtocolError) {
        return toolErrorOf(error.message);
      }

      throw error;
    }
  }
}

/**
 * EXPERIMENTAL: A remote MCP server as tools. See `McpServerOptions`.
 */
export const mcp = (options: McpServerOptions): McpServer => {
  return new McpServer(options);
};

/**
 * Replaces each MCP server in `tools` with its tools, named after the key it
 * sits under. The list is a step, `<prefix>:mcp:<key>:list`. `tools` comes
 * back as it is when it holds no server.
 */
export const expandMcpTools = async (
  tools: Record<string, unknown>,
  prefix: string,
): Promise<SandboxTools> => {
  if (
    !Object.values(tools).some((entry) => {
      return entry instanceof McpServer;
    })
  ) {
    return tools as SandboxTools;
  }

  const expanded: SandboxTools = {};
  const add = (name: string, entry: SandboxTools[string]) => {
    if (Object.hasOwn(expanded, name)) {
      throw new SandboxValidationError(`Two tools are named "${name}"`);
    }

    expanded[name] = entry;
  };

  for (const [key, entry] of Object.entries(tools)) {
    if (!(entry instanceof McpServer)) {
      add(key, entry as SandboxTools[string]);

      continue;
    }

    const listing = await step.run(
      { id: `${prefix}:mcp:${key}:list`, name: `List ${key} tools` },
      () => {
        return entry["~list"]();
      },
    );

    for (const [name, built] of Object.entries(entry["~build"](key, listing))) {
      add(name, built);
    }
  }

  return expanded;
};
