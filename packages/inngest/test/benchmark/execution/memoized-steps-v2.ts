import { ExecutionVersion } from "../../../src/components/execution/InngestExecution";
import { createExecutionWithMemoizedSteps } from "./util";

const stepCounts = [0, 1, 10, 100, 500, 1000, 2000, 5000, 10000];

export default stepCounts.reduce((acc, stepCount) => {
  const { run } = createExecutionWithMemoizedSteps({ stepCount, executionVersion: ExecutionVersion.V2 });

  return {
    ...acc,
    [stepCount]: run,
  };
}, {});
