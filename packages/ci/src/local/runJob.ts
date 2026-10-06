/**
 * The function only a local run has: it runs one job or matrix of the app by
 * ID, as the `inngest-ci` CLI asks, through the same run path as a pipeline.
 *
 * @module
 */

import type { Inngest, InngestFunction } from "inngest";
import { metadataMiddleware, sandboxMiddleware } from "inngest/experimental";
import { CiUsageError } from "../errors.ts";
import type { RegisteredJob } from "../pipeline/job.ts";
import { runJob } from "../pipeline/job.ts";
import { runCombosKey } from "../pipeline/matrix.ts";
import { runPipeline } from "../pipeline/pipeline.ts";
import type { CiInternals } from "../pipeline/scope.ts";
import type { Matrix, MatrixAxes } from "../types.ts";
import type { RunJobEventData } from "./protocol.ts";
import { runJobEvent, runJobFunctionId } from "./protocol.ts";

/** A matrix as the CLI runs it: exactly the combinations it picked. */
interface MatrixRunner {
  [runCombosKey](combos: Record<string, unknown>[]): Promise<unknown[]>;
}

/**
 * Build the function that handles {@link runJobEvent}. It runs like a
 * pipeline, so it has the same checks, repository context and cleanup.
 */
export const runJobFunction = ({
  client,
  internals,
  jobs,
  matrices,
}: {
  client: Inngest.Any;
  internals: CiInternals;
  jobs: Map<string, RegisteredJob>;
  matrices: Map<string, Matrix<MatrixAxes, unknown>>;
}): InngestFunction.Any => {
  return client.createFunction(
    {
      id: runJobFunctionId,
      triggers: [{ event: runJobEvent }],
      middleware: [sandboxMiddleware(), metadataMiddleware()],
    },
    // biome-ignore lint/suspicious/noExplicitAny: SDK ctx
    async (ctx: any) => {
      return runPipeline({
        internals,
        config: { id: runJobFunctionId, on: { event: runJobEvent } },
        handler: async ({ event }) => {
          const {
            job: id,
            input,
            combos,
          } = event.data as unknown as RunJobEventData;

          // With no combos, a matrix runs every combination.
          const matrix = matrices.get(id);

          if (matrix) {
            return combos
              ? (matrix as unknown as MatrixRunner)[runCombosKey](combos)
              : matrix();
          }

          const job = jobs.get(id);

          if (!job) {
            throw new CiUsageError(
              `No job or matrix with the ID "${id}" is defined. Define it with \`ci.job()\` or \`ci.matrix()\`.`,
            );
          }

          return runJob({ config: job.config, handler: job.handler, input });
        },
        ctx,
      });
    },
  );
};
