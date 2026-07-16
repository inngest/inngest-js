import { describe, expect, test } from "vitest";
import { reduceEventsToPropagatedSessions, compareUtf8 } from "./sessions.ts";

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

  test("batch unions sessions across all triggering events", () => {
    expect(
      reduceEventsToPropagatedSessions([evt({ a: "1" }), evt({ b: "2" })]),
    ).toEqual({
      a: "1",
      b: "2",
    });
  });

  test("exact (key,id) duplicate across the batch dedupes", () => {
    expect(
      reduceEventsToPropagatedSessions([evt({ a: "1" }), evt({ a: "1" })]),
    ).toEqual({
      a: "1",
    });
  });

  test("a key with conflicting ids across the batch is dropped entirely", () => {
    expect(
      reduceEventsToPropagatedSessions([evt({ a: "1" }), evt({ a: "2" })]),
    ).toEqual({});
  });

  test("only the conflicting key is dropped; the rest survive", () => {
    expect(
      reduceEventsToPropagatedSessions([
        evt({ a: "1", b: "9" }),
        evt({ a: "2" }),
      ]),
    ).toEqual({ b: "9" });
  });

  test("a duplicate id does not mask a genuine conflict", () => {
    // ids seen for `a` are {1, 2} even though (a,1) appears twice.
    expect(
      reduceEventsToPropagatedSessions([
        evt({ a: "1" }),
        evt({ a: "1" }),
        evt({ a: "2" }),
      ]),
    ).toEqual({});
  });

  test("numeric and string ids for a key canonicalize equal (no false conflict)", () => {
    // Guards the String() coercion: {a:1} and {a:"1"} dedupe, not conflict.
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

  test("conflict drop happens BEFORE truncation", () => {
    // Six keys a..f; `a` conflicts and is dropped, leaving exactly b..f (5).
    // If truncation ran first we would keep a..e, then drop conflicting a,
    // yielding only b..e (4) — this pins the ordering.
    const events = [
      evt({ a: "1", b: "1", c: "1", d: "1", e: "1", f: "1" }),
      evt({ a: "2" }),
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
