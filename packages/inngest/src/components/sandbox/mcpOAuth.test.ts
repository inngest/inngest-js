/**
 * @module
 * Tests for per-user OAuth on `tool.mcp()`: the flow against a fake OAuth MCP
 * server, refresh and its races, revocation, and that no credential leaks.
 */
import { describe, expect, test } from "vitest";
import { memoryKvAdapter } from "../agent/kv.ts";
import { kvOAuthStore } from "../agent/mcpOAuthStore.ts";
import { fakeMcpFetch } from "../agent/testing/mcp.ts";
import {
  completeMcpAuthorization,
  isMcpNeedsAuthorization,
  type McpAuthorizedData,
  type McpNeedsAuthorization,
  type McpOAuthStore,
} from "./mcpOAuth.ts";
import { secret } from "./secret.ts";
import type { SandboxTool } from "./tools.ts";
import { tool } from "./tools.ts";

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

const memoryStore = (): McpOAuthStore & { values: Map<string, string> } => {
  const values = new Map<string, string>();

  return {
    values,
    get: async (key) => {
      return values.get(key) ?? null;
    },
    compareAndSet: async (key, expected, next) => {
      if ((values.get(key) ?? null) !== expected) {
        return false;
      }

      values.set(key, next);

      return true;
    },
    delete: async (key) => {
      values.delete(key);
    },
  };
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
  const store = memoryStore();
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

const connectUser = async (
  fixture: ReturnType<typeof setup>,
  info: McpNeedsAuthorization,
  sent: McpAuthorizedData[] = [],
) => {
  const callback = new URL(await fixture.server.approve(info.authorizeUrl));

  return completeMcpAuthorization({
    store: fixture.store,
    code: callback.searchParams.get("code") ?? "",
    state: callback.searchParams.get("state") ?? "",
    fetch: fixture.server.fetch,
    send: async (event) => {
      sent.push(event.data);
    },
  });
};

const pause = (ms: number) => {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

const needsAuth = (value: unknown): McpNeedsAuthorization => {
  expect(isMcpNeedsAuthorization(value)).toBe(true);

  return (value as { "~error": McpNeedsAuthorization })["~error"];
};

describe("tool.mcp OAuth", () => {
  test("a user with no token gets one connect tool, then a link, then the call works", async () => {
    const fixture = setup();
    const built = await build(fixture.hex);

    // Nothing is known about the server's tools yet.
    expect(Object.keys(built)).toEqual(["hex_connect"]);

    const info = needsAuth(await run(built.hex_connect));

    expect(fixture.needs).toHaveLength(1);
    expect(info).toMatchObject({ server: "hex", user: "U1" });

    const url = new URL(info.authorizeUrl);

    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(url.searchParams.get("scope")).toBe("read offline_access");
    expect(url.searchParams.get("resource")).toContain("/mcp");
    // The verifier is not in the link.
    expect(info.authorizeUrl).not.toContain("code_verifier");

    const sent: McpAuthorizedData[] = [];
    const done = await connectUser(fixture, info, sent);

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
    const info = needsAuth(await run((await build(first.hex)).hex_connect));

    await connectUser(first, info);
    // The first successful listing is remembered for everyone.
    await build(first.hex);

    // Another user, same server and store: tools show, calls ask to connect.
    const other = tool.mcp({
      id: "hex",
      url: first.server.url,
      fetch: first.server.fetch,
      auth: { oauth: { user: "U2", redirectUri, store: first.store } },
    });
    const built = await build(other);

    expect(Object.keys(built)).toEqual(["hex_create_thread", "hex_get_thread"]);

    const result = needsAuth(
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
    const info = needsAuth(await run((await build(fixed.hex)).hex_connect));

    expect(new URL(info.authorizeUrl).searchParams.get("client_id")).toBe(
      "preset",
    );
    expect(
      fixed.server.oauthCalls.filter((c) => c.path === "/oauth/register"),
    ).toHaveLength(0);
  });

  test("an expired token refreshes on the host, once, however many calls race", async () => {
    const fixture = setup({ ttl: 1 });
    const info = needsAuth(await run((await build(fixture.hex)).hex_connect));

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
    const info = needsAuth(await run((await build(fixture.hex)).hex_connect));

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
    const info = needsAuth(await run((await build(fixture.hex)).hex_connect));

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
    const info = needsAuth(await run((await build(fixture.hex)).hex_connect));

    await connectUser(fixture, info);

    const built = await build(fixture.hex);

    fixture.server.revokeTokens();

    const result = needsAuth(
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

  test("a link works once, expires, and a denial is refused", async () => {
    const fixture = setup();
    const info = needsAuth(await run((await build(fixture.hex)).hex_connect));
    const callback = new URL(await fixture.server.approve(info.authorizeUrl));
    const params = {
      store: fixture.store,
      code: callback.searchParams.get("code") ?? "",
      state: callback.searchParams.get("state") ?? "",
      fetch: fixture.server.fetch,
    };

    await completeMcpAuthorization(params);
    await expect(completeMcpAuthorization(params)).rejects.toThrow(
      "already used",
    );
    await expect(
      completeMcpAuthorization({ ...params, state: "nope" }),
    ).rejects.toThrow("expired or was already used");
    await expect(
      completeMcpAuthorization({ ...params, error: "access_denied" }),
    ).rejects.toThrow("did not approve");
  });

  test("a link made for one user is refused for another, and still works for the right one", async () => {
    const fixture = setup();
    const info = needsAuth(await run((await build(fixture.hex)).hex_connect));
    const callback = new URL(await fixture.server.approve(info.authorizeUrl));
    const params = {
      store: fixture.store,
      code: callback.searchParams.get("code") ?? "",
      state: callback.searchParams.get("state") ?? "",
      fetch: fixture.server.fetch,
    };

    await expect(
      completeMcpAuthorization({ ...params, expectUser: "attacker" }),
    ).rejects.toThrow("another user");
    await expect(
      completeMcpAuthorization({ ...params, expectUser: "U1" }),
    ).resolves.toMatchObject({ user: "U1" });
  });

  test("a wrong code is refused by the server and stores nothing", async () => {
    const fixture = setup();
    const info = needsAuth(await run((await build(fixture.hex)).hex_connect));
    const callback = new URL(await fixture.server.approve(info.authorizeUrl));

    await expect(
      completeMcpAuthorization({
        store: fixture.store,
        code: "forged",
        state: callback.searchParams.get("state") ?? "",
        fetch: fixture.server.fetch,
      }),
    ).rejects.toThrow("invalid_grant");
    expect(
      [...fixture.store.values.keys()].some(
        (k) => k.startsWith("token:") && !k.endsWith(":lease"),
      ),
    ).toBe(false);
  });

  test("users do not share tokens", async () => {
    const fixture = setup();
    const info = needsAuth(await run((await build(fixture.hex)).hex_connect));

    await connectUser(fixture, info);
    await build(fixture.hex);

    const other = tool.mcp({
      id: "hex",
      url: fixture.server.url,
      fetch: fixture.server.fetch,
      auth: { oauth: { user: "U2", redirectUri, store: fixture.store } },
    });
    const built = await build(other);

    expect(needsAuth(await run(built.hex_create_thread, {})).user).toBe("U2");
  });

  test("no credential reaches a result, an error or the stored link", async () => {
    const fixture = setup({ ttl: 1 });
    const info = needsAuth(await run((await build(fixture.hex)).hex_connect));
    const callback = new URL(await fixture.server.approve(info.authorizeUrl));
    const code = callback.searchParams.get("code") ?? "";

    await connectUser(fixture, info);

    const built = await build(fixture.hex);
    const out = JSON.stringify([
      info,
      await run(built.hex_create_thread, { prompt: "p" }),
      await build(fixture.hex),
    ]);

    expect(out).not.toMatch(/access-\d|refresh-\d/);
    expect(out).not.toContain(code);

    // A failing exchange does not echo the code or verifier either.
    const again = needsAuth(
      await run(
        (
          await build(
            tool.mcp({
              id: "hex",
              url: fixture.server.url,
              fetch: fixture.server.fetch,
              auth: {
                oauth: { user: "U9", redirectUri, store: fixture.store },
              },
            }),
          )
        ).hex_create_thread,
        {},
      ),
    );
    const second = new URL(await fixture.server.approve(again.authorizeUrl));
    const error = await completeMcpAuthorization({
      store: fixture.store,
      code: "secret-code-1234",
      state: second.searchParams.get("state") ?? "",
      fetch: fixture.server.fetch,
    }).catch((caught: Error) => {
      return caught;
    });

    expect(String((error as Error).stack)).not.toContain("secret-code-1234");
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
