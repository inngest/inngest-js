import { vi } from "vitest";

// Mock the broken transitive dependency before any other imports.
// InngestCommHandler -> ../experimental -> otel/middleware -> otel/util
// -> @traceloop/instrumentation-anthropic (not installed)
vi.mock("@traceloop/instrumentation-anthropic", () => ({
  AnthropicInstrumentation: class {},
}));

import fetch from "cross-fetch";
import { z } from "zod/v3";
import { EventSchemas } from "../components/EventSchemas.ts";
import { InngestCommHandler } from "../components/InngestCommHandler.ts";
import type { InngestFunction } from "../components/InngestFunction.ts";
import { envKeys } from "../helpers/consts.ts";
import { hashSigningKey } from "../helpers/strings.ts";
import { serve } from "../next.ts";
import { createClient } from "../test/helpers.ts";

/**
 * EXE-1249: When signingKey is provided via serve() options but NOT via
 * process.env.INNGEST_SIGNING_KEY, the InngestApi instance never receives
 * the key. This causes outgoing API calls (getRunBatch, getRunSteps) to send
 * an empty "Authorization: Bearer " header, resulting in 401 errors.
 *
 * Affected users see "failed to retrieve list of events" /
 * "Unauthorized function execution can't continue" on long-running functions
 * once the executor switches to use_api=true.
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
    opts: { signingKey?: string } = {}
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
      () => "ok"
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
