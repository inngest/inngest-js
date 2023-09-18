import { EventSchemas, InngestMiddleware, type EventPayload } from "@local";
import { envKeys, headerKeys } from "@local/helpers/consts";
import { type IsAny } from "@local/helpers/types";
import { assertType } from "type-plus";
import { createClient } from "../test/helpers";

const testEvent: EventPayload = {
  name: "test",
  data: {},
  ts: 1688139903724,
};

const testEventKey = "foo-bar-baz-test";

describe("instantiation", () => {
  describe("event key warnings", () => {
    let warnSpy: jest.SpyInstance;
    const originalEnvEventKey = process.env[envKeys.EventKey];

    beforeEach(() => {
      warnSpy = jest.spyOn(console, "warn");
    });

    afterEach(() => {
      warnSpy.mockReset();
      warnSpy.mockRestore();

      if (originalEnvEventKey) {
        process.env[envKeys.EventKey] = originalEnvEventKey;
      } else {
        delete process.env[envKeys.EventKey];
      }
    });

    test("should log a warning if event key not specified", () => {
      createClient({ name: "test" });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Could not find event key")
      );
    });

    test("should not log a warning if event key is specified", () => {
      createClient({ name: "test", eventKey: testEventKey });
      expect(warnSpy).not.toHaveBeenCalled();
    });

    test("should not log a warning if event key is specified in env", () => {
      process.env[envKeys.EventKey] = testEventKey;
      createClient({ name: "test" });
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});

describe("send", () => {
  describe("runtime", () => {
    const originalProcessEnv = process.env;
    const originalFetch = global.fetch;

    beforeAll(() => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      global.fetch = jest.fn(
        () =>
          Promise.resolve({
            status: 200,
            json: () => Promise.resolve({}),
          })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ) as any;
    });

    beforeEach(() => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
      (global.fetch as any).mockClear();
      process.env = { ...originalProcessEnv };
    });

    afterAll(() => {
      global.fetch = originalFetch;
      process.env = originalProcessEnv;
    });

    test("should fail to send if event key not specified at instantiation", async () => {
      const inngest = createClient({ name: "test" });

      await expect(() => inngest.send(testEvent)).rejects.toThrowError(
        "Failed to send event"
      );
    });

    test("should succeed if event key specified at instantiation", async () => {
      const inngest = createClient({ name: "test", eventKey: testEventKey });

      await expect(inngest.send(testEvent)).resolves.toBeUndefined();

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining(`/e/${testEventKey}`),
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify([testEvent]),
        })
      );
    });

    test("should succeed if event key specified in env", async () => {
      process.env[envKeys.EventKey] = testEventKey;
      const inngest = createClient({ name: "test" });

      await expect(inngest.send(testEvent)).resolves.toBeUndefined();

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining(`/e/${testEventKey}`),
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify([testEvent]),
        })
      );
    });

    test("should succeed if event key given at runtime", async () => {
      const inngest = createClient({ name: "test" });
      inngest.setEventKey(testEventKey);

      await expect(inngest.send(testEvent)).resolves.toBeUndefined();

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining(`/e/${testEventKey}`),
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify([testEvent]),
        })
      );
    });

    test("should succeed if an empty list of payloads is given", async () => {
      const inngest = createClient({ name: "test" });
      inngest.setEventKey(testEventKey);

      await expect(inngest.send([])).resolves.toBeUndefined();
      expect(global.fetch).not.toHaveBeenCalled();
    });

    test("should send env:foo if explicitly set", async () => {
      const inngest = createClient({
        name: "test",
        eventKey: testEventKey,
        env: "foo",
      });

      await expect(inngest.send(testEvent)).resolves.toBeUndefined();
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining(`/e/${testEventKey}`),
        expect.objectContaining({
          method: "POST",
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          headers: expect.objectContaining({
            [headerKeys.Environment]: "foo",
          }),
        })
      );
    });

    test("should send env:foo if set in INNGEST_ENV", async () => {
      process.env[envKeys.Environment] = "foo";

      const inngest = createClient({
        name: "test",
        eventKey: testEventKey,
      });

      await expect(inngest.send(testEvent)).resolves.toBeUndefined();
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining(`/e/${testEventKey}`),
        expect.objectContaining({
          method: "POST",
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          headers: expect.objectContaining({
            [headerKeys.Environment]: "foo",
          }),
        })
      );
    });

    test("should send explicit env:foo over env var if set in both", async () => {
      process.env[envKeys.Environment] = "bar";

      const inngest = createClient({
        name: "test",
        eventKey: testEventKey,
        env: "foo",
      });

      await expect(inngest.send(testEvent)).resolves.toBeUndefined();
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining(`/e/${testEventKey}`),
        expect.objectContaining({
          method: "POST",
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          headers: expect.objectContaining({
            [headerKeys.Environment]: "foo",
          }),
        })
      );
    });

    test("should send env:foo if set in platform env key", async () => {
      process.env[envKeys.VercelBranch] = "foo";

      const inngest = createClient({
        name: "test",
        eventKey: testEventKey,
      });

      await expect(inngest.send(testEvent)).resolves.toBeUndefined();
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining(`/e/${testEventKey}`),
        expect.objectContaining({
          method: "POST",
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          headers: expect.objectContaining({
            [headerKeys.Environment]: "foo",
          }),
        })
      );
    });

    test("should insert `ts` timestamp ", async () => {
      const inngest = createClient({ name: "test" });
      inngest.setEventKey(testEventKey);

      const testEventWithoutTs = {
        name: "test.without.ts",
        data: {},
      };

      const mockedFetch = jest.mocked(global.fetch);

      await expect(inngest.send(testEventWithoutTs)).resolves.toBeUndefined();

      expect(mockedFetch).toHaveBeenCalledTimes(2); // 2nd for dev server check
      expect(mockedFetch.mock.calls[1]).toHaveLength(2);
      expect(typeof mockedFetch.mock.calls[1]?.[1]?.body).toBe("string");
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
      const body: Array<Record<string, any>> = JSON.parse(
        mockedFetch.mock.calls[1]?.[1]?.body as string
      );
      expect(body).toHaveLength(1);
      expect(body[0]).toEqual(
        expect.objectContaining({
          ...testEventWithoutTs,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          ts: expect.any(Number),
        })
      );
    });

    test("should insert blank `data` if none given", async () => {
      const inngest = createClient({ name: "test" });
      inngest.setEventKey(testEventKey);

      const testEventWithoutData = {
        name: "test.without.data",
      };

      const mockedFetch = jest.mocked(global.fetch);

      await expect(inngest.send(testEventWithoutData)).resolves.toBeUndefined();

      expect(mockedFetch).toHaveBeenCalledTimes(2); // 2nd for dev server check
      expect(mockedFetch.mock.calls[1]).toHaveLength(2);
      expect(typeof mockedFetch.mock.calls[1]?.[1]?.body).toBe("string");
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
      const body: Array<Record<string, any>> = JSON.parse(
        mockedFetch.mock.calls[1]?.[1]?.body as string
      );
      expect(body).toHaveLength(1);
      expect(body[0]).toEqual(
        expect.objectContaining({
          ...testEventWithoutData,
          data: {},
        })
      );
    });

    test("should allow middleware to mutate input", async () => {
      const inngest = createClient({
        name: "test",
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
                          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
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
        inngest.send({ ...testEvent, data: { foo: true } })
      ).resolves.toBeUndefined();

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining(`/e/${testEventKey}`),
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify([
            { ...testEvent, data: { foo: true, bar: true } },
          ]),
        })
      );
    });
  });

  describe("types", () => {
    describe("no custom types", () => {
      const inngest = createClient({ name: "test", eventKey: testEventKey });

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
    });

    describe("multiple custom types", () => {
      const inngest = createClient({
        name: "test",
        eventKey: testEventKey,
        schemas: new EventSchemas().fromRecord<{
          foo: {
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
    });
  });
});

describe("createFunction", () => {
  describe("types", () => {
    describe("function input", () => {
      const inngest = createClient({ name: "test" });

      test("has attempt number", () => {
        inngest.createFunction(
          {
            name: "test",
            onFailure: ({ attempt }) => {
              assertType<number>(attempt);
            },
          },
          { event: "test" },
          ({ attempt }) => {
            assertType<number>(attempt);
          }
        );
      });
    });

    describe("no custom types", () => {
      const inngest = createClient({ name: "test" });

      test("allows name to be a string", () => {
        inngest.createFunction("test", { event: "test" }, ({ event }) => {
          assertType<string>(event.name);
          assertType<IsAny<typeof event.data>>(true);
        });
      });

      test("allows name to be an object", () => {
        inngest.createFunction(
          { name: "test" },
          { event: "test" },
          ({ event }) => {
            assertType<string>(event.name);
            assertType<IsAny<typeof event.data>>(true);
          }
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
          }
        );
      });

      test("disallows specifying cancellation with batching", () => {
        inngest.createFunction(
          {
            name: "test",
            batchEvents: { maxSize: 5, timeout: "5s" },
            // @ts-expect-error Cannot specify cancellation with batching
            cancelOn: [{ event: "test2" }],
          },
          { event: "test" },
          () => {
            // no-op
          }
        );
      });

      test("disallows specifying rate limit with batching", () => {
        inngest.createFunction(
          {
            name: "test",
            batchEvents: { maxSize: 5, timeout: "5s" },
            // @ts-expect-error Cannot specify rate limit with batching
            rateLimit: { limit: 5, period: "5s" },
          },
          { event: "test" },
          () => {
            // no-op
          }
        );
      });

      test("allows trigger to be a string", () => {
        inngest.createFunction("test", "test", ({ event }) => {
          assertType<string>(event.name);
          assertType<IsAny<typeof event.data>>(true);
        });
      });

      test("allows trigger to be an object with an event property", () => {
        inngest.createFunction("test", { event: "test" }, ({ event }) => {
          assertType<string>(event.name);
          assertType<IsAny<typeof event.data>>(true);
        });
      });

      test("allows trigger to be an object with a cron property", () => {
        inngest.createFunction("test", { cron: "test" }, ({ event }) => {
          assertType<string>(event.name);
          assertType<IsAny<typeof event.data>>(true);
        });
      });

      test("disallows trigger with unknown properties", () => {
        // @ts-expect-error Unknown property
        inngest.createFunction("test", { foo: "bar" }, ({ event }) => {
          assertType<string>(event.name);
          assertType<IsAny<typeof event.data>>(true);
        });
      });

      test("disallows trigger with both event and cron properties", () => {
        inngest.createFunction(
          "test",
          // @ts-expect-error Both event and cron
          { event: "test", cron: "test" },
          ({ event }) => {
            assertType<string>(event.name);
            assertType<IsAny<typeof event.data>>(true);
          }
        );
      });
    });

    describe("multiple custom types", () => {
      const inngest = createClient({
        name: "test",
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

      test("allows name to be a string", () => {
        inngest.createFunction("test", { event: "foo" }, ({ event }) => {
          assertType<"foo">(event.name);
          assertType<{ title: string }>(event.data);
        });
      });

      test("allows name to be an object", () => {
        inngest.createFunction(
          { name: "test" },
          { event: "bar" },
          ({ event }) => {
            assertType<"bar">(event.name);
            assertType<{ message: string }>(event.data);
          }
        );
      });

      test("name as an object must contain a name property", () => {
        inngest.createFunction(
          // @ts-expect-error Must contain name property
          { foo: "bar" },
          { event: "foo" },
          ({ event }) => {
            assertType<"foo">(event.name);
            assertType<{ title: string }>(event.data);
          }
        );
      });

      test("allows trigger to be a string", () => {
        inngest.createFunction("test", "bar", ({ event }) => {
          assertType<"bar">(event.name);
          assertType<{ message: string }>(event.data);
        });
      });

      test("allows trigger to be an object with an event property", () => {
        inngest.createFunction("test", { event: "foo" }, ({ event }) => {
          assertType<"foo">(event.name);
          assertType<{ title: string }>(event.data);
        });
      });

      test("allows trigger to be an object with a cron property", () => {
        inngest.createFunction("test", { cron: "test" }, ({ event }) => {
          assertType<unknown>(event);
        });
      });

      test("disallows trigger with unknown properties", () => {
        // @ts-expect-error Unknown property
        inngest.createFunction("test", { foo: "bar" }, ({ event }) => {
          assertType<unknown>(event);
        });
      });

      test("disallows trigger with both event and cron properties", () => {
        inngest.createFunction(
          "test",
          // @ts-expect-error Both event and cron
          { event: "foo", cron: "test" },
          ({ event }) => {
            assertType<unknown>(event);
          }
        );
      });
    });
  });
});
