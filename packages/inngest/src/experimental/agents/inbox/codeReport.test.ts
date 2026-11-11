/**
 * @module
 * The `report` tool sandbox code gets in a `runCode`: it checks a report as
 * the model's tool does, and each call sends under its own step ID, so a
 * script that reports in a loop sends each report once on every replay.
 */
import { Inngest } from "../../../components/Inngest.ts";
import { withStepIdPrefix } from "../../../components/InngestStepTools.ts";
import { isToolError } from "../../../components/sandbox/tools.ts";
import { testClientId } from "../../../test/helpers.ts";
import { run } from "../agent/test-helpers.ts";
import { codeReportTool, type ReportBook } from "./reports.ts";

const book = (): ReportBook => {
  return {
    spec: {
      progress: {
        schema: {
          type: "object",
          properties: { pct: { type: "number" } },
          required: ["pct"],
        },
        to: [{ agent: `${testClientId}/boss`, thread: "boss-thread" }],
      },
    },
    sent: new Set(),
  } as unknown as ReportBook;
};

// Calls the tool as `runCode` calls a group tool from a script: under the
// prefix of the call's own step, with that step as the idempotency key.
const call = (
  reports: ReportBook,
  callId: number,
  input: { type: string; data: unknown },
) => {
  const stepId = `agent:run_code:tool:report:${callId}`;

  return withStepIdPrefix(`${stepId}:`, () => {
    return codeReportTool(reports).run(
      input as never,
      {
        signal: new AbortController().signal,
        idempotencyKey: `run-1:${stepId}`,
      } as never,
    );
  });
};

describe("the report tool sandbox code gets", () => {
  test("a script that reports in a loop sends each report once, under its own call", async () => {
    const client = new Inngest({ id: testClientId });
    const sent: unknown[] = [];
    const steps: string[] = [];

    vi.spyOn(client as never, "_send").mockImplementation((async ({
      payload,
    }: {
      payload: unknown;
    }) => {
      sent.push(...(Array.isArray(payload) ? payload : [payload]));

      return { ids: ["x"] };
    }) as never);

    const reports = book();
    const fn = client.createFunction(
      { id: "code-report", triggers: [{ event: "go" }] },
      async () => {
        const results: unknown[] = [];

        for (let n = 1; n <= 3; n += 1) {
          results.push(
            await call(reports, n, { type: "progress", data: { pct: n } }),
          );
        }

        return results;
      },
    );

    const { output } = await run(fn, {
      event: { name: "go", data: {} },
      onStep: (op) => {
        steps.push(op.userland?.id ?? op.displayName ?? op.id);
      },
    });

    expect(output).toEqual([{ ok: true }, { ok: true }, { ok: true }]);

    // One send per call, each its own step, and each sent once over every
    // replay the run took.
    expect(steps).toEqual([
      "agent:run_code:tool:report:1:report:progress",
      "agent:run_code:tool:report:2:report:progress",
      "agent:run_code:tool:report:3:report:progress",
    ]);
    expect(
      sent.map((event) => {
        return (event as { data: { pct: number } }).data.pct;
      }),
    ).toEqual([1, 2, 3]);

    // Each report's event has an ID of its own.
    expect(
      new Set(
        sent.map((event) => {
          return (event as { id: string }).id;
        }),
      ).size,
    ).toBe(3);
  });

  test("a report that breaks its schema or is not owed is refused with a tool error", async () => {
    const reports = book();
    const fn = new Inngest({ id: testClientId }).createFunction(
      { id: "code-report-bad", triggers: [{ event: "go" }] },
      async () => {
        return [
          await call(reports, 1, { type: "progress", data: { pct: "x" } }),
          await call(reports, 2, { type: "other", data: {} }),
        ];
      },
    );

    const { output } = await run(fn, { event: { name: "go", data: {} } });
    const [badData, notOwed] = output as unknown[];

    expect(isToolError(badData)).toBe(true);
    expect(isToolError(notOwed)).toBe(true);
    expect(reports.sent.size).toBe(0);
  });
});
