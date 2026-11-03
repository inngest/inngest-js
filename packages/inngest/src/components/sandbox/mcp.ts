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

import { traceWarning } from "../../experimental/agents/agent/traceWarning.ts";
import { currentThreadKey } from "../../experimental/agents/kv/kv.ts";
import { kvOAuthStore } from "../../experimental/agents/kv/mcpOAuthStore.ts";
import { durationToMs } from "../../helpers/duration.ts";
import { version } from "../../version.ts";
import { getAsyncCtxSync } from "../execution/als.ts";
import { step } from "../InngestStepTools.ts";
import {
  type McpCallResult,
  McpClient,
  type McpContentBlock,
  McpOutcomeUnknownError,
  McpProtocolError,
  type McpToolInfo,
} from "./mcpClient.ts";
import { assertMcpUrl } from "./mcpGuard.ts";
import {
  McpAuthorizationRequired,
  McpOAuth,
  type McpOAuthOptions,
  type McpOAuthUserContext,
} from "./mcpOAuth.ts";
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
// Under the 30s a sandbox allows a tool call, so the client gives up first and
// the outcome is reported as unknown instead of the step being retried.
const defaultCallTimeout = "25s";
const listTimeoutMs = 15_000;

/**
 * How a server is told who you are. `bearer` sends `Authorization: Bearer`;
 * `headers` sends the headers you name. Values may be `secret()`s, which are
 * read inside the call. `oauth` signs each user in to the server with their
 * own account: see `McpOAuthOptions`.
 */
export type McpAuth =
  | { bearer: string | Secret }
  | { headers: Record<string, string | Secret> }
  | { oauth: McpOAuthOptions };

export interface McpServerOptions {
  /**
   * Names the server. Its stored sign-in tokens are kept under this `id`, so
   * keep it stable: a new `id` makes every user sign in again. It is also the
   * prefix of the tools when you call `tools()`; in
   * `agent.loop({ tools: { hex } })` the key (`hex`) prefixes them instead.
   */
  id: string;

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
   * The longest one call may take. Default 25s. In a sandbox the tool
   * timeout (`toolOptions.toolTimeout`, default 30s) ends a call first, and the
   * step is then retried: raise it above this when you raise this.
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

  /**
   * Set when the user has not connected the server and its tools are not
   * known yet: the only tool is then `<name>_connect`.
   */
  connect?: boolean;
}

const resolveAuth = async (
  auth: Exclude<McpAuth, { oauth: unknown }> | undefined,
) => {
  const headers: Record<string, string> = {};
  const secrets: string[] = [];
  const read = async (
    value: string | Secret,
    redacted: boolean,
  ): Promise<string> => {
    const text = isSecret(value) ? await value.value() : value;

    if (redacted) {
      secrets.push(text);
    }

    return text;
  };

  if (auth && "bearer" in auth) {
    headers.authorization = `Bearer ${await read(auth.bearer, true)}`;
  } else if (auth) {
    for (const [name, value] of Object.entries(auth.headers)) {
      headers[name.toLowerCase()] = await read(value, isSecret(value));
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

// Blocks a server sent that are not objects are ignored.
const blocksOf = (result: McpCallResult): McpContentBlock[] => {
  return (Array.isArray(result.content) ? result.content : []).filter(
    (block) => {
      return typeof block === "object" && block !== null;
    },
  );
};

const textOf = (result: McpCallResult): string => {
  return blocksOf(result)
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
    const blocks = blocksOf(result);

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

const trimListing = (found: McpToolInfo[]): McpListing => {
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
};

interface RunContext {
  user: McpOAuthUserContext;
  logger?: { warn: (message: string) => void };
}

/**
 * What `auth.oauth.user` is told about the run that is calling. Read before
 * the first await: the context does not follow every kind of await.
 */
const currentRunContext = (): RunContext => {
  const execution = getAsyncCtxSync()?.execution;

  if (!execution) {
    return { user: {} };
  }

  const { event, runId } = execution.ctx;
  // The run's own logger, so the warning shows with the run.
  const { logger } = execution.ctx as { logger?: RunContext["logger"] };
  const threadKey = currentThreadKey();

  return {
    logger,
    user: {
      runId,
      ...(event && {
        event: { name: event.name, data: event.data, id: event.id },
      }),
      ...(threadKey !== undefined && { thread: { key: threadKey } }),
    },
  };
};

const sanitise = (name: string): string => {
  return name.replace(/[^A-Za-z0-9_]/g, "_");
};

/**
 * EXPERIMENTAL: A remote MCP server, made with `tool.mcp()`. Put it in
 * `agent.loop({ tools: { hex } })`, or get its tools as a plain record with
 * `await hex.tools()`.
 */
export class McpServer {
  readonly url: string;
  readonly id: string;
  private readonly options: McpServerOptions;
  private readonly client: McpClient;
  private readonly timeoutMs: number;
  private readonly oauth?: McpOAuth;

  constructor(options: McpServerOptions) {
    assertMcpUrl(options.url, "url");

    this.url = options.url;
    this.id = options.id;
    this.options = options;
    this.timeoutMs = durationToMs(options.timeout ?? defaultCallTimeout, {
      name: "tool.mcp() timeout",
    });
    const oauthOptions =
      options.auth && "oauth" in options.auth ? options.auth.oauth : undefined;

    if (oauthOptions) {
      const store = oauthOptions.store ?? kvOAuthStore();

      this.oauth = new McpOAuth(
        oauthOptions,
        { url: options.url, id: options.id },
        () => {
          return store;
        },
        options.fetch,
      );
    }

    const oauth = this.oauth;

    this.client = new McpClient({
      url: options.url,
      fetch: options.fetch,
      clientVersion: version,
      auth: (user) => {
        if (oauth) {
          return oauth.resolve(user ?? "");
        }

        return resolveAuth(
          options.auth as Exclude<McpAuth, { oauth: unknown }> | undefined,
        );
      },
      onUnauthorized: oauth
        ? (user, auth) => {
            return oauth.unauthorized(user ?? "", auth.secrets);
          }
        : undefined,
    });
  }

  /**
   * The server's tools as a plain record named `<name>_<tool>`, for
   * `sandbox.tools.runCode.with({ tools })` or to wrap single tools. The list is
   * read in a step. `name` is the prefix; default the `id` option.
   */
  async tools(name: string = this.id): Promise<SandboxTools> {
    const listing = await step.run(
      { id: `mcp:${name}:list`, name: `List ${name} tools` },
      () => {
        return this["~list"](name);
      },
    );

    return this["~build"](name, listing);
  }

  /**
   * Forgets `user`'s sign-in for this server: their stored token is removed,
   * and they sign in again on their next call.
   */
  async disconnect(
    /** The person, as `auth.oauth.user` named them. */
    user: string,
  ): Promise<void> {
    if (!this.oauth) {
      throw new SandboxValidationError(
        `MCP server "${this.id}" has no auth.oauth, so there is no per-user sign-in to disconnect`,
      );
    }

    await this.oauth.disconnect(user);
  }

  /**
   * @internal Reads the tool list from the server.
   */
  async "~list"(name?: string): Promise<McpListing> {
    const oauth = this.oauth;
    const run = currentRunContext();
    let found: McpToolInfo[];

    if (oauth) {
      const user = await oauth.userOf(run.user);

      try {
        found = await this.client.listTools({ timeoutMs: listTimeoutMs, user });
      } catch (error) {
        if (!(error instanceof McpAuthorizationRequired)) {
          throw error;
        }

        // The tools don't depend on the user: show what another user's
        // connection found, or just a way to connect.
        const known = await oauth.recall<McpListing>();

        return known ?? { tools: [], connect: name !== undefined };
      }
    } else {
      found = await this.client.listTools({ timeoutMs: listTimeoutMs });
    }

    const listing = trimListing(found);

    await this.oauth?.remember(listing);

    return listing;
  }

  /**
   * @internal Makes the tools of a listing, named `<name>_<tool>`.
   */
  "~build"(name: string, listing: McpListing): SandboxTools {
    if (listing.connect) {
      return {
        [`${name}_connect`]: {
          description: `Connect the user's ${name} account. Call it when the user wants something from ${name}.`,
          input: { type: "object", properties: {} },
          run: (_input: Record<string, unknown>, ctx) => {
            return this.connect(name, ctx);
          },
        } as SandboxTool,
      };
    }

    const allowed = this.options.tools;
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

      if (key.length > 64) {
        throw new SandboxValidationError(
          `MCP server "${name}" tool "${info.name}" makes a name longer than 64 characters: add tools: [...] without it`,
        );
      }

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
        // What a remote server sends back is text from outside.
        untrusted: true,
        run: (input: Record<string, unknown>, ctx) => {
          return this.call(name, info, input, ctx);
        },
      } as SandboxTool;
    }

    return built;
  }

  /**
   * The result for a user who has not connected. The sign-in link goes to the
   * app's `onNeedsAuthorization` hook, never to the model, which is only told
   * that a sign-in is needed.
   */
  private async needsAuthorization(
    name: string,
    user: string,
    signal: AbortSignal,
    run: RunContext,
  ): Promise<unknown> {
    const oauth = this.oauth as McpOAuth;
    const options = (this.options.auth as { oauth: McpOAuthOptions }).oauth;
    const { logger } = run;
    const { thread } = run.user;

    // Nobody would be given a link, so nothing is discovered, registered or
    // stored for one.
    if (!options.onNeedsAuthorization) {
      traceWarning(
        logger,
        "mcp.no-sign-in-hook",
        `MCP server "${name}" needs ${user} to sign in, but tool.mcp() has no auth.oauth.onNeedsAuthorization to deliver the link, so nobody was given it.`,
      );

      return toolErrorOf(
        `${name} needs the user to sign in, and no sign-in link could be sent. Tell the user that ${name} is not connected. Do not call ${name} tools again.`,
      );
    }

    const started = await oauth.start(user, name, signal);

    await options.onNeedsAuthorization({
      ...started,
      ...(thread && { thread }),
    });

    return `A sign-in link for ${name} was sent to the user. Tell the user to follow it, then try again once they say they are done. Do not call ${name} tools again before that.`;
  }

  private async connect(
    name: string,
    ctx: { signal: AbortSignal; runId?: string },
  ): Promise<unknown> {
    const oauth = this.oauth as McpOAuth;
    const run = currentRunContext();
    const user = await oauth.userOf(run.user);

    try {
      await oauth.resolve(user);
    } catch (error) {
      if (error instanceof McpAuthorizationRequired) {
        return this.needsAuthorization(name, user, ctx.signal, run);
      }

      throw error;
    }

    const listing = await this["~list"]();

    return `Connected. The ${name} tools are available from the next message: ${listing.tools
      .map((info) => {
        return info.name;
      })
      .join(", ")}`;
  }

  private async call(
    name: string,
    info: McpToolInfo,
    input: Record<string, unknown>,
    ctx: { signal: AbortSignal; idempotencyKey: string; runId?: string },
  ): Promise<unknown> {
    const oauth = this.oauth;
    const run = currentRunContext();
    const user = oauth ? await oauth.userOf(run.user) : undefined;
    const repeatable =
      info.annotations?.readOnlyHint === true ||
      info.annotations?.idempotentHint === true;

    try {
      const answer = await this.client.callTool(info.name, input, {
        signal: ctx.signal,
        timeoutMs: this.timeoutMs,
        idempotencyKey: ctx.idempotencyKey,
        user,
      });

      try {
        return mapMcpResult(answer);
      } catch (error) {
        // The call was sent and the answer is unreadable.
        throw new McpOutcomeUnknownError(
          `the answer could not be read: ${(error as Error).message}`,
        );
      }
    } catch (error) {
      if (error instanceof McpAuthorizationRequired && user !== undefined) {
        return this.needsAuthorization(name, user, ctx.signal, run);
      }

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
 * Removes `user`'s stored sign-in for `server`. Same as
 * `server.disconnect(user)`.
 */
export const disconnect = (
  /** The server the person signed in to. */
  server: McpServer,
  /** The person, as `auth.oauth.user` named them. */
  user: string,
): Promise<void> => {
  return server.disconnect(user);
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
        return entry["~list"](key);
      },
    );

    for (const [name, built] of Object.entries(entry["~build"](key, listing))) {
      add(name, built);
    }
  }

  return expanded;
};
