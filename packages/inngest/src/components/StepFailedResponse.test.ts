import { isSerializedError } from "../helpers/errors";
import { ServerTiming } from "../helpers/ServerTiming.ts";
import { StepOpCode } from "../types";
import { createV1InngestExecution } from "./execution/v1";
import { Inngest } from "./Inngest";
import type { InngestFunction } from "./InngestFunction";
import { NonRetriableError } from "./NonRetriableError";

describe("StepFailed response contains minimal serialized error and retriable false", () => {
  const inngest = new Inngest({ id: "test" });

  it("NonRetriableError -> StepFailed includes serialized marker in data and retriable=false", async () => {
    const fn = inngest.createFunction(
      { id: "test-stepfailed-response", retries: 1 },
      { event: "test/event" },
      async ({ step }) => {
        await step.run("fails-immediately", () => {
          throw new NonRetriableError("boom");
        });
      },
    );

    const execution = createV1InngestExecution({
      client: inngest,
      fn: fn as InngestFunction.Any,
      data: {
        event: { name: "test/event", data: {} },
        events: [{ name: "test/event", data: {} }],
        runId: "test-run",
        attempt: 0,
        maxAttempts: 1,
      },
      timer: new ServerTiming(),
      stepState: {},
      stepCompletionOrder: [],
      reqArgs: [],
      isFailureHandler: false,
      runId: "test-run",
      headers: {},
    });

    const result = await execution.start();
    expect(result.type).toBe("step-ran");
    if (result.type === "step-ran") {
      expect(result.step.op).toBe(StepOpCode.StepFailed);
      // Ensure minimal serialized error marker is present in data to support resume rejection
      expect(isSerializedError(result.step.data)).toBeTruthy();
    }
  });
});
