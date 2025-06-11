import type { Mock, MockInstance } from "vitest";
import { DefaultLogger, type Logger, ProxyLogger } from "./logger.ts";

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
    // biome-ignore lint/complexity/noForEach: <explanation>
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

  describe("arbitrary property/method access", () => {
    let internalLogger: Logger & {
      foo: Mock<() => string>;
      bar: string;
      customLog: Mock<(msg: string) => void>;
      anotherLogMethod: Mock<(msg: string) => void>;
    };

    beforeEach(() => {
      internalLogger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        foo: vi.fn(() => "custom result"),
        bar: "custom property",
        customLog: vi.fn(),
        anotherLogMethod: vi.fn(),
      };

      logger = new ProxyLogger(internalLogger);
    });

    test("should access custom methods on underlying logger", () => {
      expect((logger as unknown as Logger & { foo: () => string }).foo()).toBe(
        "custom result"
      );
      expect(internalLogger.foo).toHaveBeenCalledTimes(1);
    });

    test("should access custom properties on underlying logger", () => {
      expect((logger as unknown as Logger & { bar: string }).bar).toBe(
        "custom property"
      );
      expect(internalLogger.bar).toBe("custom property");
    });

    test("should call custom methods with correct arguments", () => {
      (
        logger as unknown as Logger & { customLog: (msg: string) => void }
      ).customLog("test message");

      expect(internalLogger.customLog).toHaveBeenCalledWith("test message");
    });

    test("should still respect enabled state for standard logging methods via proxy", () => {
      logger.disable();

      (logger as unknown as Logger & { info: (msg: string) => void }).info(
        "disabled message"
      );

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(internalLogger.info).not.toHaveBeenCalled();

      logger.enable();
      (logger as unknown as Logger & { info: (msg: string) => void }).info(
        "enabled message"
      );

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(internalLogger.info).toHaveBeenCalledWith("enabled message");
    });

    test("should call custom logging methods without enabled check", () => {
      logger.disable();

      (
        logger as unknown as Logger & {
          anotherLogMethod: (msg: string) => void;
        }
      ).anotherLogMethod("custom log message");

      expect(internalLogger.anotherLogMethod).toHaveBeenCalledWith(
        "custom log message"
      );
    });

    test("error calling a method that doesn't exist on the underlying logger", () => {
      expect(() => {
        (
          logger as unknown as Logger & {
            doesNotExist: () => string;
          }
        ).doesNotExist();
      }).toThrow();
    });
  });
});
