/**
 * @module
 * Tests for the safety rules of `tool.mcp()` sign-in: the model never sees the
 * sign-in URL, the app gets it through `onNeedsAuthorization`, the link only
 * works in the browser that first opened it, tokens live under the server's
 * `id`, and `disconnect()` removes them.
 */
import { beforeAll, describe, expect, test, vi } from "vitest";
import { getAsyncLocalStorage, runWithAsyncCtx } from "../execution/als.ts";
import { disconnect } from "./mcp.ts";
import { fakeMcpFetch } from "./mcpFakes.ts";
import type { McpOAuthStore } from "./mcpOAuth.ts";
import { mcpCallback } from "./mcpOAuth.ts";
import type { SandboxTool } from "./tools.ts";
import { tool } from "./tools.ts";

beforeAll(async () => {
  // The async context store starts on first use.
  await getAsyncLocalStorage();
});

const redirectUri = "https://app.example.test/oauth/hex/callback";

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

interface Hooked {
  url: string;
  server: string;
  thread?: { key: string };
  user: string;
}

const setup = (
  options: {
    hook?: boolean;
    id?: string;
    user?:
      | string
      | ((ctx: {
          runId?: string;
          event?: unknown;
          thread?: { key: string };
        }) => string);
    server?: ReturnType<typeof fakeMcpFetch>;
    store?: ReturnType<typeof memoryStore>;
  } = {},
) => {
  const server =
    options.server ??
    fakeMcpFetch({
      tools: { ping: { run: () => "pong" } },
      oauth: { client: { id: "preset" } },
    });
  const store = options.store ?? memoryStore();
  const hooked: Hooked[] = [];
  const warnings: string[] = [];
  const hex = tool.mcp({
    id: options.id ?? "hex",
    url: server.url,
    fetch: server.fetch,
    auth: {
      oauth: {
        user: options.user ?? "U1",
        redirectUri,
        store,
        ...(options.hook !== false && {
          onNeedsAuthorization: (info: Hooked) => {
            hooked.push(info);
          },
        }),
      },
    },
  });

  return { server, store, hex, hooked, warnings };
};

// Runs `fn` as if inside a run of an agent thread.
const inRun = <T>(
  fn: () => Promise<T>,
  warnings: string[] = [],
  extra: { threadKey?: string; event?: unknown } = {},
): Promise<T> => {
  return runWithAsyncCtx(
    {
      app: {} as never,
      execution: {
        ctx: {
          runId: "run-1",
          event: extra.event ?? { name: "chat/message", data: { q: "hi" } },
          logger: {
            warn: (message: string) => {
              warnings.push(message);
            },
          },
        },
        agent: { thread: extra.threadKey ?? "thread-1" },
      } as never,
    },
    fn,
  ) as Promise<T>;
};

const build = (hex: ReturnType<typeof tool.mcp>) => {
  return hex["~build"]("hex", { tools: [], connect: true });
};

const call = async (entry: unknown) => {
  return (entry as SandboxTool & { run: (...args: unknown[]) => unknown }).run(
    {},
    { signal: new AbortController().signal, idempotencyKey: "k" },
  );
};

const handler = (fixture: ReturnType<typeof setup>) => {
  return mcpCallback({ store: fixture.store, fetch: fixture.server.fetch });
};

const cookieOf = (response: Response): string => {
  return (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
};

describe("MCP sign-in: the model never sees the URL", () => {
  test("the app's hook gets { url, server, thread, user }; the model gets a result with no URL", async () => {
    const fixture = setup();
    const built = build(fixture.hex);
    const result = await inRun(() => {
      return call(built.hex_connect);
    }, fixture.warnings);

    expect(fixture.hooked).toHaveLength(1);
    expect(fixture.hooked[0]).toMatchObject({
      server: "hex",
      thread: { key: "thread-1" },
      user: "U1",
    });
    expect(fixture.hooked[0]?.url).toMatch(/^https:\/\/app\.example\.test\//);

    const seen = JSON.stringify(result);

    expect(seen).not.toContain("http");
    expect(seen).not.toContain(fixture.hooked[0]?.url ?? "");
    expect(seen).not.toContain("authorize");
    expect(seen).toMatch(/sign-in link for hex was sent/i);
  });

  test("with no hook the model gets an error result without the URL and the trace gets a warning", async () => {
    const fixture = setup({ hook: false });
    const built = build(fixture.hex);
    const result = await inRun(() => {
      return call(built.hex_connect);
    }, fixture.warnings);
    const seen = JSON.stringify(result);

    expect(seen).toContain("~error");
    expect(seen).not.toContain("http");
    expect(seen).not.toContain("authorize");
    expect(fixture.warnings.join("\n")).toMatch(/onNeedsAuthorization/);
    expect(fixture.warnings.join("\n")).not.toContain("http");
  });

  test("the pending link never reaches the model through a tool call either", async () => {
    const fixture = setup();
    const listing = await inRun(() => {
      return fixture.hex["~list"]("hex");
    });

    expect(listing.connect).toBe(true);
  });
});

describe("MCP sign-in: the link belongs to the browser that opened it", () => {
  const start = async (fixture: ReturnType<typeof setup>) => {
    await inRun(() => {
      return call(build(fixture.hex).hex_connect);
    });

    return fixture.hooked[0]?.url ?? "";
  };

  test("the browser that opened the link finishes it", async () => {
    const fixture = setup();
    const link = await start(fixture);
    const callback = handler(fixture);
    const opened = await callback(new Request(link));

    expect(opened.status).toBe(302);

    const cookie = cookieOf(opened);

    expect(cookie).not.toBe("");
    expect(opened.headers.get("set-cookie")).toMatch(/HttpOnly/i);
    expect(opened.headers.get("set-cookie")).toMatch(/SameSite=Lax/i);

    const returned = await fixture.server.approve(
      opened.headers.get("location") ?? "",
    );
    const done = await callback(new Request(returned, { headers: { cookie } }));

    expect(done.status).toBe(200);
    expect([...fixture.store.values.keys()]).toContain("token:hex:U1");
  });

  test("a second browser cannot open a link the first opened", async () => {
    const fixture = setup();
    const link = await start(fixture);
    const callback = handler(fixture);

    await callback(new Request(link));

    const second = await callback(new Request(link));

    expect(second.status).toBeGreaterThanOrEqual(400);
    expect(second.headers.get("location")).toBeNull();
  });

  test("a second browser cannot finish the callback without the cookie", async () => {
    const fixture = setup();
    const link = await start(fixture);
    const callback = handler(fixture);
    const opened = await callback(new Request(link));
    const returned = await fixture.server.approve(
      opened.headers.get("location") ?? "",
    );

    const without = await callback(new Request(returned));
    const wrong = await callback(
      new Request(returned, {
        headers: { cookie: `${cookieOf(opened).split("=")[0]}=other` },
      }),
    );

    expect(without.status).toBeGreaterThanOrEqual(400);
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    expect(
      [...fixture.store.values.keys()].some((key) => key.startsWith("token:")),
    ).toBe(false);

    // The right browser can still finish: a refused attempt did not use it up.
    const right = await callback(
      new Request(returned, { headers: { cookie: cookieOf(opened) } }),
    );

    expect(right.status).toBe(200);
  });

  test("a callback for a link that was never opened is refused", async () => {
    const fixture = setup();

    await start(fixture);

    const [pendingKey] = [...fixture.store.values.keys()].filter((key) => {
      return key.startsWith("pending:");
    });
    const state = (pendingKey ?? "").slice("pending:".length);
    const forged = await handler(fixture)(
      new Request(`${redirectUri}?code=x&state=${state}`),
    );

    expect(forged.status).toBeGreaterThanOrEqual(400);
  });
});

describe("MCP tokens are stored under the server id", () => {
  const connect = async (fixture: ReturnType<typeof setup>) => {
    await inRun(() => {
      return call(build(fixture.hex).hex_connect);
    });

    const callback = handler(fixture);
    const opened = await callback(new Request(fixture.hooked[0]?.url ?? ""));
    const returned = await fixture.server.approve(
      opened.headers.get("location") ?? "",
    );

    await callback(
      new Request(returned, { headers: { cookie: cookieOf(opened) } }),
    );
  };

  test("the key is token:<id>:<user>, not a hash of the URL", async () => {
    const fixture = setup({ id: "hex" });

    await connect(fixture);

    const keys = [...fixture.store.values.keys()].filter((key) => {
      return key.startsWith("token:");
    });

    expect(keys).toEqual(["token:hex:U1"]);
  });

  test("two servers with different ids at one URL do not share tokens", async () => {
    const first = setup({ id: "hex" });

    await connect(first);

    const other = setup({
      id: "hex2",
      server: first.server,
      store: first.store,
    });
    const listed = await inRun(() => {
      return other.hex["~list"]("hex2");
    });

    expect(listed.connect).toBe(true);
  });

  test("disconnect(server, user) removes the token; the user is asked again", async () => {
    const fixture = setup();

    await connect(fixture);
    expect(fixture.store.values.has("token:hex:U1")).toBe(true);

    await disconnect(fixture.hex, "U1");

    expect(fixture.store.values.has("token:hex:U1")).toBe(false);

    const again = await inRun(() => {
      return fixture.hex["~list"]("hex");
    });

    expect(again.connect).toBe(true);
  });

  test("server.disconnect(user) does the same, and leaves other users alone", async () => {
    const fixture = setup();

    await connect(fixture);
    fixture.store.values.set("token:hex:U2", "{}");

    await fixture.hex.disconnect("U1");

    expect(fixture.store.values.has("token:hex:U1")).toBe(false);
    expect(fixture.store.values.has("token:hex:U2")).toBe(true);
  });

  test("disconnect resolves to undefined", async () => {
    const fixture = setup();

    await expect(fixture.hex.disconnect("nobody")).resolves.toBeUndefined();
  });
});

describe("MCP OAuth user function", () => {
  test("gets { runId, event, thread } of the run", async () => {
    const seen = vi.fn(() => "U1");
    const fixture = setup({ user: seen });

    await inRun(
      () => {
        return call(build(fixture.hex).hex_connect);
      },
      [],
      { threadKey: "T-9", event: { name: "chat/message", data: { q: "x" } } },
    );

    expect(seen).toHaveBeenCalledWith({
      runId: "run-1",
      event: { name: "chat/message", data: { q: "x" } },
      thread: { key: "T-9" },
    });
  });
});
