import * as Inngest from "inngest";

// Prove certain types are exported and can be used
type CatchAll = Inngest.JsonError;

export const inngest = new Inngest.Inngest({
  id: "me",
  schemas: new Inngest.EventSchemas().fromRecord<{
    foo: { data: { foo: string } };
    bar: { data: { bar: string } };
  }>(),
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

const fn = inngest.createFunction(
  { id: "my-fn" },
  { event: "foo" },
  async (ctx) => {
    console.log(ctx);
    return { foo: "bar" };
  },
);

const fn2 = inngest.createFunction(
  { id: "my-fn-2" },
  [{ event: "foo" }, { cron: "* * * * *" }],
  async (ctx) => {
    console.log(ctx);
    return { foo: "bar" };
  },
);

inngest.createFunction(
  { id: "my-fn-3", cancelOn: [{ event: "foo", match: "data.foo" }] },
  [{ event: "foo" }, { cron: "* * * * *" }],
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
