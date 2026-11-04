import { describe, expect, test } from "vitest";
import { Inngest } from "../../../components/Inngest.ts";
import { lendDigest, mintGrant } from "./grant.ts";
import {
  lendIsOpen,
  lendOf,
  lentEndedNote,
  lentToolNames,
  parentEndedCancel,
  planLend,
} from "./lending.ts";
import { signLedgerData } from "./relations.ts";

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
  const grantFor = (over: {
    thread?: string;
    run?: string;
    lend?: unknown;
  }) => {
    return mintGrant(client, {
      thread: over.thread ?? thread,
      lines: [
        "iss=lend-sign",
        ...(over.run === undefined ? [] : [`run=${over.run}`]),
        `lend=${lendDigest(over.lend ?? lent)}`,
      ],
    });
  };
  const grant = grantFor({ run: "run1" });
  const message = (over: object = {}) => {
    return {
      name: "agent/message",
      data: { from: { lent, parent_run: "run1", ...over } },
    };
  };

  test("a lend is refused unless the grant names it, its run and its thread", () => {
    expect(lendOf(client, message(), thread, grant)?.machines).toEqual(lent);
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
      lendOf(client, message({ lent: reordered }), thread, grant)?.machines,
    ).toEqual(reordered);
    // A grant made for another thread.
    expect(() => lendOf(client, message(), "app/a:other", grant)).toThrow(
      "unsigned",
    );
    // A grant with no parent run, or no grant at all.
    expect(() => lendOf(client, message(), thread, grantFor({}))).toThrow(
      "unsigned",
    );
    expect(() => lendOf(client, message(), thread)).toThrow("unsigned");
    // Other machines than the grant's digest.
    expect(() =>
      lendOf(
        client,
        message({ lent: { work: { ...lent.work, id: "other" } } }),
        thread,
        grant,
      ),
    ).toThrow("unsigned");
    expect(
      lendOf(client, { name: "agent/message", data: {} }, thread, grant),
    ).toBe(undefined);
  });

  test("a resent lend is taken only on a resend this app signed", () => {
    const resent = {
      agent: "app/a",
      thread,
      event: { name: "agent/message", data: { from: { lent } } },
    };
    const claim = lendOf(
      client,
      {
        name: "agent/recover",
        data: signLedgerData(client, "agent/recover", resent),
      },
      thread,
      grant,
    );

    expect(claim?.recovered).toBe(true);
    expect(claim?.parentRun).toBe("run1");
    expect(() => {
      return lendOf(
        client,
        { name: "agent/recover", data: resent },
        thread,
        grant,
      );
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
        grant,
      );
    }).toThrow("unsigned");
  });

  test("the thread's record decides whether a lend that checked out is used", () => {
    const start = lendOf(client, message(), thread, grant);
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
      lendIsOpen(
        { ...start, recovered: true },
        { ...kept, parentRun: "x" },
        "c",
      ),
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
