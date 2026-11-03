/**
 * @module
 * Tests for the warning on a run's trace: a log line plus metadata on the step
 * that hit it.
 */
import { describe, expect, test, vi } from "vitest";
import { Inngest } from "../../../components/Inngest.ts";
import { step } from "../../../components/InngestStepTools.ts";
import { runFnWithStack, testClientId } from "../../../test/helpers.ts";
import { traceWarning } from "./traceWarning.ts";

describe("traceWarning", () => {
  test("logs the warning and attaches it to the step that is running", async () => {
    const warn = vi.fn();
    const client = new Inngest({ id: testClientId });
    const fn = client.createFunction(
      { id: "warns", triggers: [{ event: "warns/run" }] },
      async () => {
        await step.run("work", async () => {
          traceWarning({ warn }, "thread.fresh", "Nothing at event.data.pr.");
        });
      },
    );
    const ran = await runFnWithStack(fn, {});

    if (ran.type !== "step-ran") {
      throw new Error(`expected a step to run, got ${ran.type}`);
    }

    expect(warn).toHaveBeenCalledWith("Nothing at event.data.pr.");
    expect(ran.step.metadata).toEqual([
      expect.objectContaining({
        kind: "inngest.warning.sdk.agent.thread.fresh",
        scope: "step",
        values: { "sdk.agent.thread.fresh": "Nothing at event.data.pr." },
      }),
    ]);
  });

  test("outside a step it only logs", () => {
    const warn = vi.fn();

    expect(traceWarning({ warn }, "thread.fresh", "No step.")).toBe(false);
    expect(warn).toHaveBeenCalledWith("No step.");
  });
});
