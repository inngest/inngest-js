const alsSymbol = Symbol.for("inngest:als");

/**
 * Helper to check if something looks like a DefaultLogger (duck typing).
 * We can't use instanceof because vi.resetModules() creates new class instances.
 */
const isDefaultLogger = (logger: unknown): boolean => {
  return (
    logger !== null &&
    typeof logger === "object" &&
    logger.constructor.name === "DefaultLogger"
  );
};

describe("formatLogMessage", () => {
  test("returns message only when no optional fields provided", async () => {
    const { formatLogMessage } = await import("./log.ts");

    const result = formatLogMessage({ message: "Something happened" });

    expect(result).toBe("Something happened");
  });

  test("includes explanation after message", async () => {
    const { formatLogMessage } = await import("./log.ts");

    const result = formatLogMessage({
      message: "Something happened",
      explanation: "The server was unavailable.",
    });

    expect(result).toBe("Something happened The server was unavailable.");
  });

  test("includes action with 'To fix:' prefix", async () => {
    const { formatLogMessage } = await import("./log.ts");

    const result = formatLogMessage({
      message: "Something happened",
      action: "Retry the request.",
    });

    expect(result).toBe("Something happened To fix: Retry the request.");
  });

  test("includes docs with 'See:' prefix", async () => {
    const { formatLogMessage } = await import("./log.ts");

    const result = formatLogMessage({
      message: "Something happened",
      docs: "https://example.com/docs",
    });

    expect(result).toBe("Something happened See: https://example.com/docs");
  });

  test("includes code in brackets at the end", async () => {
    const { formatLogMessage } = await import("./log.ts");

    const result = formatLogMessage({
      message: "Something happened",
      code: "SERVER_ERROR",
    });

    expect(result).toBe("Something happened [SERVER_ERROR]");
  });

  test("includes all fields in correct order", async () => {
    const { formatLogMessage } = await import("./log.ts");

    const result = formatLogMessage({
      message: "Something failed",
      explanation: "The server was unavailable.",
      action: "Retry the request.",
      docs: "https://example.com/docs",
      code: "SERVER_ERROR",
    });

    expect(result).toBe(
      "Something failed The server was unavailable. To fix: Retry the request. See: https://example.com/docs [SERVER_ERROR]",
    );
  });
});

describe("getLogger", () => {
  afterEach(() => {
    vi.resetModules();
    delete (globalThis as Record<string | symbol | number, unknown>)[alsSymbol];
  });

  test("returns DefaultLogger outside of execution context", async () => {
    const { getAsyncLocalStorage } = await import(
      "../components/execution/als.ts"
    );
    const { getLogger } = await import("./log.ts");

    await getAsyncLocalStorage();

    const logger = getLogger();

    expect(isDefaultLogger(logger)).toBe(true);
  });

  test("returns DefaultLogger before ALS is initialized", async () => {
    const { getLogger } = await import("./log.ts");

    const logger = getLogger();

    expect(isDefaultLogger(logger)).toBe(true);
  });

  test("returns global logger when set and outside execution context", async () => {
    const { getAsyncLocalStorage } = await import(
      "../components/execution/als.ts"
    );
    const { getLogger, setGlobalLogger } = await import("./log.ts");

    await getAsyncLocalStorage();

    const customLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    setGlobalLogger(customLogger);

    const logger = getLogger();

    expect(logger).toBe(customLogger);
  });

  test("prefers ctx.logger over global logger during execution", async () => {
    const { Inngest } = await import("../index.ts");
    const { InngestTestEngine } = await import("@inngest/test");
    const { getLogger, setGlobalLogger } = await import("./log.ts");

    const globalCustomLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    setGlobalLogger(globalCustomLogger);

    const inngest = new Inngest({ id: "test" });

    let loggerFromHelper: unknown;

    const fn = inngest.createFunction({ id: "test" }, { event: "" }, () => {
      loggerFromHelper = getLogger();
      return "done";
    });

    // biome-ignore lint/suspicious/noExplicitAny: intentional
    const t = new InngestTestEngine({ function: fn as any });
    await t.execute();

    expect(loggerFromHelper).not.toBe(globalCustomLogger);
    expect(isDefaultLogger(loggerFromHelper)).toBe(false);
  });

  test("returns ctx.logger during function execution", async () => {
    const { Inngest } = await import("../index.ts");
    const { InngestTestEngine } = await import("@inngest/test");
    const { getLogger } = await import("./log.ts");

    const inngest = new Inngest({ id: "test" });

    let loggerFromHelper: unknown;
    let loggerFromCtx: unknown;

    const fn = inngest.createFunction(
      { id: "test" },
      { event: "" },
      ({ logger }) => {
        loggerFromCtx = logger;
        loggerFromHelper = getLogger();
        return "done";
      },
    );

    // biome-ignore lint/suspicious/noExplicitAny: intentional
    const t = new InngestTestEngine({ function: fn as any });
    const { result } = await t.execute();

    expect(result).toBe("done");
    expect(loggerFromHelper).toBe(loggerFromCtx);
  });
});

describe("warnOnce", () => {
  afterEach(async () => {
    vi.resetModules();
  });

  test("logs the warning on the first call", async () => {
    const { warnOnce } = await import("./log.ts");

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    warnOnce(logger, "test-key", "something is deprecated");

    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith("something is deprecated");
  });

  test("does not log on subsequent calls with the same key", async () => {
    const { warnOnce } = await import("./log.ts");

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    warnOnce(logger, "test-key", "something is deprecated");
    warnOnce(logger, "test-key", "something is deprecated");
    warnOnce(logger, "test-key", "something is deprecated");

    expect(logger.warn).toHaveBeenCalledOnce();
  });

  test("logs separately for different keys", async () => {
    const { warnOnce } = await import("./log.ts");

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    warnOnce(logger, "key-a", "warning A");
    warnOnce(logger, "key-b", "warning B");

    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith("warning A");
    expect(logger.warn).toHaveBeenCalledWith("warning B");
  });

  test("passes multiple args to logger.warn", async () => {
    const { warnOnce } = await import("./log.ts");

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    warnOnce(logger, "test-key", "message", { extra: true });

    expect(logger.warn).toHaveBeenCalledWith("message", { extra: true });
  });

  test("resets state when module is re-imported", async () => {
    const { warnOnce } = await import("./log.ts");

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    warnOnce(logger, "test-key", "first");
    expect(logger.warn).toHaveBeenCalledOnce();

    // vi.resetModules() in afterEach gives us a fresh Set on next import
    vi.resetModules();
    const { warnOnce: freshWarnOnce } = await import("./log.ts");

    freshWarnOnce(logger, "test-key", "second");
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });
});
