import { trace } from "@opentelemetry/api";
import hashjs from "hash.js";
import ms, { type StringValue } from "ms";
import { z } from "zod/v3";
import {
  ExecutionVersion,
  headerKeys,
  internalEvents,
} from "../../helpers/consts.ts";
import {
  deserializeError,
  ErrCode,
  minifyPrettyError,
  prettyError,
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
  runAsPromise,
} from "../../helpers/promises.ts";
import * as Temporal from "../../helpers/temporal.ts";
import type { MaybePromise, Simplify } from "../../helpers/types.ts";
import {
  type APIStepPayload,
  type BaseContext,
  type Context,
  type EventPayload,
  type FailureEventArgs,
  type Handler,
  jsonErrorSchema,
  type OutgoingOp,
  StepMode,
  StepOpCode,
} from "../../types.ts";
import { version } from "../../version.ts";
import type { Inngest } from "../Inngest.ts";
import type {
  MetadataKind,
  MetadataOpcode,
  MetadataScope,
  MetadataUpdate,
} from "../InngestMetadata.ts";
import { getHookStack, type RunHookStack } from "../InngestMiddleware.ts";
import {
  createStepTools,
  type FoundStep,
  getStepOptions,
  invokePayloadSchema,
  STEP_INDEXING_SUFFIX,
  type StepHandler,
} from "../InngestStepTools.ts";
import { NonRetriableError } from "../NonRetriableError.ts";
import { RetryAfterError } from "../RetryAfterError.ts";
import { StepError } from "../StepError.ts";
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

export const createV1InngestExecution: InngestExecutionFactory = (options) => {
  return new V1InngestExecution(options);
};

class V1InngestExecution extends InngestExecution implements IInngestExecution {
  public version = ExecutionVersion.V1;

  private state: V1ExecutionState;
  private fnArg: Context.Any;
  private checkpointHandlers: CheckpointHandlers;
  private timeoutDuration = 1000 * 10;
  private execution: Promise<ExecutionResult> | undefined;
  private userFnToRun: Handler.Any;

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
      this.state.hooks = await this.initializeMiddleware();
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
      return await this.transformOutput({ error });
    } finally {
      void this.state.loop.return();
      await this.state.hooks?.beforeResponse?.();
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
        const res = await this.options.client["inngestApi"].checkpointNewRun({
          runId: this.fnArg.runId,
          event: this.fnArg.event as APIStepPayload,
          steps,
        });

        this.state.checkpointedRun = {
          appId: res.data.app_id,
          fnId: res.data.fn_id,
          token: res.data.token,
        };
      } else {
        await this.options.client["inngestApi"].checkpointSteps({
          appId: this.state.checkpointedRun.appId,
          fnId: this.state.checkpointedRun.fnId,
          runId: this.fnArg.runId,
          steps,
        });
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

      await this.options.client["inngestApi"].checkpointStepsAsync({
        runId: this.fnArg.runId,
        fnId: this.options.internalFnId,
        queueItemId: this.options.queueItemId,
        steps,
      });
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
            id: _internals.hashId("complete"), // TODO bad ID
            data: await this.options.createResponse!(checkpoint.data),
          },
        ]);

        // Done - just return the value
        return {
          type: "function-resolved",
          ctx: this.fnArg,
          ops: this.ops,
          data: checkpoint.data,
        };
      },

      "function-rejected": (checkpoint) => {
        // If the function throws during sync execution, we want to switch to
        // async mode so that we can retry. The exception is that we're already
        // at max attempts, in which case we do actually want to reject.
        if (this.inFinalAttempt()) {
          return {
            type: "function-rejected",
            ctx: this.fnArg,
            error: checkpoint.error,
            ops: this.ops,
            retriable: false,
          };
        }

        // Otherwise, checkpoint the error and switch to async mode
        return this.checkpointAndSwitchToAsync([
          {
            id: _internals.hashId("complete"), // TODO bad ID, bad use of _internals here
            displayName: "complete", // TODO bad display name
            op: StepOpCode.StepError,
            error: checkpoint.error,
          },
        ]);
      },

      "step-not-found": ({ step }) => {
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

        return void (await this.checkpoint([
          this.resumeStepWithResult(result),
        ]));
      },

      "checkpointing-runtime-reached": () => {
        return this.checkpointAndSwitchToAsync([
          {
            op: StepOpCode.DiscoveryRequest,
            id: _internals.hashId("discovery-request"), // ID doesn't matter
          },
        ]);
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
            return {
              type: "steps-found",
              ctx: output.ctx,
              ops: output.ops,
              steps: [
                {
                  op: StepOpCode.RunComplete,
                  id: _internals.hashId("complete"), // TODO bad ID. bad bad bad
                  data: output.data,
                },
              ],
            };
          }

          return;
        },
        "function-rejected": asyncHandlers["function-rejected"],
        "step-not-found": asyncHandlers["step-not-found"],
        "steps-found": async ({ steps }) => {
          // If we are targeting a step and we have it, run it immediately and
          // return end
          if (this.options.requestedRunStep) {
            this.debug(
              "async checkpointing looking for step to run, so attempting to find it",
            );

            const step = steps.find(
              (s) => s.hashedId === this.options.requestedRunStep && s.fn,
            );
            if (step) {
              const stepResult = await this.executeStep(step);
              if (stepResult) {
                return stepRanHandler(stepResult);
              }
            }
          }

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

              this.debug("checkpointing and resuming execution after step run");

              try {
                return void (await this.checkpoint([
                  this.resumeStepWithResult(stepResult),
                ]));
              } catch (err) {
                // If checkpointing fails for any reason, fall back to the async
                // flow
                this.debug(
                  "error checkpointing after step run, so falling back to async",
                  err,
                );

                return stepRanHandler(stepResult);
              }
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

    /**
     * We're finishing up; let's trigger the last of the hooks.
     */
    await this.state.hooks?.afterMemoization?.();
    await this.state.hooks?.beforeExecution?.();
    await this.state.hooks?.afterExecution?.();

    const stepList = newSteps.map<OutgoingOp>((step) => ({
      displayName: step.displayName,
      op: step.op,
      id: step.hashedId,
      name: step.name,
      opts: step.opts,
      userland: step.userland,
    })) as [OutgoingOp, ...OutgoingOp[]];

    /**
     * We also run `onSendEvent` middleware hooks against `step.invoke()` steps
     * to ensure that their `data` is transformed correctly.
     */
    return await this.transformNewSteps(stepList);
  }

  /**
   * Using middleware, transform any newly-found steps before returning them to
   * an Inngest Server.
   */
  private async transformNewSteps<T extends [OutgoingOp, ...OutgoingOp[]]>(
    steps: T,
  ): Promise<T> {
    return Promise.all(
      steps.map(async (step) => {
        if (step.op !== StepOpCode.InvokeFunction) {
          return step;
        }

        const onSendEventHooks = await getHookStack(
          this.options.fn["middleware"],
          "onSendEvent",
          undefined,
          {
            transformInput: (prev, output) => {
              return { ...prev, ...output };
            },
            transformOutput: (prev, output) => {
              return {
                result: { ...prev.result, ...output?.result },
              };
            },
          },
        );

        /**
         * For each event being sent, create a new `onSendEvent` hook stack to
         * process it. We do this as middleware hooks are intended to run once
         * during each lifecycle (onFunctionRun or onSendEvent) and here, a hook
         * is run for every single event.
         *
         * This is done because a developer can use this hook to filter out
         * events entirely; if we batch all of the events together, we can't
         * tell which ones were filtered out if we're processing >1 invocation
         * here.
         */
        const transformedPayload = await onSendEventHooks.transformInput?.({
          payloads: [
            {
              ...(step.opts?.payload ?? {}),
              name: internalEvents.FunctionInvoked,
            },
          ],
        });

        const newPayload = invokePayloadSchema.parse(
          transformedPayload?.payloads?.[0] ?? {},
        );

        return {
          ...step,
          opts: {
            ...step.opts,
            payload: {
              ...(step.opts?.payload ?? {}),
              ...newPayload,
            },
          },
        };
      }),
    ) as Promise<T>;
  }

  private async executeStep({
    id,
    name,
    opts,
    fn,
    displayName,
    userland,
    hashedId,
  }: FoundStep): Promise<OutgoingOp> {
    this.debug(`preparing to execute step "${id}"`);

    this.timeout?.clear();
    await this.state.hooks?.afterMemoization?.();
    await this.state.hooks?.beforeExecution?.();

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

    return goIntervalTiming(() => runAsPromise(fn))
      .finally(async () => {
        this.debug(`finished executing step "${id}"`);

        delete this.state.executingStep;
        if (store?.execution) {
          delete store.execution.executingStep;
        }

        await this.state.hooks?.afterExecution?.();
      })
      .then<OutgoingOp>(async ({ resultPromise, interval: _interval }) => {
        interval = _interval;
        const metadata = this.state.metadata?.get(id);

        return {
          ...outgoingOp,
          data: await resultPromise,
          ...(metadata && metadata.length > 0 ? { metadata: metadata } : {}),
        };
      })
      .catch<OutgoingOp>((error) => {
        let errorIsRetriable = true;

        if (error instanceof NonRetriableError) {
          errorIsRetriable = false;
        } else if (
          this.fnArg.maxAttempts &&
          this.fnArg?.maxAttempts - 1 === this.fnArg.attempt
        ) {
          errorIsRetriable = false;
        }

        const metadata = this.state.metadata?.get(id);

        if (errorIsRetriable) {
          return {
            ...outgoingOp,
            op: StepOpCode.StepError,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            error,
            ...(metadata && metadata.length > 0 ? { metadata: metadata } : {}),
          };
        } else {
          return {
            ...outgoingOp,
            op: StepOpCode.StepFailed,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            error,
            ...(metadata && metadata.length > 0 ? { metadata: metadata } : {}),
          };
        }
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
     * Mutate input as neccessary based on middleware.
     */
    await this.transformInput();

    /**
     * Start the timer to time out the run if needed.
     */
    void this.timeout?.start();
    void this.checkpointingMaxRuntimeTimer?.start();

    await this.state.hooks?.beforeMemoization?.();

    /**
     * If we had no state to begin with, immediately end the memoization phase.
     */
    if (this.state.allStateUsed()) {
      await this.state.hooks?.afterMemoization?.();
      await this.state.hooks?.beforeExecution?.();
    }

    /**
     * Trigger the user's function.
     */
    runAsPromise(() => this.userFnToRun(this.fnArg))
      .finally(async () => {
        await this.state.hooks?.afterMemoization?.();
        await this.state.hooks?.beforeExecution?.();
        await this.state.hooks?.afterExecution?.();
      })
      .then((data) => {
        this.state.setCheckpoint({ type: "function-resolved", data });
      })
      .catch((error) => {
        this.state.setCheckpoint({ type: "function-rejected", error });
      });
  }

  /**
   * Using middleware, transform input before running.
   */
  private async transformInput() {
    const inputMutations = await this.state.hooks?.transformInput?.({
      ctx: { ...this.fnArg },
      steps: Object.values(this.state.stepState),
      fn: this.options.fn,
      reqArgs: this.options.reqArgs,
    });

    if (inputMutations?.ctx) {
      this.fnArg = inputMutations.ctx;
    }

    if (inputMutations?.steps) {
      this.state.stepState = Object.fromEntries(
        inputMutations.steps.map((step) => [step.id, step]),
      );
    }
  }

  /**
   * Using middleware, transform output before returning.
   */
  private async transformOutput(
    dataOrError: Parameters<
      NonNullable<RunHookStack["transformOutput"]>
    >[0]["result"],
  ): Promise<ExecutionResult> {
    const output = { ...dataOrError } as Partial<OutgoingOp>;

    const isStepExecution = Boolean(this.state.executingStep);

    const transformedOutput = await this.state.hooks?.transformOutput?.({
      result: { ...output },
      step: this.state.executingStep,
    });

    const { data, error } = { ...output, ...transformedOutput?.result };

    if (!isStepExecution) {
      await this.state.hooks?.finished?.({
        result: { ...(typeof error !== "undefined" ? { error } : { data }) },
      });
    }

    if (typeof error !== "undefined") {
      /**
       * Ensure we give middleware the chance to decide on retriable behaviour
       * by looking at the error returned from output transformation.
       */
      let retriable: boolean | string = !(
        error instanceof NonRetriableError ||
        (error instanceof StepError &&
          error === this.state.recentlyRejectedStepError)
      );
      if (retriable && error instanceof RetryAfterError) {
        retriable = error.retryAfter;
      }

      const serializedError = minifyPrettyError(serializeError(error));

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

  private createExecutionState(): V1ExecutionState {
    const d = createDeferredPromiseWithStack<Checkpoint>();
    let checkpointResolve = d.deferred.resolve;
    const checkpointResults = d.results;

    const loop: V1ExecutionState["loop"] = (async function* (
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
      void checkpointResults.return();
    });

    const stepsToFulfill = Object.keys(this.options.stepState).length;

    const state: V1ExecutionState = {
      stepState: this.options.stepState,
      stepsToFulfill,
      steps: new Map(),
      loop,
      hasSteps: Boolean(stepsToFulfill),
      stepCompletionOrder: [...this.options.stepCompletionOrder],
      remainingStepsToBeSeen: new Set(this.options.stepCompletionOrder),
      setCheckpoint: (checkpoint: Checkpoint) => {
        ({ resolve: checkpointResolve } = checkpointResolve(checkpoint));
      },
      allStateUsed: () => {
        return this.state.remainingStepsToBeSeen.size === 0;
      },
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
     * A promise that's used to represent middleware hooks running before
     * execution.
     */
    let beforeExecHooksPromise: Promise<void> | undefined;

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
            prettyError({
              type: "warn",
              whatHappened:
                "We detected that you have multiple steps with the same ID.",
              code: ErrCode.AUTOMATIC_PARALLEL_INDEXING,
              why: `This can happen if you're using the same ID for multiple steps across different chains of parallel work. We found the issue with step "${userlandCollisionId}".`,
              reassurance:
                "Your function is still running, though it may exhibit unexpected behaviour.",
              consequences:
                "Using the same IDs across parallel chains of work can cause unexpected behaviour.",
              toFixNow:
                "We recommend using a unique ID for each step, especially those happening in parallel.",
            }),
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

      foundStepsReportPromise = extensionPromise
        /**
         * Ensure that we wait for this promise to resolve before continuing.
         *
         * The groups in which steps are reported can affect how we detect some
         * more complex determinism issues like parallel indexing. This promise
         * can represent middleware hooks being run early, in the middle of
         * ingesting steps to report.
         *
         * Because of this, it's important we wait for this middleware to resolve
         * before continuing to report steps to ensure that all steps have a
         * chance to be reported throughout this asynchronous action.
         */
        .then(() => beforeExecHooksPromise)
        .then(() => {
          foundStepsReportPromise = undefined;

          for (let i = 0; i < remainingStepCompletionOrder.length; i++) {
            const nextStepId = remainingStepCompletionOrder[i];
            if (!nextStepId) {
              // Strange - skip this empty index
              continue;
            }

            const handled = unhandledFoundStepsToReport
              .get(nextStepId)
              ?.handle();
            if (handled) {
              remainingStepCompletionOrder.splice(i, 1);
              unhandledFoundStepsToReport.delete(nextStepId);
              return void reportNextTick();
            }
          }

          // If we've handled no steps in this "tick," roll up everything we've
          // found and report it.
          const steps = [...foundStepsToReport.values()] as [
            FoundStep,
            ...FoundStep[],
          ];
          foundStepsToReport.clear();
          unhandledFoundStepsToReport.clear();

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
      await beforeExecHooksPromise;

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
          prettyError({
            whatHappened: `We detected that you have nested \`step.*\` tooling in \`${
              opId.displayName ?? opId.id
            }\``,
            consequences: "Nesting `step.*` tooling is not supported.",
            type: "warn",
            reassurance:
              "It's possible to see this warning if steps are separated by regular asynchronous calls, which is fine.",
            stack: true,
            toFixNow:
              "Make sure you're not using `step.*` tooling inside of other `step.*` tooling. If you need to compose steps together, you can create a new async function and call it from within your step function, or use promise chaining.",
            code: ErrCode.NESTING_STEPS,
          }),
        );
      }

      if (this.state.steps.has(_internals.hashId(opId.id))) {
        const originalId = opId.id;
        maybeWarnOfParallelIndexing(originalId);

        const expectedNextIndex = expectedNextStepIndexes.get(originalId) ?? 1;
        for (let i = expectedNextIndex; ; i++) {
          const newId = originalId + STEP_INDEXING_SUFFIX + i;

          if (!this.state.steps.has(_internals.hashId(newId))) {
            expectedNextStepIndexes.set(originalId, i + 1);
            opId.id = newId;
            opId.userland.index = i;
            break;
          }
        }
      }

      const { promise, resolve, reject } = createDeferredPromise();
      const hashedId = _internals.hashId(opId.id);
      const stepState = this.state.stepState[hashedId];
      let isFulfilled = false;
      if (stepState) {
        stepState.seen = true;
        this.state.remainingStepsToBeSeen.delete(hashedId);

        if (typeof stepState.input === "undefined") {
          isFulfilled = true;
        }
      }

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

      const step: FoundStep = {
        ...opId,
        opts: { ...opId.opts, ...extraOpts },
        rawArgs: fnArgs, // TODO What is the right value here? Should this be raw args without affected input?
        hashedId,
        input: stepState?.input,

        fn: opts?.fn ? () => opts.fn?.(this.fnArg, ...fnArgs) : undefined,
        promise,
        fulfilled: isFulfilled,
        hasStepState: Boolean(stepState),
        displayName: opId.displayName ?? opId.id,
        handled: false,
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
              () => {
                if (typeof result.data !== "undefined") {
                  resolve(result.data);
                } else {
                  this.state.recentlyRejectedStepError = new StepError(
                    opId.id,
                    result.error,
                  );
                  reject(this.state.recentlyRejectedStepError);
                }
              },
            );
          }

          return true;
        },
      };

      this.state.steps.set(hashedId, step);
      this.state.hasSteps = true;
      pushStepToReport(step);

      /**
       * If this is the last piece of state we had, we've now finished
       * memoizing.
       */
      if (!beforeExecHooksPromise && this.state.allStateUsed()) {
        // biome-ignore lint/suspicious/noAssignInExpressions: <explanation>
        await (beforeExecHooksPromise = (async () => {
          await this.state.hooks?.afterMemoization?.();
          await this.state.hooks?.beforeExecution?.();
        })());
      }

      return promise;
    };

    return createStepTools(this.options.client, this, stepHandler);
  }

  private resumeStepWithResult(resultOp: OutgoingOp): FoundStep {
    const userlandStep = this.state.steps.get(resultOp.id);
    if (!userlandStep) {
      throw new Error(
        "Step not found in memoization state during async checkpointing; this should never happen and is a bug in the Inngest SDK",
      );
    }

    const data = undefinedToNull(resultOp.data);

    userlandStep.data = data;
    userlandStep.timing = resultOp.timing;
    userlandStep.fulfilled = true;
    userlandStep.hasStepState = true;
    userlandStep.op = resultOp.op;
    userlandStep.id = resultOp.id;

    this.state.stepState[resultOp.id] = userlandStep;

    userlandStep.handle();

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

  private initializeTimer(state: V1ExecutionState): void {
    if (!this.options.requestedRunStep) {
      return;
    }

    this.timeout = createTimeoutPromise(this.timeoutDuration);

    void this.timeout.then(async () => {
      await this.state.hooks?.afterMemoization?.();
      await this.state.hooks?.beforeExecution?.();
      await this.state.hooks?.afterExecution?.();

      state.setCheckpoint({
        type: "step-not-found",
        step: {
          id: this.options.requestedRunStep as string,
          op: StepOpCode.StepNotFound,
        },
      });
    });
  }

  private initializeCheckpointRuntimeTimer(state: V1ExecutionState): void {
    // Not checkpointing? Skip.
    if (!this.options.checkpointingConfig) {
      return;
    }

    // Default checkpointing config? Skip.
    if (typeof this.options.checkpointingConfig === "boolean") {
      return;
    }

    // Custom checkpointing config but no max runtime? Skip.
    if (!this.options.checkpointingConfig.maxRuntime) {
      return;
    }

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
    if (!Number.isFinite(maxRuntimeMs) || maxRuntimeMs <= 0) {
      return;
    }

    this.checkpointingMaxRuntimeTimer = createTimeoutPromise(maxRuntimeMs);

    void this.checkpointingMaxRuntimeTimer.then(async () => {
      await this.state.hooks?.afterMemoization?.();
      await this.state.hooks?.beforeExecution?.();
      await this.state.hooks?.afterExecution?.();

      state.setCheckpoint({
        type: "checkpointing-runtime-reached",
      });
    });
  }

  private async initializeMiddleware(): Promise<RunHookStack> {
    const ctx = this.options.data as Pick<
      Readonly<BaseContext<Inngest.Any>>,
      "event" | "events" | "runId"
    >;

    const hooks = await getHookStack(
      this.options.fn["middleware"],
      "onFunctionRun",
      {
        ctx,
        fn: this.options.fn,
        steps: Object.values(this.options.stepState),
        reqArgs: this.options.reqArgs,
      },
      {
        transformInput: (prev, output) => {
          return {
            ctx: { ...prev.ctx, ...output?.ctx },
            fn: this.options.fn,
            steps: prev.steps.map((step, i) => ({
              ...step,
              ...output?.steps?.[i],
            })),
            reqArgs: prev.reqArgs,
          };
        },
        transformOutput: (prev, output) => {
          return {
            result: { ...prev.result, ...output?.result },
            step: prev.step,
          };
        },
      },
    );

    return hooks;
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

export interface V1ExecutionState {
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
   * Initialized middleware hooks for this execution.
   *
   * Middleware hooks are cached to ensure they can only be run once, which
   * means that these hooks can be called in many different places to ensure we
   * handle all possible execution paths.
   */
  hooks?: RunHookStack;

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
 * Exported for testing.
 */
export const _internals = { hashOp, hashId };
