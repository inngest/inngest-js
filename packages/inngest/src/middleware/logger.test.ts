import { type MockInstance } from "vitest";
import { DefaultLogger, ProxyLogger, type Logger } from "./logger.ts";

describe("ProxyLogger", () => {
  const buffer = [
    { level: "info", args: ["hello", "%s!!", "world"] }, // string interpolation for some libs
    { level: "warn", args: ["do not recommend"] },
    { level: "error", args: [3, "things", "seems to have", "gone wrong"] },
  ];

  let _internal: Logger;
  let logger: ProxyLogger;

  beforeEach(() => {
    _internal = new DefaultLogger();
    logger = new ProxyLogger(_internal);
  });

  const populateBuf = () => {
    buffer.forEach(({ level, args }) => {
      const method = level as keyof ProxyLogger;

      logger[method](...args);
    });
  };

  describe("flush", () => {
    let timeout: MockInstance<typeof setTimeout>;

    beforeEach(() => {
      timeout = vi.spyOn(global, "setTimeout");
    });

    afterEach(() => {
      timeout.mockClear();
    });

    test("should not try to wait for flushing if _logger is DefaultLogger", async () => {
      populateBuf();
      await logger.flush();
      expect(timeout).toBeCalledTimes(0);
    });

    test("should attempt to wait for flushing with non DefaultLogger", async () => {
      _internal = new (class DummyLogger implements Logger {
        info(..._args: unknown[]) {}
        warn(..._args: unknown[]) {}
        error(..._args: unknown[]) {}
        debug(..._args: unknown[]) {}
      })();

      logger = new ProxyLogger(_internal);

      populateBuf();
      await logger.flush();
      expect(timeout).toBeCalledTimes(1);
    });
  });
});
