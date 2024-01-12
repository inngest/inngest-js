import { internalEvents, queryKeys } from "../helpers/consts";
import { timeStr } from "../helpers/strings";
import {
  type ClientOptions,
  type EventNameFromTrigger,
  type FunctionConfig,
  type FunctionOptions,
  type FunctionTrigger,
  type Handler,
} from "../types";
import { type EventsFromOpts, type Inngest } from "./Inngest";
import { type MiddlewareRegisterReturn } from "./InngestMiddleware";
import {
  ExecutionVersion,
  type IInngestExecution,
  type InngestExecutionOptions,
} from "./execution/InngestExecution";
import { createV0InngestExecution } from "./execution/v0";
import { createV1InngestExecution } from "./execution/v1";

/**
 * A stateless Inngest function, wrapping up function configuration and any
 * in-memory steps to run when triggered.
 *
 * This function can be "registered" to create a handler that Inngest can
 * trigger remotely.
 *
 * @public
 */
export class InngestFunction<
  TOpts extends ClientOptions = ClientOptions,
  Events extends EventsFromOpts<TOpts> = EventsFromOpts<TOpts>,
  Trigger extends FunctionTrigger<keyof Events & string> = FunctionTrigger<
    keyof Events & string
  >,
  Opts extends FunctionOptions<
    Events,
    EventNameFromTrigger<Events, Trigger>
  > = FunctionOptions<Events, EventNameFromTrigger<Events, Trigger>>,
  THandler extends Handler.Any = Handler<TOpts, Events, keyof Events & string>,
> {
  static stepId = "step";
  static failureSuffix = "-failure";

  public readonly opts: Opts;
  public readonly trigger: Trigger;
  private readonly fn: THandler;
  private readonly onFailureFn?: Handler<TOpts, Events, keyof Events & string>;
  private readonly client: Inngest<TOpts>;
  private readonly middleware: Promise<MiddlewareRegisterReturn[]>;

  /**
   * A stateless Inngest function, wrapping up function configuration and any
   * in-memory steps to run when triggered.
   *
   * This function can be "registered" to create a handler that Inngest can
   * trigger remotely.
   */
  constructor(
    client: Inngest<TOpts>,

    /**
     * Options
     */
    opts: Opts,
    trigger: Trigger,
    fn: THandler
  ) {
    this.client = client;
    this.opts = opts;
    this.trigger = trigger;
    this.fn = fn;
    this.onFailureFn = this.opts.onFailure;

    this.middleware = this.client["initializeMiddleware"](
      this.opts.middleware,
      { registerInput: { fn: this }, prefixStack: this.client["middleware"] }
    );
  }

  /**
   * The generated or given ID for this function.
   */
  public id(prefix?: string): string {
    return [prefix, this.opts.id].filter(Boolean).join("-");
  }

  /**
   * The name of this function as it will appear in the Inngest Cloud UI.
   */
  public get name(): string {
    return this.opts.name || this.id();
  }

  /**
   * Retrieve the Inngest config for this function.
   */
  private getConfig(
    /**
     * Must be provided a URL that will be used to access the function and step.
     * This function can't be expected to know how it will be accessed, so
     * relies on an outside method providing context.
     */
    baseUrl: URL,
    appPrefix?: string
  ): FunctionConfig[] {
    const fnId = this.id(appPrefix);
    const stepUrl = new URL(baseUrl.href);
    stepUrl.searchParams.set(queryKeys.FnId, fnId);
    stepUrl.searchParams.set(queryKeys.StepId, InngestFunction.stepId);

    const { retries: attempts, cancelOn, ...opts } = this.opts;

    /**
     * Convert retries into the format required when defining function
     * configuration.
     */
    const retries = typeof attempts === "undefined" ? undefined : { attempts };

    const fn: FunctionConfig = {
      ...opts,
      id: fnId,
      name: this.name,
      triggers: [this.trigger as FunctionTrigger],
      steps: {
        [InngestFunction.stepId]: {
          id: InngestFunction.stepId,
          name: InngestFunction.stepId,
          runtime: {
            type: "http",
            url: stepUrl.href,
          },
          retries,
        },
      },
    };

    if (cancelOn) {
      fn.cancel = cancelOn.map(({ event, timeout, if: ifStr, match }) => {
        const ret: NonNullable<FunctionConfig["cancel"]>[number] = {
          event,
        };

        if (timeout) {
          ret.timeout = timeStr(timeout);
        }

        if (match) {
          ret.if = `event.${match} == async.${match}`;
        } else if (ifStr) {
          ret.if = ifStr;
        }

        return ret;
      }, []);
    }

    const config: FunctionConfig[] = [fn];

    if (this.onFailureFn) {
      const failureOpts = { ...opts };
      const id = `${fn.id}${InngestFunction.failureSuffix}`;
      const name = `${fn.name ?? fn.id} (failure)`;

      const failureStepUrl = new URL(stepUrl.href);
      failureStepUrl.searchParams.set(queryKeys.FnId, id);

      config.push({
        ...failureOpts,
        id,
        name,
        triggers: [
          {
            event: internalEvents.FunctionFailed,
            expression: `event.data.function_id == '${fnId}'`,
          },
        ],
        steps: {
          [InngestFunction.stepId]: {
            id: InngestFunction.stepId,
            name: InngestFunction.stepId,
            runtime: {
              type: "http",
              url: failureStepUrl.href,
            },
            retries: { attempts: 1 },
          },
        },
      });
    }

    return config;
  }

  private createExecution(opts: CreateExecutionOptions): IInngestExecution {
    const options: InngestExecutionOptions = {
      client: this.client,
      fn: this,
      ...opts.partialOptions,
    };

    const versionHandlers = {
      [ExecutionVersion.V1]: () => createV1InngestExecution(options),
      [ExecutionVersion.V0]: () => createV0InngestExecution(options),
    } satisfies Record<ExecutionVersion, () => IInngestExecution>;

    return versionHandlers[opts.version]();
  }

  private getEventTriggerName(): string | undefined {
    const { event } = this.trigger as { event?: string };
    return event;
  }
}

export namespace InngestFunction {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type Any = InngestFunction<any, any, any, any, any>;
}

export type CreateExecutionOptions = {
  version: ExecutionVersion;
  partialOptions: Omit<InngestExecutionOptions, "client" | "fn">;
};
