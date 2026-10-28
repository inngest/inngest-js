/**
 * @module
 * Tests for the CEL subset thread keys are written in.
 */
import { compileExpression, compileKey, toAsync } from "./cel.ts";

const slack = {
  name: "slack/message",
  data: { channel: "C1", ts: "9.9", thread_ts: "1.0", n: 3 },
};

describe("thread key expressions", () => {
  test("paths, strings and concatenation", () => {
    expect(
      compileKey('event.data.channel + "/" + event.data.ts').key(slack),
    ).toBe("C1/9.9");
  });

  test("has() and the conditional pick the thread or the message", () => {
    const key = compileKey(
      'event.data.channel + "/" + (has(event.data.thread_ts) ? event.data.thread_ts : event.data.ts)',
    );

    expect(key.key(slack)).toBe("C1/1.0");
    expect(key.key({ data: { channel: "C1", ts: "9.9" } })).toBe("C1/9.9");
  });

  test("numbers, comparisons and booleans", () => {
    expect(compileExpression("event.data.n + 1").evaluate(slack)).toBe(4);
    expect(
      compileExpression(
        'event.name == "slack/message" && !(event.data.n != 3)',
      ).evaluate(slack),
    ).toBe(true);
    expect(compileExpression("false || true").evaluate(slack)).toBe(true);
  });

  test("&& and || absorb an error on one side when the other decides", () => {
    expect(
      compileExpression("event.data.nope == 1 || true").evaluate(slack),
    ).toBe(true);
    expect(
      compileExpression("false && event.data.nope == 1").evaluate(slack),
    ).toBe(false);
    expect(() => {
      return compileExpression("event.data.nope == 1 || false").evaluate(slack);
    }).toThrow(/not set/);
  });

  test("string() and escapes other than backslash and quotes are rejected", () => {
    for (const source of ["string(event.data.n)", '"a\\nb"']) {
      expect(() => {
        return compileKey(source);
      }).toThrow();
    }
  });

  test("a missing path is an error, and the key must be a non-empty string", () => {
    expect(() => {
      return compileKey("event.data.nope").key(slack);
    }).toThrow(/not set/);
    expect(() => {
      return compileKey('""').key(slack);
    }).toThrow(/non-empty string/);
    expect(() => {
      return compileKey("event.data.n").key(slack);
    }).toThrow(/non-empty string/);
    expect(() => {
      return compileKey('event.data.n + "x"').key(slack);
    }).toThrow(/two strings or two numbers/);
  });

  test("anything outside the subset is rejected when compiled", () => {
    for (const source of [
      "event.data.items[0]",
      "event.data.channel.size()",
      'event.data.channel in ["a"]',
      "now",
      "event.data.channel +",
      '"unterminated',
      "event.data.a < 2",
    ]) {
      expect(() => {
        return compileKey(source);
      }).toThrow();
    }
  });

  test("the async form renames event paths and leaves strings and fields alone", () => {
    expect(
      toAsync('event.data.event + "event." + event.data.x == "event.y"'),
    ).toBe('async.data.event + "event." + async.data.x == "event.y"');
    expect(compileKey("event.data.channel").asAsync).toBe("async.data.channel");
  });
});

describe("where the SDK subset and the backend CEL could differ", () => {
  test("inherited names are not fields: has() is false and a path throws", () => {
    for (const name of [
      "constructor",
      "toString",
      "__proto__",
      "hasOwnProperty",
    ]) {
      expect(compileExpression(`has(event.data.${name})`).evaluate(slack)).toBe(
        false,
      );
      expect(() => {
        return compileKey(`event.data.${name}`).key(slack);
      }).toThrow(/not set/);
    }
  });

  test("a null field is set, but it is not a key", () => {
    const event = { data: { channel: null } };

    expect(compileExpression("has(event.data.channel)").evaluate(event)).toBe(
      true,
    );
    expect(() => {
      return compileKey("event.data.channel").key(event);
    }).toThrow(/non-empty string/);
  });

  test("a number is not a string key, and + does not mix types", () => {
    expect(() => {
      return compileKey("event.data.n").key(slack);
    }).toThrow(/non-empty string/);
    expect(() => {
      return compileExpression('event.data.n + "x"').evaluate(slack);
    }).toThrow(/two strings or two numbers/);
  });

  test("a missing field inside the untaken branch of ?: is not evaluated", () => {
    expect(
      compileKey(
        "has(event.data.thread_ts) ? event.data.thread_ts : event.data.ts",
      ).key({ data: { ts: "9.9" } }),
    ).toBe("9.9");
  });
});

describe("constant expressions", () => {
  test("a lone string literal is constant, anything else is not", () => {
    expect(compileExpression('"nightly"').constant).toBe('"nightly"');
    expect(compileExpression("'nightly'").constant).toBe("'nightly'");
    expect(compileExpression('"a" + "b"').constant).toBeUndefined();
    expect(compileExpression("event.data.x").constant).toBeUndefined();
  });
});
