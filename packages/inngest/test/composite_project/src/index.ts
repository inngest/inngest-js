import * as Inngest from "inngest";

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
                console.log(ctx);
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
                console.log(ctx);
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

inngest.createFunction({ id: "my-fn" }, { event: "foo" }, async (ctx) => {
  console.log(ctx);
  return { foo: "bar" };
});
