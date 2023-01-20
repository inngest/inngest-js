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
