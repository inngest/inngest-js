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
});

describe("createFunction", () => {
  describe("types", () => {
    describe("no custom types", () => {
      const inngest = new Inngest({ name: "test" });

      test("allows name to be a string", () => {
        inngest.createFunction("test", { event: "test" }, () => "test");
      });

      test("allows name to be an object", () => {
        inngest.createFunction(
          { name: "test" },
          { event: "test" },
          () => "test"
        );
      });

      test("name as an object must contain a name property", () => {
        // @ts-expect-error Must contain name property
        inngest.createFunction({ foo: "bar" }, { event: "test" }, () => "test");
      });

      test("allows trigger to be a string", () => {
        inngest.createFunction("test", "test", () => "test");
      });

      test("allows trigger to be an object with an event property", () => {
        inngest.createFunction("test", { event: "test" }, () => "test");
      });

      test("allows trigger to be an object with a cron property", () => {
        inngest.createFunction("test", { cron: "test" }, () => "test");
      });

      test("disallows trigger with unknown properties", () => {
        // @ts-expect-error Unknown property
        inngest.createFunction("test", { foo: "bar" }, () => "test");
      });

      test("disallows trigger with both event and cron properties", () => {
        inngest.createFunction(
          "test",
          // @ts-expect-error Both event and cron
          { event: "test", cron: "test" },
          () => "test"
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
        inngest.createFunction("test", { event: "unknown" }, () => "test");
      });

      test("disallows unknown event as string", () => {
        // @ts-expect-error Unknown event
        inngest.createFunction("test", "unknown", () => "test");
      });

      test("allows name to be a string", () => {
        inngest.createFunction("test", { event: "foo" }, () => "test");
      });

      test("allows name to be an object", () => {
        inngest.createFunction(
          { name: "test" },
          { event: "bar" },
          () => "test"
        );
      });

      test("name as an object must contain a name property", () => {
        // @ts-expect-error Must contain name property
        inngest.createFunction({ foo: "bar" }, { event: "foo" }, () => "test");
      });

      test("allows trigger to be a string", () => {
        inngest.createFunction("test", "bar", () => "test");
      });

      test("allows trigger to be an object with an event property", () => {
        inngest.createFunction("test", { event: "foo" }, () => "test");
      });

      test("allows trigger to be an object with a cron property", () => {
        inngest.createFunction("test", { cron: "test" }, () => "test");
      });

      test("disallows trigger with unknown properties", () => {
        // @ts-expect-error Unknown property
        inngest.createFunction("test", { foo: "bar" }, () => "test");
      });

      test("disallows trigger with both event and cron properties", () => {
        inngest.createFunction(
          "test",
          // @ts-expect-error Both event and cron
          { event: "foo", cron: "test" },
          () => "test"
        );
      });
    });
  });
});
