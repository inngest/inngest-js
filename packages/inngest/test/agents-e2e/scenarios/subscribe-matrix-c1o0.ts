/**
 * @module
 * The step.subscribeLegacy matrix with checkpointing on and optimizeParallelism off. See `kit/matrix.ts`.
 */
import { matrixScenario } from "../kit/matrix.ts";

export const subscribeMatrixC1O0 = matrixScenario({
  checkpointing: true,
  optimize: false,
});
