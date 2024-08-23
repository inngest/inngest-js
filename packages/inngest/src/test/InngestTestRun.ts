import type {
  ExecutionResult,
  ExecutionResults,
} from "../components/execution/InngestExecution";
import { createDeferredPromise } from "../helpers/promises";
import type { InngestTestEngine } from "./InngestTestEngine";

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
    subset?: Partial<InngestTestRun.Checkpoint<T>>
  ): Promise<InngestTestEngine.ExecutionOutput<T>> {
    let finished = false;
    const runningState: InngestTestEngine.InlineOptions = {};

    const { promise, resolve } =
      createDeferredPromise<InngestTestEngine.ExecutionOutput<T>>();

    const finish = (output: InngestTestEngine.ExecutionOutput) => {
      finished = true;
      resolve(output as InngestTestEngine.ExecutionOutput<T>);
    };

    const processChain = async (targetStepId?: string) => {
      if (finished) {
        return;
      }

      const exec = await this.options.testEngine.execute({
        ...runningState,
        targetStepId,
      });

      if (exec.result.type === checkpoint) {
        try {
          if (subset) {
            expect(exec.result).toMatchObject(subset);
          }

          return finish(exec);
        } catch (err) {
          // noop
        }
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
            data: result.step.data,
            error: result.step.error,
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
