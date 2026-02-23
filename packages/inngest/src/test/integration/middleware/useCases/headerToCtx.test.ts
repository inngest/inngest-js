import { expect, test } from "vitest";
import { Inngest, Middleware } from "../../../../index.ts";
import { createTestApp } from "../../../devServerTestHarness.ts";
import { createState, randomSuffix, testNameFromFileUrl } from "../../utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("request headers available in function ctx via middleware", async () => {
  // Use wrapRequest to capture request headers, then transformFunctionInput to
  // inject them into the function's ctx object

  const state = createState({
    receivedHeaders: null as Record<string, string> | null,
  });

  class MW extends Middleware.BaseMiddleware {
    readonly id = "test";
    private headers: Record<string, string> = {};

    override async wrapRequest({
      next,
      requestInfo,
    }: Middleware.WrapRequestArgs) {
      this.headers = requestInfo.headers;
      return next();
    }

    override transformFunctionInput(
      arg: Middleware.TransformFunctionInputArgs,
    ) {
      return {
        ...arg,
        ctx: {
          ...arg.ctx,
          headers: this.headers,
        },
      };
    }
  }

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [MW],
  });
  const fn = client.createFunction(
    { id: "fn", retries: 0, triggers: [{ event: eventName }] },
    async ({ headers, runId }) => {
      state.runId = runId;
      state.receivedHeaders = headers;
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await state.waitForRunComplete();

  // Verify that the function received headers injected from the request
  expect(state.receivedHeaders).toEqual(
    expect.objectContaining({
      "Content-Type": expect.any(String),
    }),
  );
});
