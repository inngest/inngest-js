import { expect, expectTypeOf, test } from "vitest";
import { Inngest, Middleware } from "../../../index.ts";
import { createTestApp } from "../../devServerTestHarness.ts";
import { randomSuffix, testNameFromFileUrl } from "../utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("add ctx object field", async () => {
  // Use middleware to add a new `ctx` object field. This exists both statically
  // and at runtime

  const state = {
    done: false,
    msg: "",
  };

  class CtxMiddleware extends Middleware.BaseMiddleware {
    override extendRunInfo() {
      return { msg: "hi" };
    }
  }

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middlewareV2: [new CtxMiddleware()],
  });
  const fn = client.createFunction(
    { id: "fn", retries: 0 },
    { event: eventName },
    async ({ msg }) => {
      expectTypeOf(msg).not.toBeAny();
      expectTypeOf(msg).toBeString();
      state.msg = msg;
      state.done = true;
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await vitest.waitFor(
    async () => {
      expect(state.done).toBe(true);
    },
    { timeout: 5000 },
  );

  expect(state.msg).toBe("hi");
});
