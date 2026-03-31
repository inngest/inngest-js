import * as Inngest from "inngest";

// Prove certain types are exported and can be used
type CatchAll =
  | Inngest.JsonError
  | Inngest.EventPayload
  | Inngest.AiAdapter
  | Inngest.AiAdapters
  | Inngest.ClientOptions
  | Inngest.ClientOptionsFromInngest<any>
  | Inngest.Context.Any
  | Inngest.GetFunctionInput<any>
  | Inngest.GetFunctionOutput<any>
  | Inngest.GetStepTools<any>
  | Inngest.Inngest
  | Inngest.InngestCommHandler
  | Inngest.InngestFunction.Any
  | Inngest.InngestFunctionReference.Any
  | typeof Inngest.Middleware
  | Inngest.Logger
  | Inngest.NonRetriableError
  | Inngest.OutgoingOp
  | Inngest.ProxyLogger
  | Inngest.RegisterOptions
  | Inngest.RetryAfterError
  | Inngest.ScheduledTimerEventPayload
  | Inngest.SendEventBaseOutput
  | Inngest.ServeHandlerOptions
  | Inngest.StepError
  | Inngest.StepOptions
  | Inngest.StepOptionsOrId
  | Inngest.StrictUnion<any>
  | Inngest.TimeStr
  | Inngest.UnionKeys<any>;

class MyMiddleware extends Inngest.Middleware.BaseMiddleware {
  readonly id = "test";

  onRunStart(arg: Inngest.Middleware.OnRunStartArgs) {
    console.log("onRunStart", arg);
  }

  onRunComplete(arg: Inngest.Middleware.OnRunCompleteArgs) {
    console.log("onRunComplete", arg);
  }

  onStepStart(arg: Inngest.Middleware.OnStepStartArgs) {
    console.log("onStepStart", arg);
  }

  onStepComplete(arg: Inngest.Middleware.OnStepCompleteArgs) {
    console.log("onStepComplete", arg);
  }

  onStepError(arg: Inngest.Middleware.OnStepErrorArgs) {
    console.log("onStepError", arg);
  }

  onMemoizationEnd() {
    console.log("onMemoizationEnd");
  }

  override async wrapFunctionHandler({
    next,
  }: Inngest.Middleware.WrapFunctionHandlerArgs) {
    console.log("wrapFunctionHandler:before");
    const result = await next();
    console.log("wrapFunctionHandler:after");
    return result;
  }

  override async wrapStep({ next }: Inngest.Middleware.WrapStepArgs) {
    console.log("wrapStep:before");
    const result = await next();
    console.log("wrapStep:after");
    return result;
  }

  override async wrapRequest({ next }: Inngest.Middleware.WrapRequestArgs) {
    console.log("wrapRequest:before");
    const result = await next();
    console.log("wrapRequest:after");
    return result;
  }
}

export const inngest = new Inngest.Inngest({
  id: "me",
  middleware: [MyMiddleware],
});

void inngest.send({ name: "foo", data: { foo: "bar" } });

void inngest.sendSignal({ signal: "foo", data: { foo: "bar" } });

void inngest.setEnvVars({});

export const fn = inngest.createFunction(
  { id: "my-fn", triggers: [{ event: "foo" }] },
  async (ctx) => {
    console.log(ctx);
    return { foo: "bar" };
  },
);

export const fn2 = inngest.createFunction(
  { id: "my-fn-2", triggers: [{ event: "foo" }, { cron: "* * * * *" }] },
  async (ctx) => {
    console.log(ctx);
    return { foo: "bar" };
  },
);

export const fn3 = inngest.createFunction(
  {
    id: "my-fn-3",
    cancelOn: [{ event: "foo", match: "data.foo" }],
    triggers: [{ event: "foo" }, { cron: "* * * * *" }],
  },
  async (ctx) => {
    console.log(ctx);

    ctx.step.invoke("id", { function: fn2, data: { foo: "bar" } });

    ctx.step.waitForEvent("id", {
      event: "foo",
      match: "data.foo",
      timeout: 1000,
    });

    return { foo: "bar" };
  },
);

export const fnRef = Inngest.referenceFunction<typeof fn>({
  functionId: "my-fn",
});

export const fnWithStepRun = inngest.createFunction(
  { id: "my-fn-step-run", triggers: [{ event: "foo" }] },
  async ({ step }) => {
    const result = await step.run("get-data", () => {
      return { nested: { deeply: { value: 123 } } };
    });

    await step.sleep("wait", "1s");

    return result;
  },
);

// Exercise eventType and typed event schemas to ensure StandardSchemaV1
// and related trigger types are portable.
export const myEventType = Inngest.eventType("app/user.created", {
  schema: Inngest.staticSchema<{ userId: string }>(),
});

export const fnWithTypedEvent = inngest.createFunction(
  { id: "my-fn-typed", triggers: [myEventType] },
  async ({ event }) => {
    console.log(event);
    return { ok: true };
  },
);

// Exercise realtime channel creation to ensure Realtime namespace types
// (TopicRef, TopicConfig, etc.) are portable.
export const myChannel = Inngest.realtime.channel({
  name: "my-channel",
  topics: {
    messages: { schema: Inngest.staticSchema<{ text: string }>() },
  },
});
