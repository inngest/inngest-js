/**
 * @module
 * The step.subscribe matrix with checkpointing on and optimizeParallelism on. See `kit/matrix.ts`.
 */
import { matrixScenario } from "../kit/matrix.ts";

export const subscribeMatrixC1O1 = matrixScenario({
  checkpointing: true,
  optimize: true,
});
