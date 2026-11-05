/**
 * @module
 * Tests for `guardedFetch()`: the URL checks, the address check at connect
 * that shares one lookup with the connection, and refused redirects. The
 * requests that must connect go over plain http to a local server, with the
 * transport and the allowed addresses swapped through `_internals`.
 */
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type RequestOptions,
  type Server,
} from "node:http";
import type { request as httpsRequest } from "node:https";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as experimental from "../../experimental.ts";
import { _internals, guardedFetch } from "./guardedFetch.ts";

const original = { ..._internals };

let server: Server;
let port: number;
let hits: string[];

beforeEach(async () => {
  hits = [];
  server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);

    if (req.url === "/redirect") {
      res.writeHead(302, { location: "http://127.0.0.1/private" });
      res.end();

      return;
    }

    if (req.url === "/gzip") {
      res.writeHead(200, { "content-encoding": "gzip" });
      res.end(gzipSync("zipped"));

      return;
    }

    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      res.writeHead(201, { "content-type": "text/plain", "x-one": "1" });
      res.end(`${req.method} ${body} ${req.headers["content-type"] ?? ""}`);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();

  port = typeof address === "object" && address ? address.port : 0;
});

afterEach(async () => {
  Object.assign(_internals, original);
  await new Promise((resolve) => {
    server.close(resolve);
  });
});

// Every name answers `answers` in turn (the last one repeats), and each lookup
// is counted.
const fakeDns = (...answers: string[]) => {
  const calls: string[] = [];

  _internals.lookup = async () => {
    return ((
      hostname: string,
      _options: unknown,
      callback: (error: Error | null, found: LookupAddress[]) => void,
    ) => {
      const address = answers[Math.min(calls.length, answers.length - 1)];

      calls.push(hostname);
      callback(null, [{ address: address ?? "", family: 4 }]);
    }) as unknown as typeof dnsLookup;
  };

  return calls;
};

// `http.request` for options written for `https.request`.
const plainHttp = ((
  options: RequestOptions,
  callback?: (message: IncomingMessage) => void,
) => {
  return httpRequest({ ...options, protocol: "http:" }, callback);
}) as typeof httpsRequest;

// Plain http to the local server, which is allowed as if it were public.
const overHttp = () => {
  _internals.request = async () => {
    return plainHttp;
  };
  _internals.isAllowed = async (address) => {
    return address === "127.0.0.1";
  };
};

describe("guardedFetch refuses before the network", () => {
  test.each([
    ["http://example.com/", /https only/],
    ["ftp://example.com/", /https only/],
    ["https://user:pass@example.com/", /credentials/],
    ["https://10.0.0.1/", /non-public address/],
    ["https://127.0.0.1/", /non-public address/],
    ["https://169.254.169.254/latest", /non-public address/],
    ["https://[::1]/", /non-public address/],
    ["https://[::ffff:127.0.0.1]/", /non-public address/],
    ["https://[fd00::1]/", /non-public address/],
  ])("%s", async (url, message) => {
    const calls = fakeDns("93.184.216.34");

    await expect(guardedFetch(url)).rejects.toThrow(message);
    expect(calls).toEqual([]);
  });

  test("a Request is refused, a URL is wanted", async () => {
    await expect(
      guardedFetch(new Request("https://example.com/")),
    ).rejects.toThrow(/not a Request/);
  });

  test("a public address in the URL passes the checks and is connected to without a lookup", async () => {
    const calls = fakeDns("10.0.0.1");
    let connectedTo: string | undefined;

    _internals.request = async () => {
      return ((options: RequestOptions) => {
        connectedTo = options.hostname ?? undefined;

        throw new Error("stop here");
      }) as never;
    };

    await expect(guardedFetch("https://93.184.216.34/x")).rejects.toThrow(
      /stop here/,
    );
    expect(connectedTo).toBe("93.184.216.34");
    expect(calls).toEqual([]);
  });
});

describe("guardedFetch refuses at connect", () => {
  test("localhost, which resolves to loopback, is never connected to", async () => {
    _internals.request = async () => {
      return plainHttp;
    };

    const error = await guardedFetch(`https://localhost:${port}/`).catch(
      (caught: unknown) => {
        return caught;
      },
    );

    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toMatch(/non-public address/);
    expect((error as { cause?: { code?: string } }).cause?.code).toBe(
      "ERR_GUARDED_FETCH_ADDRESS",
    );
    expect(hits).toEqual([]);
  });

  test.each([
    ["127.0.0.1"],
    ["10.1.2.3"],
    ["172.20.0.1"],
    ["192.168.1.1"],
    ["100.64.0.1"],
  ])("a public name that resolves to %s", async (address) => {
    fakeDns(address);
    _internals.request = async () => {
      return plainHttp;
    };

    await expect(
      guardedFetch(`https://intranet.example.com:${port}/`),
    ).rejects.toMatchObject({ cause: { code: "ERR_GUARDED_FETCH_ADDRESS" } });
    expect(hits).toEqual([]);
  });

  test("a name with one private answer among public ones", async () => {
    _internals.lookup = async () => {
      return ((
        _hostname: string,
        _options: unknown,
        callback: (error: Error | null, found: LookupAddress[]) => void,
      ) => {
        callback(null, [
          { address: "93.184.216.34", family: 4 },
          { address: "10.0.0.1", family: 4 },
        ]);
      }) as unknown as typeof dnsLookup;
    };

    await expect(
      guardedFetch("https://mixed.example.com/"),
    ).rejects.toMatchObject({ cause: { code: "ERR_GUARDED_FETCH_ADDRESS" } });
  });

  test("the address checked is the one connected to: the name is looked up once", async () => {
    overHttp();

    // A second lookup would answer a private address.
    const calls = fakeDns("127.0.0.1", "10.0.0.1");
    const response = await guardedFetch(`https://app.example.com:${port}/x`, {
      method: "POST",
      body: new URLSearchParams({ a: "1" }),
    });

    expect(calls).toEqual(["app.example.com"]);
    expect(response.status).toBe(201);
    expect(response.headers.get("x-one")).toBe("1");
    expect(await response.text()).toBe(
      "POST a=1 application/x-www-form-urlencoded;charset=UTF-8",
    );
  });
});

describe("guardedFetch responses", () => {
  test("a redirect is refused and not followed", async () => {
    overHttp();
    fakeDns("127.0.0.1");

    await expect(
      guardedFetch(`https://app.example.com:${port}/redirect`),
    ).rejects.toMatchObject({
      cause: { code: "ERR_GUARDED_FETCH_REDIRECT" },
    });
    expect(hits).toEqual(["GET /redirect"]);
  });

  test("a gzip body is decoded as fetch decodes it", async () => {
    overHttp();
    fakeDns("127.0.0.1");

    const response = await guardedFetch(`https://app.example.com:${port}/gzip`);

    expect(await response.text()).toBe("zipped");
  });

  test("an aborted signal ends the request with its reason", async () => {
    overHttp();
    fakeDns("127.0.0.1");

    const controller = new AbortController();

    controller.abort(new Error("gave up"));

    await expect(
      guardedFetch(`https://app.example.com:${port}/`, {
        signal: controller.signal,
      }),
    ).rejects.toThrow(/gave up/);
  });

  test("real DNS is used when nothing is swapped", async () => {
    expect(original.lookup).toBe(_internals.lookup);
    expect(await _internals.lookup()).toBe(dnsLookup);
  });
});

test("inngest/experimental exports it", () => {
  expect(experimental.guardedFetch).toBe(guardedFetch);
});

test("tool.mcp() sends a server that is not loopback through guardedFetch", async () => {
  const { McpClient } = await import("./mcpClient.ts");
  const calls = fakeDns("10.0.0.9");
  const spy = vi.spyOn(globalThis, "fetch");
  const client = new McpClient({
    url: "https://mcp.example.com/mcp",
    clientVersion: "test",
    auth: async () => {
      return { headers: {}, secrets: [] };
    },
  });

  await expect(client.listTools({ timeoutMs: 2_000 })).rejects.toThrow(
    /non-public address/,
  );
  expect(calls).toEqual(["mcp.example.com"]);
  expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
});
