/**
 * @module
 * The step.subscribe matrix with checkpointing off and optimizeParallelism off. See `kit/matrix.ts`.
 */
import { matrixScenario } from "../kit/matrix.ts";

export const subscribeMatrixC0O0 = matrixScenario({
  checkpointing: false,
  optimize: false,
});
