import { InngestTestEngine } from "@inngest/test";
import type { AsyncContext } from "./als.ts";

const alsSymbol = Symbol.for("inngest:als");

describe("getAsyncLocalStorage", () => {
  afterEach(() => {
    // kill the global used for storing ALS state
    delete (globalThis as Record<string | symbol | number, unknown>)[alsSymbol];
  });

  test("should return an `AsyncLocalStorageIsh`", async () => {
    const mod = await import("./als.ts");
    const als = await mod.getAsyncLocalStorage();

    expect(als).toBeDefined();
    expect(als.getStore).toBeDefined();
    expect(als.run).toBeDefined();
  });

  test("should return the same instance of `AsyncLocalStorageIsh`", async () => {
    const mod = await import("./als.ts");

    const als1p = mod.getAsyncLocalStorage();
    const als2p = mod.getAsyncLocalStorage();

    const als1 = await als1p;
    const als2 = await als2p;

    expect(als1).toBe(als2);
  });
});

describe("getAsyncCtx", () => {
  const wait = async () => {
    await new Promise((resolve) => setTimeout(resolve));
    await new Promise((resolve) => process.nextTick(resolve));
  };

  afterEach(() => {
    vi.unmock("node:async_hooks");
    vi.resetModules();

    // kill the global used for storing ALS state
    delete (globalThis as Record<string | symbol | number, unknown>)[alsSymbol];
  });

  test("should return `undefined` outside of an Inngest async context", async () => {
    const mod = await import("./als.ts");
    const store = await mod.getAsyncCtx();

    expect(store).toBeUndefined();
  });

  test("should return the input context during execution", async () => {
    const { Inngest } = await import("../../index.ts");
    const mod = await import("../../experimental.ts");

    const inngest = new Inngest({ id: "test" });

    // biome-ignore lint/suspicious/noExplicitAny: intentional
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
      },
    );

    // biome-ignore lint/suspicious/noExplicitAny: intentional
    const t = new InngestTestEngine({ function: fn as any });

    const { result } = await t.execute();

    expect(result).toBe("done");
    expect(internalRunId).toBeTruthy();

    const store = await externalP;
    expect(store).toBeDefined();
    expect(store?.execution?.ctx.runId).toBe(internalRunId);
  });
});

describe("getAsyncCtxSync", () => {
  afterEach(() => {
    vi.resetModules();

    // kill the global used for storing ALS state
    delete (globalThis as Record<string | symbol | number, unknown>)[alsSymbol];
  });

  test("should return `undefined` before ALS is initialized", async () => {
    const mod = await import("./als.ts");

    // Call sync version before any async initialization
    const store = mod.getAsyncCtxSync();

    expect(store).toBeUndefined();
  });

  test("should return `undefined` outside of an Inngest async context", async () => {
    const mod = await import("./als.ts");

    // Initialize ALS first
    await mod.getAsyncLocalStorage();

    // Now sync access should work, but return undefined (no active context)
    const store = mod.getAsyncCtxSync();

    expect(store).toBeUndefined();
  });

  test("should return the context during execution", async () => {
    const { Inngest } = await import("../../index.ts");
    const mod = await import("./als.ts");

    const inngest = new Inngest({ id: "test" });

    let syncContext: ReturnType<typeof mod.getAsyncCtxSync>;
    let internalRunId: string | undefined;

    const fn = inngest.createFunction(
      { id: "test" },
      { event: "" },
      ({ runId }) => {
        internalRunId = runId;
        // Synchronous access to context
        syncContext = mod.getAsyncCtxSync();
        return "done";
      },
    );

    // biome-ignore lint/suspicious/noExplicitAny: intentional
    const t = new InngestTestEngine({ function: fn as any });
    const { result } = await t.execute();

    expect(result).toBe("done");
    expect(internalRunId).toBeTruthy();
    expect(syncContext).toBeDefined();
    expect(syncContext?.execution?.ctx.runId).toBe(internalRunId);
  });
});
