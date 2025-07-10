import { jest } from "@jest/globals";
import {
  DefaultLogger,
  ProxyLogger,
  type Logger,
} from "@local/middleware/logger";

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
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      logger[method](...args);
    });
  };

  describe("flush", () => {
    let timeout: jest.SpiedFunction<typeof setTimeout>;

    beforeEach(() => {
      timeout = jest.spyOn(global, "setTimeout");
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
      /* eslint-disable @typescript-eslint/no-empty-function, prettier/prettier */
      _internal = new (class DummyLogger implements Logger {
        info(..._args: unknown[]) {}
        warn(..._args: unknown[]) {}
        error(..._args: unknown[]) {}
        debug(..._args: unknown[]) {}
      })();
      /* eslint-enable */
      logger = new ProxyLogger(_internal);

      populateBuf();
      await logger.flush();
      expect(timeout).toBeCalledTimes(1);
    });
  });

  describe("arbitrary property/method access", () => {
    let internalLogger: Logger & {
      foo: jest.MockedFunction<() => string>;
      bar: string;
      customLog: jest.MockedFunction<(msg: string) => void>;
      anotherLogMethod: jest.MockedFunction<(msg: string) => void>;
    };

    beforeEach(() => {
      internalLogger = {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        foo: jest.fn(() => "custom result"),
        bar: "custom property",
        customLog: jest.fn(),
        anotherLogMethod: jest.fn(),
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
