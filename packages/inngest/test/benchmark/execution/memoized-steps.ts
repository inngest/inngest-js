import { createExecutionWithMemoizedSteps } from "./util";

const stepCounts = [0, 1, 10, 100, 500, 1000, 2000, 5000, 10000];

export default stepCounts.reduce((acc, stepCount) => {
  const { run } = createExecutionWithMemoizedSteps({ stepCount });

  return {
    ...acc,
    [stepCount]: run,
  };
}, {});
