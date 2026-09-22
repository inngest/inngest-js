import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, expectTypeOf, test, vi } from "vitest";
import { _internals } from "./components/execution/engine.ts";
import { NonRetriableError } from "./components/NonRetriableError.ts";
import { RetryAfterError } from "./components/RetryAfterError.ts";
import { StepError } from "./components/StepError.ts";
import { EffectMiddleware, type EffectTools } from "./effect.ts";
import { serializeError } from "./helpers/errors.ts";
import { createDeferredPromise } from "./helpers/promises.ts";
import { type GetFunctionOutput, Inngest, Middleware } from "./index.ts";
import { createFnRunner, runFnWithStack } from "./test/helpers.ts";
import { StepOpCode } from "./types.ts";

class Greeting extends Context.Service<Greeting, { message: string }>()(
  "test/Greeting",
) {}

const client = new Inngest({
  id: "effect-test",
  middleware: [EffectMiddleware],
});

describe("Effect durable execution", () => {
  test("discovers lazily without executing step bodies or acquiring their resources", async () => {
    const body = vi.fn(() => Effect.succeed("not yet"));
    const fn = client.createFunction({ id: "lazy" }, ({ effect, step }) =>
      effect.run(effect.step(body, (run) => step.run("work", run))),
    );

    const result = await runFnWithStack(
      fn,
      {},
      { disableImmediateExecution: true },
    );
    expect(result).toMatchObject({
      type: "steps-found",
      steps: [{ op: StepOpCode.StepPlanned, id: _internals.hashId("work") }],
    });
    expect(body).not.toHaveBeenCalled();
  });

  test("inherits provided services and replays serialized results without rerunning effects", async () => {
    let calls = 0;
    const fn = client.createFunction({ id: "replay" }, ({ effect, step }) =>
      effect.run(
        Effect.gen(function* () {
          const first = yield* effect.step(
            () =>
              Effect.map(Greeting, ({ message }) => {
                calls++;
                return { message, at: new Date("2026-01-01T00:00:00Z") };
              }),
            (run) => step.run("first", run),
          );
          expectTypeOf(first).toEqualTypeOf<{ message: string; at: string }>();
          return yield* effect.step(
            () => Effect.succeed(`${first.message} at ${first.at}`),
            (run) => step.run("second", run),
          );
        }).pipe(Effect.provide(Layer.succeed(Greeting)({ message: "hello" }))),
      ),
    );
    expectTypeOf<GetFunctionOutput<typeof fn>>().toEqualTypeOf<string>();

    const first = await runFnWithStack(fn, {});
    expect(first).toMatchObject({
      type: "step-ran",
      step: { data: { message: "hello" } },
    });
    if (first.type !== "step-ran") throw new Error("Expected first step");
    // The wire round-trip, not the original Date object, is what replay sees.
    const state = {
      [first.step.id]: {
        id: first.step.id,
        data: JSON.parse(JSON.stringify(first.step.data)),
      },
    };
    const second = await runFnWithStack(fn, state);
    expect(second).toMatchObject({
      type: "step-ran",
      step: { data: "hello at 2026-01-01T00:00:00.000Z" },
    });
    if (second.type !== "step-ran") throw new Error("Expected second step");
    const completed = await runFnWithStack(fn, {
      ...state,
      [second.step.id]: { id: second.step.id, data: second.step.data },
    });
    expect(completed).toEqual({
      type: "function-resolved",
      data: "hello at 2026-01-01T00:00:00.000Z",
    });
    expect(calls).toBe(1);
  });

  test("uses replay-edited step inputs instead of captured original inputs", async () => {
    const fn = client.createFunction({ id: "inputs" }, ({ effect, step }) =>
      effect.run(
        effect.step(
          (value: number) => Effect.succeed(value * 2),
          (run) => step.run("double", run, 2),
        ),
      ),
    );
    const id = _internals.hashId("double");
    expect(
      await runFnWithStack(fn, { [id]: { id, input: [7] } }, { runStep: id }),
    ).toMatchObject({ type: "step-ran", step: { data: 14 } });
  });

  test("awaits asynchronous scope finalizers at every durable suspension", async () => {
    let active = 0;
    let finalized = 0;
    const finalizing = createDeferredPromise<void>();
    const release = createDeferredPromise<void>();
    const fn = client.createFunction({ id: "scope" }, ({ effect, step }) =>
      effect.run(
        Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.acquireRelease(
              Effect.sync(() => {
                active++;
              }),
              () =>
                Effect.promise(async () => {
                  finalizing.resolve();
                  await release.promise;
                  active--;
                  finalized++;
                }),
            );
            yield* effect.promise(() => step.sleep("pause", "1h"));
            return "awake";
          }),
        ),
      ),
    );
    let settled = false;
    const suspended = runFnWithStack(fn, {}).then((result) => {
      settled = true;
      return result;
    });
    await finalizing.promise;
    expect(settled).toBe(false);
    expect(active).toBe(1);
    release.resolve();
    expect(await suspended).toMatchObject({
      type: "steps-found",
      steps: [{ op: StepOpCode.Sleep }],
    });
    expect(active).toBe(0);
    expect(finalized).toBe(1);
    const id = _internals.hashId("pause");
    expect(await runFnWithStack(fn, { [id]: { id, data: null } })).toEqual({
      type: "function-resolved",
      data: "awake",
    });
    expect(active).toBe(0);
    expect(finalized).toBe(2);
  });

  test("discovers concurrent durable steps and replays them before continuing", async () => {
    const calls: string[] = [];
    const fn = client.createFunction({ id: "parallel" }, ({ effect, step }) =>
      effect.run(
        Effect.all(
          ["left", "right"].map((id) =>
            effect.step(
              () =>
                Effect.sync(() => {
                  calls.push(id);
                  return id;
                }),
              (run) => step.run(id, run),
            ),
          ),
          { concurrency: "unbounded" },
        ),
      ),
    );
    const discovery = await runFnWithStack(fn, {});
    expect(discovery.type).toBe("steps-found");
    if (discovery.type !== "steps-found")
      throw new Error("Expected parallel discovery");
    expect(discovery.steps.map((s) => s.id).sort()).toEqual(
      [_internals.hashId("left"), _internals.hashId("right")].sort(),
    );
    expect(calls).toEqual([]);
    const leftId = _internals.hashId("left");
    const rightId = _internals.hashId("right");
    const left = await runFnWithStack(fn, {}, { runStep: leftId });
    expect(left).toMatchObject({ type: "step-ran", step: { data: "left" } });
    const right = await runFnWithStack(
      fn,
      { [leftId]: { id: leftId, data: "left" } },
      { runStep: rightId },
    );
    expect(right).toMatchObject({ type: "step-ran", step: { data: "right" } });
    expect(
      await runFnWithStack(fn, {
        [leftId]: { id: leftId, data: "left" },
        [rightId]: { id: rightId, data: "right" },
      }),
    ).toEqual({ type: "function-resolved", data: ["left", "right"] });
    expect(calls.sort()).toEqual(["left", "right"]);
  });

  test.each([
    { error: new Error("retry"), retriable: true },
    { error: new NonRetriableError("stop"), retriable: false },
    { error: new RetryAfterError("later", "5s"), retriable: "5" },
  ])(
    "preserves $error.name retry policy at function and step boundaries",
    async ({ error, retriable }) => {
      const handler = client.createFunction({ id: "failure" }, ({ effect }) =>
        effect.run(Effect.fail(error)),
      );
      expect(await runFnWithStack(handler, {})).toMatchObject({
        type: "function-rejected",
        retriable,
        error: { name: error.name, message: error.message },
      });
      const stepFn = client.createFunction(
        { id: "step-failure" },
        ({ effect, step }) =>
          effect.run(
            effect.step(
              () => Effect.fail(error),
              (run) => step.run("fail", run),
            ),
          ),
      );
      expect(await runFnWithStack(stepFn, {})).toMatchObject({
        type: "step-ran",
        retriable,
        step: {
          op:
            retriable === false ? StepOpCode.StepFailed : StepOpCode.StepError,
          error: { name: error.name },
        },
      });
    },
  );

  test("preserves retry-control defects and catches typed errors inside a step", async () => {
    const defect = client.createFunction({ id: "defect" }, ({ effect }) =>
      effect.run(Effect.die(new NonRetriableError("fatal"))),
    );
    expect(await runFnWithStack(defect, {})).toMatchObject({
      type: "function-rejected",
      retriable: false,
    });
    const recovered = client.createFunction(
      { id: "typed" },
      ({ effect, step }) =>
        effect.run(
          effect.step(
            () =>
              Effect.fail({ _tag: "Missing" as const, id: 42 }).pipe(
                Effect.catchTag("Missing", ({ id }) =>
                  Effect.succeed({ fallback: id }),
                ),
              ),
            (run) => step.run("recover", run),
          ),
        ),
    );
    expect(await runFnWithStack(recovered, {})).toMatchObject({
      type: "step-ran",
      step: { data: { fallback: 42 } },
    });
  });

  test("does not restart function retries for an uncaught replayed StepError", async () => {
    const makeProgram = (
      effect: EffectTools,
      step: Parameters<Parameters<typeof client.createFunction>[1]>[0]["step"],
    ) =>
      effect.step(
        () => Effect.succeed("unused"),
        (run) => step.run("failed", run),
      );
    const fn = client.createFunction({ id: "terminal" }, ({ effect, step }) =>
      effect.run(makeProgram(effect, step)),
    );
    const id = _internals.hashId("failed");
    const state = {
      [id]: { id, error: serializeError(new Error("exhausted")) },
    };
    expect(await runFnWithStack(fn, state)).toMatchObject({
      type: "function-rejected",
      retriable: false,
    });
    const caught = client.createFunction({ id: "caught" }, ({ effect, step }) =>
      effect.run(
        makeProgram(effect, step).pipe(
          Effect.catch((error) => {
            expect(error).toBeInstanceOf(StepError);
            return Effect.succeed("recovered");
          }),
        ),
      ),
    );
    expect(await runFnWithStack(caught, state)).toEqual({
      type: "function-resolved",
      data: "recovered",
    });
  });

  test("keeps concurrent invocation services and teardown isolated", async () => {
    let active = 0;
    const fn = client.createFunction(
      { id: "isolation", triggers: { event: "test" } },
      ({ effect, step, event }) =>
        effect.run(
          effect
            .step(
              () =>
                Effect.scoped(
                  Effect.gen(function* () {
                    yield* Effect.acquireRelease(
                      Effect.sync(() => {
                        active++;
                      }),
                      () =>
                        Effect.sync(() => {
                          active--;
                        }),
                    );
                    yield* Effect.yieldNow;
                    return (yield* Greeting).message;
                  }),
                ),
              (run) => step.run("greet", run),
            )
            .pipe(
              Effect.provideService(Greeting, {
                message: event.data.message as string,
              }),
            ),
        ),
    );
    const results = await Promise.all(
      ["one", "two"].map((message) =>
        runFnWithStack(fn, {}, { event: { name: "test", data: { message } } }),
      ),
    );
    expect(results).toMatchObject([
      { type: "step-ran", step: { data: "one", op: StepOpCode.StepRun } },
      { type: "step-ran", step: { data: "two", op: StepOpCode.StepRun } },
    ]);
    expect(active).toBe(0);
  });

  test("preserves middleware output transforms instead of assuming Jsonify", async () => {
    interface AsString extends Middleware.StaticTransform {
      Out: string;
    }
    class StringOutput extends Middleware.BaseMiddleware {
      readonly id = "string-output";
      declare stepOutputTransform: AsString;
      override async wrapStepHandler({ next }: Middleware.WrapStepHandlerArgs) {
        return String(await next());
      }
    }
    const transformedClient = new Inngest({
      id: "transformed",
      middleware: [EffectMiddleware, StringOutput],
    });
    const fn = transformedClient.createFunction(
      { id: "transform" },
      ({ effect, step }) => {
        const program = effect.step(
          () => Effect.succeed(42),
          (run) => step.run("value", run),
        );
        expectTypeOf(program).toEqualTypeOf<Effect.Effect<string, unknown>>();
        return effect.run(program);
      },
    );
    const run = createFnRunner(fn);
    (await run()).assertStepData("42");
    expect((await run()).result).toEqual({
      type: "function-resolved",
      data: "42",
    });
  });

  test("reports synchronous callback throws as failures, without leaking resources", async () => {
    const fn = client.createFunction({ id: "throw" }, ({ effect, step }) =>
      effect.run(
        effect.step(
          () => {
            throw new NonRetriableError("factory failed");
          },
          (run) => step.run("factory", run),
        ),
      ),
    );
    expect(await runFnWithStack(fn, {})).toMatchObject({
      type: "step-ran",
      retriable: false,
      step: { error: { message: "factory failed" } },
    });
    const invalid = client.createFunction({ id: "invalid" }, ({ effect }) =>
      effect.run(
        effect.promise(() => {
          throw new NonRetriableError("registration failed");
        }),
      ),
    );
    expect(await runFnWithStack(invalid, {})).toMatchObject({
      type: "function-rejected",
      retriable: false,
    });
  });

  test("joins interrupted step finalizers before releasing parent services", async () => {
    const started = createDeferredPromise<void>();
    const finalizing = createDeferredPromise<void>();
    const release = createDeferredPromise<void>();
    const controller = new AbortController();
    const order: string[] = [];
    const fn = client.createFunction({ id: "abort" }, ({ effect }) =>
      effect.run(
        Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.acquireRelease(Effect.void, () =>
              Effect.sync(() => {
                order.push("parent");
              }),
            );
            yield* effect.step(
              () =>
                Effect.scoped(
                  Effect.gen(function* () {
                    yield* Effect.acquireRelease(Effect.void, () =>
                      Effect.promise(async () => {
                        finalizing.resolve();
                        await release.promise;
                        order.push("child");
                      }),
                    );
                    started.resolve();
                    yield* Effect.never;
                  }),
                ),
              (run) => run(),
            );
          }),
        ),
        { signal: controller.signal },
      ),
    );
    const result = runFnWithStack(fn, {});
    await started.promise;
    controller.abort();
    await finalizing.promise;
    expect(order).toEqual([]);
    release.resolve();
    expect(await result).toMatchObject({ type: "function-rejected" });
    expect(order).toEqual(["child", "parent"]);
  });

  test("does not start synchronous effects with an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const sideEffect = vi.fn();
    const fn = client.createFunction({ id: "pre-abort" }, ({ effect }) =>
      effect.run(Effect.sync(sideEffect), { signal: controller.signal }),
    );
    expect(await runFnWithStack(fn, {})).toMatchObject({
      type: "function-rejected",
    });
    expect(sideEffect).not.toHaveBeenCalled();
  });

  test("suspension is not logged as failure but finalizer defects are reported", async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const scopedClient = new Inngest({
      id: "cleanup",
      middleware: [EffectMiddleware],
      logger,
    });
    const good = scopedClient.createFunction(
      { id: "good" },
      ({ effect, step }) =>
        effect.run(effect.promise(() => step.sleep("pause", "1h"))),
    );
    expect(await runFnWithStack(good, {})).toMatchObject({
      type: "steps-found",
    });
    expect(logger.error).not.toHaveBeenCalled();

    const broken = scopedClient.createFunction(
      { id: "broken" },
      ({ effect, step }) =>
        effect.run(
          Effect.scoped(
            Effect.gen(function* () {
              yield* Effect.acquireRelease(Effect.void, () =>
                Effect.die(new Error("cleanup failed")),
              );
              yield* effect.promise(() => step.sleep("pause", "1h"));
            }),
          ),
        ),
    );
    expect(await runFnWithStack(broken, {})).toMatchObject({
      type: "steps-found",
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        hook: "onExecutionEnd",
        err: expect.any(AggregateError),
      }),
      "middleware error",
    );
  });

  test("keeps outer middleware resources alive until Effect finalizers finish", async () => {
    class ParentResource extends Middleware.BaseMiddleware {
      readonly id = "parent-resource";
      readonly resource = { closed: false };

      override transformFunctionInput(
        arg: Middleware.TransformFunctionInputArgs,
      ) {
        return { ...arg, ctx: { ...arg.ctx, resource: this.resource } };
      }

      override onExecutionEnd() {
        this.resource.closed = true;
      }
    }
    const scopedClient = new Inngest({
      id: "middleware-resources",
      middleware: [ParentResource, EffectMiddleware],
    });
    const observed: boolean[] = [];
    const fn = scopedClient.createFunction(
      { id: "resource-order" },
      ({ effect, step, resource }) =>
        effect.run(
          Effect.scoped(
            Effect.gen(function* () {
              yield* Effect.acquireRelease(Effect.void, () =>
                Effect.sync(() => {
                  observed.push(resource.closed);
                }),
              );
              yield* effect.promise(() => step.sleep("pause", "1h"));
            }),
          ),
        ),
    );
    expect(await runFnWithStack(fn, {})).toMatchObject({ type: "steps-found" });
    expect(observed).toEqual([false]);
  });
});

// These callbacks are compile-time assertions, never executed.
const requireServices = (tools: EffectTools) => {
  const program = tools.step(
    () => Greeting,
    (run) => run(),
  );
  expectTypeOf(program).toEqualTypeOf<
    Effect.Effect<{ message: string }, unknown, Greeting>
  >();
  // @ts-expect-error A handler must provide all Effect services before running.
  tools.run(program);
  tools.run(
    program.pipe(Effect.provideService(Greeting, { message: "provided" })),
  );
};
void requireServices;
