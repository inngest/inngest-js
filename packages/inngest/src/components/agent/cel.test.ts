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

  test("string(), numbers, comparisons and booleans", () => {
    expect(compileExpression("string(event.data.n + 1)").evaluate(slack)).toBe(
      "4",
    );
    expect(
      compileExpression(
        'event.name == "slack/message" && !(event.data.n != 3)',
      ).evaluate(slack),
    ).toBe(true);
    expect(compileExpression("false || true").evaluate(slack)).toBe(true);
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
    }).toThrow(/string\(\)/);
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
