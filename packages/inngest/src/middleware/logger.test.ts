import type { Mock, MockInstance } from "vitest";
import { ConsoleLogger, type Logger, ProxyLogger } from "./logger.ts";

describe("ProxyLogger", () => {
  const buffer = [
    { level: "info", args: ["hello", "%s!!", "world"] }, // string interpolation for some libs
    { level: "warn", args: ["do not recommend"] },
    { level: "error", args: [3, "things", "seems to have", "gone wrong"] },
  ];

  let _internal: Logger;
  let logger: ProxyLogger;

  beforeEach(() => {
    _internal = new ConsoleLogger();
    logger = new ProxyLogger(_internal);
  });

  const populateBuf = () => {
    // biome-ignore lint/complexity/noForEach: intentional
    buffer.forEach(({ level, args }) => {
      const method = level as keyof ProxyLogger;

      logger[method](...args);
    });
  };

  describe("flush", () => {
    let immediate: MockInstance<typeof setTimeout>;

    beforeEach(() => {
      immediate = vi.spyOn(global, "setTimeout");
    });

    afterEach(() => {
      immediate.mockReset();
    });

    test("should not try to wait for flushing if _logger is ConsoleLogger", async () => {
      populateBuf();
      await logger.flush();
      expect(immediate).toHaveBeenCalledTimes(0);
    });

    test("should call flush on underlying logger if exposed by logger", async () => {
      const flushMock = vi.fn();

      _internal = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        flush: flushMock,
      } as Logger & { flush: () => void };

      logger = new ProxyLogger(_internal);

      populateBuf();
      await logger.flush();

      expect(flushMock).toHaveBeenCalledTimes(1);
      expect(immediate).toHaveBeenCalledTimes(0);
    });

    test("should attempt to yield event loop with non ConsoleLogger", async () => {
      _internal = new (class DummyLogger implements Logger {
        info(..._args: unknown[]) {}
        warn(..._args: unknown[]) {}
        error(..._args: unknown[]) {}
        debug(..._args: unknown[]) {}
      })();

      logger = new ProxyLogger(_internal);

      populateBuf();
      await logger.flush();
      expect(immediate).toHaveBeenCalledTimes(1);
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
        "custom result",
      );
      expect(internalLogger.foo).toHaveBeenCalledTimes(1);
    });

    test("should access custom properties on underlying logger", () => {
      expect((logger as unknown as Logger & { bar: string }).bar).toBe(
        "custom property",
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
        "disabled message",
      );

      expect(internalLogger.info).not.toHaveBeenCalled();

      logger.enable();
      (logger as unknown as Logger & { info: (msg: string) => void }).info(
        "enabled message",
      );

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
        "custom log message",
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

describe("ConsoleLogger Pino-style formatting", () => {
  // Pino-style is `logger.info({ err, ...fields }, message, ...rest)`

  let infoSpy: MockInstance;
  let errorSpy: MockInstance;

  beforeEach(() => {
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test("plain string call passes through unchanged", () => {
    const logger = new ConsoleLogger();
    logger.info("just a string");
    expect(infoSpy).toHaveBeenCalledWith("just a string");
  });

  test("single object arg passes through unchanged", () => {
    const logger = new ConsoleLogger();
    const obj = { key: "val" };
    logger.info(obj);
    expect(infoSpy).toHaveBeenCalledWith(obj);
  });

  test("object-first with message puts message first and drops metadata", () => {
    const logger = new ConsoleLogger();
    logger.info({ requestId: "abc" }, "Request received");
    expect(infoSpy).toHaveBeenCalledWith("Request received");
  });

  test("object-first with err field logs message and error separately", () => {
    const logger = new ConsoleLogger();
    const err = new Error("bad");
    logger.error({ err }, "Something broke");
    expect(errorSpy).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenNthCalledWith(1, "Something broke");
    expect(errorSpy).toHaveBeenNthCalledWith(2, err);
  });

  test("object-first with err and extra fields logs non-err fields separately", () => {
    const logger = new ConsoleLogger();
    const err = new Error("bad");
    logger.error({ err, requestId: "abc", code: 42 }, "Something broke");
    expect(errorSpy).toHaveBeenCalledTimes(3);
    expect(errorSpy).toHaveBeenNthCalledWith(1, "Something broke");
    expect(errorSpy).toHaveBeenNthCalledWith(2, err);
    expect(errorSpy).toHaveBeenNthCalledWith(3, { requestId: "abc", code: 42 });
  });

  test("object-first with err and rest args logs rest separately", () => {
    const logger = new ConsoleLogger();
    const err = new Error("bad");
    logger.error({ err }, "fail %s", "detail");
    expect(errorSpy).toHaveBeenCalledTimes(3);
    expect(errorSpy).toHaveBeenNthCalledWith(1, "fail %s");
    expect(errorSpy).toHaveBeenNthCalledWith(2, err);
    expect(errorSpy).toHaveBeenNthCalledWith(3, "detail");
  });

  test("object-first without error and extra args preserves fields and rest", () => {
    const logger = new ConsoleLogger();
    logger.info({ requestId: "abc" }, "hello %s", "world");
    expect(infoSpy).toHaveBeenCalledTimes(3);
    expect(infoSpy).toHaveBeenNthCalledWith(1, "hello %s");
    expect(infoSpy).toHaveBeenNthCalledWith(2, { requestId: "abc" });
    expect(infoSpy).toHaveBeenNthCalledWith(3, "world");
  });
});

describe("ConsoleLogger Winston-style passthrough", () => {
  // Winston-style is `logger.info("message", { fields }, ...rest)`. Our support
  // for it isn't as good as Pino-style, but that's OK since `ConsoleLogger` is
  // not for production use

  let infoSpy: MockInstance;
  let errorSpy: MockInstance;

  beforeEach(() => {
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test("string-first with metadata object passes through unchanged", () => {
    const logger = new ConsoleLogger();
    logger.info("Request received", { requestId: "abc" });
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith("Request received", {
      requestId: "abc",
    });
  });

  test("string-first with error object passes through unchanged", () => {
    const logger = new ConsoleLogger();
    const err = new Error("bad");
    logger.error("Something broke", { err });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith("Something broke", { err });
  });

  test("string-first with bare error passes through unchanged", () => {
    const logger = new ConsoleLogger();
    const err = new Error("bad");
    logger.error("Something broke", err);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith("Something broke", err);
  });
});

describe("ConsoleLogger log-level filtering", () => {
  test("should only output messages at or above the configured level", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const logger = new ConsoleLogger({ level: "warn" });

    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");

    expect(debugSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith("w");
    expect(errorSpy).toHaveBeenCalledWith("e");

    infoSpy.mockRestore();
    debugSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test("silent level suppresses all output", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const logger = new ConsoleLogger({ level: "silent" });

    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");

    expect(debugSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();

    infoSpy.mockRestore();
    debugSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test("defaults to info level", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    const logger = new ConsoleLogger();

    logger.debug("d");
    logger.info("i");

    expect(debugSpy).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith("i");

    infoSpy.mockRestore();
    debugSpy.mockRestore();
  });
});
