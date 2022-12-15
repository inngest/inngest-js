import nock from "nock";
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

  beforeEach(() => {
    /**
     * Ensure nock is active before each test. This is required after each
     * use of `nock.restore()`.
     *
     * See https://www.npmjs.com/package/nock#restoring
     */
    try {
      nock.activate();
    } catch {
      // no-op - will throw if Nock is already active
    }

    nock("https://inn.gs").post(`/e/${testEventKey}`).reply(200);
  });

  afterEach(() => {
    /**
     * Reset nock state after each test.
     *
     * See https://www.npmjs.com/package/nock#memory-issues-with-jest
     */
    nock.restore();
    nock.cleanAll();

    if (originalEnvEventKey) {
      process.env[envKeys.EventKey] = originalEnvEventKey;
    } else {
      delete process.env[envKeys.EventKey];
    }
  });

  test("should fail to send if event key not specified at instantiation", async () => {
    console.log("thisss");
    const inngest = new Inngest({ name: "test" });

    await expect(() => inngest.send(testEvent)).rejects.toThrowError(
      "Could not find an event key"
    );
  });

  test("should succeed if event key specified at instantiation", async () => {
    const inngest = new Inngest({ name: "test", eventKey: testEventKey });

    await expect(inngest.send(testEvent)).resolves.toBeUndefined();
  });

  test("should succeed if event key specified in env", async () => {
    process.env[envKeys.EventKey] = testEventKey;
    const inngest = new Inngest({ name: "test" });

    await expect(inngest.send(testEvent)).resolves.toBeUndefined();
  });

  test("should succeed if event key given at runtime", async () => {
    const inngest = new Inngest({ name: "test" });
    inngest.setEventKey(testEventKey);

    await expect(inngest.send(testEvent)).resolves.toBeUndefined();
  });
});
