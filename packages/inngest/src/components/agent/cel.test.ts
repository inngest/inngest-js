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

  test("escapes other than backslash and quotes are rejected", () => {
    expect(() => {
      return compileKey('"a\\nb"');
    }).toThrow();
  });

  test("string() joins a number into a key the way CEL writes a double", () => {
    // The right-hand side is what Go's strconv.FormatFloat(x, 'g', -1, 64) gives,
    // which is what cel-go's string(double) returns.
    const cases: [number, string][] = [
      [12345, "12345"],
      [123456, "123456"],
      [1234567, "1.234567e+06"],
      [1234567890, "1.23456789e+09"],
      [1.5, "1.5"],
      [100, "100"],
      [1e20, "1e+20"],
      [1e21, "1e+21"],
      [0.0001, "0.0001"],
      [0.00001, "1e-05"],
      [12345678901234567890, "1.2345678901234567e+19"],
      [-42, "-42"],
      [-1234567, "-1.234567e+06"],
      [0, "0"],
    ];

    for (const [value, expected] of cases) {
      const key = compileKey('"id-" + string(event.data.n)');

      expect(key.key({ data: { n: value } })).toBe(`id-${expected}`);
    }
  });

  test("string(int()) writes a whole number in full, as ids need", () => {
    const key = compileKey('event.data.repo + "#" + string(int(event.data.n))');

    expect(key.key({ data: { repo: "r", n: 1234567890 } })).toBe(
      "r#1234567890",
    );
    expect(key.key({ data: { repo: "r", n: 42 } })).toBe("r#42");
    expect(key.key({ data: { repo: "r", n: 42.9 } })).toBe("r#42");
    expect(key.key({ data: { repo: "r", n: -7 } })).toBe("r#-7");
  });

  test("string() of a string or a boolean, and in the async form", () => {
    expect(compileKey("string(event.data.s)").key({ data: { s: "x" } })).toBe(
      "x",
    );
    expect(
      compileKey('string(event.data.b) + "!"').key({ data: { b: true } }),
    ).toBe("true!");
    expect(compileKey("string(int(event.data.n))").asAsync).toBe(
      "string(int(async.data.n))",
    );
  });

  test("string() refuses what CEL and the SDK would write differently or cannot write", () => {
    for (const source of [
      "string(1234567)",
      "int(event.data.n)",
      'string(int("12"))',
    ]) {
      expect(() => {
        return compileKey(source).key({ data: { n: 1, s: "x" } });
      }).toThrow();
    }

    expect(() => {
      return compileKey("string(int(event.data.n))").key({
        data: { n: 2 ** 70 },
      });
    }).toThrow(/out of range/);
    expect(() => {
      return compileKey("string(event.data.n)").key({
        data: { n: Number.POSITIVE_INFINITY },
      });
    }).toThrow(/not finite/);
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
