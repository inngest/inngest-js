import { assertType } from "type-plus";
import { envKeys } from "../helpers/consts";
import { EventPayload } from "../types";
import { eventKeyWarning, Inngest } from "./Inngest";

const testEvent: EventPayload = {
  name: "test",
  data: {},
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
      new Inngest({ name: "test" });
      expect(warnSpy).toHaveBeenCalledWith(eventKeyWarning);
    });

    test("should not log a warning if event key is specified", () => {
      new Inngest({ name: "test", eventKey: testEventKey });
      expect(warnSpy).not.toHaveBeenCalled();
    });

    test("should not log a warning if event key is specified in env", () => {
      process.env[envKeys.EventKey] = testEventKey;
      new Inngest({ name: "test" });
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});

describe("send", () => {
  describe("runtime", () => {
    const originalEnvEventKey = process.env[envKeys.EventKey];
    const originalFetch = global.fetch;

    beforeAll(() => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      global.fetch = jest.fn(() =>
        Promise.resolve({
          status: 200,
          json: () => Promise.resolve({}),
        })
      ) as any;
    });

    beforeEach(() => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
      (global.fetch as any).mockClear();
    });

    afterEach(() => {
      if (originalEnvEventKey) {
        process.env[envKeys.EventKey] = originalEnvEventKey;
      } else {
        delete process.env[envKeys.EventKey];
      }
    });

    afterAll(() => {
      global.fetch = originalFetch;
    });

    test("should fail to send if event key not specified at instantiation", async () => {
      const inngest = new Inngest({ name: "test" });

      await expect(() => inngest.send(testEvent)).rejects.toThrowError(
        "Could not find an event key"
      );
    });

    test("should succeed if event key specified at instantiation", async () => {
      const inngest = new Inngest({ name: "test", eventKey: testEventKey });

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
      const inngest = new Inngest({ name: "test" });

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
      const inngest = new Inngest({ name: "test" });
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

    test("should succeed if an event name is given with an empty list of payloads", async () => {
      const inngest = new Inngest({ name: "test" });
      inngest.setEventKey(testEventKey);

      await expect(inngest.send("test", [])).resolves.toBeUndefined();
      expect(global.fetch).not.toHaveBeenCalled();
    });

    test("should succeed if an empty list of payloads is given", async () => {
      const inngest = new Inngest({ name: "test" });
      inngest.setEventKey(testEventKey);

      await expect(inngest.send([])).resolves.toBeUndefined();
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe("types", () => {
    describe("no custom types", () => {
      const inngest = new Inngest({ name: "test", eventKey: testEventKey });

      test("allows sending a single event with a string", () => {
        void inngest.send("anything", { data: "foo" });
      });

      test("allows sending a single event with an object", () => {
        void inngest.send({ name: "anything", data: "foo" });
      });

      test("allows sending multiple events", () => {
        void inngest.send([
          { name: "anything", data: "foo" },
          { name: "anything", data: "foo" },
        ]);
      });
    });

    describe("multiple custom types", () => {
      const inngest = new Inngest<{
        foo: {
          name: "foo";
          data: { foo: string };
        };
        bar: {
          name: "bar";
          data: { bar: string };
        };
      }>({ name: "test", eventKey: testEventKey });

      test("disallows sending a single unknown event with a string", () => {
        // @ts-expect-error Unknown event
        void inngest.send("unknown", { data: { foo: "" } });
      });

      test("disallows sending a single unknown event with an object", () => {
        // @ts-expect-error Unknown event
        void inngest.send({ name: "unknown", data: { foo: "" } });
      });

      test("disallows sending multiple unknown events", () => {
        void inngest.send([
          // @ts-expect-error Unknown event
          { name: "unknown", data: { foo: "" } },
          // @ts-expect-error Unknown event
          { name: "unknown2", data: { foo: "" } },
        ]);
      });

      test("disallows sending one unknown event with multiple known events", () => {
        void inngest.send([
          { name: "foo", data: { foo: "" } },
          // @ts-expect-error Unknown event
          { name: "unknown", data: { foo: "" } },
        ]);
      });

      test("disallows sending a single known event with a string and invalid data", () => {
        // @ts-expect-error Invalid data
        void inngest.send("foo", { data: { foo: 1 } });
      });

      test("disallows sending a single known event with an object and invalid data", () => {
        // @ts-expect-error Invalid data
        void inngest.send({ name: "foo", data: { foo: 1 } });
      });

      test("disallows sending multiple known events with invalid data", () => {
        void inngest.send([
          // @ts-expect-error Invalid data
          { name: "foo", data: { bar: "" } },
          // @ts-expect-error Invalid data
          { name: "bar", data: { foo: "" } },
        ]);
      });

      test("allows sending a single known event with a string", () => {
        void inngest.send("foo", { data: { foo: "" } });
      });

      test("allows sending a single known event with an object", () => {
        void inngest.send({ name: "foo", data: { foo: "" } });
      });

      test("allows sending multiple known events", () => {
        void inngest.send([
          { name: "foo", data: { foo: "" } },
          { name: "bar", data: { bar: "" } },
        ]);
      });
    });
  });
});

describe("createFunction", () => {
  describe("types", () => {
    describe("no custom types", () => {
      const inngest = new Inngest({ name: "test" });

      test("allows name to be a string", () => {
        inngest.createFunction("test", { event: "test" }, ({ event }) => {
          assertType<string>(event.name);
          assertType<any>(event.data);
        });
      });

      test("allows name to be an object", () => {
        inngest.createFunction(
          { name: "test" },
          { event: "test" },
          ({ event }) => {
            assertType<string>(event.name);
            assertType<any>(event.data);
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
            assertType<any>(event.data);
          }
        );
      });

      test("allows trigger to be a string", () => {
        inngest.createFunction("test", "test", ({ event }) => {
          assertType<string>(event.name);
          assertType<any>(event.data);
        });
      });

      test("allows trigger to be an object with an event property", () => {
        inngest.createFunction("test", { event: "test" }, ({ event }) => {
          assertType<string>(event.name);
          assertType<any>(event.data);
        });
      });

      test("allows trigger to be an object with a cron property", () => {
        inngest.createFunction("test", { cron: "test" }, ({ event }) => {
          assertType<string>(event.name);
          assertType<any>(event.data);
        });
      });

      test("disallows trigger with unknown properties", () => {
        // @ts-expect-error Unknown property
        inngest.createFunction("test", { foo: "bar" }, ({ event }) => {
          assertType<string>(event.name);
          assertType<any>(event.data);
        });
      });

      test("disallows trigger with both event and cron properties", () => {
        inngest.createFunction(
          "test",
          // @ts-expect-error Both event and cron
          { event: "test", cron: "test" },
          ({ event }) => {
            assertType<string>(event.name);
            assertType<any>(event.data);
          }
        );
      });
    });

    describe("multiple custom types", () => {
      const inngest = new Inngest<{
        foo: {
          name: "foo";
          data: { title: string };
        };
        bar: {
          name: "bar";
          data: { message: string };
        };
      }>({ name: "test" });

      test("disallows unknown event as object", () => {
        // @ts-expect-error Unknown event
        inngest.createFunction("test", { event: "unknown" }, ({ event }) => {
          assertType<unknown>(event);
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
