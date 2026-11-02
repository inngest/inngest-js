/**
 * @module
 * Tests for the network guard that covers every request `tool.mcp()` makes:
 * the MCP server itself and the OAuth endpoints it points to.
 */
import { describe, expect, test } from "vitest";
import { fakeMcpFetch, memoryOAuthStore } from "./mcpFakes.ts";
import { assertMcpUrl, isLoopbackUrl } from "./mcpGuard.ts";
import { tool } from "./tools.ts";

describe("assertMcpUrl", () => {
  test.each([
    "https://mcp.example.com/mcp",
    "https://93.184.216.34/mcp",
    "https://[2606:4700::1111]/mcp",
    "http://localhost:8288/mcp",
    "http://127.0.0.1:3000/mcp",
    "http://[::1]:3000/mcp",
    "https://localhost/mcp",
  ])("allows %s", (url) => {
    expect(() => {
      assertMcpUrl(url, "url");
    }).not.toThrow();
  });

  test.each([
    "http://mcp.example.com/mcp",
    "ftp://mcp.example.com/mcp",
    "http://93.184.216.34/mcp",
  ])("refuses %s: not https", (url) => {
    expect(() => {
      assertMcpUrl(url, "url");
    }).toThrow(/https/);
  });

  test.each([
    "https://10.0.0.5/mcp",
    "https://172.16.0.1/mcp",
    "https://172.31.255.255/mcp",
    "https://192.168.1.10/mcp",
    "https://169.254.169.254/latest/meta-data",
    "https://0.0.0.0/mcp",
    "https://100.64.0.1/mcp",
    "https://[fd00::1]/mcp",
    "https://[fe80::1]/mcp",
    "https://[::ffff:10.0.0.1]/mcp",
    "https://[::ffff:a00:1]/mcp",
    "https://db.internal/mcp",
    "https://printer.local/mcp",
    "https://metadata.google.internal/mcp",
    "https://intranet/mcp",
    "https://2130706433/mcp",
    "https://0x7f.0.0.1/mcp",
  ])("refuses %s: private or internal", (url) => {
    expect(() => {
      assertMcpUrl(url, "url");
    }).toThrow(/private or internal/);
  });

  test.each([
    "https://metadata.google.internal./mcp",
    "https://intranet./mcp",
    "https://localhost./mcp",
    "https://db.internal../mcp",
    "https://224.0.0.1/mcp",
    "https://255.255.255.255/mcp",
    "https://[::]/mcp",
    "https://[ff02::1]/mcp",
    "https://[ff00::]/mcp",
    "https://[64:ff9b::a00:1]/mcp",
    "https://[2002:a00:1::]/mcp",
    "https://[::10.0.0.1]/mcp",
    "https://[::a00:1]/mcp",
    "https://cache.localhost/mcp",
    "https://nas.lan/mcp",
    "https://box.home/mcp",
    "https://100.127.255.255/mcp",
    "https://127.0.0.2/mcp",
  ])("refuses %s: private or internal", (url) => {
    expect(() => {
      assertMcpUrl(url, "url");
    }).toThrow(/private or internal|https/);
  });

  test("allows public addresses embedded in IPv6 forms", () => {
    for (const url of [
      "https://[64:ff9b::5db8:d822]/mcp",
      "https://[2002:5db8:d822::]/mcp",
      "https://[::ffff:5db8:d822]/mcp",
    ]) {
      expect(() => {
        assertMcpUrl(url, "url");
      }).not.toThrow();
    }
  });

  test("allows addresses just outside the private ranges", () => {
    for (const url of [
      "https://172.15.0.1/mcp",
      "https://172.32.0.1/mcp",
      "https://11.0.0.1/mcp",
      "https://100.128.0.1/mcp",
      "https://100.63.255.255/mcp",
      "https://223.255.255.255/mcp",
    ]) {
      expect(() => {
        assertMcpUrl(url, "url");
      }).not.toThrow();
    }
  });

  test("refuses credentials in the url", () => {
    expect(() => {
      assertMcpUrl("https://user:pw@mcp.example.com/mcp", "url");
    }).toThrow(/credentials/);
  });
});

describe("loopback", () => {
  test("a loopback url is recognised only as written", () => {
    expect(isLoopbackUrl("http://localhost:8288/mcp")).toBe(true);
    expect(isLoopbackUrl("https://127.0.0.1/mcp")).toBe(true);
    expect(isLoopbackUrl("http://[::1]/mcp")).toBe(true);
    expect(isLoopbackUrl("https://localhost./mcp")).toBe(false);
    expect(isLoopbackUrl("https://2130706433/mcp")).toBe(false);
    expect(isLoopbackUrl("https://mcp.example.com/mcp")).toBe(false);
    expect(isLoopbackUrl("not a url")).toBe(false);
  });

  test("the unspecified and loopback IPv6 addresses are private", () => {
    for (const url of ["https://[::]/mcp", "https://[::1]/mcp"]) {
      expect(() => {
        assertMcpUrl(url, "url", { loopback: false });
      }).toThrow(/private or internal/);
    }
  });

  test("loopback is refused unless the caller allows it", () => {
    expect(() => {
      assertMcpUrl("http://localhost:9000/token", "token endpoint", {
        loopback: false,
      });
    }).toThrow(/https|private or internal/);
    expect(() => {
      assertMcpUrl("https://127.0.0.1/token", "token endpoint", {
        loopback: false,
      });
    }).toThrow(/private or internal/);
    expect(() => {
      assertMcpUrl("http://localhost:9000/token", "token endpoint", {
        loopback: true,
      });
    }).not.toThrow();
  });
});

describe("tool.mcp network guard", () => {
  test("tool.mcp() refuses a private address", () => {
    expect(() => {
      return tool.mcp({ id: "hex", url: "https://10.0.0.5/mcp" });
    }).toThrow(/private or internal/);
  });

  test("every request is sent with redirect: error", async () => {
    const server = fakeMcpFetch({
      tools: { ping: { run: () => "pong" } },
    });
    const redirects: unknown[] = [];
    const hex = tool.mcp({
      id: "hex",
      url: server.url,
      fetch: (input, init) => {
        redirects.push(init?.redirect);

        return server.fetch(input, init);
      },
    });

    await hex["~list"]("hex");

    expect(redirects.length).toBeGreaterThan(0);
    expect(redirects.every((value) => value === "error")).toBe(true);
  });

  test("a redirect is an error, not followed", async () => {
    const hex = tool.mcp({
      id: "hex",
      url: "https://mcp.example.com/mcp",
      fetch: async (_input, init) => {
        if (init?.redirect === "error") {
          throw new TypeError("redirect mode is set to error");
        }

        return new Response(null, {
          status: 302,
          headers: { location: "https://169.254.169.254/" },
        });
      },
    });

    await expect(hex["~list"]("hex")).rejects.toThrow();
  });
});

describe("tool.mcp network guard on the OAuth endpoints", () => {
  // Discovery is remembered per server URL, so each case has its own.
  let serial = 0;
  const nextUrl = () => {
    serial += 1;

    return `https://mcp-${serial}.fake.test/mcp`;
  };
  const redirectUri = "https://app.example.test/oauth/hex";
  const bad = "https://10.0.0.5";

  const signIn = async (
    endpoints: NonNullable<
      NonNullable<Parameters<typeof fakeMcpFetch>[0]["oauth"]>["endpoints"]
    >,
    registration = true,
  ) => {
    const server = fakeMcpFetch({
      tools: { ping: { run: () => "pong" } },
      oauth: { endpoints, registration, client: { id: "preset" } },
    });
    const requested: string[] = [];
    const hex = tool.mcp({
      id: "hex",
      url: nextUrl(),
      fetch: (input, init) => {
        requested.push(String(input instanceof Request ? input.url : input));

        return server.fetch(input, init);
      },
      auth: {
        oauth: {
          user: "U1",
          redirectUri,
          store: memoryOAuthStore(),
          ...(!registration && { clientId: "preset" }),
          onNeedsAuthorization: () => {},
        },
      },
    });
    const built = hex["~build"]("hex", { tools: [], connect: true });
    const connect = built.hex_connect as unknown as {
      run: (input: unknown, ctx: unknown) => Promise<unknown>;
    };
    const result = await connect
      .run({}, { signal: new AbortController().signal, idempotencyKey: "k" })
      .then(
        () => undefined,
        (error: Error) => error,
      );

    return { result, requested };
  };

  test.each([
    ["the protected-resource metadata", { metadata: `${bad}/meta` }],
    ["the authorization server", { authorizationServer: bad }],
    ["the authorization endpoint", { authorize: `${bad}/authorize` }],
    ["the token endpoint", { token: `${bad}/token` }],
  ])("refuses %s at a private address", async (_name, endpoints) => {
    const { result, requested } = await signIn(endpoints);

    expect(String(result)).toMatch(/private or internal/);
    expect(requested.some((url) => url.startsWith(bad))).toBe(false);
  });

  test("refuses the registration endpoint at a private address", async () => {
    const { result, requested } = await signIn({
      register: `${bad}/register`,
    });

    expect(String(result)).toMatch(/private or internal/);
    expect(requested.some((url) => url.startsWith(bad))).toBe(false);
  });

  test("refuses an endpoint that is not https", async () => {
    const { result } = await signIn({
      token: "http://auth.example.com/token",
    });

    expect(String(result)).toMatch(/must be https/);
  });

  test("a remote server's endpoints may never point at loopback", async () => {
    for (const endpoints of [
      { token: "http://localhost:9000/token" },
      { authorize: "https://127.0.0.1/authorize" },
    ]) {
      const { result } = await signIn(endpoints);

      expect(String(result)).toMatch(/https|private or internal/);
    }
  });

  test("the message names the endpoint once", async () => {
    const { result } = await signIn({ token: `${bad}/token` });

    expect(String(result).match(/token endpoint/g)).toHaveLength(1);
  });

  test("every OAuth request is sent with redirect: error", async () => {
    const server = fakeMcpFetch({
      tools: { ping: { run: () => "pong" } },
      oauth: { client: { id: "preset" } },
    });
    const redirects: unknown[] = [];
    const hex = tool.mcp({
      id: "hex",
      url: nextUrl(),
      fetch: (input, init) => {
        redirects.push(init?.redirect);

        return server.fetch(input, init);
      },
      auth: {
        oauth: {
          user: "U1",
          redirectUri,
          store: memoryOAuthStore(),
          onNeedsAuthorization: () => {},
        },
      },
    });
    const connect = hex["~build"]("hex", { tools: [], connect: true })
      .hex_connect as unknown as {
      run: (input: unknown, ctx: unknown) => Promise<unknown>;
    };

    await connect.run(
      {},
      { signal: new AbortController().signal, idempotencyKey: "k" },
    );

    // The probe, the metadata, the registration.
    expect(redirects.length).toBeGreaterThanOrEqual(4);
    expect(redirects.every((value) => value === "error")).toBe(true);
  });
});
