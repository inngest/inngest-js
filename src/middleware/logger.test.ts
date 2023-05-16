import { jest } from "@jest/globals";
import { type Logger, LogBuffer, ProxyLogger, DefaultLogger } from "./logger";

describe("LogBuffer", () => {
  describe("initialize", () => {
    test("should store the provided values", () => {
      const level = "info";
      const args = ["hello", "%s!!", "world"];
      const buf = new LogBuffer(level, ...args);

      expect(buf.level).toEqual("info");
      expect(buf.args).toEqual(args);
    });
  });
});

describe("ProxyLogger", () => {
  const buffer = [
    { level: "info", args: ["hello", "%s!!", "world"] }, // string interpolation for some libs
    { level: "warn", args: ["do not recommend"] },
    { level: "error", args: [3, "things", "seems to have", "gone wrong"] },
  ];

  const info = jest.spyOn(console, "info").mockImplementation(() => { });
  const warn = jest.spyOn(console, "warn").mockImplementation(() => { });
  const error = jest.spyOn(console, "error").mockImplementation(() => { });

  let _internal: Logger;
  let logger: ProxyLogger;

  beforeEach(() => {
    _internal = new DefaultLogger()
    logger = new ProxyLogger(_internal);
  });

  const populateBuf = () => {
    buffer.forEach(({ level, args }) => {
      const method = level as keyof ProxyLogger;
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      logger[method](...args);
    });
  }

  describe("std API interfaces", () => {
    test("should have the expected number of buffered logs", () => {
      populateBuf();
      expect(logger.bufSize()).toEqual(3);
    });
  });

  describe("reset", () => {
    test("should reset to buffer to zero", () => {
      populateBuf();
      expect(logger.bufSize()).toEqual(3);

      logger.reset();
      expect(logger.bufSize()).toEqual(0);
    });
  });

  describe("flush", () => {
    let reset: jest.SpiedFunction<() => void>;
    let timeout: jest.SpiedFunction<typeof setTimeout>;

    beforeEach(() => {
      reset = jest
        .spyOn(ProxyLogger.prototype, "reset")
        .mockImplementation(() => { });

      timeout = jest.spyOn(global, 'setTimeout');
    });

    afterEach(() => {
      reset.mockClear();
      timeout.mockClear();
    });

    test("don't do anything with an empty buffer", async () => {
      await logger.flush();
      expect(reset).toBeCalledTimes(0);
    });

    test("should attempt to reset buffer", async () => {
      populateBuf();
      await logger.flush();
      expect(reset).toBeCalledTimes(1);
    });

    test("should not try to wait for flushing if _logger is DefaultLogger", async () => {
      populateBuf();
      await logger.flush();
      expect(reset).toBeCalledTimes(1);
      expect(timeout).toBeCalledTimes(0);
    });

    test("should attempt to wait for flushing with non DefaultLogger", async () => {
      _internal = new (
        class DummyLogger implements Logger {
          info(...args: unknown[]) { }
          warn(...args: unknown[]) { }
          error(...args: unknown[]) { }
          debug(...args: unknown[]) { }
        }
      );
      logger = new ProxyLogger(_internal);

      populateBuf();
      await logger.flush();
      expect(reset).toBeCalledTimes(1);
      expect(timeout).toBeCalledTimes(1);
    });
  })
});
