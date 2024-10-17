import { fromPartial } from "@total-typescript/shoehorn";
import { Inngest } from "../../../src";
import { STEP_INDEXING_SUFFIX } from "../../../src/components/InngestStepTools";
import {
  IInngestExecution,
  InngestExecution,
  MemoizedOp,
  PREFERRED_EXECUTION_VERSION,
} from "../../../src/components/execution/InngestExecution";
import { _internals } from "../../../src/components/execution/v1";
import { ServerTiming } from "../../../src/helpers/ServerTiming";

interface CreateExecutionWithMemoizedStepsOptions {
  stepCount: number;
}

export const createExecutionWithMemoizedSteps = ({
  stepCount = 1,
}: CreateExecutionWithMemoizedStepsOptions): {
  run: () => Promise<void>;
} => {
  const client = new Inngest({
    id: "benchmark-app",
  });

  const userStepId = "a";
  const userStepOutput = "b";

  const stepState: Record<string, MemoizedOp> = {};
  const stepCompletionOrder: string[] = [];

  for (let i = 0; i < stepCount; i++) {
    let stepId: string;
    if (i === 0) {
      stepId = _internals.hashId(userStepId);
    } else {
      stepId = _internals.hashId(`${userStepId}${STEP_INDEXING_SUFFIX}${i}`);
    }

    stepState[stepId] = {
      id: stepId,
      data: userStepOutput,
    };

    stepCompletionOrder.push(stepId);
  }

  const run = async () => {
    const execution = client
      .createFunction({ id: "test" }, { event: "test" }, async ({ step }) => {
        for (let i = 0; i < stepCount; i++) {
          await step.run(userStepId, () => userStepOutput);
        }
      })
      ["createExecution"]({
        version: PREFERRED_EXECUTION_VERSION,
        partialOptions: {
          data: fromPartial({
            event: { name: "foo", data: {} },
          }),
          runId: "run",
          stepState,
          stepCompletionOrder,
          isFailureHandler: false,
          requestedRunStep: undefined,
          timer: new ServerTiming(),
          disableImmediateExecution: false,
          reqArgs: [],
          headers: {},
        },
      }) as IInngestExecution & InngestExecution;

    await execution.start();
  };

  return { run };
};
