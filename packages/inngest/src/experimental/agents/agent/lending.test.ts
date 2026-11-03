import { describe, expect, test } from "vitest";
import { Inngest } from "../../../components/Inngest.ts";
import {
  lentIssuedAt,
  lentOf,
  parentEndedCancel,
  planLend,
  refuseStaleLend,
} from "./lending.ts";
import { signLent } from "./relations.ts";

describe("lending", () => {
  test("nothing lent is no plan", () => {
    expect(planLend({})).toBeUndefined();
    expect(planLend({ tools: {}, sandboxes: {} })).toBeUndefined();
  });

  test("a tool that is not a sandbox's can't be lent", () => {
    expect(() => {
      return planLend({ tools: { work_run: { run: () => 1 } } });
    }).toThrow("not a tool of a sandbox");
  });

  test("a sandbox that is not the handler's can't be lent", () => {
    expect(() => {
      return planLend({ sandboxes: { work: {} as never } });
    }).toThrow("not a sandbox of this run");
  });

  test("a lend is refused unless it is signed for its run and thread", () => {
    const client = new Inngest({ id: "lend-sign", isDev: true });
    const lent = { work: { id: "sbx", cwd: "/tmp", code: true, tools: [] } };
    const sig = signLent(client, lent, "run1", "app/a:run1.0", 1000);
    const event = (over: object) => {
      return {
        data: {
          from: {
            lent,
            lent_sig: sig,
            lent_at: 1000,
            parent_run: "run1",
            ...over,
          },
        },
      };
    };

    expect(lentOf(client, event({}), "app/a:run1.0")).toEqual(lent);
    // The executor may reorder keys on the way.
    const reordered = {
      work: { tools: [], code: true, cwd: "/tmp", id: "sbx" },
    };

    expect(lentOf(client, event({ lent: reordered }), "app/a:run1.0")).toEqual(
      reordered,
    );
    expect(() => lentOf(client, event({}), "app/a:other")).toThrow("unsigned");
    expect(() =>
      lentOf(client, event({ parent_run: "run2" }), "app/a:run1.0"),
    ).toThrow("unsigned");
    expect(() =>
      lentOf(client, event({ lent_sig: undefined }), "app/a:run1.0"),
    ).toThrow("unsigned");
    // The issue time is signed: moving it to look fresh breaks the signature.
    expect(() =>
      lentOf(client, event({ lent_at: 2000 }), "app/a:run1.0"),
    ).toThrow("unsigned");
    expect(() =>
      lentOf(
        client,
        event({ lent: { work: { ...lent.work, id: "other" } } }),
        "app/a:run1.0",
      ),
    ).toThrow("unsigned");
  });

  test("a lend is good for an hour, and not from the future", () => {
    const hour = 60 * 60 * 1000;

    expect(() => refuseStaleLend(1000, 1000 + hour)).not.toThrow();
    expect(() => refuseStaleLend(1000, 1001 + hour)).toThrow("too long ago");
    expect(() => refuseStaleLend(1000 + 10 * 60_000, 1000)).toThrow(
      "too long ago",
    );
    expect(() => refuseStaleLend(0, 1000)).not.toThrow();
    expect(lentIssuedAt({ data: {} })).toBe(0);
  });

  test("attached children are cancelled by the parent's run ID", () => {
    expect(parentEndedCancel).toEqual({
      event: "agent/parent.ended",
      if: "async.data.run_id == event.data.from.parent_run",
    });
  });
});
