import type {
  ExecutionResult,
  ExecutionResults,
} from "inngest/components/execution/InngestExecution";
import { _internals } from "inngest/components/execution/v1";
import { createDeferredPromise } from "inngest/helpers/promises";
import type { InngestTestEngine } from "./InngestTestEngine.js";
import { isDeeplyEqual, type DeepPartial } from "./util";

/**
 * A test run that allows you to wait for specific checkpoints in a run that
 * covers many executions.
 *
 * @TODO We may need to separate run execution by {@link ExecutionVersion}.
 */
export namespace InngestTestRun {
  /**
   * Options for creating a new {@link InngestTestRun} instance.
   */
  export interface Options {
    /**
     * The test engine to use for running the function.
     */
    testEngine: InngestTestEngine;
  }

  /**
   * The possible checkpoints that can be reached during a test run.
   */
  export type CheckpointKey = ExecutionResult["type"];

  /**
   * A checkpoint that can be reached during a test run.
   */
  export type Checkpoint<T extends CheckpointKey> = Omit<
    Extract<ExecutionResult, { type: T }>,
    "ctx" | "ops"
  >;
}

/**
 * A test run that allows you to wait for specific checkpoints in a run that
 * covers many executions.
 *
 * @TODO We may need to separate run execution by {@link ExecutionVersion}.
 */
export class InngestTestRun {
  public options: InngestTestRun.Options;

  constructor(options: InngestTestRun.Options) {
    this.options = options;
  }

  /**
   * Keep executing the function until a specific checkpoint is reached.
   *
   * @TODO What if the thing we're waiting for has already happened?
   */
  public async waitFor<T extends InngestTestRun.CheckpointKey>(
    /**
     * The checkpoint to wait for.
     */
    checkpoint: T,

    /**
     * An optional subset of the checkpoint to match against. Any checkpoint of
     * this type will be matched.
     *
     * When providing a `subset`, use `expect` tooling such as
     * `expect.stringContaining` to match partial values.
     */
    subset?: DeepPartial<InngestTestRun.Checkpoint<T>>
  ): Promise<InngestTestEngine.ExecutionOutput<T>> {
    let finished = false;
    const runningState: InngestTestEngine.InlineOptions = {};

    const { promise, resolve, reject } =
      createDeferredPromise<InngestTestEngine.ExecutionOutput<T>>();

    const finish = (output: InngestTestEngine.ExecutionOutput) => {
      finished = true;

      if (output.result.type !== checkpoint) {
        reject(
          new Error(
            `Expected checkpoint "${checkpoint}" but got "${output.result.type}"`
          )
        );
      }

      resolve(output as InngestTestEngine.ExecutionOutput<T>);
    };

    /**
     * Make sure we sanitize any given ID to prehash it for the user. This is
     * abstracted from the user entirely so they shouldn't be expected to be
     * providing hashes.
     */
    const sanitizedSubset: typeof subset = subset && {
      ...subset,
      ...("step" in subset &&
        typeof subset.step === "object" &&
        subset.step !== null &&
        "id" in subset.step &&
        typeof subset.step.id === "string" && {
          step: { ...subset.step, id: _internals.hashId(subset.step.id) },
        }),
    };

    const processChain = async (targetStepId?: string) => {
      if (finished) {
        return;
      }

      const exec = await this.options.testEngine.execute({
        ...runningState,
        targetStepId,
      });

      if (
        exec.result.type === checkpoint &&
        (!sanitizedSubset || isDeeplyEqual(sanitizedSubset, exec.result))
      ) {
        return finish(exec);
      }

      const resultHandlers: Record<keyof ExecutionResults, () => void> = {
        "function-resolved": () => finish(exec),
        "function-rejected": () => finish(exec),
        "step-not-found": () => {
          processChain();
        },
        "steps-found": () => {
          // run all
          const result =
            exec.result as InngestTestRun.Checkpoint<"steps-found">;

          if (result.steps.length > 1) {
            runningState.disableImmediateExecution = true;
          }

          result.steps.forEach((step) => {
            processChain(step.id);
          });
        },
        "step-ran": () => {
          const result = exec.result as InngestTestRun.Checkpoint<"step-ran">;

          // add to our running state
          runningState.steps ??= [];
          runningState.steps.push({
            id: result.step.name as string, // TODO we need the non-hashed ID here, or a way to map it
            handler: () => {
              if (result.step.error) {
                throw result.step.error;
              }

              return result.step.data;
            },
          });

          processChain();
        },
      };

      resultHandlers[exec.result.type]();
    };

    // kick off
    processChain();

    return promise;
  }
}
