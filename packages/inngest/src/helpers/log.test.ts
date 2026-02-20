// biome-ignore-all lint/suspicious/noExplicitAny: it's fine

const alsSymbol = Symbol.for("inngest:als");

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

describe("builtInMiddleware", () => {
  afterEach(() => {
    vi.resetModules();
    delete (globalThis as Record<string | symbol | number, unknown>)[alsSymbol];
  });

  // Flush behavior is tested in src/test/integration/logger.test.ts where
  // wrapRequest (the flush mechanism) is exercised through the full HTTP stack.

  test("forwards log calls to underlying logger during execution", async () => {
    const { Inngest } = await import("../index.ts");
    const { InngestTestEngine } = await import("@inngest/test");

    const customLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    const inngest = new Inngest({ id: "test", logger: customLogger });
    const fn = inngest.createFunction(
      { id: "test", triggers: [{ event: "" }] },
      ({ logger }) => {
        logger.info("hello");
        return "done";
      },
    );

    const t = new InngestTestEngine({ function: fn as any });
    await t.execute();

    expect(customLogger.info).toHaveBeenCalledWith("hello");
  });

  test("logs errors on function failure", async () => {
    const { Inngest } = await import("../index.ts");
    const { InngestTestEngine } = await import("@inngest/test");

    const customLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      flush: vi.fn(),
    };

    const inngest = new Inngest({ id: "test", logger: customLogger });
    const err = new Error("boom");
    const fn = inngest.createFunction(
      { id: "test", retries: 0, triggers: [{ event: "" }] },
      () => {
        throw err;
      },
    );

    const t = new InngestTestEngine({ function: fn as any });
    await t.execute();

    expect(customLogger.error).toHaveBeenCalledWith(err);
  });

  test("creates child logger when .child() is available", async () => {
    const { Inngest } = await import("../index.ts");
    const { InngestTestEngine } = await import("@inngest/test");

    const childLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    const customLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn().mockReturnValue(childLogger),
    };

    const inngest = new Inngest({ id: "test", logger: customLogger });
    const fn = inngest.createFunction(
      { id: "test", triggers: [{ event: "" }] },
      ({ logger }) => {
        logger.info("hello");
        return "done";
      },
    );

    const t = new InngestTestEngine({ function: fn as any });
    await t.execute();

    expect(customLogger.child).toHaveBeenCalledWith(
      expect.objectContaining({
        runID: expect.any(String),
        eventName: expect.any(String),
      }),
    );
    expect(childLogger.info).toHaveBeenCalledWith("hello");
    expect(customLogger.info).not.toHaveBeenCalledWith("hello");
  });

  test("creates a new logger per execution", async () => {
    const { Inngest } = await import("../index.ts");
    const { InngestTestEngine } = await import("@inngest/test");

    const customLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    const inngest = new Inngest({ id: "test", logger: customLogger });
    const loggers: unknown[] = [];
    const fn = inngest.createFunction(
      { id: "test", triggers: [{ event: "" }] },
      ({ logger }) => {
        loggers.push(logger);
        return "done";
      },
    );

    const t = new InngestTestEngine({ function: fn as any });
    await t.execute();
    await t.execute();

    expect(loggers).toHaveLength(2);
    expect(loggers[0]).not.toBe(loggers[1]);
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
