import { OutgoingOp } from "inngest";
import { InngestExecution, InngestExecutionV1 } from "inngest/internals";
import type { InngestTestEngine } from "./InngestTestEngine.js";
import { createDeferredPromise, type DeepPartial, isDeeplyEqual } from "./util";

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
  export type CheckpointKey = InngestExecution.ExecutionResult["type"];

  /**
   * A checkpoint that can be reached during a test run.
   */
  export type Checkpoint<T extends CheckpointKey> = Omit<
    Extract<InngestExecution.ExecutionResult, { type: T }>,
    "ctx" | "ops"
  >;

  export interface RunOutput
    extends Pick<InngestTestEngine.ExecutionOutput, "ctx" | "state"> {
    result?: Checkpoint<"function-resolved">["data"];
    error?: Checkpoint<"function-rejected">["error"];
  }

  export interface RunStepOutput extends RunOutput {
    step: OutgoingOp;
  }
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
    subset?: DeepPartial<InngestTestRun.Checkpoint<T>>,
  ): Promise<InngestTestEngine.ExecutionOutput<T>> {
    let finished = false;
    const runningState: InngestTestEngine.InlineOptions = {
      events: this.options.testEngine["options"].events,
      steps: this.options.testEngine["options"].steps,
    };

    const { promise, resolve, reject } =
      createDeferredPromise<InngestTestEngine.ExecutionOutput<T>>();

    const finish = (output: InngestTestEngine.ExecutionOutput) => {
      finished = true;

      if (output.result.type !== checkpoint) {
        return reject(output);
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

      // "step" for "step-ran"
      ...("step" in subset &&
        typeof subset.step === "object" &&
        subset.step !== null &&
        "id" in subset.step &&
        typeof subset.step.id === "string" && {
          step: {
            ...subset.step,
            id: InngestExecutionV1._internals.hashId(subset.step.id),
          },
        }),

      // "steps" for "steps-found"
      ...("steps" in subset &&
        Array.isArray(subset.steps) && {
          steps: subset.steps.map((step) => ({
            ...step,
            id: InngestExecutionV1._internals.hashId(step.id),
          })),
        }),
    };

    const processChain = async (targetStepId?: string) => {
      if (finished) {
        return;
      }

      const exec = await this.options.testEngine["individualExecution"]({
        ...runningState,
        targetStepId,
      });

      if (
        exec.result.type === checkpoint &&
        (!sanitizedSubset || isDeeplyEqual(sanitizedSubset, exec.result))
      ) {
        return finish(exec);
      }

      InngestTestRun.updateState(runningState, exec.result);

      const resultHandlers: Record<
        keyof InngestExecution.ExecutionResults,
        () => void
      > = {
        "function-resolved": () => finish(exec),
        "function-rejected": () => finish(exec),
        "step-not-found": () => processChain(),
        "steps-found": () => {
          // run all
          const result =
            exec.result as InngestTestRun.Checkpoint<"steps-found">;

          result.steps.forEach((step) => {
            processChain(step.id);
          });
        },
        "step-ran": () => {
          const result = exec.result as InngestTestRun.Checkpoint<"step-ran">;

          // if this is an error, we should stop. Later we model retries.
          if (result.step.error) {
            return finish(exec);
          }

          processChain();
        },
      };

      resultHandlers[exec.result.type]();
    };

    // kick off
    processChain();

    return promise;
  }

  /**
   * Given existing state and an execution result, mutate the state.
   */
  protected static updateState(
    options: InngestTestEngine.InlineOptions,
    checkpoint: InngestTestRun.Checkpoint<InngestTestRun.CheckpointKey>,
  ): void {
    if (checkpoint.type === "steps-found") {
      const steps = (checkpoint as InngestTestRun.Checkpoint<"steps-found">)
        .steps;

      if (steps.length > 1) {
        options.disableImmediateExecution = true;
      }
    } else if (checkpoint.type === "step-ran") {
      const step = (checkpoint as InngestTestRun.Checkpoint<"step-ran">).step;

      options.steps ??= [];
      options.steps.push({
        id: step.id,
        idIsHashed: true,
        handler: () => {
          if (step.error) {
            throw step.error;
          }

          return step.data;
        },
      });
    }
  }
}
