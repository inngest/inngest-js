import { InngestTestEngine } from "@inngest/test";
import type { AsyncContext } from "./als.ts";

vi.mock("node:async_hooks", () => {
  throw new Error("import failed");
});

describe("getAsyncLocalStorage", () => {
  afterEach(() => {
    vi.resetModules();

    // kill the global used for storing ALS state
    delete (globalThis as Record<string | symbol | number, unknown>)[
      Symbol.for("inngest:als")
    ];
  });

  test("should return `undefined` if node:async_hooks is not supported", async () => {
    const consoleWarnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => {});

    const mod = await import("./als.ts");
    const als = await mod.getAsyncLocalStorage();

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "node:async_hooks is not supported in this runtime",
      ),
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
    vi.resetModules();

    // kill the global used for storing ALS state
    delete (globalThis as Record<string | symbol | number, unknown>)[
      Symbol.for("inngest:als")
    ];
  });

  test("should return `undefined` if node:async_hooks is not supported", async () => {
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
    expect(store).toBeUndefined();
  });
});
