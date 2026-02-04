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
  | Inngest.InngestMiddleware.Any
  | Inngest.Logger
  | Inngest.MiddlewareOptions
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

export const inngest = new Inngest.Inngest({
  id: "me",
  middleware: [
    new Inngest.InngestMiddleware({
      name: "foo",
      init() {
        return {
          onFunctionRun(ctx) {
            console.log(ctx);

            return {
              transformInput(ctx) {
                console.log("transformInput", ctx);
              },
              afterExecution() {
                console.log("afterExecution");
              },
              afterMemoization() {
                console.log("afterMemoization");
              },
              beforeExecution() {
                console.log("beforeExecution");
              },
              beforeMemoization() {
                console.log("beforeMemoization");
              },
              beforeResponse() {
                console.log("beforeResponse");
              },
              transformOutput(ctx) {
                console.log("transformOutput", ctx);
              },
              finished() {
                console.log("finished");
              },
            };
          },
          onSendEvent() {
            return {
              transformInput(ctx) {
                console.log(ctx);
              },
              transformOutput(ctx) {
                console.log(ctx);
              },
            };
          },
        };
      },
    }),
  ],
});

void inngest.send({ name: "foo", data: { foo: "bar" } });

void inngest.sendSignal({ signal: "foo", data: { foo: "bar" } });

void inngest.setEnvVars({});

const fn = inngest.createFunction(
  { id: "my-fn", triggers: [{ event: "foo" }] },
  async (ctx) => {
    console.log(ctx);
    return { foo: "bar" };
  },
);

const fn2 = inngest.createFunction(
  { id: "my-fn-2", triggers: [{ event: "foo" }, { cron: "* * * * *" }] },
  async (ctx) => {
    console.log(ctx);
    return { foo: "bar" };
  },
);

inngest.createFunction(
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
