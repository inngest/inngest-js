/**
 * @module
 * Tests for how a run's end is told with no KV store: the record the ledger
 * keeps as `previousRun`, the `agent/finished` notice, and the owed reports.
 */
import { owedReports, requiredReports } from "../inbox/reports.ts";
import { formatEvent } from "../loop/loop.ts";
import { finishedNotice } from "./finishedRelay.ts";

describe("run end", () => {
  test("finishedNotice: only a run start_agent began has one", () => {
    const from = {
      kind: "agent",
      address: "app/parent",
      key: "p1",
      thread: "c1",
      via: "start_agent",
      target: "app/child",
    };
    const data = (sender: unknown) => ({
      function_id: "app-child",
      result: "ok",
      events: [{ name: "agent/message", data: { from: sender } }],
    });

    expect(finishedNotice(data(from))).toEqual({
      agent: "app/parent",
      thread: "p1",
      from: { kind: "agent", address: "app/child", key: "c1" },
      outcome: "completed",
      output: "ok",
    });
    expect(finishedNotice(data({ ...from, via: undefined }))).toBeUndefined();
  });

  test("owed reports: the required ones the run has not sent", async () => {
    const spec = {
      a: { required: true as const, to: [] },
      b: { to: [] },
      c: { required: true as const, to: [] },
    };

    expect(requiredReports(spec)).toEqual(["a", "c"]);
    expect(await owedReports({ spec, sent: new Set(["a"]) })).toEqual(["c"]);
  });

  test("agent/finished reads out the reports it never sent", () => {
    const text = formatEvent({
      name: "agent/finished",
      data: { outcome: "completed", missing: ["milestone"] },
    } as never);

    expect(text).toContain("never sent the report it owed: milestone");
  });
});
