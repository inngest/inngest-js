import SuperJSON from "superjson";
import { describe, expect, expectTypeOf, test } from "vitest";
import {
  BaseSerializerMiddleware,
  SuperJsonMiddleware,
  superJsonMiddleware,
  isRecord,
} from "./index";
import type { Preserved } from "./index";

const stubClient = {} as ConstructorParameters<
  typeof SuperJsonMiddleware
>[0]["client"];

/**
 * Serialize a value, push it through JSON.stringify → JSON.parse to simulate
 * Inngest's wire transport, then deserialize back.
 */
// biome-ignore lint/suspicious/noExplicitAny: test helper
function roundTrip(mw: any, value: unknown): any {
  const serialized = simulateSerialize(mw, value);
  const transported = JSON.parse(JSON.stringify(serialized));
  return simulateDeserialize(mw, transported);
}

test("Date round-trips through JSON transport", () => {
  const mw = new SuperJsonMiddleware({ client: stubClient });
  const input = { createdAt: new Date("2024-06-15T12:00:00.000Z"), name: "test" };

  const result = roundTrip(mw, input);

  expect(result.createdAt).toBeInstanceOf(Date);
  expect(result.createdAt.toISOString()).toBe("2024-06-15T12:00:00.000Z");
  expect(result.name).toBe("test");
});

test("RegExp round-trips through JSON transport", () => {
  const mw = new SuperJsonMiddleware({ client: stubClient });
  const input = { pattern: /hello\s+world/gi, label: "greeting" };

  const result = roundTrip(mw, input);

  expect(result.pattern).toBeInstanceOf(RegExp);
  expect(result.pattern.source).toBe("hello\\s+world");
  expect(result.pattern.flags).toBe("gi");
});

test("BigInt round-trips through JSON transport", () => {
  const mw = new SuperJsonMiddleware({ client: stubClient });

  const result = roundTrip(mw, { n: BigInt("99999999999999999") });

  expect(result.n).toBe(BigInt("99999999999999999"));
});

test("Map round-trips through JSON transport", () => {
  const mw = new SuperJsonMiddleware({ client: stubClient });
  const input = {
    config: new Map([
      ["timeout", 5000],
      ["retries", 3],
    ]),
  };

  const result = roundTrip(mw, input);

  expect(result.config).toBeInstanceOf(Map);
  expect(result.config.get("timeout")).toBe(5000);
  expect(result.config.get("retries")).toBe(3);
});

test("Set round-trips through JSON transport", () => {
  const mw = new SuperJsonMiddleware({ client: stubClient });
  const input = { tags: new Set(["a", "b", "c"]) };

  const result = roundTrip(mw, input);

  expect(result.tags).toBeInstanceOf(Set);
  expect(result.tags.size).toBe(3);
  expect(result.tags.has("b")).toBe(true);
});

test("undefined values round-trip through JSON transport", () => {
  const mw = new SuperJsonMiddleware({ client: stubClient });
  const input = { present: "yes", missing: undefined };

  const result = roundTrip(mw, input);

  expect(result.present).toBe("yes");
  expect(result.missing).toBeUndefined();
  expect("missing" in result).toBe(true);
});

test("nested objects with mixed types round-trip through JSON transport", () => {
  const mw = new SuperJsonMiddleware({ client: stubClient });
  const input = {
    user: {
      name: "Alice",
      signedUp: new Date("2024-01-01"),
      preferences: {
        pattern: /test/i,
        ids: new Set([1, 2, 3]),
      },
    },
  };

  const result = roundTrip(mw, input);

  expect(result.user.name).toBe("Alice");
  expect(result.user.signedUp).toBeInstanceOf(Date);
  expect(result.user.preferences.pattern).toBeInstanceOf(RegExp);
  expect(result.user.preferences.ids).toBeInstanceOf(Set);
  expect(result.user.preferences.ids.size).toBe(3);
});

test("arrays with special types round-trip through JSON transport", () => {
  const mw = new SuperJsonMiddleware({ client: stubClient });
  const input = { dates: [new Date("2024-01-01"), new Date("2024-06-01")] };

  const result = roundTrip(mw, input);

  expect(result.dates).toHaveLength(2);
  expect(result.dates[0]).toBeInstanceOf(Date);
  expect(result.dates[1]).toBeInstanceOf(Date);
});

test("plain JSON values round-trip unchanged", () => {
  const mw = new SuperJsonMiddleware({ client: stubClient });
  const input = { name: "test", count: 42, active: true, tags: ["a", "b"] };

  expect(roundTrip(mw, input)).toEqual(input);
});

test("serialized output has the envelope marker", () => {
  const mw = new SuperJsonMiddleware({ client: stubClient });
  const serialized = simulateSerialize(mw, { date: new Date() });

  expect(serialized).toHaveProperty("__inngestSuperJson", true);
  expect(serialized).toHaveProperty("json");
  expect(serialized).toHaveProperty("meta");
});

test("null and undefined are not wrapped in an envelope", () => {
  const mw = new SuperJsonMiddleware({ client: stubClient });

  // biome-ignore lint/suspicious/noExplicitAny: test helper
  expect((mw as any).needsSerialize(null)).toBe(false);
  // biome-ignore lint/suspicious/noExplicitAny: test helper
  expect((mw as any).needsSerialize(undefined)).toBe(false);
});

test("non-envelope values pass through deserialization unchanged", () => {
  const mw = new SuperJsonMiddleware({ client: stubClient });
  const plain = { name: "not an envelope" };

  // Simulate receiving data that was never serialized by our middleware
  const result = simulateDeserialize(mw, plain);

  expect(result).toEqual(plain);
});

test("custom types via subclass round-trip through JSON transport", () => {
  class CustomValue {
    constructor(public readonly data: string) {}
  }

  class CustomSuperJson extends SuperJsonMiddleware {
    protected override sj = (() => {
      const sj = new SuperJSON();
      sj.registerCustom<CustomValue, string>(
        {
          isApplicable: (v): v is CustomValue => v instanceof CustomValue,
          serialize: (v: CustomValue) => v.data,
          deserialize: (v: string) => new CustomValue(v),
        },
        "CustomValue",
      );
      return sj;
    })();
  }

  const mw = new CustomSuperJson({ client: stubClient });
  const input = { custom: new CustomValue("hello"), created: new Date("2024-01-01") };

  const result = roundTrip(mw, input);

  expect(result.custom).toBeInstanceOf(CustomValue);
  expect(result.custom.data).toBe("hello");
  expect(result.created).toBeInstanceOf(Date);
});

test("superJsonMiddleware factory produces working middleware", () => {
  const Cls = superJsonMiddleware();
  const mw = new Cls({ client: stubClient });

  expect(mw.id).toBe("@inngest/middleware-super-json");

  const result = roundTrip(mw, { date: new Date("2024-01-01") });

  expect(result.date).toBeInstanceOf(Date);
});

test("superJsonMiddleware factory accepts a custom SuperJSON instance", () => {
  class CustomValue {
    constructor(public readonly n: number) {}
  }

  const sj = new SuperJSON();
  sj.registerCustom<CustomValue, number>(
    {
      isApplicable: (v): v is CustomValue => v instanceof CustomValue,
      serialize: (v: CustomValue) => v.n,
      deserialize: (v: number) => new CustomValue(v),
    },
    "CustomValue",
  );

  const Cls = superJsonMiddleware({ instance: sj });
  const mw = new Cls({ client: stubClient });

  const result = roundTrip(mw, { value: new CustomValue(42) });

  expect(result.value).toBeInstanceOf(CustomValue);
  expect(result.value.n).toBe(42);
});

test("BaseSerializerMiddleware is exported", () => {
  expect(typeof BaseSerializerMiddleware).toBe("function");
});

test("isRecord identifies plain objects", () => {
  expect(isRecord({})).toBe(true);
  expect(isRecord({ a: 1 })).toBe(true);
  expect(isRecord(null)).toBe(false);
  expect(isRecord([])).toBe(false);
  expect(isRecord(42)).toBe(false);
});

describe("Preserved type", () => {
  test("preserves Date and RegExp", () => {
    expectTypeOf<
      Preserved<{ createdAt: Date; pattern: RegExp; name: string }>
    >().toEqualTypeOf<{ createdAt: Date; pattern: RegExp; name: string }>();
  });

  test("preserves Map and Set", () => {
    expectTypeOf<
      Preserved<{ config: Map<string, number>; tags: Set<string> }>
    >().toEqualTypeOf<{ config: Map<string, number>; tags: Set<string> }>();
  });

  test("preserves nested types", () => {
    expectTypeOf<
      Preserved<{ user: { signedUp: Date }; patterns: RegExp[] }>
    >().toEqualTypeOf<{ user: { signedUp: Date }; patterns: RegExp[] }>();
  });

  test("strips functions", () => {
    expectTypeOf<Preserved<() => void>>().toEqualTypeOf<never>();
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: test helper
function simulateSerialize(mw: any, value: unknown): unknown {
  const result = mw.transformSendEvent({
    events: [{ name: "test", data: value as Record<string, unknown> }],
    fn: null,
  });
  return (result as { events: Array<{ data: unknown }> }).events[0].data;
}

// biome-ignore lint/suspicious/noExplicitAny: test helper
function simulateDeserialize(mw: any, value: unknown): unknown {
  const result = mw.transformFunctionInput({
    ctx: {
      event: { name: "test", data: value as Record<string, unknown> },
      events: [{ name: "test", data: value as Record<string, unknown> }],
    },
    fn: {} as never,
    steps: {},
  });
  return (result as { ctx: { event: { data: unknown } } }).ctx.event.data;
}
