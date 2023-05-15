import { LogBuffer, ProxyLogger, DefaultLogger } from "./logger";

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
  let logger: ProxyLogger;

  beforeEach(() => {
    logger = new ProxyLogger(new DefaultLogger());
  });

  describe("std API interfaces", () => {
    test("should have the expected number of buffered logs", () => {
      [
        { level: "info", args: ["hello", "%s!!", "world"] }, // string interpolation for some libs
        { level: "warn", args: ["do not recommend"] },
        { level: "error", args: [3, "things", "seems to have", "gone wrong"] },
      ].forEach(({ level, args }) => {
        const method = level as keyof ProxyLogger;
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        logger[method](...args);
      });

      expect(logger.bufSize()).toEqual(3);
    });
  });

  describe("reset", () => {
    test("should reset to buffer to zero", () => {
      [
        { level: "info", args: ["hello", "%s!!", "world"] }, // string interpolation for some libs
        { level: "warn", args: ["do not recommend"] },
        { level: "error", args: [3, "things", "seems to have", "gone wrong"] },
      ].forEach(({ level, args }) => {
        const method = level as keyof ProxyLogger;
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        logger[method](...args);
      });

      expect(logger.bufSize()).toEqual(3);

      logger.reset();

      expect(logger.bufSize()).toEqual(0);
    });
  });
});
