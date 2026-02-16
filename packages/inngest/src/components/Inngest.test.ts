import type { Mock } from "vitest";
import { literal } from "zod/v3";
import {
  dummyEventKey,
  envKeys,
  headerKeys,
  internalEvents,
} from "../helpers/consts.ts";
import type { IsAny, IsEqual, IsNever } from "../helpers/types.ts";
import {
  type EventPayload,
  EventSchemas,
  type GetEvents,
  type GetFunctionInput,
  type GetFunctionOutput,
  type GetStepTools,
  Inngest,
  InngestMiddleware,
  referenceFunction,
} from "../index.ts";
import type { Logger } from "../middleware/logger.ts";
import { createClient, nodeVersion } from "../test/helpers.ts";
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
        // biome-ignore lint/complexity/noForEach: intentional
        Object.keys(ogKeys).forEach((key) => {
          process.env[key] = ogKeys[key];
        });
      }

      return inngest;
    };

    test("should default to inferred dev mode", () => {
      const inngest = createTestClient();
      expect(inngest["mode"].isDev).toBe(true);
      expect(inngest["mode"].isExplicit).toBe(false);
    });

    test("`isDev: true` sets explicit dev mode", () => {
      const inngest = createTestClient({ opts: { isDev: true } });
      expect(inngest["mode"].isDev).toBe(true);
      expect(inngest["mode"].isExplicit).toBe(true);
    });

    test("`isDev: false` sets explict cloud mode", () => {
      const inngest = createTestClient({ opts: { isDev: false } });
      expect(inngest["mode"].isCloud).toBe(true);
      expect(inngest["mode"].isExplicit).toBe(true);
    });

    test("`INNGEST_DEV=1 sets explicit dev mode", () => {
      const inngest = createTestClient({
        env: { [envKeys.InngestDevMode]: "1" },
      });
      expect(inngest["mode"].isDev).toBe(true);
      expect(inngest["mode"].isExplicit).toBe(true);
    });

    test("`INNGEST_DEV=true` sets explicit dev mode", () => {
      const inngest = createTestClient({
        env: { [envKeys.InngestDevMode]: "true" },
      });
      expect(inngest["mode"].isDev).toBe(true);
      expect(inngest["mode"].isExplicit).toBe(true);
    });

    test("`INNGEST_DEV=false` sets explicit cloud mode", () => {
      const inngest = createTestClient({
        env: { [envKeys.InngestDevMode]: "false" },
      });
      expect(inngest["mode"].isCloud).toBe(true);
      expect(inngest["mode"].isExplicit).toBe(true);
    });

    test("`INNGEST_DEV=0 sets explicit cloud mode", () => {
      const inngest = createTestClient({
        env: { [envKeys.InngestDevMode]: "0" },
      });
      expect(inngest["mode"].isCloud).toBe(true);
      expect(inngest["mode"].isExplicit).toBe(true);
    });

    test("`isDev` overwrites `INNGEST_DEV`", () => {
      const inngest = createTestClient({
        env: { [envKeys.InngestDevMode]: "1" },
        opts: { isDev: false },
      });
      expect(inngest["mode"].isDev).toBe(false);
      expect(inngest["mode"].isExplicit).toBe(true);
    });

    test("`INNGEST_DEV=URL sets explicit dev mode", () => {
      const inngest = createTestClient({
        env: { [envKeys.InngestDevMode]: "http://localhost:3000" },
      });
      expect(inngest["mode"].isDev).toBe(true);
      expect(inngest["mode"].isExplicit).toBe(true);
      expect(inngest["mode"].explicitDevUrl?.href).toBe(
        "http://localhost:3000/",
      );
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

      expect(mockedFetch).toHaveBeenCalledTimes(2); // 2nd for dev server check
      expect(mockedFetch.mock.calls[1]).toHaveLength(2);
      expect(typeof mockedFetch.mock.calls[1]?.[1]?.body).toBe("string");
      // biome-ignore lint/suspicious/noExplicitAny: intentional
      const body: Array<Record<string, any>> = JSON.parse(
        mockedFetch.mock.calls[1]?.[1]?.body as string,
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

      expect(mockedFetch).toHaveBeenCalledTimes(2); // 2nd for dev server check
      expect(mockedFetch.mock.calls[1]).toHaveLength(2);
      expect(typeof mockedFetch.mock.calls[1]?.[1]?.body).toBe("string");
      // biome-ignore lint/suspicious/noExplicitAny: intentional
      const body: Array<Record<string, any>> = JSON.parse(
        mockedFetch.mock.calls[1]?.[1]?.body as string,
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

        expect(mockedFetch).toHaveBeenCalledTimes(2); // 2nd for dev server check
        expect(mockedFetch.mock.calls[1]).toHaveLength(2);

        const reqHeaders = mockedFetch.mock.calls[1]?.[1]?.headers as Record<
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

    describe("multiple custom types", () => {
      const inngest = createClient({
        id: "test",
        eventKey: testEventKey,
        schemas: new EventSchemas().fromRecord<{
          foo: {
            name: "foo";
            data: { foo: string };
          };
          bar: {
            data: { bar: string };
          };
          baz: {};
        }>(),
      });

      test("disallows sending a single unknown event with a string", () => {
        // @ts-expect-error Unknown event
        const _fn = () => inngest.send("unknown", { data: { foo: "" } });
      });

      test("disallows sending a single unknown event with an object", () => {
        // @ts-expect-error Unknown event
        const _fn = () => inngest.send({ name: "unknown", data: { foo: "" } });
      });

      test("disallows sending multiple unknown events", () => {
        const _fn = () =>
          inngest.send([
            // @ts-expect-error Unknown event
            { name: "unknown", data: { foo: "" } },
            // @ts-expect-error Unknown event
            { name: "unknown2", data: { foo: "" } },
          ]);
      });

      test("disallows sending one unknown event with multiple known events", () => {
        const _fn = () =>
          inngest.send([
            { name: "foo", data: { foo: "" } },
            // @ts-expect-error Unknown event
            { name: "unknown", data: { foo: "" } },
          ]);
      });

      test("disallows sending a single known event with a string and invalid data", () => {
        // @ts-expect-error Invalid data
        const _fn = () => inngest.send("foo", { data: { foo: 1 } });
      });

      test("disallows sending a single known event with an object and invalid data", () => {
        // @ts-expect-error Invalid data
        const _fn = () => inngest.send({ name: "foo", data: { foo: 1 } });
      });

      test("disallows sending multiple known events with invalid data", () => {
        const _fn = () =>
          inngest.send([
            // @ts-expect-error Invalid data
            { name: "foo", data: { bar: "" } },
            // @ts-expect-error Invalid data
            { name: "bar", data: { foo: "" } },
          ]);
      });

      test("disallows sending known data-filled event with no data", () => {
        // @ts-expect-error No data
        const _fn = () => inngest.send({ name: "foo" });
      });

      test("disallows sending known data-filled event with empty data object", () => {
        // @ts-expect-error Empty data
        const _fn = () => inngest.send({ name: "foo", data: {} });
      });

      test.todo("disallows sending invalid fields for a known event");

      test("allows sending known data-empty event with no data", () => {
        const _fn = () => inngest.send({ name: "baz" });
      });

      test("allows sending known data-empty event with empty data object", () => {
        const _fn = () => inngest.send({ name: "baz", data: {} });
      });

      test("allows sending a single known event with an object", () => {
        const _fn = () => inngest.send({ name: "foo", data: { foo: "" } });
      });

      test("allows sending multiple known events", () => {
        const _fn = () =>
          inngest.send([
            { name: "foo", data: { foo: "" } },
            { name: "bar", data: { bar: "" } },
          ]);
      });

      test("allows setting an ID for a known event", () => {
        const _fn = () =>
          inngest.send({ name: "foo", data: { foo: "" }, id: "test" });
      });

      test("disallows sending an internal event", () => {
        const _fn = () =>
          // @ts-expect-error Internal event
          inngest.send({ name: internalEvents.FunctionFinished });
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

    describe("multiple custom types", () => {
      const inngest = createClient({
        id: "test",
        schemas: new EventSchemas().fromRecord<{
          foo: {
            name: "foo";
            data: { title: string };
          };
          bar: {
            name: "bar";
            data: { message: string };
          };
        }>(),
      });

      test("disallows unknown event as object", () => {
        // @ts-expect-error Unknown event
        inngest.createFunction("test", { event: "unknown" }, () => {
          // no-op
        });
      });

      test("disallows unknown event as string", () => {
        // @ts-expect-error Unknown event
        inngest.createFunction("test", "unknown", ({ event }) => {
          assertType<unknown>(event);
        });
      });

      test("allows name to be an object", () => {
        inngest.createFunction(
          { id: "test" },
          { event: "bar" },
          ({ event }) => {
            assertType<
              IsEqual<
                `${internalEvents.FunctionInvoked}` | "bar",
                typeof event.name
              >
            >(true);
            assertType<{ message: string }>(event.data);
          },
        );
      });

      test("name as an object must contain a name property", () => {
        inngest.createFunction(
          // @ts-expect-error Must contain name property
          { foo: "bar" },
          { event: "foo" },
          ({ event }) => {
            assertType<
              IsEqual<
                `${internalEvents.FunctionInvoked}` | "foo",
                typeof event.name
              >
            >(true);
            assertType<{ title: string }>(event.data);
          },
        );
      });

      test("allows trigger to be an object with an event property", () => {
        inngest.createFunction(
          { id: "test" },
          { event: "foo" },
          ({ event }) => {
            assertType<
              IsEqual<
                `${internalEvents.FunctionInvoked}` | "foo",
                typeof event.name
              >
            >(true);
            assertType<{ title: string }>(event.data);
          },
        );
      });

      test("allows trigger to be an object with a cron property", () => {
        inngest.createFunction(
          { id: "test" },
          { cron: "test" },
          ({ event }) => {
            assertType<unknown>(event);
          },
        );
      });

      test("disallows trigger with unknown properties", () => {
        // @ts-expect-error Unknown property
        inngest.createFunction("test", { foo: "bar" }, ({ event }) => {
          assertType<unknown>(event);
        });
      });

      test("disallows trigger with both event and cron properties", () => {
        inngest.createFunction(
          { id: "test" },
          // @ts-expect-error Both event and cron
          { event: "foo", cron: "test" },
          ({ event }) => {
            assertType<unknown>(event);
          },
        );
      });

      test("allows no triggers (and no schema) with an empty array", () => {
        inngest.createFunction({ id: "test" }, [], ({ event }) => {
          assertType<
            IsEqual<`${internalEvents.FunctionInvoked}`, typeof event.name>
          >(true);
          assertType<IsAny<typeof event.data>>(true);
        });
      });

      test("allows multiple event triggers", () => {
        inngest.createFunction(
          { id: "test" },
          [{ event: "foo" }, { event: "bar" }, { cron: "* * * * *" }],
          ({ event, events }) => {
            // `event` should represent all possible triggers
            assertType<
              IsEqual<
                | `${internalEvents.FunctionInvoked}`
                | `${internalEvents.ScheduledTimer}`
                | "foo"
                | "bar",
                typeof event.name
              >
            >(true);

            // Without narrowing, `event.data` should be the union of all
            // possible data
            assertType<
              IsEqual<
                { cron: string } | { title: string } | { message: string },
                typeof event.data
              >
            >(true);

            // Type narrowing should allow for specific data access
            switch (event.name) {
              case "inngest/scheduled.timer":
                assertType<
                  IsEqual<`${internalEvents.ScheduledTimer}`, typeof event.name>
                >(true);
                assertType<IsEqual<{ cron: string }, typeof event.data>>(true);
                break;
              case "foo":
                assertType<IsEqual<"foo", typeof event.name>>(true);
                assertType<IsEqual<{ title: string }, typeof event.data>>(true);
                break;
              case "bar":
                assertType<IsEqual<"bar", typeof event.name>>(true);
                assertType<{ message: string }>(event.data);
                break;
              case "inngest/function.invoked":
                assertType<
                  IsEqual<"inngest/function.invoked", typeof event.name>
                >(true);
                assertType<
                  IsEqual<
                    { cron: string } | { title: string } | { message: string },
                    typeof event.data
                  >
                >(true);
                break;
              default:
                // Proves we have exhausted all possibilities
                assertType<IsNever<typeof event>>(true);
            }

            // `events` should omit internal triggers, as they are not
            // batched
            assertType<IsEqual<"foo" | "bar", (typeof events)[number]["name"]>>(
              true,
            );

            // Without narrowing, `event.data` should be the union of all
            // possible data, excluding internal triggers
            assertType<
              IsEqual<
                { title: string } | { message: string },
                (typeof events)[number]["data"]
              >
            >(true);

            // Type narrowing should allow for specific data access
            switch (events[0].name) {
              case "foo":
                assertType<"foo">(events[0].name);
                assertType<{ title: string }>(events[0].data);

                // Proves that each event can be different
                assertType<"foo" | "bar" | undefined>(events[1]?.name);
                break;
              case "bar":
                assertType<"bar">(events[0].name);
                assertType<{ message: string }>(events[0].data);

                // Proves that each event can be different
                assertType<"foo" | "bar" | undefined>(events[1]?.name);
                break;
              default:
                // Proves we have exhausted all possibilities
                assertType<never>(events[0]);
            }
          },
        );
      });
    });
  });
});

describe("setEnvVars", () => {
  test("overwrites existing env vars", () => {
    const inngest = createClient({ id: "test" });

    expect(inngest["_mode"]).toMatchObject({
      type: "dev",
      isExplicit: false,
    });
    expect(inngest["mode"]["explicitDevUrl"]).toBeUndefined();
    expect(inngest["_apiBaseUrl"]).toBeUndefined();
    expect(inngest["_eventBaseUrl"]).toBeUndefined();
    expect(inngest["eventKey"]).toBe(dummyEventKey);
    expect(inngest["inngestApi"]["apiBaseUrl"]).toBeUndefined();
    expect(inngest["inngestApi"]["mode"]).toMatchObject({
      type: "dev",
      isExplicit: false,
    });
    expect(inngest["inngestApi"]["mode"]["explicitDevUrl"]).toBeUndefined();

    const devUrl = "http://example.com:5000/";
    const devEventKey = "dev-event-key";

    inngest.setEnvVars({
      [envKeys.InngestDevMode]: devUrl,
      [envKeys.InngestEventKey]: devEventKey,
    });

    expect(inngest["_mode"]).toMatchObject({
      type: "dev",
      isExplicit: true,
    });
    expect(inngest["_mode"]["explicitDevUrl"]?.href).toBe(devUrl);
    expect(inngest["_apiBaseUrl"]).toBe(devUrl);
    expect(inngest["_eventBaseUrl"]).toBe(devUrl);
    expect(inngest["eventKey"]).toBe(devEventKey);
    expect(inngest["inngestApi"]["apiBaseUrl"]).toBe(devUrl);
    expect(inngest["inngestApi"]["mode"]).toMatchObject({
      type: "dev",
      isExplicit: true,
    });
    expect(inngest["inngestApi"]["mode"]["explicitDevUrl"]?.href).toBe(devUrl);
  });
});

describe("helper types", () => {
  const inngest = new Inngest({
    id: "test",
    schemas: new EventSchemas().fromRecord<{
      foo: { data: { foo: string } };
      bar: { data: { bar: string } };
    }>(),
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

  type GetUnionKeyValue<
    T,
    K extends string | number | symbol,
  > = T extends Record<K, infer U> ? U : never;

  describe("type GetEvents", () => {
    test("can use GetEvents to send an event", () => {
      type T0 = GetEvents<typeof inngest>;
      type T1 = T0[keyof T0];

      const _myEventSendingFn = (events: T1[]) => {
        void inngest.send(events);
      };
    });
  });

  describe("type GetFunctionInput", () => {
    type T0 = GetFunctionInput<typeof inngest>;

    test("returns event typing", () => {
      type Expected =
        | `${internalEvents.FunctionFailed}`
        | `${internalEvents.FunctionFinished}`
        | `${internalEvents.FunctionInvoked}`
        | `${internalEvents.FunctionCancelled}`
        | `${internalEvents.ScheduledTimer}`
        | `${internalEvents.HttpRequest}`
        | "foo"
        | "bar";
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

    test("returns step typing for sendEvent", () => {
      type Expected = "foo" | "bar";
      type Actual = GetUnionKeyValue<
        Parameters<T0["step"]["sendEvent"]>[1],
        "name"
      >;
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

    test("returns step typing for sendEvent", () => {
      type Expected = "foo" | "bar";
      type Actual = GetUnionKeyValue<Parameters<T0["sendEvent"]>[1], "name">;
      assertType<IsEqual<Expected, Actual>>(true);
    });
  });
});

describe("endpointProxy", () => {
  // Helper to create mock adapters with consistent shape
  // biome-ignore lint/suspicious/noExplicitAny: test helper
  const createMockAdapter = (createProxyHandler?: () => any) => {
    const adapter = Object.assign(() => {}, {
      [Symbol.toStringTag]: "Inngest.EndpointAdapter" as const,
      withOptions: () => adapter,
      ...(createProxyHandler && { createProxyHandler }),
    });
    return adapter;
  };

  test("throws error when no endpoint adapter is configured", () => {
    const inngest = createClient({ id: "test" });

    expect(() => inngest.endpointProxy()).toThrow(
      "No endpoint adapter configured for this Inngest client.",
    );
  });

  test("throws error when adapter does not support proxy handlers", () => {
    const inngest = createClient({
      id: "test",
      endpointAdapter: createMockAdapter(),
    });

    expect(() => inngest.endpointProxy()).toThrow(
      "The configured endpoint adapter does not support proxy handlers.",
    );
  });

  test("returns proxy handler when adapter supports it", () => {
    const mockProxyHandler = () => Promise.resolve(new Response());

    const inngest = createClient({
      id: "test",
      endpointAdapter: createMockAdapter(() => mockProxyHandler),
    });

    expect(inngest.endpointProxy()).toBe(mockProxyHandler);
  });

  test("passes client to createProxyHandler", () => {
    const createProxyHandler = vi.fn().mockReturnValue(() => {});

    const inngest = createClient({
      id: "test",
      endpointAdapter: createMockAdapter(createProxyHandler),
    });

    inngest.endpointProxy();

    expect(createProxyHandler).toHaveBeenCalledWith({ client: inngest });
  });
});
