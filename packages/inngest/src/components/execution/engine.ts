import { trace } from "@opentelemetry/api";
import hashjs from "hash.js";
import ms, { type StringValue } from "ms";
import { z } from "zod/v3";

import {
  defaultMaxRetries,
  ExecutionVersion,
  headerKeys,
  internalEvents,
} from "../../helpers/consts.ts";

import {
  deserializeError,
  ErrCode,
  serializeError,
} from "../../helpers/errors.js";
import { undefinedToNull } from "../../helpers/functions.js";
import {
  createDeferredPromise,
  createDeferredPromiseWithStack,
  createTimeoutPromise,
  type GoInterval,
  goIntervalTiming,
  resolveAfterPending,
  resolveNextTick,
  retryWithBackoff,
  runAsPromise,
} from "../../helpers/promises.ts";
import * as Temporal from "../../helpers/temporal.ts";
import type { MaybePromise, Simplify } from "../../helpers/types.ts";
import {
  type APIStepPayload,
  type Context,
  type EventPayload,
  type FailureEventArgs,
  type Handler,
  type HashedOp,
  jsonErrorSchema,
  type OutgoingOp,
  StepMode,
  StepOpCode,
} from "../../types.ts";
import { version } from "../../version.ts";
import { createGroupTools } from "../InngestGroupTools.ts";
import type {
  MetadataKind,
  MetadataOpcode,
  MetadataScope,
  MetadataUpdate,
} from "../InngestMetadata.ts";
import {
  createStepTools,
  type FoundStep,
  getStepOptions,
  STEP_INDEXING_SUFFIX,
  type StepHandler,
} from "../InngestStepTools.ts";
import { MiddlewareManager } from "../middleware/index.ts";
import type { Middleware } from "../middleware/middleware.ts";
import { UnreachableError } from "../middleware/utils.ts";
import { NonRetriableError } from "../NonRetriableError.ts";
import { RetryAfterError } from "../RetryAfterError.ts";
import { StepError } from "../StepError.ts";
import { validateEvents } from "../triggers/utils.js";
import { getAsyncCtx, getAsyncLocalStorage } from "./als.ts";
import {
  type ExecutionResult,
  type IInngestExecution,
  InngestExecution,
  type InngestExecutionFactory,
  type InngestExecutionOptions,
  type MemoizedOp,
} from "./InngestExecution.ts";
import { clientProcessorMap } from "./otel/access.ts";

const { sha1 } = hashjs;

/**
 * Retry configuration for checkpoint operations.
 *
 * Checkpoint calls use exponential backoff with jitter to handle transient
 * network failures (e.g., dev server temporarily down, cloud hiccup). If
 * retries exhaust, the error propagates up - for Sync mode this results in a
 * 500 error, for AsyncCheckpointing the caller handles fallback.
 */
const CHECKPOINT_RETRY_OPTIONS = { maxAttempts: 5, baseDelay: 100 };

export const createExecutionEngine: InngestExecutionFactory = (options) => {
  return new InngestExecutionEngine(options);
};

class InngestExecutionEngine
  extends InngestExecution
  implements IInngestExecution
{
  public version = ExecutionVersion.V2;

  private state: ExecutionState;
  private fnArg: Context.Any;
  private checkpointHandlers: CheckpointHandlers;
  private timeoutDuration = 1000 * 10;
  private execution: Promise<ExecutionResult> | undefined;
  private userFnToRun: Handler.Any;
  private middlewareManager: MiddlewareManager;

  /**
   * If we're supposed to run a particular step via `requestedRunStep`, this
   * will be a `Promise` that resolves after no steps have been found for
   * `timeoutDuration` milliseconds.
   *
   * If we're not supposed to run a particular step, this will be `undefined`.
   */
  private timeout?: ReturnType<typeof createTimeoutPromise>;

  /**
   * If we're checkpointing and have been given a maximum runtime, this will be
   * a `Promise` that resolves after that duration has elapsed, allowing us to
   * ensure that we end the execution in good time, especially in serverless
   * environments.
   */
  private checkpointingMaxRuntimeTimer?: ReturnType<
    typeof createTimeoutPromise
  >;

  /**
   * If we're checkpointing and have been given a maximum buffer interval, this
   * will be a `Promise` that resolves after that duration has elapsed, allowing
   * us to periodically checkpoint even if the step buffer hasn't filled.
   */
  private checkpointingMaxBufferIntervalTimer?: ReturnType<
    typeof createTimeoutPromise
  >;

  constructor(rawOptions: InngestExecutionOptions) {
    const options: InngestExecutionOptions = {
      ...rawOptions,
      stepMode: rawOptions.stepMode ?? StepMode.Async,
    };

    super(options);

    /**
     * Check we have everything we need for checkpointing
     */
    if (this.options.stepMode === StepMode.Sync) {
      if (!this.options.createResponse) {
        throw new Error("createResponse is required for sync step mode");
      }
    }

    this.userFnToRun = this.getUserFnToRun();
    this.state = this.createExecutionState();
    this.fnArg = this.createFnArg();

    // Setup middleware
    const mwInstances =
      this.options.middlewareInstances ??
      (this.options.client.middleware || []).map((Cls) => {
        return new Cls({ client: this.options.client });
      });
    const functionInfo: Middleware.FunctionInfo = {
      id: this.options.fn.opts.id,
    };
    this.middlewareManager = new MiddlewareManager(
      this.fnArg,
      () => this.state.stepState,
      mwInstances,
      functionInfo,
      this.options.client.logger,
    );

    this.checkpointHandlers = this.createCheckpointHandlers();
    this.initializeTimer(this.state);
    this.initializeCheckpointRuntimeTimer(this.state);

    this.debug(
      "created new V1 execution for run;",
      this.options.requestedRunStep
        ? `wanting to run step "${this.options.requestedRunStep}"`
        : "discovering steps",
    );

    this.debug("existing state keys:", Object.keys(this.state.stepState));
  }

  /**
   * Idempotently start the execution of the user's function.
   */
  public start() {
    if (!this.execution) {
      this.debug("starting V1 execution");

      const tracer = trace.getTracer("inngest", version);

      this.execution = getAsyncLocalStorage().then((als) => {
        return als.run(
          {
            app: this.options.client,
            execution: {
              ctx: this.fnArg,
              instance: this,
            },
          },
          async () => {
            return tracer.startActiveSpan("inngest.execution", (span) => {
              clientProcessorMap.get(this.options.client)?.declareStartingSpan({
                span,
                runId: this.options.runId,
                traceparent: this.options.headers[headerKeys.TraceParent],
                tracestate: this.options.headers[headerKeys.TraceState],
              });

              return this._start()
                .then((result) => {
                  this.debug("result:", result);
                  return result;
                })
                .finally(() => {
                  span.end();
                });
            });
          },
        );
      });
    }

    return this.execution;
  }

  public addMetadata(
    stepId: string,
    kind: MetadataKind,
    scope: MetadataScope,
    op: MetadataOpcode,
    values: Record<string, unknown>,
  ) {
    if (!this.state.metadata) {
      this.state.metadata = new Map();
    }

    const updates = this.state.metadata.get(stepId) ?? [];
    updates.push({ kind, scope, op, values });
    this.state.metadata.set(stepId, updates);

    return true;
  }

  /**
   * Starts execution of the user's function and the core loop.
   */
  private async _start(): Promise<ExecutionResult> {
    try {
      const allCheckpointHandler = this.getCheckpointHandler("");
      await this.startExecution();

      let i = 0;

      for await (const checkpoint of this.state.loop) {
        await allCheckpointHandler(checkpoint, i);

        const handler = this.getCheckpointHandler(checkpoint.type);
        const result = await handler(checkpoint, i++);

        if (result) {
          return result;
        }
      }
    } catch (error) {
      return this.transformOutput({ error });
    } finally {
      void this.state.loop.return();
    }

    /**
     * If we're here, the generator somehow finished without returning a value.
     * This should never happen.
     */
    throw new Error("Core loop finished without returning a value");
  }

  private async checkpoint(steps: OutgoingOp[]): Promise<void> {
    if (this.options.stepMode === StepMode.Sync) {
      if (!this.state.checkpointedRun) {
        // We have to start the run
        const res = await retryWithBackoff(
          () =>
            this.options.client["inngestApi"].checkpointNewRun({
              runId: this.fnArg.runId,
              event: this.fnArg.event as APIStepPayload,
              steps,
              executionVersion: this.version,
              retries: this.fnArg.maxAttempts ?? defaultMaxRetries,
            }),
          CHECKPOINT_RETRY_OPTIONS,
        );

        this.state.checkpointedRun = {
          appId: res.data.app_id,
          fnId: res.data.fn_id,
          token: res.data.token,
        };
      } else {
        await retryWithBackoff(
          () =>
            this.options.client["inngestApi"].checkpointSteps({
              appId: this.state.checkpointedRun!.appId,
              fnId: this.state.checkpointedRun!.fnId,
              runId: this.fnArg.runId,
              steps,
            }),
          CHECKPOINT_RETRY_OPTIONS,
        );
      }
    } else if (this.options.stepMode === StepMode.AsyncCheckpointing) {
      if (!this.options.queueItemId) {
        throw new Error(
          "Missing queueItemId for async checkpointing. This is a bug in the Inngest SDK.",
        );
      }

      if (!this.options.internalFnId) {
        throw new Error(
          "Missing internalFnId for async checkpointing. This is a bug in the Inngest SDK.",
        );
      }

      await retryWithBackoff(
        () =>
          this.options.client["inngestApi"].checkpointStepsAsync({
            runId: this.fnArg.runId,
            fnId: this.options.internalFnId!,
            queueItemId: this.options.queueItemId!,
            steps,
          }),
        CHECKPOINT_RETRY_OPTIONS,
      );
    } else {
      throw new Error(
        "Checkpointing is only supported in Sync and AsyncCheckpointing step modes. This is a bug in the Inngest SDK.",
      );
    }
  }

  private async checkpointAndSwitchToAsync(
    steps: OutgoingOp[],
  ): Promise<ExecutionResult> {
    await this.checkpoint(steps);

    if (!this.state.checkpointedRun?.token) {
      throw new Error("Failed to checkpoint and switch to async mode");
    }

    return {
      type: "change-mode",
      ctx: this.fnArg,
      ops: this.ops,
      to: StepMode.Async,
      token: this.state.checkpointedRun?.token!,
    };
  }

  /**
   * Returns whether we're in the final attempt of execution, or `null` if we
   * can't determine this in the SDK.
   */
  private inFinalAttempt(): boolean | null {
    if (typeof this.fnArg.maxAttempts !== "number") {
      return null;
    }

    return this.fnArg.attempt + 1 >= this.fnArg.maxAttempts;
  }

  /**
   * Creates a handler for every checkpoint type, defining what to do when we
   * reach that checkpoint in the core loop.
   */
  private createCheckpointHandlers(): CheckpointHandlers {
    const commonCheckpointHandler: CheckpointHandlers[StepMode][""] = (
      checkpoint,
    ) => {
      this.debug(`${this.options.stepMode} checkpoint:`, checkpoint);
    };

    const stepRanHandler = async (
      stepResult: OutgoingOp,
    ): Promise<ExecutionResult> => {
      const transformResult = await this.transformOutput(stepResult);

      /**
       * Transforming output will always return either function rejection or
       * resolution. In most cases, this can be immediately returned, but in
       * this particular case we want to handle it differently.
       */
      if (transformResult.type === "function-resolved") {
        return {
          type: "step-ran",
          ctx: transformResult.ctx,
          ops: transformResult.ops,
          step: {
            ...stepResult,
            data: transformResult.data,
          },
        };
      } else if (transformResult.type === "function-rejected") {
        const stepForResponse = {
          ...stepResult,
          error: transformResult.error,
        };

        if (stepResult.op === StepOpCode.StepFailed) {
          const ser = serializeError(transformResult.error);
          stepForResponse.data = {
            __serialized: true,
            name: ser.name,
            message: ser.message,
            stack: "",
          };
        }

        return {
          type: "step-ran",
          ctx: transformResult.ctx,
          ops: transformResult.ops,
          retriable: transformResult.retriable,
          step: stepForResponse,
        };
      }

      return transformResult;
    };

    const maybeReturnNewSteps = async (): Promise<
      ExecutionResult | undefined
    > => {
      const newSteps = await this.filterNewSteps(
        Array.from(this.state.steps.values()),
      );
      if (newSteps) {
        return {
          type: "steps-found",
          ctx: this.fnArg,
          ops: this.ops,
          steps: newSteps,
        };
      }

      return;
    };

    const attemptCheckpointAndResume = async (
      stepResult?: OutgoingOp,
      resume = true,
      force = false,
    ) => {
      // If we're here, we successfully ran a step, so we may now need
      // to checkpoint it depending on the step buffer configured.
      if (stepResult) {
        const stepToResume = this.resumeStepWithResult(stepResult, resume);

        this.state.checkpointingStepBuffer.push({
          ...stepToResume,
          data: stepResult.data,
        });
      }

      if (
        force ||
        !this.options.checkpointingConfig?.bufferedSteps ||
        this.state.checkpointingStepBuffer.length >=
          this.options.checkpointingConfig.bufferedSteps
      ) {
        this.debug("checkpointing and resuming execution after step run");

        try {
          this.debug(
            `checkpointing all buffered steps:`,
            this.state.checkpointingStepBuffer
              .map((op) => op.displayName || op.id)
              .join(", "),
          );

          return void (await this.checkpoint(
            this.state.checkpointingStepBuffer,
          ));
        } catch (err) {
          // If checkpointing fails for any reason, fall back to the async
          // flow
          this.debug(
            "error checkpointing after step run, so falling back to async",
            err,
          );

          if (stepResult) {
            return stepRanHandler(stepResult);
          }
        } finally {
          // Clear the checkpointing buffer
          this.state.checkpointingStepBuffer = [];
        }
      } else {
        this.debug(
          `not checkpointing yet, continuing execution as we haven't reached buffered step limit of ${this.options.checkpointingConfig?.bufferedSteps}`,
        );
      }

      return;
    };

    const syncHandlers: CheckpointHandlers[StepMode.Sync] = {
      /**
       * Run for all checkpoints. Best used for logging or common actions.
       * Use other handlers to return values and interrupt the core loop.
       */
      "": commonCheckpointHandler,

      "function-resolved": async (checkpoint, i) => {
        await this.checkpoint([
          {
            op: StepOpCode.RunComplete,
            id: _internals.hashId("complete"), // ID is not important here
            data: await this.options.createResponse!(checkpoint.data),
          },
        ]);

        // Apply middleware transformation before returning
        return await this.transformOutput({ data: checkpoint.data });
      },

      "function-rejected": async (checkpoint) => {
        // If the function throws during sync execution, we want to switch to
        // async mode so that we can retry. The exception is that we're already
        // at max attempts, in which case we do actually want to reject.
        if (this.inFinalAttempt()) {
          // Apply middleware transformation before returning
          return await this.transformOutput({ error: checkpoint.error });
        }

        // Otherwise, checkpoint the error and switch to async mode
        return this.checkpointAndSwitchToAsync([
          {
            id: _internals.hashId("complete"), // ID is not important here
            op: StepOpCode.StepError,
            error: checkpoint.error,
          },
        ]);
      },

      "step-not-found": () => {
        return {
          type: "function-rejected",
          ctx: this.fnArg,
          error: new Error(
            "Step not found when checkpointing; this should never happen",
          ),
          ops: this.ops,
          retriable: false,
        };
      },

      "steps-found": async ({ steps }) => {
        // If we're entering parallelism or async mode, checkpoint and switch
        // to async.
        if (steps.length !== 1 || steps[0].mode !== StepMode.Sync) {
          return this.checkpointAndSwitchToAsync(
            steps.map((step) => ({ ...step, id: step.hashedId })),
          );
        }

        // Otherwise we're good to start executing things right now.
        const result = await this.executeStep(steps[0]);

        if (result.error) {
          return this.checkpointAndSwitchToAsync([result]);
        }

        // Resume the step with original data for user code
        const stepToResume = this.resumeStepWithResult(result);

        // Transform data for checkpoint (middleware)
        return void (await this.checkpoint([stepToResume]));
      },

      "checkpointing-runtime-reached": () => {
        return this.checkpointAndSwitchToAsync([
          {
            op: StepOpCode.DiscoveryRequest,
            id: _internals.hashId("discovery-request"), // ID doesn't matter
          },
        ]);
      },

      "checkpointing-buffer-interval-reached": () => {
        return attemptCheckpointAndResume(undefined, false, true);
      },
    };

    const asyncHandlers: CheckpointHandlers[StepMode.Async] = {
      /**
       * Run for all checkpoints. Best used for logging or common actions.
       * Use other handlers to return values and interrupt the core loop.
       */
      "": commonCheckpointHandler,

      /**
       * The user's function has completed and returned a value.
       */
      "function-resolved": async ({ data }) => {
        // Check for unreported new steps (e.g. from `Promise.race` where
        // the winning branch completed before losing branches reported)
        const newStepsResult = await maybeReturnNewSteps();
        if (newStepsResult) {
          return newStepsResult;
        }

        // We need to do this even here for async, as we could be returning
        // data from an API endpoint, even if we were triggered async.
        if (this.options.createResponse) {
          data = await this.options.createResponse(data);
        }

        return await this.transformOutput({ data });
      },

      /**
       * The user's function has thrown an error.
       */
      "function-rejected": async (checkpoint) => {
        return await this.transformOutput({ error: checkpoint.error });
      },

      /**
       * We've found one or more steps. Here we may want to run a step or report
       * them back to Inngest.
       */
      "steps-found": async ({ steps }) => {
        const stepResult = await this.tryExecuteStep(steps);
        if (stepResult) {
          return stepRanHandler(stepResult);
        }

        return maybeReturnNewSteps();
      },

      /**
       * While trying to find a step that Inngest has told us to run, we've
       * timed out or have otherwise decided that it doesn't exist.
       */
      "step-not-found": ({ step }) => {
        return {
          type: "step-not-found",
          ctx: this.fnArg,
          ops: this.ops,
          step,
        };
      },

      "checkpointing-runtime-reached": () => {
        throw new Error(
          "Checkpointing maximum runtime reached, but this is not in a checkpointing step mode. This is a bug in the Inngest SDK.",
        );
      },

      "checkpointing-buffer-interval-reached": () => {
        throw new Error(
          "Checkpointing maximum buffer interval reached, but this is not in a checkpointing step mode. This is a bug in the Inngest SDK.",
        );
      },
    };

    const asyncCheckpointingHandlers: CheckpointHandlers[StepMode.AsyncCheckpointing] =
      {
        "": commonCheckpointHandler,
        "function-resolved": async (checkpoint, i) => {
          const output = await asyncHandlers["function-resolved"](
            checkpoint,
            i,
          );
          if (output?.type === "function-resolved") {
            const steps = this.state.checkpointingStepBuffer.concat({
              op: StepOpCode.RunComplete,
              id: _internals.hashId("complete"), // ID is not important here
              data: output.data,
            });

            if (isNonEmpty(steps)) {
              return {
                type: "steps-found",
                ctx: output.ctx,
                ops: output.ops,
                steps,
              };
            }
          }

          return;
        },
        "function-rejected": async (checkpoint) => {
          // If we have buffered steps, attempt checkpointing them first
          if (this.state.checkpointingStepBuffer.length) {
            await attemptCheckpointAndResume(undefined, false);
          }

          return await this.transformOutput({ error: checkpoint.error });
        },
        "step-not-found": asyncHandlers["step-not-found"],
        "steps-found": async ({ steps }) => {
          // Note that if we have a requested run step, we'll never be
          // checkpointing, as that's an async parallel execution mode.

          // Break found steps in to { stepsToResume, newSteps }
          const { stepsToResume, newSteps } = steps.reduce(
            (acc, step) => {
              if (!step.hasStepState) {
                acc.newSteps.push(step);
              } else if (!step.fulfilled) {
                acc.stepsToResume.push(step);
              }

              return acc;
            },
            { stepsToResume: [], newSteps: [] } as {
              stepsToResume: FoundStep[];
              newSteps: FoundStep[];
            },
          );

          this.debug("split found steps in to:", {
            stepsToResume: stepsToResume.length,
            newSteps: newSteps.length,
          });

          // Got new steps? Exit early.
          if (!this.options.requestedRunStep && newSteps.length) {
            const stepResult = await this.tryExecuteStep(newSteps);
            if (stepResult) {
              this.debug(`executed step "${stepResult.id}" successfully`);

              // We executed a step!
              //
              // We know that because we're in this mode, we're always free to
              // checkpoint and continue if we ran a step and it was successful.
              if (stepResult.error) {
                // If we failed, go back to the regular async flow.
                return stepRanHandler(stepResult);
              }

              // If we're here, we successfully ran a step, so we may now need
              // to checkpoint it depending on the step buffer configured.
              return await attemptCheckpointAndResume(stepResult);
            }

            return maybeReturnNewSteps();
          }

          // If we have stepsToResume, resume as many as possible and resume execution
          if (stepsToResume.length) {
            this.debug(`resuming ${stepsToResume.length} steps`);

            for (const st of stepsToResume) {
              this.resumeStepWithResult({
                ...st,
                id: st.hashedId,
              });
            }
          }

          return;
        },
        "checkpointing-runtime-reached": async () => {
          return {
            type: "steps-found",
            ctx: this.fnArg,
            ops: this.ops,
            steps: [
              {
                op: StepOpCode.DiscoveryRequest,
                id: _internals.hashId("discovery-request"), // ID doesn't matter
              },
            ],
          };
        },

        "checkpointing-buffer-interval-reached": () => {
          return attemptCheckpointAndResume(undefined, false, true);
        },
      };

    return {
      [StepMode.Async]: asyncHandlers,
      [StepMode.Sync]: syncHandlers,
      [StepMode.AsyncCheckpointing]: asyncCheckpointingHandlers,
    };
  }

  private getCheckpointHandler(type: keyof CheckpointHandlers[StepMode]) {
    return this.checkpointHandlers[this.options.stepMode][type] as (
      checkpoint: Checkpoint,
      iteration: number,
    ) => MaybePromise<ExecutionResult | undefined>;
  }

  private async tryExecuteStep(
    steps: FoundStep[],
  ): Promise<OutgoingOp | undefined> {
    const hashedStepIdToRun =
      this.options.requestedRunStep || this.getEarlyExecRunStep(steps);
    if (!hashedStepIdToRun) {
      return;
    }

    const step = steps.find(
      (step) => step.hashedId === hashedStepIdToRun && step.fn,
    );

    if (step) {
      return await this.executeStep(step);
    }

    /**
     * Ensure we reset the timeout if we have a requested run step but couldn't
     * find it, but also that we don't reset if we found and executed it.
     */
    return void this.timeout?.reset();
  }

  /**
   * Given a list of outgoing ops, decide if we can execute an op early and
   * return the ID of the step to execute if we can.
   */
  private getEarlyExecRunStep(steps: FoundStep[]): string | undefined {
    /**
     * We may have been disabled due to parallelism, in which case we can't
     * immediately execute unless explicitly requested.
     */
    if (this.options.disableImmediateExecution) return;

    const unfulfilledSteps = steps.filter((step) => !step.fulfilled);
    if (unfulfilledSteps.length !== 1) return;

    const op = unfulfilledSteps[0];

    if (
      op &&
      op.op === StepOpCode.StepPlanned
      // TODO We must individually check properties here that we do not want to
      // execute on, such as retry counts. Nothing exists here that falls in to
      // this case, but should be accounted for when we add them.
      // && typeof op.opts === "undefined"
    ) {
      return op.hashedId;
    }

    return;
  }

  private async filterNewSteps(
    foundSteps: FoundStep[],
  ): Promise<[OutgoingOp, ...OutgoingOp[]] | undefined> {
    if (this.options.requestedRunStep) {
      return;
    }

    const newSteps = foundSteps.reduce((acc, step) => {
      if (!step.hasStepState) {
        acc.push(step);
      }

      return acc;
    }, [] as FoundStep[]);

    if (!newSteps.length) {
      return;
    }

    await this.middlewareManager.onMemoizationEnd();

    const stepList = newSteps.map<OutgoingOp>((step) => {
      return {
        displayName: step.displayName,
        op: step.op,
        id: step.hashedId,
        name: step.name,
        opts: step.opts,
        userland: step.userland,
      };
    });

    if (!isNonEmpty(stepList)) {
      throw new UnreachableError("stepList is empty");
    }

    return stepList;
  }

  private async executeStep(foundStep: FoundStep): Promise<OutgoingOp> {
    const { id, name, opts, fn, displayName, userland, hashedId } = foundStep;
    const { stepInfo, wrappedHandler, setActualHandler } = foundStep.middleware;

    this.debug(`preparing to execute step "${id}"`);

    this.timeout?.clear();

    const outgoingOp: OutgoingOp = {
      id: hashedId,
      op: StepOpCode.StepRun,
      name,
      opts,
      displayName,
      userland,
    };
    this.state.executingStep = outgoingOp;

    const store = await getAsyncCtx();

    if (store?.execution) {
      store.execution.executingStep = {
        id,
        name: displayName,
      };
    }

    this.debug(`executing step "${id}"`);

    let interval: GoInterval | undefined;

    // `fn` already has middleware-transformed args baked in via `fnArgs` (i.e.
    // the `transformStepInput` middleware hook already ran).
    const actualHandler = () => runAsPromise(fn);

    await this.middlewareManager.onMemoizationEnd();
    await this.middlewareManager.onStepStart(stepInfo);

    // If wrappedHandler hasn't been called yet (no deferred from discovery),
    // set one up so wrapStep's next() still blocks until memoization.
    if (!foundStep.memoizationDeferred) {
      const deferred = createDeferredPromise<unknown>();
      foundStep.memoizationDeferred = deferred;
      setActualHandler(() => deferred.promise);
      foundStep.transformedResultPromise = wrappedHandler();
      foundStep.transformedResultPromise.catch(() => {
        // Swallow — errors handled by handle()
      });
    }

    // Build wrapStepHandler chain around the actual handler
    const wrappedActualHandler =
      this.middlewareManager.buildWrapStepHandlerChain(actualHandler, stepInfo);

    return goIntervalTiming(() => wrappedActualHandler())
      .finally(() => {
        this.debug(`finished executing step "${id}"`);

        delete this.state.executingStep;
        if (store?.execution) {
          delete store.execution.executingStep;
        }
      })
      .then<OutgoingOp>(async ({ resultPromise, interval: _interval }) => {
        interval = _interval;
        const metadata = this.state.metadata?.get(id);
        const serverData = await resultPromise;

        // Don't resolve memoizationDeferred here. wrapStep's next() must
        // block until the step is actually memoized (i.e. handle() fires
        // with confirmed data from the server). handle() resolves it.
        await this.middlewareManager.onStepComplete(stepInfo, serverData);

        return {
          ...outgoingOp,
          data: serverData,
          ...(metadata && metadata.length > 0 ? { metadata: metadata } : {}),
        };
      })
      .catch<OutgoingOp>((error) => {
        // Don't reject memoizationDeferred — handle() will reject it when
        // the error is memoized.
        return this.buildStepErrorOp({
          error,
          id,
          outgoingOp,
          stepInfo,
        });
      })
      .then((op) => ({
        ...op,
        timing: interval,
      }));
  }

  /**
   * Starts execution of the user's function, including triggering checkpoints
   * and middleware hooks where appropriate.
   */
  private async startExecution(): Promise<void> {
    /**
     * Start the timer to time out the run if needed.
     */
    void this.timeout?.start();
    void this.checkpointingMaxRuntimeTimer?.start();
    void this.checkpointingMaxBufferIntervalTimer?.start();

    const fnInputResult = await this.middlewareManager.transformFunctionInput();
    this.applyFunctionInputMutations(fnInputResult);

    if (this.state.allStateUsed()) {
      await this.middlewareManager.onMemoizationEnd();
    }

    if (this.state.stepsToFulfill === 0 && this.fnArg.attempt === 0) {
      await this.middlewareManager.onRunStart();
    }

    const innerHandler: () => Promise<unknown> = async () => {
      await this.validateEventSchemas();
      return this.userFnToRun(this.fnArg);
    };

    const runHandler = this.middlewareManager.wrapRunHandler(innerHandler);

    runAsPromise(runHandler)
      .then(async (data) => {
        await this.middlewareManager.onRunComplete(data);
        this.state.setCheckpoint({ type: "function-resolved", data });
      })
      .catch(async (error) => {
        // Preserve Error instances; stringify non-Error throws (e.g. `throw {}`)
        let err: Error;
        if (error instanceof Error) {
          err = error;
        } else if (typeof error === "object") {
          err = new Error(JSON.stringify(error));
        } else {
          err = new Error(String(error));
        }

        await this.middlewareManager.onRunError(err, this.isFinalAttempt(err));
        this.state.setCheckpoint({ type: "function-rejected", error: err });
      });
  }

  /**
   * Whether this error will not be retried (NonRetriableError or last attempt).
   */
  private isFinalAttempt(error: unknown): boolean {
    if (
      error instanceof NonRetriableError ||
      // biome-ignore lint/suspicious/noExplicitAny: instanceof fails across module boundaries
      (error as any)?.name === "NonRetriableError"
    ) {
      return true;
    }

    return Boolean(
      this.fnArg.maxAttempts &&
        this.fnArg.maxAttempts - 1 === this.fnArg.attempt,
    );
  }

  /**
   * Build the OutgoingOp for a failed step, notifying middleware and choosing
   * retriable vs non-retriable opcode.
   */
  private async buildStepErrorOp({
    error,
    id,
    outgoingOp,
    stepInfo,
  }: {
    error: unknown;
    id: string;
    outgoingOp: OutgoingOp;
    stepInfo: Middleware.StepInfo;
  }): Promise<OutgoingOp> {
    const isFinal = this.isFinalAttempt(error);
    const metadata = this.state.metadata?.get(id);

    await this.middlewareManager.onStepError(
      stepInfo,
      error instanceof Error ? error : new Error(String(error)),
      isFinal,
    );

    return {
      ...outgoingOp,
      error,
      op: isFinal ? StepOpCode.StepFailed : StepOpCode.StepError,
      ...(metadata && metadata.length > 0 ? { metadata } : {}),
    };
  }

  /**
   * Validate event data against schemas defined in function triggers.
   */
  private async validateEventSchemas(): Promise<void> {
    const triggers = this.options.fn.opts.triggers;
    if (!triggers || triggers.length === 0) return;

    const fnArgEvents = this.fnArg.events;
    if (!fnArgEvents || fnArgEvents.length === 0) return;

    const events = fnArgEvents.map((event) => ({
      name: event.name,
      data: event.data,
    }));

    await validateEvents(events, triggers);
  }

  /**
   * Using middleware, transform output before returning.
   */
  private transformOutput(dataOrError: {
    data?: unknown;
    error?: unknown;
  }): ExecutionResult {
    const { data, error } = dataOrError;

    if (typeof error !== "undefined") {
      /**
       * Ensure we give middleware the chance to decide on retriable behaviour
       * by looking at the error returned from output transformation.
       */
      let retriable: boolean | string = !(
        error instanceof NonRetriableError ||
        // biome-ignore lint/suspicious/noExplicitAny: instanceof fails across module boundaries
        (error as any)?.name === "NonRetriableError" ||
        (error instanceof StepError &&
          error === this.state.recentlyRejectedStepError)
      );
      if (
        retriable &&
        (error instanceof RetryAfterError ||
          // biome-ignore lint/suspicious/noExplicitAny: instanceof fails across module boundaries
          (error as any)?.name === "RetryAfterError")
      ) {
        retriable = (error as RetryAfterError).retryAfter;
      }

      const serializedError = serializeError(error);

      return {
        type: "function-rejected",
        ctx: this.fnArg,
        ops: this.ops,
        error: serializedError,
        retriable,
      };
    }

    return {
      type: "function-resolved",
      ctx: this.fnArg,
      ops: this.ops,
      data: undefinedToNull(data),
    };
  }

  private createExecutionState(): ExecutionState {
    const d = createDeferredPromiseWithStack<Checkpoint>();
    let checkpointResolve = d.deferred.resolve;
    const checkpointResults = d.results;

    const loop: ExecutionState["loop"] = (async function* (
      cleanUp?: () => void,
    ) {
      try {
        while (true) {
          const res = (await checkpointResults.next()).value;
          if (res) {
            yield res;
          }
        }
      } finally {
        cleanUp?.();
      }
    })(() => {
      this.timeout?.clear();
      this.checkpointingMaxRuntimeTimer?.clear();
      this.checkpointingMaxBufferIntervalTimer?.clear();
      void checkpointResults.return();
    });

    const stepsToFulfill = Object.keys(this.options.stepState).length;

    const state: ExecutionState = {
      stepState: this.options.stepState,
      stepsToFulfill,
      steps: new Map(),
      loop,
      hasSteps: Boolean(stepsToFulfill),
      stepCompletionOrder: [...this.options.stepCompletionOrder],
      remainingStepsToBeSeen: new Set(this.options.stepCompletionOrder),
      setCheckpoint: (checkpoint: Checkpoint) => {
        this.debug("setting checkpoint:", checkpoint.type);

        ({ resolve: checkpointResolve } = checkpointResolve(checkpoint));
      },
      allStateUsed: () => {
        return this.state.remainingStepsToBeSeen.size === 0;
      },
      checkpointingStepBuffer: [],
      metadata: new Map(),
    };

    return state;
  }

  get ops(): Record<string, MemoizedOp> {
    return Object.fromEntries(this.state.steps);
  }

  private createFnArg(): Context.Any {
    const step = this.createStepTools();

    let fnArg = {
      ...(this.options.data as { event: EventPayload }),
      step,
      group: createGroupTools(),
    } as Context.Any;

    /**
     * Handle use of the `onFailure` option by deserializing the error.
     */
    if (this.options.isFailureHandler) {
      const eventData = z
        .object({ error: jsonErrorSchema })
        .parse(fnArg.event?.data);

      (fnArg as Partial<Pick<FailureEventArgs, "error">>) = {
        ...fnArg,
        error: deserializeError(eventData.error),
      };
    }

    return this.options.transformCtx?.(fnArg) ?? fnArg;
  }

  /**
   * Apply mutations from `transformFunctionInput` back to execution state.
   * Allows middleware to modify event data, step tools, memoized step data,
   * and inject custom fields into the handler context.
   */
  private applyFunctionInputMutations(
    result: Middleware.TransformFunctionInputArgs,
  ): void {
    const { event, events, step, ...extensions } = result.ctx;

    // Mutate in place so the ALS store's reference to this.fnArg stays valid.
    if (event !== this.fnArg.event) {
      this.fnArg.event = event;
    }

    if (events !== this.fnArg.events) {
      this.fnArg.events = events;
    }

    if (step !== this.fnArg.step) {
      this.fnArg.step = step;
    }

    if (Object.keys(extensions).length > 0) {
      Object.assign(this.fnArg, extensions);
    }

    // Apply step data mutations
    for (const [hashedId, stepData] of Object.entries(result.steps)) {
      const existing = this.state.stepState[hashedId];
      if (
        existing &&
        stepData &&
        stepData.type === "data" &&
        stepData.data !== existing.data
      ) {
        this.state.stepState[hashedId] = { ...existing, data: stepData.data };
      }
    }
  }

  private createStepTools(): ReturnType<typeof createStepTools> {
    /**
     * A list of steps that have been found and are being rolled up before being
     * reported to the core loop.
     */
    const foundStepsToReport: Map<string, FoundStep> = new Map();

    /**
     * A map of the subset of found steps to report that have not yet been
     * handled. Used for fast access to steps that need to be handled in order.
     */
    const unhandledFoundStepsToReport: Map<string, FoundStep> = new Map();

    /**
     * A map of the latest sequential step indexes found for each step ID. Used
     * to ensure that we don't index steps in parallel.
     *
     * Note that these must be sequential; if we've seen or assigned `a:1`,
     * `a:2` and `a:4`, the latest sequential step index is `2`.
     *
     */
    const expectedNextStepIndexes: Map<string, number> = new Map();

    /**
     * An ordered list of step IDs that have yet to be handled in this
     * execution. Used to ensure that we handle steps in the order they were
     * found and based on the `stepCompletionOrder` in this execution's state.
     */
    const remainingStepCompletionOrder: string[] =
      this.state.stepCompletionOrder.slice();

    /**
     * A promise that's used to ensure that step reporting cannot be run more than
     * once in a given asynchronous time span.
     */
    let foundStepsReportPromise: Promise<void> | undefined;

    /**
     * A flag used to ensure that we only warn about parallel indexing once per
     * execution to avoid spamming the console.
     */
    let warnOfParallelIndexing = false;

    /**
     * Counts the number of times we've extended this tick.
     */
    let tickExtensionCount = 0;

    /**
     * Given a colliding step ID, maybe warn the user about parallel indexing.
     */
    const maybeWarnOfParallelIndexing = (userlandCollisionId: string) => {
      if (warnOfParallelIndexing) {
        return;
      }

      const hashedCollisionId = _internals.hashId(userlandCollisionId);

      const stepExists = this.state.steps.has(hashedCollisionId);
      if (stepExists) {
        const stepFoundThisTick = foundStepsToReport.has(hashedCollisionId);
        if (!stepFoundThisTick) {
          warnOfParallelIndexing = true;

          this.options.client["warnMetadata"](
            { run_id: this.fnArg.runId },
            ErrCode.AUTOMATIC_PARALLEL_INDEXING,
            {
              message: `Duplicate step ID "${userlandCollisionId}" detected across parallel chains`,
              explanation:
                "Using the same ID for steps in different parallel chains can cause unexpected behaviour. Your function is still running.",
              action:
                "Use a unique ID for each step, especially those in parallel.",
              code: ErrCode.AUTOMATIC_PARALLEL_INDEXING,
            },
          );
        }
      }
    };

    /**
     * A helper used to report steps to the core loop. Used after adding an item
     * to `foundStepsToReport`.
     */
    const reportNextTick = () => {
      // Being explicit instead of using `??=` to appease TypeScript.
      if (foundStepsReportPromise) {
        return;
      }

      let extensionPromise: Promise<void>;
      if (++tickExtensionCount >= 10) {
        tickExtensionCount = 0;
        extensionPromise = resolveNextTick();
      } else {
        extensionPromise = resolveAfterPending();
      }

      foundStepsReportPromise = extensionPromise.then(() => {
        foundStepsReportPromise = undefined;

        for (let i = 0; i < remainingStepCompletionOrder.length; i++) {
          const nextStepId = remainingStepCompletionOrder[i];
          if (!nextStepId) {
            // Strange - skip this empty index
            continue;
          }

          const handled = unhandledFoundStepsToReport.get(nextStepId)?.handle();
          if (handled) {
            remainingStepCompletionOrder.splice(i, 1);
            unhandledFoundStepsToReport.delete(nextStepId);
            return void reportNextTick();
          }
        }

        // If we've handled no steps in this "tick," roll up everything we've
        // found and report it.
        const steps = [...foundStepsToReport.values()];
        foundStepsToReport.clear();
        unhandledFoundStepsToReport.clear();

        if (!isNonEmpty(steps)) {
          return;
        }

        return void this.state.setCheckpoint({
          type: "steps-found",
          steps: steps,
        });
      });
    };

    /**
     * A helper used to push a step to the list of steps to report.
     */
    const pushStepToReport = (step: FoundStep) => {
      foundStepsToReport.set(step.hashedId, step);
      unhandledFoundStepsToReport.set(step.hashedId, step);
      reportNextTick();
    };

    const stepHandler: StepHandler = async ({
      args,
      matchOp,
      opts,
    }): Promise<unknown> => {
      const stepOptions = getStepOptions(args[0]);
      const opId = matchOp(stepOptions, ...args.slice(1));

      if (this.state.executingStep) {
        /**
         * If a step is found after asynchronous actions during another step's
         * execution, everything is fine. The problem here is if we've found
         * that a step nested inside another a step, which is something we don't
         * support at the time of writing.
         *
         * In this case, we could use something like Async Hooks to understand
         * how the step is being triggered, though this isn't available in all
         * environments.
         *
         * Therefore, we'll only show a warning here to indicate that this is
         * potentially an issue.
         */
        this.options.client["warnMetadata"](
          { run_id: this.fnArg.runId },
          ErrCode.NESTING_STEPS,
          {
            message: `Nested step tooling detected in "${opId.displayName ?? opId.id}"`,
            explanation:
              "Nesting step.* calls is not supported. This warning may also appear if steps are separated by regular async calls, which is fine.",
            action:
              "Avoid using step.* inside other step.* calls. Use a separate async function or promise chaining to compose steps.",
            code: ErrCode.NESTING_STEPS,
          },
        );
      }

      // Apply middleware transformations (may change step ID, affecting
      // memoization lookup)
      const {
        hashedId,
        isFulfilled,
        setActualHandler,
        stepInfo,
        stepState,
        wrappedHandler,
      } = await this.applyMiddlewareToStep(
        opId,
        expectedNextStepIndexes,
        maybeWarnOfParallelIndexing,
      );

      const { promise, resolve, reject } = createDeferredPromise();

      let extraOpts: Record<string, unknown> | undefined;
      let fnArgs = [...args];

      if (
        typeof stepState?.input !== "undefined" &&
        Array.isArray(stepState.input)
      ) {
        switch (opId.op) {
          // `step.run()` has its function input affected
          case StepOpCode.StepPlanned: {
            fnArgs = [...args.slice(0, 2), ...stepState.input];

            extraOpts = { input: [...stepState.input] };
            break;
          }

          // `step.ai.infer()` has its body affected
          case StepOpCode.AiGateway: {
            extraOpts = {
              body: {
                ...(typeof opId.opts?.body === "object"
                  ? { ...opId.opts.body }
                  : {}),
                ...stepState.input[0],
              },
            };
            break;
          }
        }
      }

      // If transformStepInput middleware may have changed the input, update
      // `fnArgs` so `fn` uses the transformed values. Skip if replay already
      // set `extraOpts`.
      if (!extraOpts && Array.isArray(stepInfo.input)) {
        fnArgs = [...args.slice(0, 2), ...stepInfo.input];
      }

      const step: FoundStep = {
        ...opId,
        opts: { ...opId.opts, ...extraOpts },
        rawArgs: fnArgs,
        hashedId,
        input: stepState?.input,

        fn: opts?.fn ? () => opts.fn?.(this.fnArg, ...fnArgs) : undefined,
        promise,
        fulfilled: isFulfilled,
        hasStepState: Boolean(stepState),
        displayName: opId.displayName ?? opId.id,
        handled: false,

        // Middleware context for deferred handler pattern
        middleware: {
          wrappedHandler,
          stepInfo,
          setActualHandler,
        },

        handle: () => {
          if (step.handled) {
            return false;
          }

          this.debug(`handling step "${hashedId}"`);

          step.handled = true;

          // Refetch step state because it may have been changed since we found
          // the step. This could be due to checkpointing, where we run this
          // live and then return to the function.
          const result = this.state.stepState[hashedId];

          if (step.fulfilled && result) {
            result.fulfilled = true;

            // For some execution scenarios such as testing, `data`, `error`,
            // and `input` may be `Promises`. This could also be the case for
            // future middleware applications. For this reason, we'll make sure
            // the values are fully resolved before continuing.
            void Promise.all([result.data, result.error, result.input]).then(
              async () => {
                // If the wrapStep chain already ran during discovery in this
                // same request (checkpointing), reuse its result instead of
                // firing wrappedHandler() again. This prevents middleware from
                // seeing a duplicate wrapStep call per step per request.
                if (step.transformedResultPromise) {
                  // Resolve the memoization deferred so wrapStep's next()
                  // unblocks. The step data is now confirmed memoized.
                  if (step.memoizationDeferred) {
                    if (typeof result.data !== "undefined") {
                      step.memoizationDeferred.resolve(await result.data);
                    } else {
                      const stepError = new StepError(opId.id, result.error);
                      this.state.recentlyRejectedStepError = stepError;
                      step.memoizationDeferred.reject(stepError);
                    }
                  }

                  step.transformedResultPromise.then(resolve, reject);
                  return;
                }

                // The wrapStep chain is about to fire again to resolve the
                // step promise through middleware (e.g. deserialization).
                // Mark the step as memoized so middleware can distinguish
                // this from the original execution call.
                //
                // This need for this change was discovered when checkpointing +
                // middleware's "double `wrapStep` call" behavior had `memoized:
                // false` on the 2nd call
                step.middleware.stepInfo.memoized = true;

                if (typeof result.data !== "undefined") {
                  // Validate waitForEvent results against the schema if present
                  // Skip validation if result.data is null (timeout case)
                  if (
                    opId.op === StepOpCode.WaitForEvent &&
                    result.data !== null
                  ) {
                    const { event } = (step.rawArgs?.[1] ?? {}) as {
                      event: unknown;
                    };
                    if (!event) {
                      // Unreachable
                      throw new Error("Missing event option in waitForEvent");
                    }
                    try {
                      await validateEvents(
                        [result.data],

                        // @ts-expect-error - This is a full event object at runtime
                        [{ event }],
                      );
                    } catch (err) {
                      this.state.recentlyRejectedStepError = new StepError(
                        opId.id,
                        err,
                      );
                      reject(this.state.recentlyRejectedStepError);
                      return;
                    }
                  }

                  // Set inner handler to return memoized data
                  step.middleware.setActualHandler(() =>
                    Promise.resolve(result.data),
                  );

                  step.middleware.wrappedHandler().then(resolve);
                } else {
                  const stepError = new StepError(opId.id, result.error);
                  this.state.recentlyRejectedStepError = stepError;

                  // Set inner handler to reject with step error
                  step.middleware.setActualHandler(() =>
                    Promise.reject(stepError),
                  );

                  step.middleware.wrappedHandler().catch(reject);
                }
              },
            );
          }

          return true;
        },
      };

      this.state.steps.set(hashedId, step);
      this.state.hasSteps = true;

      const isNewStepWithHandler = !isFulfilled && !stepState && step.fn;
      if (isNewStepWithHandler) {
        // New, never-seen step with a handler (e.g. `step.run`). Kick off the
        // middleware wrapStep chain now so it runs during discovery, not later
        // in executeStep.
        //
        // This is necessary so that middleware can inject their own steps.
        // Reporting is deferred to the center of the onion so that if
        // middleware throws or injects prerequisites, the step is never
        // reported.
        const deferred = createDeferredPromise<unknown>();
        step.memoizationDeferred = deferred;

        setActualHandler(() => {
          pushStepToReport(step);
          return deferred.promise;
        });

        step.transformedResultPromise = wrappedHandler();
        step.transformedResultPromise.catch((error) => {
          reject(error);
        });
      } else {
        pushStepToReport(step);
      }

      return promise;
    };

    return createStepTools(this.options.client, this, stepHandler);
  }

  /**
   * Applies middleware transformations to a step, resolves ID collisions,
   * and performs memoization lookup.
   */
  private async applyMiddlewareToStep(
    opId: HashedOp,
    expectedNextStepIndexes: Map<string, number>,
    maybeWarnOfParallelIndexing: (userlandCollisionId: string) => void,
  ): Promise<MiddlewareApplicationResult> {
    // 1. Resolve initial collision with original ID
    const initialCollision = resolveStepIdCollision({
      baseId: opId.id,
      expectedIndexes: expectedNextStepIndexes,
      stepsMap: this.state.steps,
    });
    if (initialCollision.finalId !== opId.id) {
      maybeWarnOfParallelIndexing(opId.id);
      opId.id = initialCollision.finalId;
      if (initialCollision.index !== undefined) {
        opId.userland.index = initialCollision.index;
      }
    }

    const originalId = opId.userland.id;
    let hashedId = _internals.hashId(opId.id);

    // 2. Apply middleware (stepType, input extraction, deferred handler).
    //    Pass preliminary memoization status so middleware sees it.
    const prepared = await this.middlewareManager.applyToStep({
      displayName: opId.displayName ?? opId.userland.id,
      hashedId,
      memoized:
        Boolean(this.state.stepState[hashedId]) &&
        typeof this.state.stepState[hashedId]?.input === "undefined",
      op: opId.op,
      opts: opId.opts,
      userlandId: opId.userland.id,
    });
    const { entryPoint, opName, opOpts, setActualHandler, stepInfo } = prepared;

    if (opName !== undefined) {
      opId.name = opName;
    }
    if (opOpts !== undefined) {
      opId.opts = opOpts;
    }

    // 3. If middleware changed the step ID, re-resolve collisions
    if (stepInfo.options.id !== originalId) {
      opId.id = stepInfo.options.id;
      opId.userland.id = stepInfo.options.id;

      const secondCollision = resolveStepIdCollision({
        baseId: stepInfo.options.id,
        expectedIndexes: expectedNextStepIndexes,
        stepsMap: this.state.steps,
      });
      if (secondCollision.finalId !== stepInfo.options.id) {
        opId.id = secondCollision.finalId;
        opId.userland.id = secondCollision.finalId;
        stepInfo.options.id = secondCollision.finalId;
        if (secondCollision.index !== undefined) {
          opId.userland.index = secondCollision.index;
        }
      }

      // Recompute hashedId with final ID
      hashedId = _internals.hashId(opId.id);
      stepInfo.hashedId = hashedId;
    }

    // 4. Final memoization lookup with potentially modified hashedId.
    //    Also marks step as seen and may trigger onMemoizationEnd.
    const stepState = this.state.stepState[hashedId];
    let isFulfilled = false;
    if (stepState) {
      stepState.seen = true;
      this.state.remainingStepsToBeSeen.delete(hashedId);

      if (this.state.allStateUsed()) {
        await this.middlewareManager.onMemoizationEnd();
      }

      if (typeof stepState.input === "undefined") {
        isFulfilled = true;
      }
      stepInfo.memoized = isFulfilled;
    } else {
      stepInfo.memoized = false;
    }

    // 5. Build wrapStep chain after all mutations so middleware sees final values
    const wrappedHandler = this.middlewareManager.buildWrapStepChain(
      entryPoint,
      stepInfo,
    );

    return {
      hashedId,
      stepInfo,
      wrappedHandler,
      setActualHandler,
      stepState,
      isFulfilled,
    };
  }

  private resumeStepWithResult(resultOp: OutgoingOp, resume = true): FoundStep {
    const userlandStep = this.state.steps.get(resultOp.id);
    if (!userlandStep) {
      throw new Error(
        "Step not found in memoization state during async checkpointing; this should never happen and is a bug in the Inngest SDK",
      );
    }

    const data = undefinedToNull(resultOp.data);

    userlandStep.data = data;
    userlandStep.timing = resultOp.timing;
    userlandStep.op = resultOp.op;
    userlandStep.id = resultOp.id;

    if (resume) {
      userlandStep.fulfilled = true;
      userlandStep.hasStepState = true;
      this.state.stepState[resultOp.id] = userlandStep;

      userlandStep.handle();
    }

    return userlandStep;
  }

  private getUserFnToRun(): Handler.Any {
    if (!this.options.isFailureHandler) {
      return this.options.fn["fn"];
    }

    if (!this.options.fn["onFailureFn"]) {
      /**
       * Somehow, we've ended up detecting that this is a failure handler but
       * doesn't have an `onFailure` function. This should never happen.
       */
      throw new Error("Cannot find function `onFailure` handler");
    }

    return this.options.fn["onFailureFn"];
  }

  private initializeTimer(state: ExecutionState): void {
    if (!this.options.requestedRunStep) {
      return;
    }

    this.timeout = createTimeoutPromise(this.timeoutDuration);

    void this.timeout.then(async () => {
      await this.middlewareManager.onMemoizationEnd();
      state.setCheckpoint({
        type: "step-not-found",
        step: {
          id: this.options.requestedRunStep as string,
          op: StepOpCode.StepNotFound,
        },
      });
    });
  }

  private initializeCheckpointRuntimeTimer(state: ExecutionState): void {
    this.debug(
      "initializing checkpointing runtime timers",
      this.options.checkpointingConfig,
    );

    if (this.options.checkpointingConfig?.maxRuntime) {
      const maxRuntimeMs = Temporal.isTemporalDuration(
        this.options.checkpointingConfig.maxRuntime,
      )
        ? this.options.checkpointingConfig.maxRuntime.total({
            unit: "milliseconds",
          })
        : typeof this.options.checkpointingConfig.maxRuntime === "string"
          ? ms(this.options.checkpointingConfig.maxRuntime as StringValue) // type assertion to satisfy ms package
          : (this.options.checkpointingConfig.maxRuntime as number);

      // 0 or negative max runtime? Skip.
      if (Number.isFinite(maxRuntimeMs) && maxRuntimeMs > 0) {
        this.checkpointingMaxRuntimeTimer = createTimeoutPromise(maxRuntimeMs);

        void this.checkpointingMaxRuntimeTimer.then(async () => {
          await this.middlewareManager.onMemoizationEnd();
          state.setCheckpoint({
            type: "checkpointing-runtime-reached",
          });
        });
      }
    }

    if (this.options.checkpointingConfig?.maxInterval) {
      const maxIntervalMs = Temporal.isTemporalDuration(
        this.options.checkpointingConfig.maxInterval,
      )
        ? this.options.checkpointingConfig.maxInterval.total({
            unit: "milliseconds",
          })
        : typeof this.options.checkpointingConfig.maxInterval === "string"
          ? ms(this.options.checkpointingConfig.maxInterval as StringValue) // type assertion to satisfy ms package
          : (this.options.checkpointingConfig.maxInterval as number);

      // 0 or negative max interval? Skip.
      if (Number.isFinite(maxIntervalMs) && maxIntervalMs > 0) {
        this.checkpointingMaxBufferIntervalTimer =
          createTimeoutPromise(maxIntervalMs);

        void this.checkpointingMaxBufferIntervalTimer.then(async () => {
          // Note that this will not immediately run; it will be queued like all
          // other checkpoints so that we're never running multiple checkpoints
          // at the same time and it's easier to reason about those decision
          // points.
          //
          // A change in the future may be to make this particular checkpointing
          // action immediate and have the checkpoint action itself be
          // idempotent.
          state.setCheckpoint({
            type: "checkpointing-buffer-interval-reached",
          });

          this.checkpointingMaxBufferIntervalTimer?.reset();
        });
      }
    }
  }
}

/**
 * Types of checkpoints that can be reached during execution.
 */
export interface Checkpoints {
  "steps-found": { steps: [FoundStep, ...FoundStep[]] };
  "function-rejected": { error: unknown };
  "function-resolved": { data: unknown };
  "step-not-found": { step: OutgoingOp };
  "checkpointing-runtime-reached": {};
  "checkpointing-buffer-interval-reached": {};
}

type Checkpoint = {
  [K in keyof Checkpoints]: Simplify<{ type: K } & Checkpoints[K]>;
}[keyof Checkpoints];

type CheckpointHandlers = Record<
  StepMode,
  {
    [C in Checkpoint as C["type"]]: (
      checkpoint: C,

      /**
       * This is the number of checkpoints that have been seen before this one was
       * triggered.
       *
       * The catch-all `""` checkpoint does not increment this count.
       */
      i: number,
    ) => MaybePromise<ExecutionResult | undefined>;
  } & {
    "": (
      checkpoint: Checkpoint,

      /**
       * This is the number of checkpoints that have been seen before this one was
       * triggered.
       *
       * The catch-all `""` checkpoint does not increment this count.
       */
      i: number,
    ) => MaybePromise<void>;
  }
>;

export interface ExecutionState {
  /**
   * A value that indicates that we're executing this step. Can be used to
   * ensure steps are not accidentally nested until we support this across all
   * platforms.
   */
  executingStep?: Readonly<Omit<OutgoingOp, "id">>;

  /**
   * A map of step IDs to their data, used to fill previously-completed steps
   * with state from the executor.
   */
  stepState: Record<string, MemoizedOp>;

  /**
   * The number of steps we expect to fulfil based on the state passed from the
   * Executor.
   */
  stepsToFulfill: number;

  /**
   * A map of step IDs to their functions to run. The executor can request a
   * specific step to run, so we need to store the function to run here.
   */
  steps: Map<string, FoundStep>;

  /**
   * A flag which represents whether or not steps are understood to be used in
   * this function. This is used to determine whether or not we should run
   * some steps (such as `step.sendEvent`) inline as they are found.
   */
  hasSteps: boolean;

  /**
   * The core loop - a generator used to take an action upon finding the next
   * checkpoint. Manages the flow of execution and cleaning up after itself.
   */
  loop: AsyncGenerator<Checkpoint, void, void>;

  /**
   * A function that resolves the `Promise` returned by `waitForNextDecision`.
   */
  setCheckpoint: (data: Checkpoint) => void;

  /**
   * Returns whether or not all state passed from the executor has been used to
   * fulfill found steps.
   */
  allStateUsed: () => boolean;

  /**
   * An ordered list of step IDs that represents the order in which their
   * execution was completed.
   */
  stepCompletionOrder: string[];

  /**
   * An set of step IDs that have yet to be seen in this execution. Used to
   * decide when to trigger middleware based on the current state.
   */
  remainingStepsToBeSeen: Set<string>;

  /**
   * If defined, this is the error that purposefully thrown when memoizing step
   * state in order to support per-step errors.
   *
   * We use this so that if the function itself rejects with the same error, we
   * know that it was entirely uncaught (or at the very least rethrown), so we
   * should send a `NonRetriableError` to stop needless execution of a function
   * that will continue to fail.
   *
   * TODO This is imperfect, as this state is currently kept around for longer
   * than it needs to be. It should disappear as soon as we've seen that the
   * error did not immediately throw. It may need to be refactored to work a
   * little more smoothly with the core loop.
   */
  recentlyRejectedStepError?: StepError;

  /**
   * If defined, this indicates that we're running a checkpointed function run,
   * and contains the data needed to report progress back to Inngest.
   */
  checkpointedRun?: {
    fnId: string;
    appId: string;
    token?: string;
  };

  /**
   * A buffer of steps that are currently queued to be checkpointed.
   */
  checkpointingStepBuffer: OutgoingOp[];

  /**
   * Metadata collected during execution to be sent with outgoing ops.
   */
  metadata?: Map<string, Array<MetadataUpdate>>;
}

const hashId = (id: string): string => {
  return sha1().update(id).digest("hex");
};

const hashOp = (op: OutgoingOp): OutgoingOp => {
  return {
    ...op,
    id: hashId(op.id),
  };
};

/**
 * Result of resolving a step ID collision.
 */
interface CollisionResolutionResult {
  /** The final ID to use (either original or with index suffix). */
  finalId: string;

  /** The index used, if collision was detected. */
  index?: number;
}

/** Result of applying middleware to a step. */
interface MiddlewareApplicationResult {
  hashedId: string;
  isFulfilled: boolean;
  setActualHandler: (handler: () => Promise<unknown>) => void;
  stepInfo: Middleware.StepInfo;
  stepState: MemoizedOp | undefined;
  wrappedHandler: () => Promise<unknown>;
}

/**
 * Resolves step ID collisions by appending an index suffix if needed.
 * Consolidates the duplicated collision detection logic.
 *
 * @param baseId - The original step ID
 * @param stepsMap - Map of existing steps (keyed by hashed ID)
 * @param expectedIndexes - Map tracking expected next index for each base ID
 * @returns The final ID to use and optional index
 */
function resolveStepIdCollision({
  baseId,
  expectedIndexes,
  stepsMap,
}: {
  baseId: string;
  expectedIndexes: Map<string, number>;
  stepsMap: Map<string, FoundStep>;
}): CollisionResolutionResult {
  const hashedBaseId = hashId(baseId);

  // Check both stepsMap (steps added to state) and expectedIndexes (claimed by
  // concurrent in-progress step handlers that haven't been added to state yet).
  if (!stepsMap.has(hashedBaseId) && !expectedIndexes.has(baseId)) {
    // No collision. Claim this base ID so concurrent callers detect collision.
    expectedIndexes.set(baseId, 1);
    return { finalId: baseId };
  }

  // Collision detected. Find next available index
  const expectedNextIndex = expectedIndexes.get(baseId) ?? 1;
  const maxIndex = expectedNextIndex + stepsMap.size + 1;
  for (let i = expectedNextIndex; i < maxIndex; i++) {
    const indexedId = baseId + STEP_INDEXING_SUFFIX + i;
    const hashedIndexedId = hashId(indexedId);

    if (!stepsMap.has(hashedIndexedId)) {
      expectedIndexes.set(baseId, i + 1);
      return { finalId: indexedId, index: i };
    }
  }

  throw new UnreachableError(
    `Could not resolve step ID collision for "${baseId}" after ${stepsMap.size + 1} attempts`,
  );
}

function isNonEmpty<T>(arr: T[]): arr is [T, ...T[]] {
  return arr.length > 0;
}

/**
 * Exported for testing.
 */
export const _internals = { hashOp, hashId, resolveStepIdCollision };
