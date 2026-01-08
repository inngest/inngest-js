import type { Mock } from "vitest";
import { literal } from "zod/v3";
import { dummyEventKey, envKeys, headerKeys } from "../helpers/consts.ts";
import type { IsAny, IsEqual } from "../helpers/types.ts";
import {
  type EventPayload,
  type GetFunctionInput,
  type GetFunctionOutput,
  type GetStepTools,
  Inngest,
  InngestMiddleware,
  referenceFunction,
} from "../index.ts";
import type { Logger } from "../middleware/logger.ts";
import { createClient, nodeVersion, testSigningKey } from "../test/helpers.ts";
import type { SendEventResponse } from "../types.ts";
import type { createStepTools } from "./InngestStepTools.ts";

const testEvent: EventPayload = {
  name: "test",
  data: {},
  ts: 1688139903724,
};

const testEventKey = "foo-bar-baz-test";

describe("new Inngest()", () => {
  describe("mode", () => {
    const createTestClient = ({
      env,
      opts,
    }: {
      env?: Record<string, string>;
      opts?: Omit<ConstructorParameters<typeof Inngest>[0], "id">;
    } = {}): Inngest.Any => {
      let ogKeys: Record<string, string | undefined> = {};

      if (env) {
        ogKeys = Object.keys(env).reduce<Record<string, string | undefined>>(
          (acc, key) => {
            acc[key] = process.env[key];
            process.env[key] = env[key];
            return acc;
          },
          {},
        );
      }

      const inngest = new Inngest({ id: "test", ...opts });

      if (env) {
        // biome-ignore lint/complexity/noForEach: <explanation>
        Object.keys(ogKeys).forEach((key) => {
          process.env[key] = ogKeys[key];
        });
      }

      return inngest;
    };

    test("should default to cloud mode", () => {
      const inngest = createTestClient();
      expect(inngest.mode === "cloud").toBe(true);
    });

    test("`isDev: true` sets dev mode", () => {
      const inngest = createTestClient({ opts: { isDev: true } });
      expect(inngest.mode === "dev").toBe(true);
    });

    test("`isDev: false` sets cloud mode", () => {
      const inngest = createTestClient({ opts: { isDev: false } });
      expect(inngest.mode === "cloud").toBe(true);
    });

    test("`INNGEST_DEV=1` sets dev mode", () => {
      const inngest = createTestClient({
        env: { [envKeys.InngestDevMode]: "1" },
      });
      expect(inngest.mode === "dev").toBe(true);
    });

    test("`INNGEST_DEV=true` sets dev mode", () => {
      const inngest = createTestClient({
        env: { [envKeys.InngestDevMode]: "true" },
      });
      expect(inngest.mode === "dev").toBe(true);
    });

    test("`INNGEST_DEV=false` sets cloud mode", () => {
      const inngest = createTestClient({
        env: { [envKeys.InngestDevMode]: "false" },
      });
      expect(inngest.mode === "cloud").toBe(true);
    });

    test("`INNGEST_DEV=0` sets cloud mode", () => {
      const inngest = createTestClient({
        env: { [envKeys.InngestDevMode]: "0" },
      });
      expect(inngest.mode === "cloud").toBe(true);
    });

    test("`isDev` overwrites `INNGEST_DEV`", () => {
      const inngest = createTestClient({
        env: { [envKeys.InngestDevMode]: "1" },
        opts: { isDev: false },
      });
      expect(inngest.mode === "cloud").toBe(true);
    });

    test("`INNGEST_DEV=URL` sets dev mode with custom URL", () => {
      const inngest = createTestClient({
        env: { [envKeys.InngestDevMode]: "http://localhost:3000" },
      });
      expect(inngest.mode === "dev").toBe(true);
      expect(inngest.getExplicitDevUrl?.href).toBe("http://localhost:3000/");
    });
  });
});

describe("send", () => {
  describe("runtime", () => {
    const originalProcessEnv = process.env;
    const originalFetch = global.fetch;

    const setFetch = ({
      status = 200,
      ids,
      error,
    }: Partial<SendEventResponse> = {}) => {
      return vi.fn((_url: string, opts: { body: string }) => {
        const json = error
          ? {
              error,
            }
          : {
              status,
              ids:
                ids ??
                (JSON.parse(opts.body) as EventPayload[]).map(() => "test-id"),
            };

        return Promise.resolve({
          status,
          json: () => {
            return Promise.resolve(json);
          },
          text: () => {
            return Promise.resolve(JSON.stringify(json));
          },
        });
      }) as unknown as typeof fetch;
    };

    beforeAll(() => {
      Object.defineProperties(global, {
        fetch: {
          value: setFetch(),
          configurable: true,
        },
      });
    });

    beforeEach(() => {
      (global.fetch as Mock).mockClear();
      process.env = { ...originalProcessEnv };
    });

    afterAll(() => {
      Object.defineProperties(global, {
        fetch: {
          value: originalFetch,
          configurable: true,
        },
      });

      process.env = originalProcessEnv;
    });

    test("should fail to send if event key not specified at instantiation", async () => {
      // Will only throw this error in prod
      process.env.CONTEXT = "production";

      const inngest = createClient({ id: "test" });

      await expect(() => inngest.send(testEvent)).rejects.toThrowError(
        "Failed to send event",
      );
    });

    test("should succeed if event key specified at instantiation", async () => {
      const inngest = createClient({ id: "test", eventKey: testEventKey });

      await expect(inngest.send(testEvent)).resolves.toMatchObject({
        ids: Array(1).fill(expect.any(String)),
      });

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining(`/e/${testEventKey}`),
        expect.objectContaining({
          method: "POST",

          body: expect.stringMatching(
            new RegExp(JSON.stringify(testEvent).slice(1, -1)),
          ),
        }),
      );
    });

    test("should succeed if event key specified in env", async () => {
      process.env[envKeys.InngestEventKey] = testEventKey;
      const inngest = createClient({ id: "test" });

      await expect(inngest.send(testEvent)).resolves.toMatchObject({
        ids: Array(1).fill(expect.any(String)),
      });

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining(`/e/${testEventKey}`),
        expect.objectContaining({
          method: "POST",

          body: expect.stringMatching(
            new RegExp(JSON.stringify(testEvent).slice(1, -1)),
          ),
        }),
      );
    });

    test("should succeed if event key given at runtime", async () => {
      const inngest = createClient({ id: "test" });
      inngest.setEventKey(testEventKey);

      await expect(inngest.send(testEvent)).resolves.toMatchObject({
        ids: Array(1).fill(expect.any(String)),
      });

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining(`/e/${testEventKey}`),
        expect.objectContaining({
          method: "POST",

          body: expect.stringMatching(
            new RegExp(JSON.stringify(testEvent).slice(1, -1)),
          ),
        }),
      );
    });

    test("should succeed if an empty list of payloads is given", async () => {
      const inngest = createClient({ id: "test" });
      inngest.setEventKey(testEventKey);

      await expect(inngest.send([])).resolves.toMatchObject({
        ids: Array(0).fill(expect.any(String)),
      });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    test("should send env:foo if explicitly set in client", async () => {
      const inngest = createClient({
        id: "test",
        eventKey: testEventKey,
        env: "foo",
      });

      await expect(inngest.send(testEvent)).resolves.toMatchObject({
        ids: Array(1).fill(expect.any(String)),
      });
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining(`/e/${testEventKey}`),
        expect.objectContaining({
          method: "POST",

          headers: expect.objectContaining({
            [headerKeys.Environment]: "foo",
          }),
        }),
      );
    });

    test("should send env:foo if explicitly set in send call", async () => {
      const inngest = createClient({ id: "test", eventKey: testEventKey });

      await expect(
        inngest.send(testEvent, { env: "foo" }),
      ).resolves.toMatchObject({
        ids: Array(1).fill(expect.any(String)),
      });
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining(`/e/${testEventKey}`),
        expect.objectContaining({
          method: "POST",

          headers: expect.objectContaining({
            [headerKeys.Environment]: "foo",
          }),
        }),
      );
    });

    test("should send env:foo if set in INNGEST_ENV", async () => {
      process.env[envKeys.InngestEnvironment] = "foo";

      const inngest = createClient({
        id: "test",
        eventKey: testEventKey,
      });

      await expect(inngest.send(testEvent)).resolves.toMatchObject({
        ids: Array(1).fill(expect.any(String)),
      });
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining(`/e/${testEventKey}`),
        expect.objectContaining({
          method: "POST",

          headers: expect.objectContaining({
            [headerKeys.Environment]: "foo",
          }),
        }),
      );
    });

    test("should send explicit env:foo over env var if set in env and client", async () => {
      process.env[envKeys.InngestEnvironment] = "bar";

      const inngest = createClient({
        id: "test",
        eventKey: testEventKey,
        env: "foo",
      });

      await expect(inngest.send(testEvent)).resolves.toMatchObject({
        ids: Array(1).fill(expect.any(String)),
      });
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining(`/e/${testEventKey}`),
        expect.objectContaining({
          method: "POST",

          headers: expect.objectContaining({
            [headerKeys.Environment]: "foo",
          }),
        }),
      );
    });

    test("should send env:foo if set in platform env key", async () => {
      process.env[envKeys.VercelBranch] = "foo";

      const inngest = createClient({
        id: "test",
        eventKey: testEventKey,
      });

      await expect(inngest.send(testEvent)).resolves.toMatchObject({
        ids: Array(1).fill(expect.any(String)),
      });
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining(`/e/${testEventKey}`),
        expect.objectContaining({
          method: "POST",

          headers: expect.objectContaining({
            [headerKeys.Environment]: "foo",
          }),
        }),
      );
    });

    test("should send explicit env:foo over env var and client if set in send call", async () => {
      process.env[envKeys.InngestEnvironment] = "bar";

      const inngest = createClient({
        id: "test",
        eventKey: testEventKey,
        env: "baz",
      });

      await expect(
        inngest.send(testEvent, { env: "foo" }),
      ).resolves.toMatchObject({
        ids: Array(1).fill(expect.any(String)),
      });
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining(`/e/${testEventKey}`),
        expect.objectContaining({
          method: "POST",

          headers: expect.objectContaining({
            [headerKeys.Environment]: "foo",
          }),
        }),
      );
    });

    test("should insert `ts` timestamp ", async () => {
      const inngest = createClient({ id: "test" });
      inngest.setEventKey(testEventKey);

      const testEventWithoutTs = {
        name: "test.without.ts",
        data: {},
      };

      const mockedFetch = vi.mocked(global.fetch);

      await expect(inngest.send(testEventWithoutTs)).resolves.toMatchObject({
        ids: Array(1).fill(expect.any(String)),
      });

      expect(mockedFetch).toHaveBeenCalledTimes(1);
      expect(mockedFetch.mock.calls[0]).toHaveLength(2);
      expect(typeof mockedFetch.mock.calls[0]?.[1]?.body).toBe("string");
      // biome-ignore lint/suspicious/noExplicitAny: <explanation>
      const body: Array<Record<string, any>> = JSON.parse(
        mockedFetch.mock.calls[0]?.[1]?.body as string,
      );
      expect(body).toHaveLength(1);
      expect(body[0]).toEqual(
        expect.objectContaining({
          ...testEventWithoutTs,

          ts: expect.any(Number),
        }),
      );
    });

    test("should insert blank `data` if none given", async () => {
      const inngest = createClient({ id: "test" });
      inngest.setEventKey(testEventKey);

      const testEventWithoutData = {
        name: "test.without.data",
      };

      const mockedFetch = vi.mocked(global.fetch);

      await expect(inngest.send(testEventWithoutData)).resolves.toMatchObject({
        ids: Array(1).fill(expect.any(String)),
      });

      expect(mockedFetch).toHaveBeenCalledTimes(1);
      expect(mockedFetch.mock.calls[0]).toHaveLength(2);
      expect(typeof mockedFetch.mock.calls[0]?.[1]?.body).toBe("string");
      // biome-ignore lint/suspicious/noExplicitAny: <explanation>
      const body: Array<Record<string, any>> = JSON.parse(
        mockedFetch.mock.calls[0]?.[1]?.body as string,
      );
      expect(body).toHaveLength(1);
      expect(body[0]).toEqual(
        expect.objectContaining({
          ...testEventWithoutData,
          data: {},
        }),
      );
    });

    if (nodeVersion?.major && nodeVersion.major >= 19) {
      test("should use seed header for idempotency ID if none given", async () => {
        const inngest = createClient({ id: "test" });
        inngest.setEventKey(testEventKey);

        const testEventWithoutId = {
          name: "test.without.id",
          data: {},
        };

        const mockedFetch = vi.mocked(global.fetch);

        await expect(inngest.send(testEventWithoutId)).resolves.toMatchObject({
          ids: Array(1).fill(expect.any(String)),
        });

        expect(mockedFetch).toHaveBeenCalledTimes(1);
        expect(mockedFetch.mock.calls[0]).toHaveLength(2);

        const reqHeaders = mockedFetch.mock.calls[0]?.[1]?.headers as Record<
          string,
          string
        >;
        expect(reqHeaders).toBeDefined();
        expect(typeof reqHeaders).toBe("object");

        expect(reqHeaders[headerKeys.EventIdSeed]).toBeDefined();
        expect(typeof reqHeaders[headerKeys.EventIdSeed]).toBe("string");
        expect(reqHeaders[headerKeys.EventIdSeed]).toBeTruthy();
      });
    }

    test("should allow middleware to mutate input", async () => {
      const inngest = createClient({
        id: "test",
        eventKey: testEventKey,
        middleware: [
          new InngestMiddleware({
            name: "Test",
            init() {
              return {
                onSendEvent() {
                  return {
                    transformInput(ctx) {
                      return {
                        payloads: ctx.payloads.map((payload) => ({
                          ...payload,

                          data: {
                            ...payload.data,
                            bar: true,
                          },
                        })),
                      };
                    },
                  };
                },
              };
            },
          }),
        ],
      });

      await expect(
        inngest.send({ ...testEvent, data: { foo: true } }),
      ).resolves.toMatchObject({
        ids: Array(1).fill(expect.any(String)),
      });

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining(`/e/${testEventKey}`),
        expect.objectContaining({
          method: "POST",

          body: expect.stringMatching(
            new RegExp(
              JSON.stringify({
                ...testEvent,
                data: { foo: true, bar: true },
              }).slice(1, -1),
            ),
          ),
        }),
      );
    });

    test("should allow middleware to mutate output", async () => {
      const inngest = createClient({
        id: "test",
        eventKey: testEventKey,
        middleware: [
          new InngestMiddleware({
            name: "Test",
            init() {
              return {
                onSendEvent() {
                  return {
                    transformOutput({ result }) {
                      return {
                        result: {
                          ids: result.ids.map((id) => `${id}-bar`),
                        },
                      };
                    },
                  };
                },
              };
            },
          }),
        ],
      });

      await expect(inngest.send(testEvent)).resolves.toMatchObject({
        ids: Array(1).fill(expect.stringMatching(/-bar$/)),
      });
    });

    test("should return error from Inngest if parsed", () => {
      const inngest = createClient({
        id: "test",
        eventKey: testEventKey,
        fetch: setFetch({ status: 400, error: "Test Error" }),
      });

      return expect(inngest.send(testEvent)).rejects.toThrowError("Test Error");
    });

    test("should return error from Inngest if parsed even for 200", () => {
      const inngest = createClient({
        id: "test",
        eventKey: testEventKey,
        fetch: setFetch({ status: 200, error: "Test Error" }),
      });

      return expect(inngest.send(testEvent)).rejects.toThrowError("Test Error");
    });

    test("should return error if bad status code with no error string", () => {
      const inngest = createClient({
        id: "test",
        eventKey: testEventKey,
        fetch: setFetch({ status: 400 }),
      });

      return expect(inngest.send(testEvent)).rejects.toThrowError(
        "Cannot process event payload",
      );
    });

    test("should return unknown error from response text if very bad status code", () => {
      const inngest = createClient({
        id: "test",
        eventKey: testEventKey,
        fetch: setFetch({ status: 600 }),
      });

      return expect(inngest.send(testEvent)).rejects.toThrowError("600");
    });
  });

  describe("types", () => {
    describe("no custom types", () => {
      const inngest = createClient({ id: "test", eventKey: testEventKey });

      test.todo("disallows sending invalid fields");

      test.todo(
        "disallows sending invalid fields when sending multiple events",
      );

      test("allows sending a single event with an object", () => {
        const _fn = () => inngest.send({ name: "anything", data: "foo" });
      });

      test("allows sending multiple events", () => {
        const _fn = () =>
          inngest.send([
            { name: "anything", data: "foo" },
            { name: "anything", data: "foo" },
            { name: "anythingelse" },
          ]);
      });

      test("allows setting an ID for an event", () => {
        const _fn = () =>
          inngest.send({ name: "anything", data: "foo", id: "test" });
      });
    });
  });
});

describe("createFunction", () => {
  describe("types", () => {
    describe("function input", () => {
      const inngest = createClient({ id: "test" });

      test("has attempt number", () => {
        inngest.createFunction(
          {
            id: "test",
            onFailure: ({ attempt }) => {
              assertType<number>(attempt);
            },
          },
          { event: "test" },
          ({ attempt }) => {
            assertType<number>(attempt);
          },
        );
      });
    });

    describe("no custom types", () => {
      const inngest = createClient({ id: "test" });

      test("allows name to be an object", () => {
        inngest.createFunction(
          { id: "test" },
          { event: "test" },
          ({ event }) => {
            assertType<string>(event.name);
            assertType<IsAny<typeof event.data>>(true);
          },
        );
      });

      test("name as an object must contain a name property", () => {
        inngest.createFunction(
          // @ts-expect-error Must contain name property
          { foo: "bar" },
          { event: "test" },
          ({ event }) => {
            assertType<string>(event.name);
            assertType<IsAny<typeof event.data>>(true);
          },
        );
      });

      test("allows trigger to be an object with an event property", () => {
        inngest.createFunction(
          { id: "test" },
          { event: "test" },
          ({ event }) => {
            assertType<string>(event.name);
            assertType<IsAny<typeof event.data>>(true);
          },
        );
      });

      test("allows trigger to be an object with a cron property", () => {
        inngest.createFunction(
          { id: "test" },
          { cron: "test" },
          ({ event }) => {
            assertType<string>(event.name);
            assertType<IsAny<typeof event.data>>(true);
          },
        );
      });

      test("disallows trigger with unknown properties", () => {
        // @ts-expect-error Unknown property
        inngest.createFunction({ id: "test" }, { foo: "bar" }, ({ event }) => {
          assertType<string>(event.name);
          assertType<IsAny<typeof event.data>>(true);
        });
      });

      test("disallows trigger with both event and cron properties", () => {
        inngest.createFunction(
          { id: "test" },
          // @ts-expect-error Both event and cron
          { event: "test", cron: "test" },
          ({ event }) => {
            assertType<string>(event.name);
            assertType<IsAny<typeof event.data>>(true);
          },
        );
      });
    });
  });
});

describe("setEnvVars", () => {
  test("mode is mutable after construction", () => {
    const inngest = createClient({ id: "test" });
    expect(inngest.mode).toBe("cloud");

    inngest.setEnvVars({ [envKeys.InngestDevMode]: "1" });

    // Mode changed by INNGEST_DEV=1
    expect(inngest.mode).toBe("dev");
  });

  test("updates event key from env", () => {
    const inngest = createClient({ id: "test" });
    expect(inngest["eventKey"]).toBe(dummyEventKey);

    inngest.setEnvVars({ [envKeys.InngestEventKey]: "new-key" });
    expect(inngest["eventKey"]).toBe("new-key");
  });
});

describe("URL configuration", () => {
  test("defaults to cloud URLs", () => {
    const inngest = createClient({ id: "test" });
    expect(inngest.apiBaseUrl).toBe("https://api.inngest.com/");
    expect(inngest.eventBaseUrl).toBe("https://inn.gs/");
  });

  test("isDev: true uses dev server URL", () => {
    const inngest = createClient({ id: "test", isDev: true });
    expect(inngest.apiBaseUrl).toBe("http://localhost:8288/");
    expect(inngest.eventBaseUrl).toBe("http://localhost:8288/");
  });

  test("INNGEST_BASE_URL sets both URLs", () => {
    const inngest = createClient({ id: "test" });
    inngest.setEnvVars({ [envKeys.InngestBaseUrl]: "http://custom:8000/" });

    expect(inngest.apiBaseUrl).toBe("http://custom:8000/");
    expect(inngest.eventBaseUrl).toBe("http://custom:8000/");
  });

  test("INNGEST_API_BASE_URL sets only API URL", () => {
    const inngest = createClient({ id: "test" });
    inngest.setEnvVars({
      [envKeys.InngestApiBaseUrl]: "http://api-only:8000/",
    });

    expect(inngest.apiBaseUrl).toBe("http://api-only:8000/");
    expect(inngest.eventBaseUrl).toBe("https://inn.gs/"); // unchanged
  });

  test("INNGEST_EVENT_API_BASE_URL sets only event URL", () => {
    const inngest = createClient({ id: "test" });
    inngest.setEnvVars({
      [envKeys.InngestEventApiBaseUrl]: "http://event-only:8000/",
    });

    expect(inngest.apiBaseUrl).toBe("https://api.inngest.com/"); // unchanged
    expect(inngest.eventBaseUrl).toBe("http://event-only:8000/");
  });

  test("specific URL env vars override INNGEST_BASE_URL", () => {
    const inngest = createClient({ id: "test" });
    inngest.setEnvVars({
      [envKeys.InngestBaseUrl]: "http://base:8000/",
      [envKeys.InngestApiBaseUrl]: "http://api-specific:9000/",
      [envKeys.InngestEventApiBaseUrl]: "http://event-specific:9001/",
    });

    expect(inngest.apiBaseUrl).toBe("http://api-specific:9000/");
    expect(inngest.eventBaseUrl).toBe("http://event-specific:9001/");
  });

  test("options.baseUrl overrides all env vars", () => {
    const inngest = createClient({
      id: "test",
      baseUrl: "http://option:7000/",
    });
    inngest.setEnvVars({
      [envKeys.InngestBaseUrl]: "http://base:8000/",
      [envKeys.InngestApiBaseUrl]: "http://api:9000/",
      [envKeys.InngestEventApiBaseUrl]: "http://event:9001/",
    });

    expect(inngest.apiBaseUrl).toBe("http://option:7000/");
    expect(inngest.eventBaseUrl).toBe("http://option:7000/");
  });
});

describe("helper types", () => {
  const inngest = new Inngest({
    id: "test",
    middleware: [
      new InngestMiddleware({
        name: "",
        init: () => ({
          onFunctionRun: () => ({
            transformInput: () => ({
              ctx: {
                foo: "bar",
              } as const,
            }),
          }),
        }),
      }),
    ],
  });

  describe("type GetFunctionInput", () => {
    type T0 = GetFunctionInput<typeof inngest>;

    test("returns event typing", () => {
      type Expected = string;
      type Actual = T0["event"]["name"];
      assertType<IsEqual<Expected, Actual>>(true);
    });

    test("returns built-in middleware typing", () => {
      type Expected = Logger;
      type Actual = T0["logger"];
      assertType<IsEqual<Expected, Actual>>(true);
    });

    test("returns custom middleware typing", () => {
      type Expected = "bar";
      type Actual = T0["foo"];
      assertType<IsEqual<Expected, Actual>>(true);
    });

    test("has all step tooling", () => {
      type Expected = keyof ReturnType<typeof createStepTools>;
      type Actual = keyof T0["step"];
      assertType<IsEqual<Expected, Actual>>(true);
    });
  });

  describe("type GetFunctionOutput", () => {
    test("returns output of an async `InngestFunction`", () => {
      const fn = inngest.createFunction(
        { id: "test" },
        { event: "foo" },

        async () => {
          return "foo" as const;
        },
      );

      type Expected = "foo";
      type Actual = GetFunctionOutput<typeof fn>;
      assertType<IsEqual<Expected, Actual>>(true);
    });

    test("returns output of a sync `InngestFunction`", () => {
      const fn = inngest.createFunction(
        { id: "test" },
        { event: "foo" },
        () => {
          return "foo" as const;
        },
      );

      type Expected = "foo";
      type Actual = GetFunctionOutput<typeof fn>;
      assertType<IsEqual<Expected, Actual>>(true);
    });

    test("returns output of an `InngestFunctionReference` to an async `InngestFunction`", () => {
      const fn = inngest.createFunction(
        { id: "test" },
        { event: "foo" },

        async () => {
          return "foo" as const;
        },
      );

      const ref = referenceFunction<typeof fn>({ functionId: "test" });

      type Expected = "foo";
      type Actual = GetFunctionOutput<typeof ref>;
      assertType<IsEqual<Expected, Actual>>(true);
    });

    test("returns output of an `InngestFunctionReference` to a sync `InngestFunction`", () => {
      const fn = inngest.createFunction(
        { id: "test" },
        { event: "foo" },
        () => {
          return "foo" as const;
        },
      );

      const ref = referenceFunction<typeof fn>({ functionId: "test" });

      type Expected = "foo";
      type Actual = GetFunctionOutput<typeof ref>;
      assertType<IsEqual<Expected, Actual>>(true);
    });

    test("returns output of an `InngestFunctionReference` with `schemas`", () => {
      const ref = referenceFunction({
        functionId: "test",
        schemas: { return: literal("foo") },
      });

      type Expected = "foo";
      type Actual = GetFunctionOutput<typeof ref>;

      assertType<IsEqual<Expected, Actual>>(true);
    });
  });

  describe("type GetStepTools", () => {
    type T0 = GetStepTools<typeof inngest>;

    test("has all tooling", () => {
      type Expected = keyof ReturnType<typeof createStepTools>;
      type Actual = keyof T0;
      assertType<IsEqual<Expected, Actual>>(true);
    });
  });
});
