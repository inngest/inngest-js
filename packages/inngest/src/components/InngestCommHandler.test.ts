import fetch from "cross-fetch";
import { z } from "zod/v3";
import { EventSchemas } from "../components/EventSchemas.ts";
import { InngestCommHandler } from "../components/InngestCommHandler.ts";
import type { InngestFunction } from "../components/InngestFunction.ts";
import { envKeys, headerKeys } from "../helpers/consts.ts";
import { signDataWithKey } from "../helpers/net.ts";
import { hashSigningKey } from "../helpers/strings.ts";
import { serve } from "../next.ts";
import { createClient } from "../test/helpers.ts";
import { RequestSignature } from "./InngestCommHandler.ts";

/**
 * When signingKey is provided via serve() options but NOT via
 * process.env.INNGEST_SIGNING_KEY, the InngestApi instance never receives
 * the key. This causes outgoing API calls (getRunBatch, getRunSteps) to send
 * an empty "Authorization: Bearer " header, resulting in 401 errors.
 */
describe("signing key propagation from serve() to InngestApi", () => {
  const signingKey =
    "signkey-test-f00f3005a3666b359a79c2bc3380ce2715e62727ac461ae1a2618f8766029c9f";

  let prevEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    prevEnv = process.env;
    // Ensure INNGEST_SIGNING_KEY is NOT in process.env
    process.env = { ...prevEnv };
    delete process.env[envKeys.InngestSigningKey];
    delete process.env[envKeys.InngestSigningKeyFallback];
  });

  afterEach(() => {
    process.env = prevEnv;
  });

  /**
   * Helper: create a comm handler backed by a simple Request-based adapter.
   * This avoids framework-specific type issues (e.g. NextRequest).
   */
  const createTestHandler = (
    client: ReturnType<typeof createClient>,
    functions: InngestFunction.Any[],
    opts: { signingKey?: string } = {},
  ) => {
    const commHandler = new InngestCommHandler({
      client,
      frameworkName: "test",
      functions,
      fetch,
      signingKey: opts.signingKey,
      handler: (req: Request) => {
        return {
          body: () => req.text(),
          headers: (key: string) => req.headers.get(key),
          method: () => req.method,
          url: () => new URL(req.url),
          transformResponse: ({
            body,
            headers,
            status,
          }: {
            body: string;
            headers: Record<string, string>;
            status: number;
          }) => {
            return new Response(body, { status, headers });
          },
        };
      },
    });

    return commHandler["createHandler"]();
  };

  test("serve() signingKey propagates to InngestApi when env var is absent", async () => {
    const client = createClient({ id: "test" });

    // Helper to access private inngestApi.signingKey
    const getApiSigningKey = (): string =>
      (client as unknown as { inngestApi: { signingKey: string } })[
        "inngestApi"
      ]["signingKey"];

    // InngestApi starts with empty signing key
    expect(getApiSigningKey()).toBe("");
    // An empty key hashes to "" → would produce "Authorization: Bearer "
    expect(hashSigningKey("")).toBe("");

    const fn = client.createFunction(
      { id: "test-fn", name: "Test" },
      { event: "test/event" },
      () => "ok",
    );

    // Create a handler with signingKey in serve() options
    const handler = createTestHandler(client, [fn], { signingKey });

    // Trigger a GET request which calls initRequest() -> upsertKeysFromEnv()
    const req = new Request("https://localhost:3000/api/inngest", {
      method: "GET",
      headers: { host: "localhost:3000" },
    });
    await handler(req);

    // serve() signing key should be propagated to InngestApi for outgoing
    // API calls (getRunBatch, getRunSteps, etc.)
    expect(getApiSigningKey()).toBe(signingKey);

    // The hashed key used in Authorization headers should be non-empty
    const hashedKey = hashSigningKey(signingKey);
    expect(hashedKey).not.toBe("");
    expect(hashedKey).toMatch(/^signkey-test-/);
  });
});

describe("#153", () => {
  test('does not throw "type instantiation is excessively deep and possibly infinite" for looping type', () => {
    const literalSchema = z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.null(),
    ]);
    type Literal = z.infer<typeof literalSchema>;
    type Json = Literal | { [key: string]: Json } | Json[];

    const inngest = createClient({
      id: "My App",
      schemas: new EventSchemas().fromRecord<{
        foo: {
          name: "foo";
          data: {
            json: Json;
          };
        };
      }>(),
    });

    /**
     * This would throw:
     * "Type instantiation is excessively deep and possibly infinite.ts(2589)"
     */
    serve({ client: inngest, functions: [] });
  });
});

describe("ServeHandler", () => {
  describe("functions argument", () => {
    test("types: allows mutable functions array", () => {
      const inngest = createClient({ id: "test" });

      const functions = [
        inngest.createFunction(
          { id: "test" },
          { event: "demo/event.sent" },
          () => "test",
        ),
      ];

      serve({ client: inngest, functions });
    });

    test("types: allows readonly functions array", () => {
      const inngest = createClient({ id: "test" });

      const functions = [
        inngest.createFunction(
          { id: "test" },
          { event: "demo/event.sent" },
          () => "test",
        ),
      ] as const;

      serve({ client: inngest, functions });
    });
  });
});

describe("#597", () => {
  test("does not mark `fetch` as custom if none given to `new Inngest()`", () => {
    const inngest = createClient({ id: "test" });

    const commHandler = new InngestCommHandler({
      client: inngest,
      frameworkName: "test-framework",
      functions: [],
      handler: () => ({
        body: () => "body",
        headers: () => undefined,
        method: () => "GET",
        url: () => new URL("https://www.inngest.com"),
        transformResponse: (response) => response,
      }),
    });

    expect(commHandler["fetch"]).toBe(inngest["fetch"]);
  });
});

describe("introspection", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("authenticated", async () => {
    const fakeEnv = "v10";
    vi.stubEnv(envKeys.InngestEnvironment, fakeEnv);

    const signingKey =
      "signkey-test-0000000000000000000000000000000000000000000000000000000000000000";
    const signingKeyFallback =
      "signkey-test-1111111111111111111111111111111111111111111111111111111111111111";

    const client = createClient({ id: "test", isDev: false });
    const commHandler = new InngestCommHandler({
      client,
      frameworkName: "test",
      functions: [],
      fetch,
      signingKey,
      signingKeyFallback,
      handler: (req: Request) => {
        return {
          body: () => req.text(),
          headers: (key: string) => req.headers.get(key),
          method: () => req.method,
          url: () => new URL(req.url),
          transformResponse: ({
            body,
            headers,
            status,
          }: {
            body: string;
            headers: Record<string, string>;
            status: number;
          }) => {
            return new Response(body, { status, headers });
          },
        };
      },
    });
    const handler = commHandler["createHandler"]();

    const timestamp = Math.round(Date.now() / 1000).toString();
    const signature = await signDataWithKey("", signingKey, timestamp);
    const req = new Request("https://localhost:3000/api/inngest", {
      method: "GET",
      headers: {
        host: "localhost:3000",

        // Request signature is used to authenticate the request
        [headerKeys.Signature]: `t=${timestamp}&s=${signature}`,
      },
    });
    const res = await handler(req);
    expect(res.status).toBe(200);

    // Authenticated response body (since signature is valid)
    expect(await res.json()).toEqual({
      api_origin: "https://api.inngest.com/",
      app_id: "test",
      authentication_succeeded: true,
      capabilities: { trust_probe: "v1", connect: "v1" },
      env: fakeEnv,
      event_api_origin: "https://inn.gs/",
      event_key_hash: null,
      extra: {
        is_mode_explicit: true,
        native_crypto: true,
        is_streaming: false,
      },
      framework: "test",
      function_count: 0,
      has_event_key: false,
      has_signing_key: true,
      mode: "cloud",
      schema_version: "2024-05-24",
      sdk_language: "js",
      sdk_version: expect.any(String),
      serve_origin: null,
      serve_path: null,

      // IMPORTANT: Only the first 12 characters of the hash are included
      signing_key_fallback_hash: "02d449a31fbb",
      signing_key_hash: "66687aadf862",
    });
  });

  test("unauthenticated", async () => {
    const client = createClient({ id: "test", isDev: false });
    const commHandler = new InngestCommHandler({
      client,
      frameworkName: "test",
      functions: [],
      fetch,
      handler: (req: Request) => {
        return {
          body: () => req.text(),
          headers: (key: string) => req.headers.get(key),
          method: () => req.method,
          url: () => new URL(req.url),
          transformResponse: ({
            body,
            headers,
            status,
          }: {
            body: string;
            headers: Record<string, string>;
            status: number;
          }) => {
            return new Response(body, { status, headers });
          },
        };
      },
    });
    const handler = commHandler["createHandler"]();

    const req = new Request("https://localhost:3000/api/inngest", {
      method: "GET",
      headers: {
        host: "localhost:3000",
      },
    });
    const res = await handler(req);
    expect(res.status).toBe(200);

    // Unauthenticated response body (since signature is not provided)
    expect(await res.json()).toEqual({
      extra: { is_mode_explicit: true },
      function_count: 0,
      has_event_key: false,
      has_signing_key: false,
      mode: "cloud",
      schema_version: "2024-05-24",
    });
  });

  test("wrong signature", async () => {
    const signingKey =
      "signkey-test-0000000000000000000000000000000000000000000000000000000000000000";
    const signingKeyFallback =
      "signkey-test-1111111111111111111111111111111111111111111111111111111111111111";
    const wrongSigningKey =
      "signkey-test-wrong-2222222222222222222222222222222222222222222222222222222222222222";

    const client = createClient({ id: "test", isDev: false });
    const commHandler = new InngestCommHandler({
      client,
      frameworkName: "test",
      functions: [],
      fetch,
      signingKey,
      signingKeyFallback,
      handler: (req: Request) => {
        return {
          body: () => req.text(),
          headers: (key: string) => req.headers.get(key),
          method: () => req.method,
          url: () => new URL(req.url),
          transformResponse: ({
            body,
            headers,
            status,
          }: {
            body: string;
            headers: Record<string, string>;
            status: number;
          }) => {
            return new Response(body, { status, headers });
          },
        };
      },
    });
    const handler = commHandler["createHandler"]();

    const timestamp = Math.round(Date.now() / 1000).toString();
    const signature = await signDataWithKey("", wrongSigningKey, timestamp);
    const req = new Request("https://localhost:3000/api/inngest", {
      method: "GET",
      headers: {
        host: "localhost:3000",

        // Request signature is used to authenticate the request
        [headerKeys.Signature]: `t=${timestamp}&s=${signature}`,
      },
    });
    const res = await handler(req);
    expect(res.status).toBe(200);

    // Unauthenticated response body (since signature is wrong)
    expect(await res.json()).toEqual({
      extra: { is_mode_explicit: true },
      function_count: 0,
      has_event_key: false,
      has_signing_key: true,
      mode: "cloud",
      schema_version: "2024-05-24",
    });
  });
});

describe("RequestSignature", () => {
  const signingKey = "signkey-test-deadbeefcafef00d";
  const body = { event: { name: "demo/event.sent", data: {} } };

  const fixedNowMs = new Date("2026-04-22T12:00:00Z").getTime();
  const fixedNowSeconds = Math.round(fixedNowMs / 1000);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedNowMs);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const verify = async (
    ts: string,
    { allowExpired = false }: { allowExpired?: boolean } = {},
  ) => {
    const mac = await signDataWithKey(body, signingKey, ts);
    return new RequestSignature(`t=${ts}&s=${mac}`).verifySignature({
      body,
      signingKey,
      signingKeyFallback: undefined,
      allowExpiredSignatures: allowExpired,
    });
  };

  describe("constructor", () => {
    test("throws when `t` is missing", () => {
      expect(() => new RequestSignature("s=abc")).toThrow(/Invalid/);
    });

    test("throws when `s` is missing", () => {
      expect(() => new RequestSignature("t=123")).toThrow(/Invalid/);
    });
  });

  describe("verifySignature expiry", () => {
    test("accepts a timestamp 60s in the future (tolerates clock skew)", async () => {
      await expect(verify((fixedNowSeconds + 60).toString())).resolves.toBe(
        signingKey,
      );
    });

    test("accepts a timestamp exactly 5 minutes old (boundary)", async () => {
      await expect(verify((fixedNowSeconds - 300).toString())).resolves.toBe(
        signingKey,
      );
    });

    test("rejects a timestamp older than 5 minutes", async () => {
      await expect(verify((fixedNowSeconds - 301).toString())).rejects.toThrow(
        "Signature has expired",
      );
    });

    test("rejects a timestamp more than 5 minutes in the future", async () => {
      await expect(verify((fixedNowSeconds + 301).toString())).rejects.toThrow(
        "Signature has expired",
      );
    });

    test("rejects an unparseable `t`", async () => {
      await expect(verify("not-a-number")).rejects.toThrow(
        "Signature has expired",
      );
    });

    test("rejects a hex-prefixed `t` (parseInt radix guard)", async () => {
      const hexTs = `0x${fixedNowSeconds.toString(16)}`;
      await expect(verify(hexTs)).rejects.toThrow("Signature has expired");
    });

    test.each([
      ["past", -3600],
      ["future", 3600],
    ])(
      "accepts a %s expired timestamp when allowExpiredSignatures is true",
      async (_label, offsetSeconds) => {
        await expect(
          verify((fixedNowSeconds + offsetSeconds).toString(), {
            allowExpired: true,
          }),
        ).resolves.toBe(signingKey);
      },
    );
  });

  describe("verifySignature signature check", () => {
    test("rejects a tampered signature", async () => {
      const ts = fixedNowSeconds.toString();
      const mac = await signDataWithKey(body, signingKey, ts);
      const tampered = (mac[0] === "0" ? "1" : "0") + mac.slice(1);

      await expect(
        new RequestSignature(`t=${ts}&s=${tampered}`).verifySignature({
          body,
          signingKey,
          signingKeyFallback: undefined,
          allowExpiredSignatures: false,
        }),
      ).rejects.toThrow("Invalid signature");
    });
  });
});
