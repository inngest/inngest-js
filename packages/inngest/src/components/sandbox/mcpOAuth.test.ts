/**
 * @module
 * Tests for per-user OAuth on `tool.mcp()`: the flow against a fake OAuth MCP
 * server, refresh and its races, revocation, and that no credential leaks.
 */
import { beforeAll, describe, expect, test } from "vitest";
import { memoryKvAdapter } from "../../experimental/agents/kv/kv.ts";
import { kvOAuthStore } from "../../experimental/agents/kv/mcpOAuthStore.ts";
import { getAsyncLocalStorage, runWithAsyncCtx } from "../execution/als.ts";
import { fakeMcpFetch, memoryOAuthStore } from "./mcpFakes.ts";
import {
  type McpAuthorizedData,
  type McpNeedsAuthorization,
  type McpOAuthStore,
  mcpCallback,
} from "./mcpOAuth.ts";
import { secret } from "./secret.ts";
import type { SandboxTool } from "./tools.ts";
import { tool } from "./tools.ts";

beforeAll(async () => {
  // The async context store starts on first use.
  await getAsyncLocalStorage();
});

const redirectUri = "https://app.example.test/oauth/hex/callback";

const tools = {
  create_thread: {
    description: "Starts a thread",
    run: (args: Record<string, unknown>) => {
      return { id: "t-1", prompt: args.prompt };
    },
  },
  get_thread: {
    annotations: { readOnlyHint: true },
    run: () => {
      return "running";
    },
  },
};

const setup = (
  options: {
    ttl?: number;
    user?: string;
    registration?: boolean;
    clientSecret?: string;
  } = {},
) => {
  const server = fakeMcpFetch({
    tools,
    oauth: {
      accessTokenTtl: options.ttl,
      registration: options.registration,
      client: { id: "preset" },
    },
  });
  const store = memoryOAuthStore();
  const needs: McpNeedsAuthorization[] = [];
  const hex = tool.mcp({
    id: "hex",
    url: server.url,
    fetch: server.fetch,
    auth: {
      oauth: {
        user: options.user ?? "U1",
        redirectUri,
        store,
        ...(options.registration === false && { clientId: "preset" }),
        ...(options.clientSecret && { clientSecret: options.clientSecret }),
        onNeedsAuthorization: (info) => {
          needs.push(info);
        },
      },
    },
  });

  return { server, store, hex, needs };
};

const build = async (hex: ReturnType<typeof tool.mcp>) => {
  return hex["~build"]("hex", await hex["~list"]("hex"));
};

const run = async (entry: unknown, input: unknown = {}) => {
  return (entry as SandboxTool & { run: (...args: unknown[]) => unknown }).run(
    input,
    {
      signal: new AbortController().signal,
      idempotencyKey: "k",
    },
  );
};

type Fixture = ReturnType<typeof setup>;

// What the person's browser does with the link the app was given: open it,
// approve at the authorization server, come back with the same cookie.
const browse = async (
  fixture: Pick<Fixture, "server" | "store">,
  link: string,
  options: { code?: string; sent?: McpAuthorizedData[] } = {},
) => {
  const callback = mcpCallback({
    store: fixture.store,
    fetch: fixture.server.fetch,
    send: async (event) => {
      options.sent?.push(event.data);
    },
  });
  const opened = await callback(new Request(link));
  const cookie = (opened.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const returned = new URL(
    await fixture.server.approve(opened.headers.get("location") ?? ""),
  );

  if (options.code !== undefined) {
    returned.searchParams.set("code", options.code);
  }

  return callback(new Request(returned, { headers: { cookie } }));
};

const connectUser = async (
  fixture: Fixture,
  info: McpNeedsAuthorization,
  sent: McpAuthorizedData[] = [],
) => {
  const response = await browse(fixture, info.url, { sent });

  expect(response.status).toBe(200);

  return sent.at(-1) as McpAuthorizedData;
};

// A sign-in for another user of the same server, as the app would be told.
const nextLink = async (
  fixture: Fixture,
  user: string,
): Promise<McpNeedsAuthorization> => {
  const other = tool.mcp({
    id: "hex",
    url: fixture.server.url,
    fetch: fixture.server.fetch,
    auth: {
      oauth: {
        user,
        redirectUri,
        store: fixture.store,
        onNeedsAuthorization: (info) => {
          fixture.needs.push(info);
        },
      },
    },
  });

  const built = await build(other);

  await run(built.hex_create_thread ?? built.hex_connect, {});

  return fixture.needs.at(-1) as McpNeedsAuthorization;
};

const pause = (ms: number) => {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

// The sign-in the app was just told about. The tool's own result is a
// message for the model and holds no link.
const needsAuth = (fixture: Fixture, value: unknown): McpNeedsAuthorization => {
  expect(String(value)).toMatch(/sign-in link/);
  expect(String(value)).not.toContain("http");

  return fixture.needs.at(-1) as McpNeedsAuthorization;
};

describe("tool.mcp OAuth", () => {
  test("a user with no token gets one connect tool, then a link, then the call works", async () => {
    const fixture = setup();
    const built = await build(fixture.hex);

    // Nothing is known about the server's tools yet.
    expect(Object.keys(built)).toEqual(["hex_connect"]);

    const info = needsAuth(fixture, await run(built.hex_connect));

    expect(fixture.needs).toHaveLength(1);
    expect(info).toMatchObject({ server: "hex", user: "U1" });

    // The link opens on the app's own route, then goes on to the server.
    expect(info.url.startsWith(redirectUri)).toBe(true);

    const opened = await mcpCallback({
      store: fixture.store,
      fetch: fixture.server.fetch,
    })(new Request(info.url));
    const url = new URL(opened.headers.get("location") ?? "");

    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(url.searchParams.get("scope")).toBe("read offline_access");
    expect(url.searchParams.get("resource")).toContain("/mcp");
    // The verifier is not in the link.
    expect(url.toString()).not.toContain("code_verifier");
    expect(info.url).not.toContain("code_challenge");

    // Opening the link above used it up for any other browser; the app is
    // told about a new one when the model asks again.
    const sent: McpAuthorizedData[] = [];
    const done = await connectUser(
      fixture,
      needsAuth(fixture, await run(built.hex_connect)),
      sent,
    );

    expect(done).toMatchObject({ server: "hex", user: "U1" });
    expect(sent).toEqual([done]);

    // A new run lists with the token.
    const next = await build(fixture.hex);

    expect(Object.keys(next)).toEqual(["hex_create_thread", "hex_get_thread"]);
    expect(await run(next.hex_create_thread, { prompt: "hi" })).toEqual({
      id: "t-1",
      prompt: "hi",
    });
    expect(fixture.server.calls.at(-1)?.headers.authorization).toMatch(
      /^Bearer access-/,
    );
  });

  test("a tool call for a user with no token returns the link, and tools are known once anyone connected", async () => {
    const first = setup();
    const info = needsAuth(
      first,
      await run((await build(first.hex)).hex_connect),
    );

    await connectUser(first, info);
    // The first successful listing is remembered for everyone.
    await build(first.hex);

    // Another user, same server and store: tools show, calls ask to connect.
    const other = tool.mcp({
      id: "hex",
      url: first.server.url,
      fetch: first.server.fetch,
      auth: {
        oauth: {
          user: "U2",
          redirectUri,
          store: first.store,
          onNeedsAuthorization: (info) => {
            first.needs.push(info);
          },
        },
      },
    });
    const built = await build(other);

    expect(Object.keys(built)).toEqual(["hex_create_thread", "hex_get_thread"]);

    const result = needsAuth(
      first,
      await run(built.hex_create_thread, { prompt: "x" }),
    );

    expect(result.user).toBe("U2");
    expect(
      first.server.calls.filter((c) => c.method === "tools/call"),
    ).toHaveLength(0);
  });

  test("dynamic registration happens once, and a configured client is used without it", async () => {
    const dynamic = setup();

    await run((await build(dynamic.hex)).hex_connect);
    await run((await build(dynamic.hex)).hex_connect);

    expect(
      dynamic.server.oauthCalls.filter((c) => c.path === "/oauth/register"),
    ).toHaveLength(1);

    const fixed = setup({ registration: false });
    const info = needsAuth(
      fixed,
      await run((await build(fixed.hex)).hex_connect),
    );

    const opened = await mcpCallback({
      store: fixed.store,
      fetch: fixed.server.fetch,
    })(new Request(info.url));

    expect(
      new URL(opened.headers.get("location") ?? "").searchParams.get(
        "client_id",
      ),
    ).toBe("preset");
    expect(
      fixed.server.oauthCalls.filter((c) => c.path === "/oauth/register"),
    ).toHaveLength(0);
  });

  test("an expired token refreshes on the host, once, however many calls race", async () => {
    const fixture = setup({ ttl: 1 });
    const info = needsAuth(
      fixture,
      await run((await build(fixture.hex)).hex_connect),
    );

    await connectUser(fixture, info);

    const built = await build(fixture.hex);

    await pause(1100);

    const results = await Promise.all(
      Array.from({ length: 8 }, () => {
        return run(built.hex_create_thread, { prompt: "p" });
      }),
    );

    expect(results.every((r) => (r as { id: string }).id === "t-1")).toBe(true);
    expect(
      fixture.server.oauthCalls.filter((c) => c.path === "/oauth/token").length,
    ).toBe(2); // the code exchange, then one refresh
  });

  test("a rotated refresh token is kept and used next time", async () => {
    const fixture = setup({ ttl: 1 });
    const info = needsAuth(
      fixture,
      await run((await build(fixture.hex)).hex_connect),
    );

    await connectUser(fixture, info);

    const built = await build(fixture.hex);

    for (const prompt of ["a", "b", "c"]) {
      await pause(1100);
      await run(built.hex_create_thread, { prompt });
    }

    expect(
      fixture.server.oauthCalls.filter((c) => c.path === "/oauth/token").length,
    ).toBeGreaterThanOrEqual(3);
  });

  test("a token the server stopped accepting is refreshed and the call is sent again", async () => {
    const fixture = setup();
    const info = needsAuth(
      fixture,
      await run((await build(fixture.hex)).hex_connect),
    );

    await connectUser(fixture, info);

    const built = await build(fixture.hex);

    fixture.server.expireAccessTokens();

    expect(await run(built.hex_create_thread, { prompt: "p" })).toEqual({
      id: "t-1",
      prompt: "p",
    });
    expect(
      fixture.server.oauthCalls.filter((c) => c.path === "/oauth/token"),
    ).toHaveLength(2);
  });

  test("a revoked grant goes back to needing authorization", async () => {
    const fixture = setup({ ttl: 1 });
    const info = needsAuth(
      fixture,
      await run((await build(fixture.hex)).hex_connect),
    );

    await connectUser(fixture, info);

    const built = await build(fixture.hex);

    fixture.server.revokeTokens();

    const result = needsAuth(
      fixture,
      await run(built.hex_create_thread, { prompt: "p" }),
    );

    expect(result.user).toBe("U1");
    expect(
      [...fixture.store.values.keys()].some(
        (k) => k.startsWith("token:") && !k.endsWith(":lease"),
      ),
    ).toBe(false);
    expect(fixture.needs).toHaveLength(2);

    // And connecting again works.
    await connectUser(fixture, result);
    expect(await run(built.hex_create_thread, { prompt: "q" })).toMatchObject({
      id: "t-1",
    });
  });

  test("a link works once, an unknown link is refused, and a denial is refused", async () => {
    const fixture = setup();
    const info = needsAuth(
      fixture,
      await run((await build(fixture.hex)).hex_connect),
    );
    const callback = mcpCallback({
      store: fixture.store,
      fetch: fixture.server.fetch,
    });
    const opened = await callback(new Request(info.url));
    const cookie = (opened.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const returned = await fixture.server.approve(
      opened.headers.get("location") ?? "",
    );
    const back = () => {
      return callback(new Request(returned, { headers: { cookie } }));
    };

    expect((await back()).status).toBe(200);

    const again = await back();

    expect(again.status).toBe(400);
    expect(await again.text()).toContain("expired or was already used");

    const unknown = await callback(
      new Request(`${redirectUri}?code=x&state=nope`, { headers: { cookie } }),
    );

    expect(unknown.status).toBe(400);

    const denied = await nextLink(fixture, "U5");
    const deniedOpen = await callback(new Request(denied.url));
    const deniedCookie =
      (deniedOpen.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const state = new URL(
      deniedOpen.headers.get("location") ?? "",
    ).searchParams.get("state");
    const refused = await callback(
      new Request(`${redirectUri}?error=access_denied&state=${state}`, {
        headers: { cookie: deniedCookie },
      }),
    );

    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("not approved");
  });

  test("a wrong code is refused by the server and stores nothing", async () => {
    const fixture = setup();
    const info = needsAuth(
      fixture,
      await run((await build(fixture.hex)).hex_connect),
    );
    const response = await browse(fixture, info.url, { code: "forged" });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(
      [...fixture.store.values.keys()].some(
        (k) => k.startsWith("token:") && !k.endsWith(":lease"),
      ),
    ).toBe(false);
  });

  test("users do not share tokens", async () => {
    const fixture = setup();
    const info = needsAuth(
      fixture,
      await run((await build(fixture.hex)).hex_connect),
    );

    await connectUser(fixture, info);
    await build(fixture.hex);

    const other = tool.mcp({
      id: "hex",
      url: fixture.server.url,
      fetch: fixture.server.fetch,
      auth: {
        oauth: {
          user: "U2",
          redirectUri,
          store: fixture.store,
          onNeedsAuthorization: (next) => {
            fixture.needs.push(next);
          },
        },
      },
    });
    const built = await build(other);

    expect(
      needsAuth(fixture, await run(built.hex_create_thread, {})).user,
    ).toBe("U2");
  });

  test("no credential reaches a result, an error, the link or the callback page", async () => {
    const fixture = setup({ ttl: 1 });
    const result = await run((await build(fixture.hex)).hex_connect);
    const info = needsAuth(fixture, result);

    await connectUser(fixture, info);

    const code =
      new URLSearchParams(
        fixture.server.oauthCalls.find((call) => {
          return call.path === "/oauth/token";
        })?.body ?? "",
      ).get("code") ?? "";

    expect(code).not.toBe("");

    const built = await build(fixture.hex);
    const out = JSON.stringify([
      result,
      await run(built.hex_create_thread, { prompt: "p" }),
      await build(fixture.hex),
    ]);

    expect(out).not.toMatch(/access-\d|refresh-\d/);
    expect(out).not.toContain(code);
    expect(out).not.toContain(info.url);

    // A failing exchange does not echo the code or verifier either.
    const failed = await browse(fixture, (await nextLink(fixture, "U9")).url, {
      code: "secret-code-1234",
    });

    expect(failed.status).toBeGreaterThanOrEqual(400);
    expect(await failed.text()).not.toContain("secret-code-1234");
  });

  test("kvOAuthStore encrypts at rest and swaps by plaintext", async () => {
    const adapter = memoryKvAdapter();
    const store = kvOAuthStore({
      adapter,
      encryptionKey: secret(() => "a-long-random-test-key"),
    });

    expect(await store.compareAndSet("k", null, "hello")).toBe(true);
    expect(await store.get("k")).toBe("hello");
    expect(await adapter.get("inngest:mcp-oauth", "k")).not.toContain("hello");
    expect(await store.compareAndSet("k", null, "x")).toBe(false);
    expect(await store.compareAndSet("k", "nope", "x")).toBe(false);
    expect(await store.compareAndSet("k", "hello", "world")).toBe(true);
    expect(await store.get("k")).toBe("world");

    // A value moved to another field does not decrypt.
    const raw = await adapter.get("inngest:mcp-oauth", "k");

    await adapter.set("inngest:mcp-oauth", "moved", raw ?? "");
    expect(await store.get("moved")).toBeNull();

    // The wrong key reads as absent.
    const other = kvOAuthStore({
      adapter,
      encryptionKey: secret(() => "different-key-entirely"),
    });

    expect(await other.get("k")).toBeNull();
    await store.delete("k");
    expect(await store.get("k")).toBeNull();
  });
});
