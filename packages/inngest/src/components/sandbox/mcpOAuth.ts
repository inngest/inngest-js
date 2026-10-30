/**
 * @module
 * EXPERIMENTAL: per-user OAuth for `tool.mcp()`, following the MCP
 * authorization spec (OAuth 2.1): protected-resource and authorization-server
 * discovery, dynamic client registration (or a configured client), PKCE,
 * the authorization-code exchange, and refresh.
 *
 * Everything here runs on the host. Tokens live in a `McpOAuthStore`, are read
 * inside the step that makes a call, and never reach the model, a sandbox, a
 * step output or an error: the access token is passed to the MCP client as a
 * secret to redact, and error text from the authorization server is cut to its
 * `error` code and a short description with every known secret removed.
 *
 * A user with no token gets a `McpNeedsAuthorization` result holding the URL
 * to open. `completeMcpAuthorization()` finishes the flow from the app's
 * callback route and sends `agent/mcp.authorized`.
 */
import hashjs from "hash.js";
import { step } from "../InngestStepTools.ts";
import { NonRetriableError } from "../NonRetriableError.ts";
import { mcpProtocolVersion } from "./mcpClient.ts";
import { redact, type Secret } from "./secret.ts";

/**
 * The event `completeMcpAuthorization()` sends when a user finishes
 * connecting a server. Its data is `McpAuthorizedData`.
 */
export const mcpAuthorizedEvent = "agent/mcp.authorized";

/**
 * The data of `agent/mcp.authorized`.
 */
export interface McpAuthorizedData {
  /**
   * The server's name: the key it has in `agent.loop({ tools })`.
   */
  server: string;

  /**
   * The user who connected it, as `auth.oauth.user` named them.
   */
  user: string;

  /**
   * The server's URL.
   */
  url: string;
}

/**
 * Where OAuth state lives: tokens, registered clients, pending
 * authorizations and refresh leases. Values are opaque strings.
 *
 * What a store must guarantee: `compareAndSet` is atomic across callers (of
 * two calls that expect the same value, one wins), because concurrent runs
 * refresh a token under a lease made with it. Values are secrets: a store
 * encrypts them at rest. `kvOAuthStore()` does.
 */
export interface McpOAuthStore {
  get(key: string): Promise<string | null>;

  /**
   * Writes `next` only when the live value is `expected` (`null`: absent),
   * and returns whether it did.
   */
  compareAndSet(
    key: string,
    expected: string | null,
    next: string,
  ): Promise<boolean>;
  delete(key: string): Promise<void>;
}

/**
 * What `auth.oauth.user` is called with.
 */
export interface McpOAuthUserContext {
  /**
   * The ID of the run that is calling, when there is one.
   */
  runId?: string;
}

/**
 * Per-user OAuth for a server, as `tool.mcp({ auth: { oauth } })`.
 */
export interface McpOAuthOptions {
  /**
   * Whose token to use: an ID that is stable for the person, such as the
   * Slack user who asked. A function is called for every call.
   */
  user: string | ((ctx: McpOAuthUserContext) => string | Promise<string>);

  /**
   * Your route that receives the redirect after the user approves. It calls
   * `completeMcpAuthorization()`. Must be registered with the server if it
   * has no dynamic registration.
   */
  redirectUri: string;

  /**
   * Where tokens live. Default: `kvOAuthStore()`, the agents KV encrypted
   * with the key in `MCP_OAUTH_ENCRYPTION_KEY`.
   */
  store?: McpOAuthStore;

  /**
   * An OAuth client you registered, for a server without dynamic client
   * registration. Default: register one with the server and remember it.
   */
  clientId?: string;

  /**
   * The registered client's secret, if it has one.
   */
  clientSecret?: string | Secret;

  /**
   * Scopes to ask for. Default: the server's `scopes_supported`, plus
   * `offline_access` when the authorization server offers it, so the token
   * can refresh.
   */
  scopes?: string[];

  /**
   * The name shown on the consent screen. Default `Inngest agent`.
   */
  clientName?: string;

  /**
   * Called when a user has no token, with the link to give them. Runs in the
   * step that made the call; post the link where the user will see it.
   */
  onNeedsAuthorization?: (info: McpNeedsAuthorization) => void | Promise<void>;
}

/**
 * What a call returns (as an error result) for a user who has not connected
 * the server. The model reads it; an app can read it with
 * `isMcpNeedsAuthorization()`.
 */
export interface McpNeedsAuthorization {
  type: "mcp_needs_authorization";

  /**
   * The server's name.
   */
  server: string;

  /**
   * The user who needs to connect.
   */
  user: string;

  /**
   * Where the user approves access. Valid for 10 minutes.
   */
  authorizeUrl: string;

  /**
   * What the model should do.
   */
  message: string;
}

/**
 * Whether `value` is a needs-authorization result, or a tool error holding one.
 */
export const isMcpNeedsAuthorization = (
  value: unknown,
): value is McpNeedsAuthorization => {
  const inner =
    typeof value === "object" && value !== null && "~error" in value
      ? (value as { "~error": unknown })["~error"]
      : value;

  return (
    typeof inner === "object" &&
    inner !== null &&
    (inner as { type?: unknown }).type === "mcp_needs_authorization" &&
    typeof (inner as { authorizeUrl?: unknown }).authorizeUrl === "string"
  );
};

/**
 * Thrown inside the client when the user has no usable token. Never leaves
 * `tool.mcp()`: it becomes a `McpNeedsAuthorization` result.
 */
export class McpAuthorizationRequired extends Error {
  constructor() {
    super("The user has not authorized this MCP server");
    this.name = "McpAuthorizationRequired";
  }
}

/**
 * The authorization server refused a grant: a refresh token or code that is
 * no longer valid.
 */
class GrantRejected extends Error {}

/**
 * Thrown by `completeMcpAuthorization()` for a callback it can't finish. The
 * message is safe to show the user.
 */
export class McpAuthorizationError extends NonRetriableError {
  constructor(message: string) {
    super(message);
    this.name = "McpAuthorizationError";
  }
}

interface TokenRecord {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms; absent when the server gave no lifetime. */
  expiresAt?: number;
  /** Epoch ms the token was issued, to size the refresh margin. */
  issuedAt?: number;
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  resource: string;
}

interface ClientRecord {
  clientId: string;
  clientSecret?: string;
}

interface PendingRecord {
  server: string;
  user: string;
  url: string;
  verifier: string;
  redirectUri: string;
  tokenEndpoint: string;
  clientId: string;
  /** Dynamically registered clients only; a configured secret is not stored. */
  clientSecret?: string;
  secretConfigured: boolean;
  resource: string;
  createdAt: number;
}

interface Discovery {
  resource: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  authMethods: string[];
  scopes: string[];
  challengeMethods?: string[];
}

const pendingMs = 10 * 60_000;
const refreshMarginMs = 60_000;
const leaseMs = 30_000;
const leaseWaitMs = 250;
const leaseWaitTries = 130;
const requestTimeoutMs = 15_000;
const discoveryTtlMs = 10 * 60_000;
const maxDescription = 200;
const maxMetadataChars = 256 * 1024;

const discoveries = new Map<
  string,
  { at: number; value: Promise<Discovery> }
>();

// Refresh a little before expiry: a minute, or a tenth of a short lifetime.
const marginOf = (record: TokenRecord): number => {
  return Math.min(
    refreshMarginMs,
    ((record.expiresAt ?? 0) - (record.issuedAt ?? 0)) / 10,
  );
};

const sha256Hex = (text: string): string => {
  return hashjs.sha256().update(text).digest("hex");
};

const base64url = (bytes: Uint8Array): string => {
  let text = "";

  for (const byte of bytes) {
    text += String.fromCharCode(byte);
  }

  return btoa(text)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
};

const randomToken = (bytes = 32): string => {
  return base64url(globalThis.crypto.getRandomValues(new Uint8Array(bytes)));
};

const challengeOf = async (verifier: string): Promise<string> => {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );

  return base64url(new Uint8Array(digest));
};

const sleep = (ms: number): Promise<void> => {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

const secureUrl = (value: string, what: string): URL => {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new NonRetriableError(`The MCP server's ${what} is not a URL`);
  }

  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);

  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new NonRetriableError(
      `The MCP server's ${what} must be https: ${url.origin}`,
    );
  }

  return url;
};

const parse = <T>(text: string | null): T | undefined => {
  if (text === null) {
    return undefined;
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
};

/**
 * The stable part of a server's key in the store.
 */
export const serverIdOf = (url: string): string => {
  return sha256Hex(url).slice(0, 16);
};

const tokenKey = (url: string, user: string): string => {
  return `token:${serverIdOf(url)}:${encodeURIComponent(user)}`;
};

const pendingKey = (state: string): string => {
  return `pending:${state}`;
};

const toolsKey = (url: string): string => {
  return `tools:${serverIdOf(url)}`;
};

/**
 * The OAuth side of one `tool.mcp()` server.
 */
export class McpOAuth {
  readonly #options: McpOAuthOptions;
  readonly #store: () => McpOAuthStore;
  readonly #url: string;
  readonly #fetch: typeof fetch;

  constructor(
    options: McpOAuthOptions,
    url: string,
    store: () => McpOAuthStore,
    fetchFn?: typeof fetch,
  ) {
    this.#options = options;
    this.#url = url;
    this.#store = store;
    this.#fetch = fetchFn ?? ((...args) => fetch(...args));
  }

  async userOf(ctx: McpOAuthUserContext): Promise<string> {
    const user =
      typeof this.#options.user === "function"
        ? await this.#options.user(ctx)
        : this.#options.user;

    if (typeof user !== "string" || user === "") {
      throw new NonRetriableError(
        "tool.mcp() auth.oauth.user must give a non-empty string",
      );
    }

    return user;
  }

  /**
   * The auth headers for `user`, refreshing the token if it is about to
   * expire. Throws `McpAuthorizationRequired` when there is no usable token.
   */
  async resolve(user: string) {
    const record = await this.#fresh(user);

    return {
      headers: { authorization: `Bearer ${record.accessToken}` },
      secrets: [record.accessToken],
    };
  }

  /**
   * The server answered 401 to `failed`. Refreshes the token if it is still
   * the one that failed (another run may have replaced it) and returns
   * whether a new request is worth sending. Throws `McpAuthorizationRequired`
   * when the grant is gone.
   */
  async unauthorized(user: string, failed: string[]): Promise<boolean> {
    const store = this.#store();
    const key = tokenKey(this.#url, user);
    const raw = await store.get(key);
    const record = parse<TokenRecord>(raw);

    if (!record) {
      throw new McpAuthorizationRequired();
    }

    if (!failed.includes(record.accessToken)) {
      return true;
    }

    // Mark it expired so the next read refreshes it, once, under the lease.
    const expired = { ...record, expiresAt: 0 };

    await store.compareAndSet(key, raw, JSON.stringify(expired));
    await this.#fresh(user);

    return true;
  }

  /**
   * Remembers the server's tool list, which does not depend on the user, so a
   * user who has not connected still sees the tools.
   */
  async remember(listing: unknown): Promise<void> {
    const store = this.#store();
    const key = toolsKey(this.#url);
    const current = await store.get(key);

    await store.compareAndSet(key, current, JSON.stringify(listing));
  }

  async recall<T>(): Promise<T | undefined> {
    return parse<T>(await this.#store().get(toolsKey(this.#url)));
  }

  /**
   * Begins an authorization: discovers the server, registers a client if
   * needed, and returns the URL the user opens.
   */
  async start(
    user: string,
    server: string,
    signal?: AbortSignal,
  ): Promise<McpNeedsAuthorization> {
    const found = await this.#discover(signal);
    const client = await this.#client(found);
    const state = randomToken();
    const verifier = randomToken(48);
    const scopes = this.#options.scopes ?? found.scopes;
    const url = new URL(found.authorizationEndpoint);

    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", client.clientId);
    url.searchParams.set("redirect_uri", this.#options.redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", await challengeOf(verifier));
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("resource", found.resource);

    if (scopes.length > 0) {
      url.searchParams.set("scope", scopes.join(" "));
    }

    const pending: PendingRecord = {
      server,
      user,
      url: this.#url,
      verifier,
      redirectUri: this.#options.redirectUri,
      tokenEndpoint: found.tokenEndpoint,
      clientId: client.clientId,
      ...(this.#options.clientId === undefined &&
        client.clientSecret !== undefined && {
          clientSecret: client.clientSecret,
        }),
      secretConfigured: this.#options.clientSecret !== undefined,
      resource: found.resource,
      createdAt: Date.now(),
    };

    await this.#store().compareAndSet(
      pendingKey(state),
      null,
      JSON.stringify(pending),
    );

    return {
      type: "mcp_needs_authorization",
      server,
      user,
      authorizeUrl: url.toString(),
      message: `${server} needs the user's permission. Tell the user to open authorizeUrl to connect it (the link works for 10 minutes), then try again once they say they are done. Do not call ${server} tools again before that.`,
    };
  }

  /**
   * The current token for `user`, refreshed under a lease when it is about to
   * expire. Of several runs that find it expired, one refreshes and the rest
   * read the result.
   */
  async #fresh(user: string): Promise<TokenRecord> {
    const store = this.#store();
    const key = tokenKey(this.#url, user);
    const leaseKey = `${key}:lease`;

    for (let tries = 0; tries < leaseWaitTries; tries += 1) {
      const raw = await store.get(key);
      const record = parse<TokenRecord>(raw);

      if (!record) {
        throw new McpAuthorizationRequired();
      }

      if (
        record.expiresAt === undefined ||
        record.expiresAt - marginOf(record) > Date.now()
      ) {
        return record;
      }

      if (!record.refreshToken) {
        await this.#discard(store, key, raw);

        throw new McpAuthorizationRequired();
      }

      const held = await store.get(leaseKey);

      if (held !== null && Number(held) > Date.now()) {
        await sleep(leaseWaitMs);

        continue;
      }

      const mine = String(Date.now() + leaseMs);

      if (!(await store.compareAndSet(leaseKey, held, mine))) {
        continue;
      }

      try {
        // Someone may have refreshed between our read and taking the lease.
        if ((await store.get(key)) !== raw) {
          continue;
        }

        try {
          const next = await this.#refresh(record);

          // The server has rotated the refresh token: this write must land,
          // or the next refresh uses a token that no longer works.
          for (let tries = 0; ; tries += 1) {
            const current = await store.get(key);

            const newer =
              current === null ? undefined : parse<TokenRecord>(current);

            // Only a different refresh token is a newer grant. The same one
            // with another access token is the "expired" marker a 401 leaves,
            // and ours replaces it.
            if (!newer || newer.refreshToken === record.refreshToken) {
              if (
                await store.compareAndSet(key, current, JSON.stringify(next))
              ) {
                return next;
              }
            } else {
              // A newer grant replaced it; keep that one.
              return newer;
            }

            if (tries >= 5) {
              throw new Error(
                "Could not store the refreshed MCP token: try again",
              );
            }
          }
        } catch (error) {
          if (error instanceof GrantRejected) {
            await this.#discard(store, key, raw);

            throw new McpAuthorizationRequired();
          }

          throw error;
        }
      } finally {
        await store.compareAndSet(leaseKey, mine, "0");
      }
    }

    throw new Error("Another run is refreshing this MCP token: try again");
  }

  async #discard(store: McpOAuthStore, key: string, raw: string | null) {
    // Only if nobody replaced it meanwhile.
    if (raw !== null && (await store.get(key)) === raw) {
      await store.delete(key);
    }
  }

  async #refresh(record: TokenRecord): Promise<TokenRecord> {
    const secrets = [record.refreshToken ?? "", record.clientSecret ?? ""];
    const secret = await this.#clientSecret(record.clientSecret);
    const answer = await this.#form(
      record.tokenEndpoint,
      {
        grant_type: "refresh_token",
        refresh_token: record.refreshToken ?? "",
        client_id: record.clientId,
        resource: record.resource,
      },
      secret,
      [...secrets, secret ?? ""],
    );

    const { expiresAt: _expiresAt, issuedAt: _issuedAt, ...kept } = record;

    return {
      ...kept,
      ...this.#tokens(answer),
      // A server that doesn't rotate keeps the old refresh token.
      refreshToken: answer.refresh_token ?? record.refreshToken,
    };
  }

  #tokens(answer: TokenResponse) {
    return {
      accessToken: answer.access_token,
      ...(typeof answer.expires_in === "number" && {
        issuedAt: Date.now(),
        expiresAt: Date.now() + answer.expires_in * 1000,
      }),
    };
  }

  async #clientSecret(stored?: string): Promise<string | undefined> {
    const configured = this.#options.clientSecret;

    if (configured === undefined) {
      return stored;
    }

    return typeof configured === "string" ? configured : configured.value();
  }

  async #client(found: Discovery): Promise<ClientRecord> {
    if (this.#options.clientId !== undefined) {
      return { clientId: this.#options.clientId };
    }

    const store = this.#store();
    const key = `client:${sha256Hex(`${found.issuer}\n${this.#options.redirectUri}`).slice(0, 16)}`;
    const known = parse<ClientRecord>(await store.get(key));

    if (known) {
      return known;
    }

    if (!found.registrationEndpoint) {
      throw new NonRetriableError(
        "The MCP server does not offer dynamic client registration: register an OAuth client with it and pass auth.oauth.clientId (and clientSecret)",
      );
    }

    const method = found.authMethods.includes("none")
      ? "none"
      : "client_secret_post";
    const response = await this.#request(
      secureUrl(found.registrationEndpoint, "registration endpoint").href,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: this.#options.clientName ?? "Inngest agent",
          redirect_uris: [this.#options.redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: method,
        }),
      },
    );
    const body = parse<{ client_id?: unknown; client_secret?: unknown }>(
      await response.text(),
    );

    if (!response.ok || typeof body?.client_id !== "string") {
      throw new NonRetriableError(
        `The MCP server refused client registration (${response.status}): register an OAuth client with it and pass auth.oauth.clientId (and clientSecret)`,
      );
    }

    const client: ClientRecord = {
      clientId: body.client_id,
      ...(typeof body.client_secret === "string" && {
        clientSecret: body.client_secret,
      }),
    };

    await store.compareAndSet(key, null, JSON.stringify(client));

    return (parse<ClientRecord>(await store.get(key)) ??
      client) as ClientRecord;
  }

  async #request(url: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await this.#fetch(url, {
        redirect: "error",
        ...init,
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch {
      // The cause of a failed fetch can name headers and bodies.
      throw new Error(`OAuth request to ${new URL(url).origin} failed`);
    }
  }

  async #form(
    url: string,
    params: Record<string, string>,
    clientSecret: string | undefined,
    secrets: string[],
  ): Promise<TokenResponse> {
    const refreshing = params.grant_type === "refresh_token";
    const body = new URLSearchParams(params);
    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    };

    if (clientSecret !== undefined) {
      body.set("client_secret", clientSecret);
    }

    const response = await this.#request(url, {
      method: "POST",
      redirect: "error",
      headers,
      body,
    });

    return readTokenResponse(
      response,
      [
        ...secrets,
        ...(clientSecret ? [clientSecret] : []),
        ...Object.values(params),
      ],
      refreshing,
    );
  }

  /**
   * Exchanges an authorization code and stores the token.
   */
  async exchange(
    pending: PendingRecord,
    code: string,
    clientSecret?: string,
  ): Promise<void> {
    const answer = await this.#form(
      pending.tokenEndpoint,
      {
        grant_type: "authorization_code",
        code,
        redirect_uri: pending.redirectUri,
        client_id: pending.clientId,
        code_verifier: pending.verifier,
        resource: pending.resource,
      },
      clientSecret ?? pending.clientSecret,
      [code, pending.verifier],
    );
    const record: TokenRecord = {
      ...this.#tokens(answer),
      ...(answer.refresh_token !== undefined && {
        refreshToken: answer.refresh_token,
      }),
      tokenEndpoint: pending.tokenEndpoint,
      clientId: pending.clientId,
      ...(pending.clientSecret !== undefined && {
        clientSecret: pending.clientSecret,
      }),
      resource: pending.resource,
    };
    const store = this.#store();
    const key = tokenKey(pending.url, pending.user);

    // Replace whatever was there; a fresh grant wins.
    for (let tries = 0; tries < 5; tries += 1) {
      if (
        await store.compareAndSet(
          key,
          await store.get(key),
          JSON.stringify(record),
        )
      ) {
        return;
      }
    }

    throw new Error("Could not store the MCP token: try again");
  }

  #discover(signal?: AbortSignal): Promise<Discovery> {
    const held = discoveries.get(this.#url);

    if (held && Date.now() - held.at < discoveryTtlMs) {
      return held.value;
    }

    const value = this.#discoverNow(signal);

    discoveries.set(this.#url, { at: Date.now(), value });
    value.catch(() => {
      if (discoveries.get(this.#url)?.value === value) {
        discoveries.delete(this.#url);
      }
    });

    return value;
  }

  async #json(url: string): Promise<Record<string, unknown> | undefined> {
    const response = await this.#request(secureUrl(url, "metadata URL").href, {
      headers: { accept: "application/json" },
    });

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});

      return undefined;
    }

    const text = await response.text();

    return text.length > maxMetadataChars
      ? undefined
      : parse<Record<string, unknown>>(text);
  }

  async #discoverNow(_signal?: AbortSignal): Promise<Discovery> {
    const mcp = new URL(this.#url);
    const candidates: string[] = [];

    // An unauthenticated request makes the server say where its metadata is.
    const probe = await this.#request(this.#url, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: mcpProtocolVersion,
          capabilities: {},
          clientInfo: { name: "inngest", version: "0" },
        },
      }),
    });

    await probe.body?.cancel().catch(() => {});

    const advertised = /resource_metadata="?([^",\s]+)"?/i.exec(
      probe.headers.get("www-authenticate") ?? "",
    )?.[1];

    if (advertised) {
      candidates.push(advertised);
    }

    candidates.push(
      `${mcp.origin}/.well-known/oauth-protected-resource${mcp.pathname === "/" ? "" : mcp.pathname}`,
      `${mcp.origin}/.well-known/oauth-protected-resource`,
    );

    let resource: Record<string, unknown> | undefined;

    for (const candidate of candidates) {
      resource = await this.#json(candidate);

      if (resource) {
        break;
      }
    }

    const servers = resource?.authorization_servers;
    const issuer =
      Array.isArray(servers) && typeof servers[0] === "string"
        ? servers[0]
        : mcp.origin;
    const issuerUrl = secureUrl(issuer, "authorization server");
    const path = issuerUrl.pathname === "/" ? "" : issuerUrl.pathname;
    let meta: Record<string, unknown> | undefined;

    for (const candidate of [
      `${issuerUrl.origin}/.well-known/oauth-authorization-server${path}`,
      `${issuerUrl.origin}/.well-known/openid-configuration${path}`,
      `${issuerUrl.href.replace(/\/$/, "")}/.well-known/openid-configuration`,
    ]) {
      meta = await this.#json(candidate);

      if (meta) {
        break;
      }
    }

    const text = (value: unknown): string | undefined => {
      return typeof value === "string" ? value : undefined;
    };
    const list = (value: unknown): string[] => {
      return Array.isArray(value)
        ? value.filter((item): item is string => {
            return typeof item === "string";
          })
        : [];
    };
    const authorizationEndpoint = text(meta?.authorization_endpoint);
    const tokenEndpoint = text(meta?.token_endpoint);

    if (!authorizationEndpoint || !tokenEndpoint) {
      throw new NonRetriableError(
        `Could not discover OAuth endpoints for the MCP server at ${mcp.origin}`,
      );
    }

    secureUrl(authorizationEndpoint, "authorization endpoint");
    secureUrl(tokenEndpoint, "token endpoint");

    const offered = list(meta?.scopes_supported);
    // The resource's scopes, else everything the authorization server offers.
    const scopes = list(resource?.scopes_supported);
    const wanted = scopes.length > 0 ? scopes : offered;

    return {
      resource: text(resource?.resource) ?? this.#url,
      issuer,
      authorizationEndpoint,
      tokenEndpoint,
      registrationEndpoint: text(meta?.registration_endpoint),
      authMethods: list(meta?.token_endpoint_auth_methods_supported),
      scopes: [
        ...wanted,
        ...(offered.includes("offline_access") &&
        !wanted.includes("offline_access")
          ? ["offline_access"]
          : []),
      ],
      challengeMethods: list(meta?.code_challenge_methods_supported),
    };
  }
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

const readTokenResponse = async (
  response: Response,
  secrets: string[],
  refreshing = false,
): Promise<TokenResponse> => {
  const text = await response.text();
  const body = parse<Record<string, unknown>>(text);

  if (!response.ok) {
    // Redact before cutting, so a secret split by the cut isn't left as a prefix.
    const code =
      typeof body?.error === "string" &&
      /^[A-Za-z0-9_.-]{1,64}$/.test(body.error)
        ? body.error
        : "";
    const description =
      typeof body?.error_description === "string"
        ? redact(body.error_description, secrets).slice(0, maxDescription)
        : "";
    const message = redact(
      `The OAuth server refused the request (${response.status}${code ? ` ${code}` : ""}${description ? `: ${description}` : ""})`,
      secrets,
    );

    // Only a grant the server calls invalid is dropped. A client it doesn't
    // accept, or a request it dislikes, must not wipe every user's token.
    if (code === "invalid_grant" || (refreshing && code === "invalid_token")) {
      throw new GrantRejected(message);
    }

    if (response.status >= 500 || response.status === 429) {
      throw new Error(message);
    }

    throw new NonRetriableError(message);
  }

  if (typeof body?.access_token !== "string" || body.access_token === "") {
    throw new NonRetriableError(
      "The OAuth server's answer had no access token",
    );
  }

  return {
    access_token: body.access_token,
    ...(typeof body.refresh_token === "string" && {
      refresh_token: body.refresh_token,
    }),
    ...(Number.isFinite(Number(body.expires_in)) &&
      body.expires_in !== null &&
      body.expires_in !== "" && { expires_in: Number(body.expires_in) }),
  };
};

/**
 * Finishes an authorization from your callback route: checks `state`,
 * exchanges the `code` (with PKCE), stores the token and, if you pass `send`,
 * sends `agent/mcp.authorized` so a waiting run can continue.
 *
 * @example
 * ```ts
 * app.get("/oauth/hex/callback", async (req, res) => {
 *   await completeMcpAuthorization({
 *     store,
 *     code: String(req.query.code),
 *     state: String(req.query.state),
 *     send: (event) => inngest.send(event),
 *   });
 *   res.send("Connected. You can close this tab.");
 * });
 * ```
 */
export const completeMcpAuthorization = async (options: {
  /**
   * The same store the server's `auth.oauth.store` uses.
   */
  store: McpOAuthStore;

  /**
   * The `code` query parameter.
   */
  code: string;

  /**
   * The `state` query parameter.
   */
  state: string;

  /**
   * The `error` query parameter, if the user denied access.
   */
  error?: string;

  /**
   * The user your app has signed in on this request. When set, the callback
   * is refused unless the link was made for this user, so a link passed to
   * someone else can't connect their account to the asker. Set it whenever
   * your route knows who is calling.
   */
  expectUser?: string;

  /**
   * The client secret, when the server's `auth.oauth` has `clientSecret`.
   */
  clientSecret?: string | Secret;

  /**
   * Sends the event, such as `(event) => inngest.send(event)`.
   */
  send?: (event: {
    name: typeof mcpAuthorizedEvent;
    data: McpAuthorizedData;
  }) => Promise<unknown>;

  /**
   * A `fetch` to use instead of the global one, for tests.
   */
  fetch?: typeof fetch;
}): Promise<McpAuthorizedData> => {
  const key = pendingKey(options.state);
  const raw = options.state ? await options.store.get(key) : null;
  const pending = parse<PendingRecord>(raw);

  if (options.error) {
    if (raw !== null) {
      await options.store.delete(key);
    }

    throw new McpAuthorizationError("The user did not approve access");
  }

  if (
    pending &&
    options.expectUser !== undefined &&
    pending.user !== options.expectUser
  ) {
    throw new McpAuthorizationError(
      "This authorization link was made for another user",
    );
  }

  if (pending && Date.now() - pending.createdAt > pendingMs) {
    await options.store.delete(key);
  }

  // One use: take it before the exchange so a replayed link fails.
  if (
    !pending ||
    Date.now() - pending.createdAt > pendingMs ||
    !(await options.store.compareAndSet(key, raw, "{}"))
  ) {
    throw new McpAuthorizationError(
      "This authorization link has expired or was already used: ask for a new one",
    );
  }

  await options.store.delete(key);

  if (pending.secretConfigured && options.clientSecret === undefined) {
    throw new McpAuthorizationError(
      "This server needs its client secret: pass clientSecret to completeMcpAuthorization()",
    );
  }

  const secret =
    options.clientSecret === undefined ||
    typeof options.clientSecret === "string"
      ? options.clientSecret
      : await options.clientSecret.value();
  const oauth = new McpOAuth(
    { user: pending.user, redirectUri: pending.redirectUri },
    pending.url,
    () => {
      return options.store;
    },
    options.fetch,
  );

  await oauth.exchange(pending, options.code, secret);

  const data: McpAuthorizedData = {
    server: pending.server,
    user: pending.user,
    url: pending.url,
  };

  await options.send?.({ name: mcpAuthorizedEvent, data });

  return data;
};

/**
 * Pauses the run until `user` finishes connecting a server (the
 * `agent/mcp.authorized` event that `completeMcpAuthorization()` sends).
 * Returns the event, or `null` if `timeout` passes first. Call it from the
 * agent function after a tool returned a needs-authorization result.
 */
export const waitForMcpAuthorization = async (options: {
  /**
   * The user, as `auth.oauth.user` named them.
   */
  user: string;

  /**
   * Only this server (its name in `tools: { hex }`). Default: any.
   */
  server?: string;

  /**
   * How long to wait, such as `"10m"`.
   */
  timeout: string;

  /**
   * The step ID. Default `mcp:authorized:<server>:<user>`.
   */
  id?: string;
}): Promise<{ name: string; data: McpAuthorizedData } | null> => {
  const condition = [
    `async.data.user == ${JSON.stringify(options.user)}`,
    ...(options.server === undefined
      ? []
      : [`async.data.server == ${JSON.stringify(options.server)}`]),
  ].join(" && ");
  const found = await step.waitForEvent(
    options.id ?? `mcp:authorized:${options.server ?? "any"}:${options.user}`,
    {
      event: mcpAuthorizedEvent,
      timeout: options.timeout as "1m",
      if: condition,
    },
  );

  return found
    ? { name: found.name, data: found.data as McpAuthorizedData }
    : null;
};
