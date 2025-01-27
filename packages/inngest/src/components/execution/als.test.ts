import { InngestTestEngine } from "@inngest/test";
import { type AsyncContext } from "@local/components/execution/als";

describe("getAsyncLocalStorage", () => {
  const warningSpy = jest.spyOn(console, "warn");

  afterEach(() => {
    jest.unmock("node:async_hooks");
    jest.resetModules();

    // kill the global used for storing ALS state
    delete (globalThis as Record<string | symbol | number, unknown>)[
      Symbol.for("inngest:als")
    ];
  });

  test("should return an `AsyncLocalStorageIsh`", async () => {
    const mod = await import("@local/components/execution/als");
    const als = await mod.getAsyncLocalStorage();

    expect(als).toBeDefined();
    expect(als.getStore).toBeDefined();
    expect(als.run).toBeDefined();
  });

  test("should return the same instance of `AsyncLocalStorageIsh`", async () => {
    const mod = await import("@local/components/execution/als");

    const als1p = mod.getAsyncLocalStorage();
    const als2p = mod.getAsyncLocalStorage();

    const als1 = await als1p;
    const als2 = await als2p;

    expect(als1).toBe(als2);
  });

  test("should return `undefined` if node:async_hooks is not supported", async () => {
    jest.mock("node:async_hooks", () => {
      throw new Error("import failed");
    });

    const mod = await import("@local/components/execution/als");
    const als = await mod.getAsyncLocalStorage();

    expect(warningSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "node:async_hooks is not supported in this runtime"
      )
    );

    expect(als).toBeDefined();
    expect(als.getStore()).toBeUndefined();
    expect(als.run).toBeDefined();
  });
});

describe("getAsyncCtx", () => {
  const wait = async () => {
    await new Promise((resolve) => setTimeout(resolve));
    await new Promise((resolve) => process.nextTick(resolve));
  };

  afterEach(() => {
    jest.unmock("node:async_hooks");
    jest.resetModules();

    // kill the global used for storing ALS state
    delete (globalThis as Record<string | symbol | number, unknown>)[
      Symbol.for("inngest:als")
    ];
  });

  test("should return `undefined` outside of an Inngest async context", async () => {
    const mod = await import("@local/components/execution/als");
    const store = await mod.getAsyncCtx();

    expect(store).toBeUndefined();
  });

  test("should return the input context during execution", async () => {
    const { Inngest } = await import("@local");
    const mod = await import("@local/experimental");

    const inngest = new Inngest({ id: "test" });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resolve: (value: any) => void | PromiseLike<void>;
    const externalP = new Promise<AsyncContext | undefined>((r) => {
      resolve = r;
    });

    let internalRunId: string | undefined;

    const fn = inngest.createFunction(
      { id: "test" },
      { event: "" },
      ({ runId }) => {
        internalRunId = runId;

        void wait()
          .then(() => mod.getAsyncCtx())
          .then(resolve);

        return "done";
      }
    );

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
    const t = new InngestTestEngine({ function: fn as any });

    const { result } = await t.execute();

    expect(result).toBe("done");
    expect(internalRunId).toBeTruthy();

    const store = await externalP;
    expect(store).toBeDefined();
    expect(store?.ctx.runId).toBe(internalRunId);
  });

  test("should return `undefined` if node:async_hooks is not supported", async () => {
    jest.mock("node:async_hooks", () => {
      throw new Error("import failed");
    });

    const { Inngest } = await import("@local");
    const mod = await import("@local/experimental");

    const inngest = new Inngest({ id: "test" });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resolve: (value: any) => void | PromiseLike<void>;
    const externalP = new Promise<AsyncContext | undefined>((r) => {
      resolve = r;
    });

    let internalRunId: string | undefined;

    const fn = inngest.createFunction(
      { id: "test" },
      { event: "" },
      ({ runId }) => {
        internalRunId = runId;

        void wait()
          .then(() => mod.getAsyncCtx())
          .then(resolve);

        return "done";
      }
    );

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
    const t = new InngestTestEngine({ function: fn as any });

    const { result } = await t.execute();

    expect(result).toBe("done");
    expect(internalRunId).toBeTruthy();

    const store = await externalP;
    expect(store).toBeUndefined();
  });
});
