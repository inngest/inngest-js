import { describe, expect, test } from "vitest";
import { createDefer } from "./DeferredFunction.ts";
import { Inngest } from "./Inngest.ts";

describe("createDefer ID validation", () => {
  // Reject IDs that break CEL trigger string interpolation
  const client = new Inngest({ id: "test", isDev: true });

  test.each(["foo'bar", "foo\\bar", "foo\nbar", "foo\rbar"])(
    "rejects %j",
    (id) => {
      expect(() => {
        createDefer(client, { id }, async () => {});
      }).toThrowError(`invalid id "${id}"`);
    },
  );

  test.each(["foo-bar", "foo_bar", "foo123", "foo-bar_123", "foo/bar"])(
    "accepts %j",
    (id) => {
      expect(() => {
        createDefer(client, { id }, async () => {});
      }).not.toThrow();
    },
  );
});
