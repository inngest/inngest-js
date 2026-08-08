import {
  InngestMiddleware,
  type EventPayload,
  type InngestFunction,
  type MiddlewareOptions,
} from "inngest";

export interface RemoteStateMiddlewareOptions {
  /**
   * Options are just maybes
   */
  service: RemoteStateService;
}

export type MemoizedSteps = Readonly<StepResult>[];

export interface StepResult {
  // note that ID is missing, as it's not exposed by the middleware everywhere
  data?: unknown;
  error?: unknown;
}

/**
 * Like a dataloader, so people can batch-load keys.
 *
 * They should probably receive all step data?
 * { [stepId]: { data: ... } | { error: ...}
 *
 * Then return a promise that resolves with the new data.
 *
 * Don't mutate - pure.
 *
 * Errors should be able to be handled by the middleware too.
 * We don't support that yet!
 *
 * Event data?
 *
 * Conditional saving/loading? i.e. only save/load if some data is present?
 */

export const remoteStateMiddleware = ({
  service,
}: RemoteStateMiddlewareOptions): InngestMiddleware<MiddlewareOptions> => {
  const mw = new InngestMiddleware({
    name: "Inngest: Remote State Middleware",
    init: () => {
      return {
        onFunctionRun: ({ steps, ctx: { event, runId }, fn }) => {
          return {
            transformInput: async () => {
              const remoteSteps = await service.loadSteps({
                event,
                fn,
                runId,
                steps,
              });

              return {
                steps: remoteSteps,
              };
            },
            transformOutput: async ({ result, step }) => {
              // Should we also save function-level results and errors?
              if (!step || result.error) {
                return;
              }

              const sanitizedStepResult = await service.saveStep({
                event,
                fn,
                result,
                runId,
                // stepId: step.id,
              });

              return {
                result: {
                  ...result,
                  ...sanitizedStepResult,
                },
              };
            },
            beforeResponse: async () => {},
          };
        },
      };
    },
  });

  return mw;
};

export namespace RemoteStateService {
  export interface LoadStepsContext {
    event: EventPayload;
    fn: InngestFunction.Any;
    runId: string;
    steps: MemoizedSteps;
  }

  export interface SaveStepContext {
    event: EventPayload;
    fn: InngestFunction.Any;
    result: StepResult;
    runId: string;
    // stepId: string; // Middleware doesn't expose this - should it?
  }
}

export abstract class RemoteStateService {
  /**
   * Given a map of known step data, load any data needed and return the data
   * that the SDK will use to memoize state.
   */
  public abstract loadSteps(
    ctx: RemoteStateService.LoadStepsContext
  ): Promise<MemoizedSteps>;

  /**
   * Given a step, maybe save it to a remote state store and then return the
   * data that will be sent back to Inngest. This data will be received again by
   * another request and used to load the step data.
   */
  public abstract saveStep(
    ctx: RemoteStateService.SaveStepContext
  ): Promise<StepResult>;
}

// e.g. export class S3RemoteStateService extends RemoteStateService {...}
