import { expect, test } from "vitest";
import { Inngest, Middleware } from "../../../../index.ts";
import { dependencyInjectionMiddleware } from "../../../../middleware/dependencyInjection.ts";
import { createTestApp } from "../../../devServerTestHarness.ts";
import { createState, randomSuffix, testNameFromFileUrl } from "../../utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("available in other middleware", async () => {
  class Database {}
  const db = new Database();

  const state = createState({
    beforeMw: {
      db: null as unknown,
    },
    afterMw: {
      db: null as unknown,
    },
    fn: {
      db: null as Database | null,
    },
  });

  class BeforeMiddleware extends Middleware.BaseMiddleware {
    readonly id = "test";
    override transformFunctionInput(
      arg: Middleware.TransformFunctionInputArgs,
    ) {
      // @ts-expect-error - Not typed
      state.beforeMw.db = arg.ctx.db;
      return arg;
    }
  }

  class AfterMiddleware extends Middleware.BaseMiddleware {
    readonly id = "test";
    override transformFunctionInput(
      arg: Middleware.TransformFunctionInputArgs,
    ) {
      // @ts-expect-error - Not typed
      state.afterMw.db = arg.ctx.db;
      return arg;
    }
  }

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [
      BeforeMiddleware,
      dependencyInjectionMiddleware({ db }),
      AfterMiddleware,
    ],
  });

  const fn = client.createFunction(
    { id: "fn", retries: 0, triggers: [{ event: eventName }] },
    async ({ db, runId }) => {
      state.runId = runId;
      expectTypeOf(db).not.toBeAny();
      expectTypeOf(db).toEqualTypeOf<Database>();
      state.fn.db = db;
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await state.waitForRunComplete();

  // Undefined because DI happens in the next middleware
  expect(state.beforeMw.db).toBeUndefined();

  expect(state.afterMw.db).toEqual(db);
  expect(state.fn.db).toEqual(db);
});
