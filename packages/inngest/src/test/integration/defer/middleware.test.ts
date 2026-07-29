import {
  createState,
  createTestApp,
  randomSuffix,
  testNameFromFileUrl,
  waitFor,
} from "@inngest/test-harness";
import { expect, expectTypeOf, test } from "vitest";
import { z } from "zod";
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

test("transformDeferInput can modify data", async () => {
  const deferState = createState({ value: 0 });

  class MW extends Middleware.BaseMiddleware {
    readonly id = "mw";
    override transformDeferInput(
      arg: Middleware.TransformDeferInputArgs,
    ): Middleware.TransformDeferInputArgs {
      return { ...arg, data: { value: 42 } };
    }
  }

  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [MW],
  });
  const eventName = randomSuffix("evt");
  const foo = createDefer(
    client,
    { id: "foo", schema: z.object({ value: z.number() }) },
    async ({ event, runId }) => {
      deferState.runId = runId;
      deferState.value = event.data.value;
    },
  );
  const fn = client.createFunction(
    { id: "fn", retries: 0, triggers: { event: eventName } },
    async ({ defer }) => {
      defer("foo", { function: foo, data: { value: 1 } });
    },
  );
  await createTestApp({ client, functions: [fn, foo], serve: createServer });

  await client.send({ name: eventName });
  await deferState.waitForRunComplete();
  expect(deferState.value).toBe(42);
});

test("transformDeferInput composes in forward order", async () => {
  const deferState = createState({ value: 0 });

  class MW1 extends Middleware.BaseMiddleware {
    readonly id = "mw1";
    override transformDeferInput(
      arg: Middleware.TransformDeferInputArgs,
    ): Middleware.TransformDeferInputArgs {
      return { ...arg, data: { value: (arg.data.value as number) * 10 } };
    }
  }

  class MW2 extends Middleware.BaseMiddleware {
    readonly id = "mw2";
    override transformDeferInput(
      arg: Middleware.TransformDeferInputArgs,
    ): Middleware.TransformDeferInputArgs {
      return { ...arg, data: { value: (arg.data.value as number) + 5 } };
    }
  }

  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [MW1, MW2],
  });
  const eventName = randomSuffix("evt");
  const foo = createDefer(
    client,
    { id: "foo", schema: z.object({ value: z.number() }) },
    async ({ event, runId }) => {
      deferState.runId = runId;
      deferState.value = event.data.value;
    },
  );
  const fn = client.createFunction(
    { id: "fn", retries: 0, triggers: { event: eventName } },
    async ({ defer }) => {
      defer("foo", { function: foo, data: { value: 1 } });
    },
  );
  await createTestApp({ client, functions: [fn, foo], serve: createServer });

  await client.send({ name: eventName });
  await deferState.waitForRunComplete();
  // Forward order: MW1 runs first (1 * 10 = 10), then MW2 (10 + 5 = 15)
  expect(deferState.value).toBe(15);
});

test("async transformDeferInput is applied before the defer op ships", async () => {
  const parentState = createState({ transformComplete: false });
  const deferState = createState({ value: 0 });

  class MW extends Middleware.BaseMiddleware {
    readonly id = "mw";
    override async transformDeferInput(
      arg: Middleware.TransformDeferInputArgs,
    ): Promise<Middleware.TransformDeferInputArgs> {
      await new Promise((resolve) => setTimeout(resolve, 10));
      parentState.transformComplete = true;
      return { ...arg, data: { value: 42 } };
    }
  }

  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [MW],
  });
  const eventName = randomSuffix("evt");
  const foo = createDefer(
    client,
    { id: "foo", schema: z.object({ value: z.number() }) },
    async ({ event, runId }) => {
      deferState.runId = runId;
      deferState.value = event.data.value;
    },
  );
  const fn = client.createFunction(
    { id: "fn", retries: 0, triggers: { event: eventName } },
    async ({ defer, runId }) => {
      parentState.runId = runId;
      defer("foo", { function: foo, data: { value: 1 } });
    },
  );
  await createTestApp({ client, functions: [fn, foo], serve: createServer });

  await client.send({ name: eventName });
  await parentState.waitForRunComplete();
  await waitFor(() => expect(parentState.transformComplete).toBe(true), 3_000);
  await waitFor(() => expect(deferState.runId).not.toBeNull(), 3_000);
  await deferState.waitForRunComplete();
  expect(deferState.value).toBe(42);
});
