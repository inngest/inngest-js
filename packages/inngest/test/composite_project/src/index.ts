import { Inngest, InngestMiddleware } from "inngest";

export const inngest = new Inngest({
  id: "me",
  middleware: [
    new InngestMiddleware({
      name: "foo",
      init() {
        return {
          onFunctionRun(ctx) {
            console.log(ctx);

            return {
              transformInput(ctx) {
                console.log(ctx);

                return {
                  ctx: {
                    oof: "doof",
                  },
                };
              },
            };
          },
        };
      },
    }),
  ],
});
