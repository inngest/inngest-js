import { describe, expect, test } from "vitest";
import { Inngest } from "../../../components/Inngest.ts";
import {
  lendIsOpen,
  lendOf,
  lentEndedNote,
  lentToolNames,
  parentEndedCancel,
  planLend,
} from "./lending.ts";
import { signLedgerData, signLent } from "./relations.ts";

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

  const client = new Inngest({ id: "lend-sign", isDev: true });
  const lent = {
    work: {
      id: "sbx",
      cwd: "/tmp",
      code: true,
      tools: [{ name: "work_run", builtin: "run" as const }],
    },
  };
  const thread = "app/a:run1.0";
  const sig = signLent(client, lent, "run1", thread);
  const from = (over: object) => {
    return { lent, lent_sig: sig, parent_run: "run1", ...over };
  };
  const message = (over: object) => {
    return { name: "agent/message", data: { from: from(over) } };
  };

  test("a lend is refused unless it is signed for its run and thread", () => {
    expect(lendOf(client, message({}), thread)?.machines).toEqual(lent);
    // The executor may reorder keys on the way.
    const reordered = {
      work: {
        tools: [{ builtin: "run", name: "work_run" }],
        code: true,
        cwd: "/tmp",
        id: "sbx",
      },
    };

    expect(
      lendOf(client, message({ lent: reordered }), thread)?.machines,
    ).toEqual(reordered);
    expect(() => lendOf(client, message({}), "app/a:other")).toThrow(
      "unsigned",
    );
    expect(() => lendOf(client, message({ parent_run: "run2" }), thread)).toThrow(
      "unsigned",
    );
    expect(() =>
      lendOf(client, message({ lent_sig: undefined }), thread),
    ).toThrow("unsigned");
    expect(() =>
      lendOf(
        client,
        message({ lent: { work: { ...lent.work, id: "other" } } }),
        thread,
      ),
    ).toThrow("unsigned");
    expect(lendOf(client, { name: "agent/message", data: {} }, thread)).toBe(
      undefined,
    );
  });

  test("a resent lend is taken only on a resend this app signed", () => {
    const resent = {
      agent: "app/a",
      thread,
      event: { name: "agent/message", data: { from: from({}) } },
    };
    const claim = lendOf(
      client,
      {
        name: "agent/recover",
        data: signLedgerData(client, "agent/recover", resent),
      },
      thread,
    );

    expect(claim?.recovered).toBe(true);
    expect(claim?.parentRun).toBe("run1");
    expect(() => {
      return lendOf(client, { name: "agent/recover", data: resent }, thread);
    }).toThrow("unsigned");
    // A resend signed for another thread's lend does not carry this one.
    expect(() => {
      return lendOf(
        client,
        {
          name: "agent/recover",
          data: signLedgerData(client, "agent/recover", resent),
        },
        "app/a:run1.1",
      );
    }).toThrow("unsigned");
  });

  test("the thread's record decides whether a lend that checked out is used", () => {
    const start = lendOf(client, message({}), thread);
    const kept = { parentRun: "run1", tools: ["work_run"], takenBy: "child1" };

    if (!start) {
      throw new Error("expected a lend");
    }

    // The run that took it first uses it; a copy of the start does not.
    expect(lendIsOpen(start, kept, "child1")).toBe(true);
    expect(lendIsOpen(start, kept, "child2")).toBe(false);
    // A recovery's resend of the same thread uses it again.
    expect(lendIsOpen({ ...start, recovered: true }, kept, "child2")).toBe(
      true,
    );
    // Not one that names another parent run, or a thread that kept none.
    expect(
      lendIsOpen({ ...start, recovered: true }, { ...kept, parentRun: "x" }, "c"),
    ).toBe(false);
    expect(lendIsOpen({ ...start, recovered: true }, undefined, "c")).toBe(
      false,
    );
  });

  test("the model of a thread whose lend is over is told so", () => {
    expect(lentToolNames(lent)).toEqual(["work_run"]);
    expect(lentEndedNote(["work_run"])).toContain("work_run");
    expect(lentEndedNote(["work_run"])).toContain("ended with that start");
  });

  test("attached children are cancelled by the parent's run ID", () => {
    expect(parentEndedCancel.event).toBe("agent/parent.ended");
    expect(parentEndedCancel.if).toContain("event.data.from.parent_run");
  });
});
