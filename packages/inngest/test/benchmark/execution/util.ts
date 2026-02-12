import { fromPartial } from "@total-typescript/shoehorn";
import { Inngest } from "../../../src";
import {
  ExecutionVersion,
  type IInngestExecution,
  type InngestExecution,
  type MemoizedOp,
  PREFERRED_ASYNC_EXECUTION_VERSION,
} from "../../../src/components/execution/InngestExecution";
import { _internals } from "../../../src/components/execution/v1";
import { STEP_INDEXING_SUFFIX } from "../../../src/components/InngestStepTools";
import { ServerTiming } from "../../../src/helpers/ServerTiming";
import { StepMode } from "../../../src/types";

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
      .createFunction(
        { id: "test", triggers: [{ event: "test" }] },
        async ({ step }) => {
          for (let i = 0; i < stepCount; i++) {
            await step.run(
              i === 0 ? userStepId : `${userStepId}${STEP_INDEXING_SUFFIX}${i}`,
              () => userStepOutput,
            );
          }
        },
      )
      ["createExecution"]({
        version: ExecutionVersion.V2,
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
          stepMode: StepMode.Async,
          client,
        },
      }) as IInngestExecution & InngestExecution;

    await execution.start();
  };

  return { run };
};
