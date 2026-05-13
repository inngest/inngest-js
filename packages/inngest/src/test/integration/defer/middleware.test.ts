import {
  createState,
  createTestApp,
  randomSuffix,
  testNameFromFileUrl,
} from "@inngest/test-harness";
import { expect, expectTypeOf, test } from "vitest";
import { createDefer } from "../../../experimental.ts";
import {
  dependencyInjectionMiddleware,
  Inngest,
  Middleware,
} from "../../../index.ts";
import { createServer } from "../../../node.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("dependency injection", () => {
  // Client-level dependency injection middleware is available in the defer
  // handler

  class DB {}
  const db = new DB();
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [dependencyInjectionMiddleware({ db })],
  });
  createDefer(client, { id: "foo" }, async ({ db }) => {
    expectTypeOf(db).toEqualTypeOf<DB>();
  });
  client.createFunction(
    {
      id: "mixed-defer",
      triggers: { event: "test" },
    },
    async ({ db }) => {
      expectTypeOf(db).toEqualTypeOf<DB>();
    },
  );
});

test("no step hooks", async () => {
  // Since `defer()` isn't a step we don't want to call any step-related hooks
  // for it

  const state = createState({
    hooks: {
      onRunStart: 0,
      onStepStart: 0,
      onStepComplete: 0,
      onStepError: 0,
      transformStepInput: 0,
      wrapStep: 0,
      wrapStepHandler: 0,
    },
  });

  class MW extends Middleware.BaseMiddleware {
    readonly id = "mw";
    override onRunStart() {
      state.hooks.onRunStart++;
    }
    override onStepStart() {
      state.hooks.onStepStart++;
    }
    override onStepComplete() {
      state.hooks.onStepComplete++;
    }
    override onStepError() {
      state.hooks.onStepError++;
    }
    override transformStepInput(arg: Middleware.TransformStepInputArgs) {
      state.hooks.transformStepInput++;
      return arg;
    }
    override wrapStep({ next }: Middleware.WrapStepArgs) {
      return next();
    }
    override wrapStepHandler({ next }: Middleware.WrapStepHandlerArgs) {
      return next();
    }
  }

  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
  });
  const fooDefer = createDefer(client, { id: "foo" }, async () => {});
  const fn = client.createFunction(
    {
      id: "fn",
      middleware: [MW],
      triggers: { event: "test" },
    },
    async ({ defer, runId }) => {
      state.runId = runId;
      defer("foo", { function: fooDefer, data: {} });
    },
  );
  await createTestApp({
    client,
    functions: [fn, fooDefer],
    serve: createServer,
  });
  await client.send({ name: "test", data: {} });
  await state.waitForRunComplete();
  expect(state.hooks).toEqual({
    onRunStart: 1,
    onStepStart: 0,
    onStepComplete: 0,
    onStepError: 0,
    transformStepInput: 0,
    wrapStep: 0,
    wrapStepHandler: 0,
  });
});
