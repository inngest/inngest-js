import { describe, expect, test } from "vitest";
import type { EventMeta } from "../types.ts";
import {
  compareUtf8,
  normalizeEventMeta,
  normalizeManualSessions,
  normalizePropagatedSessions,
  reduceEventsToPropagatedSessions,
  stampPropagatedSessions,
  stampPropagatedSessionsOnEvent,
} from "./sessions.ts";

/** Build a triggering event carrying the given session map. */
const evt = (sessions?: Record<string, string>) => ({ meta: { sessions } });

describe("reduceEventsToPropagatedSessions", () => {
  test("single event, single session passes through", () => {
    expect(reduceEventsToPropagatedSessions([evt({ a: "1" })])).toEqual({
      a: "1",
    });
  });

  test("no events / no sessions yields an empty map (no-run safety)", () => {
    expect(reduceEventsToPropagatedSessions([])).toEqual({});
    expect(reduceEventsToPropagatedSessions([evt(undefined)])).toEqual({});
    expect(reduceEventsToPropagatedSessions([evt({})])).toEqual({});
    expect(reduceEventsToPropagatedSessions([{ meta: null }])).toEqual({});
  });

  test("a key with conflicting ids across the batch is dropped entirely", () => {
    expect(
      reduceEventsToPropagatedSessions([evt({ a: "1" }), evt({ a: "2" })]),
    ).toEqual({});
  });

  test("batch keeps only the (key,id) pairs every event shares", () => {
    expect(
      reduceEventsToPropagatedSessions([
        evt({ a: "1", b: "9" }),
        evt({ a: "1", c: "9" }),
      ]),
    ).toEqual({ a: "1" });
  });

  test("a key held by most of the batch still needs every event", () => {
    expect(
      reduceEventsToPropagatedSessions([
        evt({ a: "1" }),
        evt({ a: "1" }),
        evt({ b: "2" }),
      ]),
    ).toEqual({});
  });

  test("an event with no sessions empties the intersection, either side", () => {
    // Leading empty seeds an empty intersection; trailing empty narrows a
    // non-empty one to nothing. Both paths must agree.
    expect(
      reduceEventsToPropagatedSessions([evt({ a: "1" }), evt(undefined)]),
    ).toEqual({});
    expect(
      reduceEventsToPropagatedSessions([evt(undefined), evt({ a: "1" })]),
    ).toEqual({});
  });

  test("numeric and string ids for a key canonicalize equal (no false conflict)", () => {
    // Guards the String() coercion: {a:1} and {a:"1"} match, not conflict.
    // The numeric id is a deliberate type violation, hence the cast.
    const numericEvt = {
      meta: { sessions: { a: 1 } },
    } as unknown as ReturnType<typeof evt>;
    expect(
      reduceEventsToPropagatedSessions([numericEvt, evt({ a: "1" })]),
    ).toEqual({
      a: "1",
    });
  });

  test("more than five keys truncate to the first five by key", () => {
    const events = [evt({ a: "1", b: "1", c: "1", d: "1", e: "1", f: "1" })];
    expect(reduceEventsToPropagatedSessions(events)).toEqual({
      a: "1",
      b: "1",
      c: "1",
      d: "1",
      e: "1",
    });
  });

  test("intersection happens BEFORE truncation", () => {
    // Six keys a..f on both events; `a` conflicts and is dropped, leaving
    // exactly b..f (5). If truncation ran first we would keep a..e, then drop
    // conflicting a, yielding only b..e (4) — this pins the ordering.
    const events = [
      evt({ a: "1", b: "1", c: "1", d: "1", e: "1", f: "1" }),
      evt({ a: "2", b: "1", c: "1", d: "1", e: "1", f: "1" }),
    ];
    expect(reduceEventsToPropagatedSessions(events)).toEqual({
      b: "1",
      c: "1",
      d: "1",
      e: "1",
      f: "1",
    });
  });

  test("truncation uses UTF-8 byte order, not UTF-16 code-unit order", () => {
    // Byte order of the first byte: digits 0x31.. < U+FFFF (0xEF..) < 😀 (0xF0..).
    // So the ≤5 cut keeps "￿" and drops "😀".
    // UTF-16 code-unit order would rank 😀 (lead surrogate 0xD83D) *before*
    // "￿", keeping 😀 and dropping "￿" — the opposite survivor.
    const events = [
      evt({
        "1": "x",
        "2": "x",
        "3": "x",
        "4": "x",
        "￿": "x",
        "\u{1F600}": "x",
      }),
    ];
    const got = reduceEventsToPropagatedSessions(events);
    expect(Object.keys(got).sort()).toEqual(["1", "2", "3", "4", "￿"]);
    expect(got).not.toHaveProperty("\u{1F600}");
  });

  test("__proto__ is collected as an own property, not the prototype", () => {
    // Received events are JSON-parsed, which makes __proto__ an own property
    // (unlike an object literal, which would invoke the prototype setter).
    const sessions = JSON.parse('{"__proto__":"1"}') as Record<string, string>;
    const got = reduceEventsToPropagatedSessions([{ meta: { sessions } }]);
    expect(Object.hasOwn(got, "__proto__")).toBe(true);
    expect(got["__proto__"]).toBe("1");
  });
});

describe("compareUtf8", () => {
  test("equal strings compare equal", () => {
    expect(compareUtf8("abc", "abc")).toBe(0);
  });

  test("orders ASCII by byte value", () => {
    expect(compareUtf8("a", "b")).toBeLessThan(0);
    // Uppercase 'Z' (0x5A) sorts before lowercase 'a' (0x61).
    expect(compareUtf8("Z", "a")).toBeLessThan(0);
  });

  test("a prefix sorts before its extension", () => {
    expect(compareUtf8("a", "ab")).toBeLessThan(0);
    expect(compareUtf8("ab", "a")).toBeGreaterThan(0);
  });

  test("multi-byte characters sort after ASCII", () => {
    // 'z' is 0x7A; 'é' begins 0xC3.
    expect(compareUtf8("z", "é")).toBeLessThan(0);
  });

  test("astral char ordering matches UTF-8 bytes, not UTF-16 code units", () => {
    // U+FFFF encodes to 0xEF..; U+1F600 (😀) encodes to 0xF0.. → "￿" first.
    expect(compareUtf8("￿", "\u{1F600}")).toBeLessThan(0);
    // Sanity: JS's native UTF-16 comparison disagrees (proves we diverge from it).
    expect("￿" < "\u{1F600}").toBe(false);
  });
});

describe("normalizePropagatedSessions", () => {
  test("normalizes string/number ids, absent when empty", () => {
    expect(normalizePropagatedSessions({ a: "1", b: 2 })).toEqual({
      a: "1",
      b: "2",
    });
    expect(normalizePropagatedSessions(undefined)).toBeUndefined();
    expect(normalizePropagatedSessions({})).toBeUndefined();
  });

  test("rejects a per-key null, since the layer carries no tombstones", () => {
    expect(() =>
      // @ts-expect-error the type forbids tombstones here; this guards the
      // runtime path against JS callers and payloads rebuilt from untyped data
      normalizePropagatedSessions({ a: null }),
    ).toThrow(/must be a string or number/);
  });

  test("drops whole-field null rather than preserving it", () => {
    expect(normalizePropagatedSessions(null)).toBeUndefined();
  });
});

describe("normalizeManualSessions (tombstones)", () => {
  test("normalizes string/number ids, absent when empty", () => {
    expect(normalizeManualSessions({ a: "1", b: 2 })).toEqual({
      a: "1",
      b: "2",
    });
    expect(normalizeManualSessions(undefined)).toBeUndefined();
    expect(normalizeManualSessions({})).toBeUndefined();
  });

  test("preserves a per-key null tombstone", () => {
    expect(normalizeManualSessions({ conv_id: null, keep: "1" })).toEqual({
      conv_id: null,
      keep: "1",
    });
  });

  test("preserves whole-field null (clear all)", () => {
    expect(normalizeManualSessions(null)).toBeNull();
  });

  test("still rejects non-string/number/null values", () => {
    expect(() =>
      // @ts-expect-error runtime guard for a value the type forbids
      normalizeManualSessions({ a: true }),
    ).toThrow(/must be a string, number, or null/);
  });
});

describe("normalizeEventMeta (tombstones)", () => {
  test("carries a per-key tombstone on the manual layer through", () => {
    expect(
      normalizeEventMeta({
        sessions: { conv_id: null },
        propagated_sessions: { conv_id: "123", org_id: "42" },
      }),
    ).toEqual({
      sessions: { conv_id: null },
      propagated_sessions: { conv_id: "123", org_id: "42" },
    });
  });

  test("carries whole-field null (clear all) through, keeping propagated", () => {
    expect(
      normalizeEventMeta({
        sessions: null,
        propagated_sessions: { a: "1" },
      }),
    ).toEqual({ sessions: null, propagated_sessions: { a: "1" } });
  });

  test("drops the meta entirely when nothing is set", () => {
    expect(normalizeEventMeta({})).toBeUndefined();
    expect(normalizeEventMeta(undefined)).toBeUndefined();
  });
});

describe("stampPropagatedSessionsOnEvent", () => {
  const sessions = { conv_id: "123", org_id: "42" };

  /** Minimal shape the stamper accepts, for tests that read `meta` back. */
  type Payload = { data: Record<string, unknown>; meta?: EventMeta };

  test("returns payload unchanged when there are no sessions", () => {
    const payload: Payload = { data: {} };
    expect(stampPropagatedSessionsOnEvent(payload, undefined)).toBe(payload);
    expect(stampPropagatedSessionsOnEvent(payload, {})).toBe(payload);
  });

  test("stamps propagated_sessions onto the payload", () => {
    const payload: Payload = { data: { foo: "bar" } };
    expect(stampPropagatedSessionsOnEvent(payload, sessions)).toEqual({
      data: { foo: "bar" },
      meta: { propagated_sessions: sessions },
    });
  });

  test("preserves the manual sessions layer alongside propagated", () => {
    const payload = { data: {}, meta: { sessions: { conv_id: "manual" } } };
    expect(stampPropagatedSessionsOnEvent(payload, sessions)).toEqual({
      data: {},
      meta: {
        sessions: { conv_id: "manual" },
        propagated_sessions: sessions,
      },
    });
  });

  test("does not mutate the input payload", () => {
    const payload: Payload = { data: {} };
    stampPropagatedSessionsOnEvent(payload, sessions);
    expect(payload).toEqual({ data: {} });
  });

  test("clones the sessions so the stamp can't write back to ctx.sessions", () => {
    const ctxSessions = { conv_id: "123" };
    const payload: Payload = { data: {} };
    const result = stampPropagatedSessionsOnEvent(payload, ctxSessions);

    // Stands in for middleware mutating the stamped layer.
    result.meta!.propagated_sessions!.conv_id = "mutated";

    expect(ctxSessions).toEqual({ conv_id: "123" });
  });

  test("gives each payload its own sessions object", () => {
    const a = stampPropagatedSessionsOnEvent({ data: {} } as Payload, sessions);
    const b = stampPropagatedSessionsOnEvent({ data: {} } as Payload, sessions);

    expect(a.meta?.propagated_sessions).not.toBe(b.meta?.propagated_sessions);
  });

  test("overwrites an existing propagated layer by default", () => {
    const payload = { data: {}, meta: { propagated_sessions: { old: "1" } } };
    expect(stampPropagatedSessionsOnEvent(payload, sessions)).toEqual({
      data: {},
      meta: { propagated_sessions: sessions },
    });
  });

  test("onlyIfAbsent leaves an existing propagated layer untouched", () => {
    const payload = { data: {}, meta: { propagated_sessions: { old: "1" } } };
    expect(
      stampPropagatedSessionsOnEvent(payload, sessions, {
        onlyIfAbsent: true,
      }),
    ).toBe(payload);
  });

  test("onlyIfAbsent treats an empty propagated layer as already stamped", () => {
    // An upstream entry point that deliberately stamped nothing must not be
    // second-guessed downstream.
    const payload = { data: {}, meta: { propagated_sessions: {} } };
    expect(
      stampPropagatedSessionsOnEvent(payload, sessions, {
        onlyIfAbsent: true,
      }),
    ).toBe(payload);
  });

  test("onlyIfAbsent still stamps when there is no propagated layer", () => {
    const payload = { data: {}, meta: { sessions: { conv_id: "manual" } } };
    expect(
      stampPropagatedSessionsOnEvent(payload, sessions, {
        onlyIfAbsent: true,
      }),
    ).toEqual({
      data: {},
      meta: {
        sessions: { conv_id: "manual" },
        propagated_sessions: sessions,
      },
    });
  });
});

describe("stampPropagatedSessions", () => {
  const sessions = { conv_id: "123", org_id: "42" };

  test("returns payload unchanged when there are no sessions", () => {
    const payload = { name: "app/event", data: {} };
    expect(stampPropagatedSessions(payload, undefined)).toBe(payload);
    expect(stampPropagatedSessions(payload, {})).toBe(payload);
  });

  test("stamps propagated_sessions onto a single payload", () => {
    const payload = { name: "app/event", data: {} };
    expect(stampPropagatedSessions(payload, sessions)).toEqual({
      name: "app/event",
      data: {},
      meta: { propagated_sessions: sessions },
    });
  });

  test("stamps each payload in an array", () => {
    const result = stampPropagatedSessions(
      [
        { name: "app/a", data: {} },
        { name: "app/b", data: {} },
      ],
      sessions,
    );
    expect(result).toEqual([
      { name: "app/a", data: {}, meta: { propagated_sessions: sessions } },
      { name: "app/b", data: {}, meta: { propagated_sessions: sessions } },
    ]);
  });

  test("preserves the manual sessions layer alongside propagated", () => {
    const payload = {
      name: "app/event",
      data: {},
      meta: { sessions: { conv_id: "manual" } },
    };
    expect(stampPropagatedSessions(payload, sessions)).toEqual({
      name: "app/event",
      data: {},
      meta: {
        sessions: { conv_id: "manual" },
        propagated_sessions: sessions,
      },
    });
  });

  test("does not mutate the input payload", () => {
    const payload = { name: "app/event", data: {} };
    stampPropagatedSessions(payload, sessions);
    expect(payload).toEqual({ name: "app/event", data: {} });
  });
});
