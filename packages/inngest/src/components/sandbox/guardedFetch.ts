/**
 * @module
 * EXPERIMENTAL: `guardedFetch()`, a `fetch` for URLs that come from outside
 * the app, such as an MCP server or the OAuth endpoints it names. It allows
 * https only, no credentials in the URL and no redirects, and connects only
 * to a public address. The name is looked up once and that one answer is both
 * checked and connected to, so a name that changes its answer between the
 * check and the connection cannot reach a private address.
 *
 * It is built on `node:https` and `node:dns`, loaded when first called, so it
 * runs on Node, Bun and Deno and adds no dependency. A runtime without them
 * (an edge runtime) gets an error that says so.
 */
import type { LookupAddress } from "node:dns";
import type { IncomingMessage, RequestOptions } from "node:http";
import type { BlockList } from "node:net";

/**
 * How long a request may take when the caller passes no `signal` of its own.
 */
const timeoutMs = 15_000;

const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const nullBodyStatuses = new Set([101, 103, 204, 205, 304]);

/**
 * The error code of a name that resolves to an address that is not public.
 */
export const refusedAddressCode = "ERR_GUARDED_FETCH_ADDRESS";

// Private, loopback, link-local, carrier-grade NAT, documentation, benchmark,
// multicast and reserved ranges.
const refusedIpv4: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

// Unspecified and IPv4-compatible, IPv4-translated, NAT64, discard, Teredo
// and other special ranges, documentation, 6to4, unique local, link-local,
// site-local and multicast. An IPv4-mapped address (`::ffff:a.b.c.d`) is
// checked against the IPv4 ranges by `BlockList` itself.
const refusedIpv6: [string, number][] = [
  ["::", 96],
  ["::ffff:0:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
];

interface NodeParts {
  request: typeof import("node:https").request;
  lookup: typeof import("node:dns").lookup;
  isIP: typeof import("node:net").isIP;
  stream: Pick<typeof import("node:stream"), "Readable" | "pipeline">;
  zlib: Pick<
    typeof import("node:zlib"),
    "createGunzip" | "createInflate" | "createBrotliDecompress"
  >;
  refused: BlockList;
}

let loaded: Promise<NodeParts> | undefined;

const load = async (): Promise<NodeParts> => {
  try {
    const [https, dns, net, stream, zlib] = await Promise.all([
      import("node:https"),
      import("node:dns"),
      import("node:net"),
      import("node:stream"),
      import("node:zlib"),
    ]);
    const refused = new net.BlockList();

    for (const [network, bits] of refusedIpv4) {
      refused.addSubnet(network, bits, "ipv4");
    }

    for (const [network, bits] of refusedIpv6) {
      refused.addSubnet(network, bits, "ipv6");
    }

    return {
      request: https.request,
      lookup: dns.lookup,
      isIP: net.isIP,
      stream: { Readable: stream.Readable, pipeline: stream.pipeline },
      zlib: {
        createGunzip: zlib.createGunzip,
        createInflate: zlib.createInflate,
        createBrotliDecompress: zlib.createBrotliDecompress,
      },
      refused,
    };
  } catch (error) {
    loaded = undefined;

    throw new Error(
      "guardedFetch needs node:https and node:dns, which this runtime does not have",
      { cause: error },
    );
  }
};

const nodeParts = (): Promise<NodeParts> => {
  loaded ??= load();

  return loaded;
};

const isPublicWith = (parts: NodeParts, address: string): boolean => {
  const family = parts.isIP(address);

  if (family === 0) {
    return false;
  }

  return !parts.refused.check(address, family === 4 ? "ipv4" : "ipv6");
};

/**
 * Seams for tests: how a request is made, how a name is looked up and which
 * addresses may be connected to.
 */
export const _internals = {
  request: async (): Promise<typeof import("node:https").request> => {
    return (await nodeParts()).request;
  },
  lookup: async (): Promise<typeof import("node:dns").lookup> => {
    return (await nodeParts()).lookup;
  },
  isAllowed: async (address: string): Promise<boolean> => {
    return isPublicWith(await nodeParts(), address);
  },
};

const fail = (message: string, code: string): TypeError => {
  return new TypeError(`fetch failed: ${message}`, {
    cause: Object.assign(new Error(message), { code }),
  });
};

/**
 * The URL checks made before anything touches the network: https only, no
 * credentials, and an address written in the URL must be public.
 */
const checkedUrl = async (input: string | URL): Promise<URL> => {
  const url = new URL(input);

  if (url.protocol !== "https:") {
    throw new TypeError(
      `guardedFetch refused a ${url.protocol} URL: https only`,
    );
  }

  if (url.username || url.password) {
    throw new TypeError("guardedFetch refused a URL with credentials");
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");
  const parts = await nodeParts();

  if (parts.isIP(host) !== 0 && !(await _internals.isAllowed(host))) {
    throw new TypeError(`guardedFetch refused a non-public address: ${host}`);
  }

  return url;
};

/**
 * A lookup for `https.request` that answers once, with an address it checked.
 * Every address the name has must be allowed, and the first is used.
 */
const checkedLookup = (
  lookup: typeof import("node:dns").lookup,
): NonNullable<RequestOptions["lookup"]> => {
  return (hostname, options, callback) => {
    lookup(hostname, { all: true }, (error, found: LookupAddress[]) => {
      const first = found?.[0];

      if (error || !first) {
        callback(
          error ??
            Object.assign(new Error(`no address for ${hostname}`), {
              code: "ENOTFOUND",
            }),
          "",
          4,
        );

        return;
      }

      void Promise.all(
        found.map(({ address }) => {
          return _internals.isAllowed(address);
        }),
      ).then(
        (allowed) => {
          if (!allowed.every(Boolean)) {
            callback(
              Object.assign(
                new Error(`${hostname} resolves to a non-public address`),
                { code: refusedAddressCode },
              ),
              "",
              4,
            );

            return;
          }

          if (options.all) {
            (callback as (e: null, a: LookupAddress[]) => void)(null, [first]);

            return;
          }

          callback(null, first.address, first.family);
        },
        (failed: Error) => {
          callback(failed, "", 4);
        },
      );
    });
  };
};

/**
 * The response body as a web stream, decoded the way `fetch` decodes it.
 */
const bodyOf = (
  parts: NodeParts,
  message: IncomingMessage,
): ReadableStream<Uint8Array> => {
  const encoding = String(message.headers["content-encoding"] ?? "")
    .trim()
    .toLowerCase();
  const decoder =
    encoding === "gzip" || encoding === "x-gzip"
      ? parts.zlib.createGunzip()
      : encoding === "deflate"
        ? parts.zlib.createInflate()
        : encoding === "br"
          ? parts.zlib.createBrotliDecompress()
          : undefined;
  const source = decoder
    ? parts.stream.pipeline(message, decoder, () => undefined)
    : message;

  return parts.stream.Readable.toWeb(source) as ReadableStream<Uint8Array>;
};

/**
 * EXPERIMENTAL: A `fetch` for a URL from outside the app. It refuses anything
 * but `https:`, a URL with a user or password, an address in the URL that is
 * not public and a redirect, and it connects only to an address its single
 * lookup of the name checked is public, so DNS cannot point it at a private
 * or internal address. A request takes at most 15 seconds unless `init`
 * carries a `signal`, which then sets the deadline.
 *
 * It takes a URL and `init` as `fetch` does, but not a `Request`. A refusal
 * before the network is a `TypeError`; one at connect is a `TypeError` whose
 * `cause.code` is `ERR_GUARDED_FETCH_ADDRESS`, as a failed `fetch` names its
 * cause.
 *
 * `tool.mcp()` uses it for every server and OAuth endpoint that is not plain
 * loopback (`localhost`, for tests and the Dev Server).
 *
 * @example
 * ```ts
 * import { guardedFetch } from "inngest/experimental";
 *
 * const page = await guardedFetch(urlFromAUser);
 * ```
 */
export const guardedFetch = async (
  input: string | URL | Request,
  init: RequestInit = {},
): Promise<Response> => {
  if (input instanceof Request) {
    throw new TypeError("guardedFetch takes a URL, not a Request");
  }

  const parts = await nodeParts();
  const url = await checkedUrl(input);
  const signal = init.signal ?? AbortSignal.timeout(timeoutMs);

  signal.throwIfAborted();

  // A Request reads the body and headers the way `fetch` would, from any of
  // the body types `fetch` takes.
  const prepared = new Request(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    ...(init.body instanceof ReadableStream && { duplex: "half" }),
  } as RequestInit);
  const body =
    prepared.body === null
      ? undefined
      : new Uint8Array(await prepared.arrayBuffer());
  const headers: Record<string, string> = {};

  prepared.headers.forEach((value, name) => {
    headers[name] = value;
  });

  // `fetch` sends both unless told otherwise, and some servers refuse a
  // request without a user agent.
  headers["accept-encoding"] ??= "gzip, deflate, br";
  headers["user-agent"] ??= "inngest-js";

  if (body) {
    headers["content-length"] = String(body.byteLength);
  }

  const request = await _internals.request();
  const lookup = checkedLookup(await _internals.lookup());

  return new Promise<Response>((resolve, reject) => {
    const req = request(
      {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: prepared.method,
        headers,
        lookup,
      },
      (message) => {
        const status = message.statusCode ?? 0;

        if (redirectStatuses.has(status)) {
          message.resume();
          req.destroy();
          reject(fail("redirect refused", "ERR_GUARDED_FETCH_REDIRECT"));

          return;
        }

        const responseHeaders = new Headers();

        for (let i = 0; i + 1 < message.rawHeaders.length; i += 2) {
          responseHeaders.append(
            message.rawHeaders[i] ?? "",
            message.rawHeaders[i + 1] ?? "",
          );
        }

        const empty =
          nullBodyStatuses.has(status) || prepared.method === "HEAD";

        if (empty) {
          message.resume();
        }

        message.once("close", () => {
          signal.removeEventListener("abort", onAbort);
        });

        resolve(
          new Response(empty ? null : bodyOf(parts, message), {
            status,
            statusText: message.statusMessage,
            headers: responseHeaders,
          }),
        );
      },
    );

    const onAbort = () => {
      req.destroy(signal.reason);
      reject(signal.reason);
    };

    signal.addEventListener("abort", onAbort, { once: true });

    req.on("error", (error: Error & { code?: string }) => {
      signal.removeEventListener("abort", onAbort);

      if (signal.aborted) {
        reject(signal.reason);

        return;
      }

      reject(new TypeError(`fetch failed: ${error.message}`, { cause: error }));
    });

    req.end(body);
  });
};
