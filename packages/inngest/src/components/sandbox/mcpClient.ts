/**
 * @module
 * EXPERIMENTAL: A small client for the Streamable HTTP transport of the Model
 * Context Protocol: `initialize`, `tools/list` and `tools/call` over plain
 * `fetch`. It runs anywhere `fetch` does (Node, Bun, Deno, edge runtimes) and
 * adds no dependency. Sessions live in memory in this process only; a process
 * that starts fresh initializes again.
 *
 * Errors say whether the server could have acted, because a caller must not
 * repeat a call that may have had an effect:
 * - `McpUnavailableError`: the request did not reach the server's logic
 *   (no connection, 429, 503). Safe to repeat.
 * - `McpOutcomeUnknownError`: the request was sent and no answer came back
 *   (timeout, dropped connection, 5xx). The server may have acted.
 * - `McpAuthError`: 401 or 403. A retry can't fix it.
 * - `McpProtocolError`: the server answered with a JSON-RPC error or a 4xx.
 */
import hashjs from "hash.js";
import { NonRetriableError } from "../NonRetriableError.ts";
import { redact } from "./secret.ts";

export const mcpProtocolVersion = "2025-06-18";

/**
 * The most pages of `tools/list` that are read.
 */
const maxListPages = 10;

export class McpAuthError extends NonRetriableError {
  constructor(message: string) {
    super(message);
    this.name = "McpAuthError";
  }
}

export class McpUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "McpUnavailableError";
  }
}

export class McpOutcomeUnknownError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "McpOutcomeUnknownError";
  }
}

export class McpProtocolError extends Error {
  /**
   * The JSON-RPC error code, or the HTTP status for a 4xx.
   */
  readonly code: number;

  constructor(message: string, code: number) {
    super(message);
    this.name = "McpProtocolError";
    this.code = code;
  }
}

/**
 * What a server says about a tool, trimmed to what the SDK uses.
 */
export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: { type: "object"; [key: string]: unknown };
  annotations?: {
    readOnlyHint?: boolean;
    idempotentHint?: boolean;
    destructiveHint?: boolean;
  };
}

export interface McpContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  [key: string]: unknown;
}

export interface McpCallResult {
  content?: McpContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
}

/**
 * The headers of one call, and the secret values among them, which are
 * removed from any error that leaves the client.
 */
export interface McpResolvedAuth {
  headers: Record<string, string>;
  secrets: string[];
}

export interface McpClientOptions {
  url: string;
  fetch?: typeof fetch;

  /**
   * Reads the auth headers. Runs for every call, so a secret is read inside
   * the step that uses it.
   */
  auth: () => Promise<McpResolvedAuth>;
  clientVersion: string;
}

export interface McpRequestOptions {
  /**
   * Aborts the call.
   */
  signal?: AbortSignal;

  /**
   * The longest the call may take.
   */
  timeoutMs: number;
}

interface Session {
  id?: string;
  version: string;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

// The sessions of this process, by server and credentials.
const sessions = new Map<string, Promise<Session>>();

const preSendCodes = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/**
 * Whether a failed `fetch` never got a request to the server: the connection
 * was refused, the name did not resolve, or TLS failed.
 */
const failedBeforeSend = (error: unknown): boolean => {
  const code = (error as { cause?: { code?: unknown } })?.cause?.code;

  return typeof code === "string" && preSendCodes.has(code);
};

const sha256 = (text: string): string => {
  return hashjs.sha256().update(text).digest("hex");
};

/**
 * Reads the first JSON-RPC response with `id` from an event stream, then
 * stops reading.
 */
const readEventStream = async (
  body: ReadableStream<Uint8Array>,
  id: number,
): Promise<JsonRpcMessage | undefined> => {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();

      buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replaceAll("\r\n", "\n");

      for (
        let end = buffer.indexOf("\n\n");
        end >= 0;
        end = buffer.indexOf("\n\n")
      ) {
        const event = buffer.slice(0, end);

        buffer = buffer.slice(end + 2);

        const data = event
          .split("\n")
          .filter((line) => {
            return line.startsWith("data:");
          })
          .map((line) => {
            return line.slice(5).replace(/^ /, "");
          })
          .join("\n");

        if (!data) {
          continue;
        }

        try {
          const message = JSON.parse(data) as JsonRpcMessage;

          if (message.id === id) {
            return message;
          }
        } catch {}
      }

      if (done) {
        return undefined;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
};

/**
 * A timeout and a caller's signal as one signal, with a way to tell which
 * one fired.
 */
const withTimeout = (options: McpRequestOptions) => {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);
  const onAbort = () => {
    controller.abort();
  };

  if (options.signal?.aborted) {
    controller.abort();
  } else {
    options.signal?.addEventListener("abort", onAbort, { once: true });
  }

  return {
    signal: controller.signal,
    timedOut: () => {
      return timedOut;
    },
    done: () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    },
  };
};

export class McpClient {
  readonly #options: McpClientOptions;
  #lastId = 0;

  constructor(options: McpClientOptions) {
    this.#options = options;
  }

  /**
   * Lists the server's tools, all pages.
   */
  async listTools(options: McpRequestOptions): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < maxListPages; page += 1) {
      const result = (await this.#call(
        "tools/list",
        cursor === undefined ? {} : { cursor },
        options,
      )) as { tools?: McpToolInfo[]; nextCursor?: string };

      tools.push(...(result.tools ?? []));
      cursor = result.nextCursor;

      if (!cursor) {
        break;
      }
    }

    return tools;
  }

  /**
   * Calls a tool. `idempotencyKey` goes in `_meta` for servers that
   * deduplicate on it.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    options: McpRequestOptions & { idempotencyKey?: string },
  ): Promise<McpCallResult> {
    return (await this.#call(
      "tools/call",
      {
        name,
        arguments: args,
        ...(options.idempotencyKey !== undefined && {
          _meta: { "inngest/idempotencyKey": options.idempotencyKey },
        }),
      },
      options,
    )) as McpCallResult;
  }

  #newId(): number {
    this.#lastId += 1;

    return this.#lastId;
  }

  async #call(
    method: string,
    params: unknown,
    options: McpRequestOptions,
  ): Promise<unknown> {
    const auth = await this.#options.auth();
    const timeout = withTimeout(options);

    try {
      const result = await this.#send(method, params, auth, timeout);
      const text = JSON.stringify(result) ?? "";

      // A server that echoes a credential doesn't get to pass it on.
      return auth.secrets.some((secret) => {
        return secret.length >= 4 && text.includes(secret);
      })
        ? JSON.parse(redact(text, auth.secrets))
        : result;
    } catch (error) {
      if (error instanceof Error) {
        error.message = redact(error.message, auth.secrets);
      }

      throw error;
    } finally {
      timeout.done();
    }
  }

  async #send(
    method: string,
    params: unknown,
    auth: McpResolvedAuth,
    timeout: ReturnType<typeof withTimeout>,
  ): Promise<unknown> {
    const key = sha256(
      `${this.#options.url}\n${JSON.stringify(Object.entries(auth.headers).sort())}`,
    );

    for (let attempt = 0; ; attempt += 1) {
      const session = await this.#session(key, auth, timeout);
      const id = this.#newId();
      const response = await this.#post(
        { jsonrpc: "2.0", id, method, params },
        auth,
        timeout,
        session,
      );

      // The server dropped the session. Nothing ran, so start a new one.
      if (response.status === 404 && session.id && attempt === 0) {
        sessions.delete(key);
        await response.body?.cancel().catch(() => {});

        continue;
      }

      const message = await this.#message(response, id, timeout);

      if (message.error) {
        throw new McpProtocolError(message.error.message, message.error.code);
      }

      return message.result;
    }
  }

  #session(
    key: string,
    auth: McpResolvedAuth,
    timeout: ReturnType<typeof withTimeout>,
  ): Promise<Session> {
    const held = sessions.get(key);

    if (held) {
      return held;
    }

    const initId = this.#newId();
    const created = (async () => {
      const response = await this.#post(
        {
          jsonrpc: "2.0",
          id: initId,
          method: "initialize",
          params: {
            protocolVersion: mcpProtocolVersion,
            capabilities: {},
            clientInfo: {
              name: "inngest",
              version: this.#options.clientVersion,
            },
          },
        },
        auth,
        timeout,
      );
      const initialized = await this.#message(response, initId, timeout);

      if (initialized.error) {
        throw new McpProtocolError(
          initialized.error.message,
          initialized.error.code,
        );
      }

      const session: Session = {
        id: response.headers.get("mcp-session-id") ?? undefined,
        version:
          (initialized.result as { protocolVersion?: string } | undefined)
            ?.protocolVersion ?? mcpProtocolVersion,
      };
      const ack = await this.#post(
        { jsonrpc: "2.0", method: "notifications/initialized" },
        auth,
        timeout,
        session,
      );

      await ack.body?.cancel().catch(() => {});

      return session;
    })();

    sessions.set(key, created);
    created.catch(() => {
      if (sessions.get(key) === created) {
        sessions.delete(key);
      }
    });

    return created;
  }

  async #post(
    body: unknown,
    auth: McpResolvedAuth,
    timeout: ReturnType<typeof withTimeout>,
    session?: Session,
  ): Promise<Response> {
    let response: Response;

    try {
      // A redirect would carry the credentials to another origin.
      response = await (this.#options.fetch ?? fetch)(this.#options.url, {
        method: "POST",
        redirect: "error",
        signal: timeout.signal,
        headers: {
          ...auth.headers,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(session && { "mcp-protocol-version": session.version }),
          ...(session?.id && { "mcp-session-id": session.id }),
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (timeout.timedOut()) {
        throw new McpOutcomeUnknownError("The MCP server timed out", {
          cause: error,
        });
      }

      if (failedBeforeSend(error)) {
        throw new McpUnavailableError(
          `Could not reach the MCP server: ${(error as Error).message}`,
          { cause: error },
        );
      }

      throw new McpOutcomeUnknownError(
        `The connection to the MCP server failed: ${(error as Error).message}`,
        { cause: error },
      );
    }

    if (response.ok || response.status === 404) {
      return response;
    }

    await response.body?.cancel().catch(() => {});

    if (response.status === 401) {
      const oauth = /resource_metadata/i.test(
        response.headers.get("www-authenticate") ?? "",
      );

      throw new McpAuthError(
        oauth
          ? "The MCP server requires OAuth, which agents don't support yet: give it a bearer token with auth: { bearer: secret(...) }"
          : "The MCP server rejected the credentials (401)",
      );
    }

    if (response.status === 403) {
      throw new McpAuthError("The MCP server refused access (403)");
    }

    if (response.status === 429 || response.status === 503) {
      throw new McpUnavailableError(
        `The MCP server is busy (${response.status})`,
      );
    }

    if (response.status >= 500) {
      throw new McpOutcomeUnknownError(
        `The MCP server failed (${response.status})`,
      );
    }

    throw new McpProtocolError(
      `The MCP server answered ${response.status}`,
      response.status,
    );
  }

  /**
   * The JSON-RPC message that answers request `id`, from a JSON body or an
   * event stream.
   */
  async #message(
    response: Response,
    id: number,
    timeout: ReturnType<typeof withTimeout>,
  ): Promise<JsonRpcMessage> {
    if (response.status === 404) {
      await response.body?.cancel().catch(() => {});

      throw new McpProtocolError("The MCP server answered 404", 404);
    }

    try {
      const type = response.headers.get("content-type") ?? "";
      let message: JsonRpcMessage | undefined;

      if (type.includes("text/event-stream") && response.body) {
        message = await readEventStream(response.body, id);
      } else {
        const parsed = (await response.json()) as
          | JsonRpcMessage
          | JsonRpcMessage[];

        message = Array.isArray(parsed)
          ? parsed.find((item) => {
              return item.id === id;
            })
          : parsed;
      }

      if (!message) {
        throw new McpOutcomeUnknownError(
          "The MCP server ended the response without an answer",
        );
      }

      return message;
    } catch (error) {
      if (error instanceof McpOutcomeUnknownError) {
        throw error;
      }

      throw new McpOutcomeUnknownError(
        timeout.signal.aborted
          ? "The MCP server timed out"
          : `The MCP server's answer could not be read: ${(error as Error).message}`,
        { cause: error },
      );
    }
  }
}
