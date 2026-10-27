/**
 * @module
 * Tests for the config resolver: values and functions, eager fields in
 * parallel, lazy fields on first use, and failures.
 */
import { describe, expect, expectTypeOf, test, vi } from "vitest";
import {
  ConfigResolveError,
  type ConfigValue,
  createConfigResolver,
  resolveConfigValue,
} from "./config.ts";

describe("resolveConfigValue", () => {
  test("passes a value through", async () => {
    expect(await resolveConfigValue("C1", {})).toBe("C1");
  });

  test("calls a sync function with the context", async () => {
    const value: ConfigValue<string, { team: string }> = (ctx) => {
      return `#${ctx.team}`;
    };

    expect(await resolveConfigValue(value, { team: "eng" })).toBe("#eng");
  });

  test("awaits an async function", async () => {
    expect(
      await resolveConfigValue(async () => {
        return 7;
      }, {}),
    ).toBe(7);
  });
});

describe("createConfigResolver", () => {
  const deferred = () => {
    let resolve: (value: string) => void = () => {};
    const promise = new Promise<string>((res) => {
      resolve = res;
    });

    return { promise, resolve };
  };

  test("resolves eager fields in parallel", async () => {
    const a = deferred();
    const b = deferred();
    const started: string[] = [];
    const resolver = createConfigResolver({
      config: {
        a: () => {
          started.push("a");

          return a.promise;
        },
        b: () => {
          started.push("b");

          return b.promise;
        },
      },
      ctx: {},
      modes: { a: "eager", b: "eager" },
    });
    const ready = resolver.ready();

    await Promise.resolve();
    expect(started).toEqual(["a", "b"]);

    a.resolve("A");
    b.resolve("B");
    expect(await ready).toEqual({ a: "A", b: "B" });
  });

  test("calls a lazy field on first get only, once", async () => {
    const channel = vi.fn(() => {
      return "slack";
    });
    const resolver = createConfigResolver({
      config: { model: "m", channel },
      ctx: {},
      modes: { model: "eager", channel: "lazy" },
    });

    await resolver.ready();
    expect(channel).not.toHaveBeenCalled();

    expect(await resolver.get("channel")).toBe("slack");
    expect(await resolver.get("channel")).toBe("slack");
    expect(channel).toHaveBeenCalledTimes(1);
  });

  test("ready leaves lazy fields out and shares work with get", async () => {
    const model = vi.fn(() => {
      return "m";
    });
    const resolver = createConfigResolver({
      config: { model, channel: "C1" },
      ctx: {},
      modes: { model: "eager", channel: "lazy" },
    });

    expect(await resolver.get("model")).toBe("m");
    expect(await resolver.ready()).toEqual({ model: "m" });
    expect(await resolver.ready()).toEqual({ model: "m" });
    expect(model).toHaveBeenCalledTimes(1);
  });

  test("passes the context to every function", async () => {
    const resolver = createConfigResolver({
      config: {
        channel: (ctx: { event: { data: { team: string } } }) => {
          return ctx.event.data.team;
        },
      },
      ctx: { event: { data: { team: "ops" } } },
      modes: { channel: "lazy" },
    });

    expect(await resolver.get("channel")).toBe("ops");
  });

  test("leaves undefined fields alone", async () => {
    const resolver = createConfigResolver({
      config: { limits: undefined as { turns: number } | undefined },
      ctx: {},
      modes: { limits: "eager" },
    });

    expect(await resolver.ready()).toEqual({ limits: undefined });
  });

  test("a failing eager field rejects ready with its name", async () => {
    const cause = new Error("no such team");
    const resolver = createConfigResolver({
      config: {
        channel: () => {
          throw cause;
        },
      },
      ctx: {},
      modes: { channel: "eager" },
    });
    const err = await resolver.ready().catch((e: unknown) => {
      return e;
    });

    expect(err).toBeInstanceOf(ConfigResolveError);
    expect((err as ConfigResolveError).field).toBe("channel");
    expect((err as ConfigResolveError).message).toContain("no such team");
    expect((err as ConfigResolveError).cause).toBe(cause);
  });

  test("a failing lazy field that is never read never surfaces", async () => {
    const resolver = createConfigResolver({
      config: {
        model: "m",
        channel: () => {
          throw new Error("boom");
        },
      },
      ctx: {},
      modes: { model: "eager", channel: "lazy" },
    });

    expect(await resolver.ready()).toEqual({ model: "m" });
  });

  test("a new resolver runs the functions again, as a replay does", async () => {
    const channel = vi.fn(() => {
      return "C1";
    });
    const make = () => {
      return createConfigResolver({
        config: { channel },
        ctx: {},
        modes: { channel: "lazy" },
      });
    };

    await make().get("channel");
    await make().get("channel");
    expect(channel).toHaveBeenCalledTimes(2);
  });

  test("types: values and functions resolve to plain values", () => {
    const resolver = createConfigResolver({
      config: {
        model: "m" as ConfigValue<string, { n: number }>,
        turns: async (ctx: { n: number }) => {
          return ctx.n;
        },
      },
      ctx: { n: 1 },
      modes: { model: "eager", turns: "lazy" },
    });

    expectTypeOf(resolver.get("model")).toEqualTypeOf<Promise<string>>();
    expectTypeOf(resolver.get("turns")).toEqualTypeOf<Promise<number>>();
    expectTypeOf(resolver.ready()).toEqualTypeOf<Promise<{ model: string }>>();
  });
});
