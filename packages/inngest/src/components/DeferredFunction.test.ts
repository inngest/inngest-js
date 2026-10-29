import { describe, expect, test } from "vitest";
import { createDefer, stripInngestMetadata } from "./DeferredFunction.ts";
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

describe("stripInngestMetadata parent outcome", () => {
  const base = {
    fn_slug: "child",
    parent_fn_slug: "parent",
    parent_run_id: "01HKQJZ5R7XR4MNTQGZ8Z3KPAB",
  };

  test("exposes status, error and endedAt", () => {
    const event = {
      data: {
        a: 1,
        _inngest: {
          ...base,
          parent_status: "Failed",
          parent_error: {
            name: "NonRetriableError",
            message: "nope",
            stack: "at x",
          },
          parent_ended_at: 1700000000000,
        },
      },
    };
    const parent = stripInngestMetadata(event);
    expect(parent.status).toBe("Failed");
    expect(parent.error).toEqual({
      name: "NonRetriableError",
      message: "nope",
      stack: "at x",
    });
    expect(parent.endedAt).toEqual(new Date(1700000000000));
    expect(event.data).toEqual({ a: 1 });
  });

  test("keeps the truncated flag", () => {
    const parent = stripInngestMetadata({
      data: {
        _inngest: {
          ...base,
          parent_status: "Failed",
          parent_error: { name: "E", message: "m", truncated: true },
        },
      },
    });
    expect(parent.error).toEqual({ name: "E", message: "m", truncated: true });
  });

  test("completed has no error", () => {
    const parent = stripInngestMetadata({
      data: { _inngest: { ...base, parent_status: "Completed" } },
    });
    expect(parent.status).toBe("Completed");
    expect(parent.error).toBeUndefined();
  });

  test("older servers leave outcome undefined", () => {
    const parent = stripInngestMetadata({ data: { _inngest: base } });
    expect(parent.status).toBeUndefined();
    expect(parent.error).toBeUndefined();
    expect(parent.endedAt).toBeUndefined();
  });

  test("ignores malformed outcome fields", () => {
    const parent = stripInngestMetadata({
      data: {
        _inngest: {
          ...base,
          parent_status: "Weird",
          parent_error: "str",
          parent_ended_at: "yesterday",
        },
      },
    });
    expect(parent.status).toBeUndefined();
    expect(parent.error).toBeUndefined();
    expect(parent.endedAt).toBeUndefined();
  });
});
