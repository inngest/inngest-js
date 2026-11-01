/**
 * @module
 * The step.subscribeLegacy matrix with checkpointing off and optimizeParallelism on. See `kit/matrix.ts`.
 */
import { matrixScenario } from "../kit/matrix.ts";

export const subscribeMatrixC0O1 = matrixScenario({
  checkpointing: false,
  optimize: true,
});
