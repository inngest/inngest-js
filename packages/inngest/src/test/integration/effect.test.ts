import {
  createState,
  createTestApp,
  randomSuffix,
  sleep,
  testNameFromFileUrl,
} from "@inngest/test-harness";
import * as Effect from "effect/Effect";
import { expect, test } from "vitest";
import { EffectMiddleware } from "../../effect.ts";
import { Inngest, NonRetriableError } from "../../index.ts";
import { createServer } from "../../node.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("Effect steps replay, retry, converge, and resume with invocation scopes closed", async () => {
  const state = createState({
    invocations: 0,
    acquiredScopes: [] as number[],
    closedScopes: [] as number[],
    activeScopes: new Set<number>(),
    sleepingScopes: new Set<number>(),
    firstCalls: 0,
    secondCalls: 0,
    parallelCalls: { left: 0, right: 0 },
    retryAttempts: [] as number[],
    resumedCalls: 0,
  });
  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    checkpointing: false,
    middleware: [EffectMiddleware],
  });
  const fn = client.createFunction(
    { id: "workflow", retries: 1, triggers: [{ event: eventName }] },
    ({ effect, step, runId, attempt }) => {
      state.runId = runId;
      const invocation = ++state.invocations;
      return effect.run(
        Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.acquireRelease(
              Effect.sync(() => {
                state.acquiredScopes.push(invocation);
                state.activeScopes.add(invocation);
              }),
              () =>
                Effect.promise(async () => {
                  // Cleanup must finish before the response, not just be started.
                  await sleep(5);
                  state.activeScopes.delete(invocation);
                  state.closedScopes.push(invocation);
                }),
            );

            const first = yield* effect.step(
              () =>
                Effect.sync(() => {
                  state.firstCalls++;
                  return { value: 20 };
                }),
              (run) => step.run("first", run),
            );
            const second = yield* effect.step(
              () =>
                Effect.sync(() => {
                  state.secondCalls++;
                  return first.value + 1;
                }),
              (run) => step.run("second", run),
            );
            const parallel = yield* Effect.all(
              (["left", "right"] as const).map((side, index) =>
                effect.step(
                  () =>
                    Effect.sync(() => {
                      state.parallelCalls[side]++;
                      return second + index;
                    }),
                  (run) => step.run(side, run),
                ),
              ),
              { concurrency: "unbounded" },
            );
            const retried = yield* effect.step(
              () =>
                Effect.gen(function* () {
                  state.retryAttempts.push(attempt);
                  if (attempt === 0) {
                    return yield* Effect.fail(new Error("temporary failure"));
                  }
                  return {
                    sum: parallel.reduce((total, value) => total + value, 0),
                    sleepStartedAt: Date.now(),
                  };
                }),
              (run) => step.run("retry", run),
            );

            state.sleepingScopes.add(invocation);
            yield* effect.promise(() => step.sleep("pause", "1s"));
            return yield* effect.step(
              () =>
                Effect.sync(() => {
                  state.resumedCalls++;
                  return {
                    sum: retried.sum,
                    parallel,
                    sleptFor: Date.now() - retried.sleepStartedAt,
                    // The scope in this request is live; prior suspended requests
                    // must already have finished their asynchronous finalizers.
                    suspendedScopesStillOpen: [...state.sleepingScopes].filter(
                      (id) => id !== invocation && state.activeScopes.has(id),
                    ),
                  };
                }),
              (run) => step.run("resumed", run),
            );
          }),
        ),
      );
    },
  );
  await createTestApp({ client, functions: [fn], serve: createServer });

  await client.send({ name: eventName });
  const result = await state.waitForRunComplete();

  expect(result).toEqual({
    sum: 43,
    parallel: [21, 22],
    sleptFor: expect.any(Number),
    suspendedScopesStillOpen: [],
  });
  if (!result || typeof result !== "object" || !("sleptFor" in result)) {
    throw new Error("Expected the completed workflow's sleep duration");
  }
  expect(result.sleptFor).toBeGreaterThanOrEqual(1000);
  expect(state.firstCalls).toBe(1);
  expect(state.secondCalls).toBe(1);
  expect(state.parallelCalls).toEqual({ left: 1, right: 1 });
  expect(state.retryAttempts).toEqual([0, 1]);
  expect(state.resumedCalls).toBe(1);
  expect(state.invocations).toBeGreaterThan(1);
  expect(state.acquiredScopes).toHaveLength(state.invocations);
  expect(state.closedScopes.sort((a, b) => a - b)).toEqual(
    state.acquiredScopes.sort((a, b) => a - b),
  );
  expect(state.activeScopes.size).toBe(0);
});

test("Effect step NonRetriableError ends the real run without using its retry budget", async () => {
  const state = createState({
    prefixCalls: 0,
    terminalAttempts: [] as number[],
    unreachableCalls: 0,
  });
  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    checkpointing: false,
    middleware: [EffectMiddleware],
  });
  const fn = client.createFunction(
    { id: "terminal", retries: 2, triggers: [{ event: eventName }] },
    ({ effect, step, runId, attempt }) => {
      state.runId = runId;
      return effect.run(
        Effect.gen(function* () {
          yield* effect.step(
            () =>
              Effect.sync(() => {
                state.prefixCalls++;
                return "saved";
              }),
            (run) => step.run("prefix", run),
          );
          yield* effect.step(
            () =>
              Effect.gen(function* () {
                state.terminalAttempts.push(attempt);
                return yield* Effect.fail(
                  new NonRetriableError("permanent failure"),
                );
              }),
            (run) => step.run("terminal", run),
          );
          yield* effect.step(
            () => Effect.sync(() => state.unreachableCalls++),
            (run) => step.run("unreachable", run),
          );
        }),
      );
    },
  );
  await createTestApp({ client, functions: [fn], serve: createServer });

  await client.send({ name: eventName });
  const error = await state.waitForRunFailed();

  expect(error).toMatchObject({ message: "permanent failure" });
  expect(state.prefixCalls).toBe(1);
  expect(state.terminalAttempts).toEqual([0]);
  expect(state.unreachableCalls).toBe(0);
});
