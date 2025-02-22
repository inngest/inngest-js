import { sha1 } from "hash.js";
import { undefinedToNull } from "inngest/helpers/functions";
import { z } from "zod";
import { deserializeError, serializeError } from "../../helpers/errors.js";
import {
  createDeferredPromise,
  runAsPromise,
  type createTimeoutPromise,
} from "../../helpers/promises.js";
import {
  jsonErrorSchema,
  type Context,
  type EventPayload,
  type FailureEventArgs,
  type OutgoingOp,
} from "../../types.js";
import {
  createStepTools,
  getStepOptions,
  STEP_INDEXING_SUFFIX,
} from "../InngestStepTools.js";
import { StepError } from "../StepError.js";
import {
  InngestExecution,
  type ExecutionResult,
  type IInngestExecution,
  type InngestExecutionFactory,
  type InngestExecutionOptions,
} from "./InngestExecution.js";

export const createV2InngestExecution: InngestExecutionFactory = (options) => {
  return new V2InngestExecution(options);
};

class V2InngestExecution extends InngestExecution implements IInngestExecution {
  private state: V2ExecutionState;
  private execution: Promise<ExecutionResult> | undefined;

  /**
   * If we're supposed to run a particular step via `requestedRunStep`, this
   * will be a `Promise` that resolves after no steps have been found for
   * `timeoutDuration` milliseconds.
   *
   * If we're not supposed to run a particular step, this will be `undefined`.
   */
  private timeout?: ReturnType<typeof createTimeoutPromise>;

  constructor(options: InngestExecutionOptions) {
    super(options);

    this.state = this.createExecutionState();

    this.debug(
      "created new V2 execution for run;",
      this.options.requestedRunStep
        ? `wanting to run step "${this.options.requestedRunStep}"`
        : "discovering steps"
    );

    //     this.debug("existing state keys:", Object.keys(this.state.stepState));
  }

  /**
   * Idempotently start the execution of the user's function.
   */
  public start() {
    this.debug("starting V2 execution");

    return (this.execution ??= this._start().then((result) => {
      this.debug("result:", result);
      return result;
    }));
  }

  private _start(): Promise<ExecutionResult> {
    const { promise: executionPromise, resolve: resolveExecution } =
      createDeferredPromise<ExecutionResult>();

    const step = createStepTools(
      this.options.client,
      this,
      async ({ matchOp, opts, args }) => {
        const stepOptions = getStepOptions(args[0]);
        const opId = matchOp(stepOptions, ...args.slice(1));

        if (this.state.foundSteps[opId.id]) {
          for (let i = 1; ; i++) {
            const newId = opId.id + STEP_INDEXING_SUFFIX + i;

            if (!this.state.foundSteps[newId]) {
              opId.id = newId;
              break;
            }
          }
        }

        const {
          promise: stepPromise,
          resolve: resolveStep,
          reject: rejectStep,
        } = createDeferredPromise();

        const hashedId = _internals.hashId(opId.id);
        const stepResult = this.options.stepState[hashedId];

        if (stepResult) {
          await stepResult.data;
          await stepResult.error;
          await stepResult.input;

          if (typeof stepResult.data !== "undefined") {
            resolveStep(stepResult.data);
          } else {
            rejectStep(new StepError(opId.id, stepResult.error));
          }
        }

        return stepPromise;
      }
    );

    let fnArg = {
      ...(this.options.data as { event: EventPayload }),
      step,
    } as Context.Any;

    if (this.options.isFailureHandler) {
      const eventData = z
        .object({ error: jsonErrorSchema })
        .parse(fnArg.event?.data);

      (fnArg as Partial<Pick<FailureEventArgs, "error">>) = {
        ...fnArg,
        error: deserializeError(eventData.error),
      };
    }

    fnArg = this.options.transformCtx?.(fnArg) ?? fnArg;

    let userFnToRun = this.options.fn["fn"];
    if (this.options.isFailureHandler) {
      if (!this.options.fn["onFailureFn"]) {
        throw new Error("Expected failure handler function");
      }

      userFnToRun = this.options.fn["onFailureFn"];
    }

    runAsPromise(() => userFnToRun(fnArg))
      .then((data) => {
        // resolved
        resolveExecution({
          type: "function-resolved",
          ctx: fnArg,
          ops: {},
          data: undefinedToNull(data),
        });
      })
      .catch((error) => {
        // rejected
        resolveExecution({
          type: "function-rejected",
          ctx: fnArg,
          ops: {},
          error: serializeError(error),
          retriable: false,
        });
      });

    // Also wait for the next tick; if this hits before we resolve/reject then
    // we're hanging and need to address steps or decide to wait.
    setTimeout(() => {
      // if foundsteps...
    });

    return executionPromise;
  }

  private createExecutionState() {
    return {
      foundSteps: {},
    } satisfies V2ExecutionState;
  }
}

export interface V2ExecutionState {
  foundSteps: Record<string, OutgoingOp>;
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
