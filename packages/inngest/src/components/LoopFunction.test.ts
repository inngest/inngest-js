import { fromPartial } from "@total-typescript/shoehorn";
import httpMocks from "node-mocks-http";
import { describe, expect, expectTypeOf, test, vi } from "vitest";
import type { InngestApi } from "../api/api.ts";
import { headerKeys } from "../helpers/consts.ts";
import { isLoopFunction } from "../helpers/marker.ts";
import { ServerTiming } from "../helpers/ServerTiming.ts";
import { serve } from "../next.ts";
import { createClient } from "../test/helpers.ts";
import {
  type EventPayload,
  functionConfigSchema,
  type OutgoingOp,
  StepMode,
  StepOpCode,
} from "../types.ts";
import { createDefer } from "./DeferredFunction.ts";
import { _internals } from "./execution/engine.ts";
import type {
  ExecutionResult,
  InngestExecutionOptions,
} from "./execution/InngestExecution.ts";
import type {
  FSMTools,
  LoopInput,
  LoopRequest,
  LoopReturnData,
  LoopTools,
} from "./execution/loop.ts";
import { internalLoggerSymbol } from "./Inngest.ts";
import {
  createFSM,
  createLoop,
  type LoopFunction,
  type LoopTickEvent,
  type LoopWakeEvent,
} from "./LoopFunction.ts";

const client = createClient({ id: "test", isDev: true });

const triggerEvent = { name: "app/thing", data: { id: "a" } };

const loopBlock = (overrides: Partial<LoopRequest> = {}): LoopRequest => ({
  state: null,
  version: 0,
  key: "a",
  input: {
    kind: "event",
    id: "",
  },
  ...overrides,
});

/**
 * runs one request of a loop run through the execution engine.
 */
const run = async (
  fn: LoopFunction.Any,
  opts: {
    loop?: LoopRequest | null;
    event?: EventPayload;
    stepState?: InngestExecutionOptions["stepState"];
    partialOptions?: Partial<InngestExecutionOptions>;
  } = {},
): Promise<ExecutionResult> => {
  const stepState = opts.stepState ?? {};
  const event = opts.event ?? triggerEvent;

  return fn["createExecution"]({
    partialOptions: {
      client: fn["client"],
      data: fromPartial({
        event,
        events: [event],
        runId: "run",
        attempt: 0,
      }),
      runId: "run",
      stepState,
      stepCompletionOrder: Object.keys(stepState),
      handlerKind: "main",
      loop: opts.loop === null ? undefined : (opts.loop ?? loopBlock()),
      timer: new ServerTiming(fn["client"][internalLoggerSymbol]),
      reqArgs: [],
      headers: {},
      stepMode: StepMode.Async,
      ...opts.partialOptions,
    },
  }).start();
};

/**
 * returns the ops of a result that ends a loop run and the data of its
 * `LoopReturn` opcode.
 */
const loopReturn = (
  result: ExecutionResult,
): { steps: OutgoingOp[]; data: LoopReturnData } => {
  if (result.type !== "steps-found") {
    throw new Error(`expected "steps-found", got ${JSON.stringify(result)}`);
  }

  const last = result.steps[result.steps.length - 1];
  expect(last?.op).toBe(StepOpCode.LoopReturn);
  expect(
    result.steps.filter((step) => step.op === StepOpCode.LoopReturn),
  ).toHaveLength(1);

  return {
    steps: result.steps,
    data: last?.data as LoopReturnData,
  };
};

const counterOpts = {
  id: "counter",
  triggers: [{ event: "app/thing" }],
  key: "event.data.id",
  state: { count: 0 },
};

describe("config", () => {
  test("createLoop adds the loop block to the sync config", () => {
    const fn = createLoop(
      client,
      {
        ...counterOpts,
        tick: "30s",
        idleTTL: "7d",
      },
      () => {},
    );

    const [config] = fn["getConfig"]({
      baseUrl: new URL("https://example.com"),
      appPrefix: "test",
    });

    expect(config?.loop).toEqual({
      kind: "loop",
      key: "event.data.id",
      tick: "30s",
      idle_ttl: "1w",
    });
    expect(config?.triggers).toEqual([{ event: "app/thing" }]);
    expect(functionConfigSchema.safeParse(config).success).toBe(true);
    expect(isLoopFunction(fn)).toBe(true);
  });

  test("createFSM sets the fsm kind and leaves unset durations out", () => {
    const fn = createFSM(client, counterOpts, () => {});

    const configs = fn["getConfig"]({
      baseUrl: new URL("https://example.com"),
      appPrefix: "test",
    });

    expect(configs).toHaveLength(1);
    expect(configs[0]?.loop).toEqual({
      kind: "fsm",
      key: "event.data.id",
    });
  });

  test("accepts one trigger that is not in an array", () => {
    const fn = createLoop(
      client,
      {
        ...counterOpts,
        triggers: { event: "app/thing" },
      },
      () => {},
    );

    const [config] = fn["getConfig"]({
      baseUrl: new URL("https://example.com"),
      appPrefix: "test",
    });

    expect(config?.triggers).toEqual([{ event: "app/thing" }]);
  });

  test("converts numeric and compound durations", () => {
    const fn = createLoop(
      client,
      {
        ...counterOpts,
        tick: 90_000,
        idleTTL: "1h30m",
      },
      () => {},
    );

    expect(fn.loop.tick).toBe("1m30s");
    expect(fn.loop.idle_ttl).toBe("1h30m");
  });

  test("a function made with createFunction has no loop block", () => {
    const fn = client.createFunction(
      {
        id: "plain",
        triggers: [{ event: "app/thing" }],
      },
      () => {},
    );

    const [config] = fn["getConfig"]({
      baseUrl: new URL("https://example.com"),
      appPrefix: "test",
    });

    expect(config).not.toHaveProperty("loop");
    expect(isLoopFunction(fn)).toBe(false);
  });
});

describe("option validation", () => {
  // biome-ignore lint/suspicious/noExplicitAny: the cases pass options the types reject
  const create = (overrides: Record<string, any>) => () =>
    createLoop(
      client,
      {
        ...counterOpts,
        ...overrides,
        // biome-ignore lint/suspicious/noExplicitAny: see above
      } as any,
      () => {},
    );

  test.each([
    ["an empty key", { key: "" }, 'requires a "key" expression'],
    ["a missing key", { key: undefined }, 'requires a "key" expression'],
    ["no triggers", { triggers: [] }, "requires at least one trigger"],
    ["undefined triggers", { triggers: undefined }, "at least one trigger"],
    [
      "a singleton",
      { singleton: { mode: "skip" } },
      "loops and singletons are mutually exclusive",
    ],
    [
      "batching",
      { batchEvents: { maxSize: 2, timeout: "1s" } },
      "loops and batching are mutually exclusive",
    ],
    [
      "debounce",
      { debounce: { period: "1s" } },
      "loops and debouncing are mutually exclusive",
    ],
    ["onFailure", { onFailure: () => {} }, "loops do not support onFailure"],
    [
      "a keyed concurrency limit",
      { concurrency: { limit: 1, key: "event.data.id" } },
      "keyed concurrency limits are mutually exclusive",
    ],
    [
      "a keyed concurrency limit in an array",
      { concurrency: [{ limit: 5 }, { limit: 1, key: "event.data.id" }] },
      "keyed concurrency limits are mutually exclusive",
    ],
    ["a null state", { state: null }, '"state" to be an object or an array'],
    ["a missing state", { state: undefined }, '"state" to be an object'],
    ["a primitive state", { state: 1 }, '"state" to be an object or an array'],
    ["a zero tick", { tick: 0 }, "tick must be a positive"],
    ["a negative tick", { tick: -1000 }, "tick must be a positive"],
    ["a malformed tick", { tick: "soon" }, "tick must be a positive"],
    ["a negative idleTTL", { idleTTL: "-1h" }, "idleTTL must be a positive"],
  ])("rejects %s", (_name, overrides, message) => {
    expect(create(overrides)).toThrowError(message);
  });

  test("rejects a state that JSON cannot encode", () => {
    const state: Record<string, unknown> = {};
    state.self = state;

    expect(create({ state })).toThrowError('could not encode "state" as JSON');
  });

  test("rejects a missing handler", () => {
    expect(() =>
      // biome-ignore lint/suspicious/noExplicitAny: the types reject this call
      (createLoop as any)(client, counterOpts),
    ).toThrowError("expected a handler function");
  });

  test.each([
    ["an unkeyed concurrency limit", { concurrency: 5 }],
    ["an unkeyed concurrency object", { concurrency: { limit: 5 } }],
    ["cancelOn", { cancelOn: [{ event: "app/stop" }] }],
    ["an array state", { state: [] }],
  ])("accepts %s", (_name, overrides) => {
    expect(create(overrides)).not.toThrow();
  });
});

describe("state", () => {
  test("a null state gets the initial state, and the changed state is returned", async () => {
    const seen: unknown[] = [];
    const fn = createLoop(client, counterOpts, ({ state }) => {
      seen.push({ ...state });
      state.count++;
    });

    const { steps, data } = loopReturn(await run(fn));

    expect(seen).toEqual([{ count: 0 }]);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      op: StepOpCode.LoopReturn,
      id: _internals.hashId("loop"),
      name: "loop",
    });
    expect(data).toEqual({
      state: { count: 1 },
      version: 0,
      end: false,
    });
  });

  test("an absent state gets the initial state", async () => {
    const fn = createLoop(client, counterOpts, ({ state }) => {
      state.count += 5;
    });

    const { data } = loopReturn(
      await run(fn, {
        loop: {
          version: 0,
          key: "a",
          input: {
            kind: "event",
          },
        },
      }),
    );

    expect(data.state).toEqual({ count: 5 });
  });

  test("the initial state is copied for each run", async () => {
    const initial = { count: 0, tags: [] as string[] };
    const fn = createLoop(
      client,
      {
        ...counterOpts,
        state: initial,
      },
      ({ state }) => {
        state.count++;
        state.tags.push("seen");
      },
    );

    const first = loopReturn(await run(fn));
    const second = loopReturn(await run(fn));

    expect(first.data.state).toEqual({ count: 1, tags: ["seen"] });
    expect(second.data.state).toEqual({ count: 1, tags: ["seen"] });
    expect(initial).toEqual({ count: 0, tags: [] });
    expect(fn.initialState).toBe(initial);
  });

  test("a committed state is used, and the version is sent back unchanged", async () => {
    const fn = createLoop(client, counterOpts, ({ state }) => {
      state.count++;
    });

    const { data } = loopReturn(
      await run(fn, {
        loop: loopBlock({
          state: { count: 41 },
          version: 7,
        }),
      }),
    );

    expect(data.state).toEqual({ count: 42 });
    expect(data.version).toBe(7);
  });

  test("a handler that changes nothing returns the state it got", async () => {
    const fn = createLoop(client, counterOpts, () => {});

    const { data } = loopReturn(
      await run(fn, {
        loop: loopBlock({
          state: { count: 3 },
          version: 2,
        }),
      }),
    );

    expect(data).toEqual({
      state: { count: 3 },
      version: 2,
      end: false,
    });
  });

  test("the returned state is a JSON copy", async () => {
    const fn = createLoop(
      client,
      {
        ...counterOpts,
        state: {} as Record<string, unknown>,
      },
      ({ state }) => {
        state.at = new Date(0);
        state.gone = undefined;
      },
    );

    const { data } = loopReturn(await run(fn));

    expect(data.state).toEqual({ at: "1970-01-01T00:00:00.000Z" });
  });

  test("a handler error commits nothing", async () => {
    const fn = createLoop(client, counterOpts, ({ state, loop }) => {
      state.count++;
      loop.wake("later", "1m");
      throw new Error("boom");
    });

    const result = await run(fn);

    expect(result.type).toBe("function-rejected");
    expect(JSON.stringify(result)).not.toContain(StepOpCode.LoopReturn);
  });

  test("a returned value is dropped and logged", async () => {
    const warn = vi.spyOn(client[internalLoggerSymbol], "warn");
    const fn = createLoop(
      client,
      counterOpts,
      // biome-ignore lint/suspicious/noExplicitAny: the types reject a returned value
      (() => ({ count: 99 })) as any,
    );

    const { data } = loopReturn(await run(fn));

    expect(data.state).toEqual({ count: 0 });
    expect(warn).toHaveBeenCalledWith(
      { runId: "run" },
      expect.stringContaining("loop handler returned a value"),
    );
    warn.mockRestore();
  });

  test("a request without a loop block fails without retry", async () => {
    const handler = vi.fn();
    const fn = createLoop(client, counterOpts, handler);

    const result = await run(fn, { loop: null });

    expect(result).toMatchObject({
      type: "function-rejected",
      retriable: false,
      error: {
        message:
          'loop function "test-counter" was invoked without a loop block',
      },
    });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("input", () => {
  test("the handler gets the kind, id, key, and version", async () => {
    let seen: LoopInput | undefined;
    const fn = createLoop(client, counterOpts, ({ input }) => {
      seen = input;
    });

    await run(fn, {
      loop: loopBlock({
        state: { count: 1 },
        version: 4,
        key: "user-1",
        input: {
          kind: "wake",
          id: "soak",
        },
      }),
      event: {
        name: "inngest/loop.wake",
        data: { key: "user-1", id: "soak" },
      },
    });

    expect(seen).toEqual({
      kind: "wake",
      id: "soak",
      key: "user-1",
      version: 4,
    });
  });

  test("an event input has no id", async () => {
    let seen: LoopInput | undefined;
    const fn = createLoop(client, counterOpts, ({ input }) => {
      seen = input;
    });

    await run(fn);

    expect(seen).toEqual({
      kind: "event",
      key: "a",
      version: 0,
    });
  });

  test.each([
    ["tick", "inngest/loop.tick"],
    ["wake", "inngest/loop.wake"],
    ["subscription", "github/pr.reviewed"],
  ])("a %s event is not checked against the triggers", async (kind, name) => {
    const fn = createLoop(client, counterOpts, ({ state }) => {
      state.count++;
    });

    const { data } = loopReturn(
      await run(fn, {
        loop: loopBlock({
          input: {
            kind,
            id: kind === "tick" ? "" : "some-id",
          },
        }),
        event: {
          name,
          data: { key: "a" },
        },
      }),
    );

    expect(data.state).toEqual({ count: 1 });
  });

  test("a trigger event that is not in the triggers fails the run", async () => {
    const fn = createLoop(client, counterOpts, () => {});

    const result = await run(fn, {
      event: {
        name: "app/other",
        data: {},
      },
    });

    expect(result).toMatchObject({
      type: "function-rejected",
      retriable: false,
    });
  });
});

describe("loop tools", () => {
  test("wake, subscribe, and unsubscribe are sent in the LoopReturn", async () => {
    const fn = createLoop(client, counterOpts, ({ loop }) => {
      loop.subscribe("pr-review", {
        event: "github/pr.reviewed",
        if: "event.data.pr == 123",
        ttl: "7d",
      });
      loop.subscribe("alerts", { event: "app/alert" });
      loop.unsubscribe("stale");
      loop.unsubscribe("older");

      return loop.wake("soak", "30s");
    });

    const { data } = loopReturn(await run(fn));

    expect(data).toEqual({
      state: { count: 0 },
      version: 0,
      end: false,
      wake: {
        id: "soak",
        after: "30s",
      },
      subscribe: [
        {
          id: "alerts",
          event: "app/alert",
        },
        {
          id: "pr-review",
          event: "github/pr.reviewed",
          if: "event.data.pr == 123",
          ttl: "1w",
        },
      ],
      unsubscribe: ["older", "stale"],
    });
  });

  test("the last wake wins", async () => {
    const fn = createLoop(client, counterOpts, ({ loop }) => {
      loop.wake("first", "1m");
      loop.wake("second", 90_000);
    });

    const { data } = loopReturn(await run(fn));

    expect(data.wake).toEqual({
      id: "second",
      after: "1m30s",
    });
  });

  test("end drops the wake and still returns the state", async () => {
    const fn = createLoop(client, counterOpts, ({ state, loop }) => {
      state.count = 10;
      loop.wake("soak", "30s");

      return loop.end();
    });

    const { data } = loopReturn(await run(fn));

    expect(data).toEqual({
      state: { count: 10 },
      version: 0,
      end: true,
    });
  });

  test("the last call for a subscription id wins", async () => {
    const fn = createLoop(client, counterOpts, ({ loop }) => {
      loop.subscribe("a", { event: "app/first" });
      loop.subscribe("a", { event: "app/second" });

      loop.subscribe("b", { event: "app/b" });
      loop.unsubscribe("b");

      loop.unsubscribe("c");
      loop.subscribe("c", { event: "app/c" });
    });

    const { data } = loopReturn(await run(fn));

    expect(data.subscribe).toEqual([
      {
        id: "a",
        event: "app/second",
      },
      {
        id: "c",
        event: "app/c",
      },
    ]);
    expect(data.unsubscribe).toEqual(["b"]);
  });

  test.each<[string, (loop: LoopTools) => void, string]>([
    [
      "wake without an id",
      (loop) => loop.wake("", "1m"),
      "loop.wake requires a non-empty id",
    ],
    [
      "wake with a zero duration",
      (loop) => loop.wake("a", 0),
      "loop.wake requires a duration above zero",
    ],
    [
      "wake with a negative duration",
      (loop) => loop.wake("a", -5),
      "loop.wake requires a duration above zero",
    ],
    [
      "wake with a malformed duration",
      (loop) => loop.wake("a", "later"),
      "loop.wake requires a duration above zero",
    ],
    [
      "subscribe without an id",
      (loop) => loop.subscribe("", { event: "app/a" }),
      "loop.subscribe requires a non-empty id",
    ],
    [
      "subscribe without an event",
      (loop) => loop.subscribe("a", { event: "" }),
      "loop.subscribe requires a non-empty event",
    ],
    [
      "subscribe with a zero ttl",
      (loop) => loop.subscribe("a", { event: "app/a", ttl: 0 }),
      "loop.subscribe requires a ttl above zero",
    ],
    [
      "unsubscribe without an id",
      (loop) => loop.unsubscribe(""),
      "loop.unsubscribe requires a non-empty id",
    ],
  ])("%s fails the run without retry", async (_name, call, message) => {
    const fn = createLoop(client, counterOpts, ({ loop }) => call(loop));

    const result = await run(fn);

    expect(result).toMatchObject({
      type: "function-rejected",
      retriable: false,
      error: { message },
    });
  });

  test.each<[string, (loop: LoopTools) => void, string]>([
    [
      "subscribe",
      (loop) => loop.subscribe("a", { event: "app/a" }),
      "loop.subscribe called in an fsm.  an fsm cannot subscribe to events",
    ],
    [
      "unsubscribe",
      (loop) => loop.unsubscribe("a"),
      "loop.unsubscribe called in an fsm.  an fsm has no subscriptions",
    ],
  ])(
    "%s in an fsm fails the run without retry",
    async (_name, call, message) => {
      const fn = createFSM(client, counterOpts, ({ loop }) =>
        call(loop as unknown as LoopTools),
      );

      const result = await run(fn);

      expect(result).toMatchObject({
        type: "function-rejected",
        retriable: false,
        error: { message },
      });
    },
  );

  test("an fsm can wake and end", async () => {
    const fn = createFSM(client, counterOpts, ({ loop }) =>
      loop.wake("soak", "2h"),
    );

    const { data } = loopReturn(await run(fn));

    expect(data.wake).toEqual({
      id: "soak",
      after: "2h",
    });
  });

  test("a loop call inside step.run fails the step", async () => {
    const fn = createLoop(client, counterOpts, async ({ step, loop }) => {
      await step.run("inner", () => {
        loop.wake("soak", "1m");
      });
    });

    const result = await run(fn);

    expect(result).toMatchObject({
      type: "step-ran",
      retriable: false,
      step: {
        op: StepOpCode.StepFailed,
        error: {
          message:
            "loop.wake called inside a step.  call it from the handler body",
        },
      },
    });
  });
});

describe("steps", () => {
  test("a step returns its op alone, and the next request returns the LoopReturn", async () => {
    const calls: string[] = [];
    const fn = createLoop(client, counterOpts, async ({ state, step }) => {
      const loaded = await step.run("load", () => {
        calls.push("load");
        return 5;
      });

      state.count += loaded;
    });

    const first = await run(fn);

    expect(first.type).toBe("step-ran");
    expect(JSON.stringify(first)).not.toContain(StepOpCode.LoopReturn);
    if (first.type !== "step-ran") {
      throw new Error("unreachable");
    }
    expect(first.step).toMatchObject({
      op: StepOpCode.StepRun,
      data: 5,
    });

    const second = loopReturn(
      await run(fn, {
        stepState: {
          [first.step.id]: {
            id: first.step.id,
            data: first.step.data,
          },
        },
      }),
    );

    expect(calls).toEqual(["load"]);
    expect(second.steps).toHaveLength(1);
    expect(second.data.state).toEqual({ count: 5 });
  });

  test.each<[string, (step: Record<string, CallableFunction>) => unknown]>([
    ["step.sleep", (step) => step.sleep?.("wait", "1m")],
    ["step.sleep", (step) => step.sleepUntil?.("wait", new Date(1))],
    [
      "step.waitForEvent",
      (step) => step.waitForEvent?.("wait", { event: "app/x", timeout: "1m" }),
    ],
    [
      "step.waitForSignal",
      (step) => step.waitForSignal?.("wait", { signal: "s", timeout: "1m" }),
    ],
  ])("%s fails the run without retry", async (name, call) => {
    const fn = createLoop(client, counterOpts, async ({ step }) => {
      await call(step as unknown as Record<string, CallableFunction>);
    });

    const result = await run(fn);

    expect(result).toMatchObject({
      type: "function-rejected",
      retriable: false,
      error: {
        message: `${name} is not allowed in a loop handler.  use loop.wake or loop.subscribe instead`,
      },
    });
  });

  test("step.sleep still works in a function made with createFunction", async () => {
    const fn = client.createFunction(
      {
        id: "plain",
        triggers: [{ event: "app/thing" }],
      },
      async ({ step }) => {
        await step.sleep("wait", "1m");
      },
    );

    const result = await run(fn as unknown as LoopFunction.Any, {
      loop: null,
    });

    expect(result).toMatchObject({
      type: "steps-found",
      steps: [{ op: StepOpCode.Sleep }],
    });
  });

  test("defer is skipped and logged", async () => {
    const error = vi.spyOn(client[internalLoggerSymbol], "error");
    const deferred = createDefer(client, { id: "deferred" }, () => {});
    const fn = createLoop(client, counterOpts, (ctx) => {
      (ctx as unknown as { defer: CallableFunction })
        .defer("later", { function: deferred, data: {} })
        .abort();
    });

    const { steps } = loopReturn(await run(fn));

    expect(steps).toHaveLength(1);
    expect(error).toHaveBeenCalledWith(
      { runId: "run" },
      "defer skipped: defer is not supported in a loop handler",
    );
    error.mockRestore();
  });
});

describe("checkpointing", () => {
  const checkpointingClient = () => {
    const c = createClient({ id: "test", isDev: true });
    const checkpointStepsAsync = vi.fn().mockResolvedValue(undefined);
    (c as unknown as { inngestApi: Partial<InngestApi> }).inngestApi = {
      checkpointStepsAsync,
    };

    return { client: c, checkpointStepsAsync };
  };

  const partialOptions = (
    bufferedSteps: number,
  ): Partial<InngestExecutionOptions> => ({
    stepMode: StepMode.AsyncCheckpointing,
    queueItemId: "queue-item",
    internalFnId: "internal-fn",
    checkpointingConfig: {
      bufferedSteps,
      maxRuntime: 0,
      maxInterval: 0,
    },
  });

  test("checkpointed steps are not sent again, and the LoopReturn is the response", async () => {
    const { client, checkpointStepsAsync } = checkpointingClient();
    const fn = createLoop(
      client,
      counterOpts,
      async ({ state, step, loop }) => {
        state.count += await step.run("a", () => 1);
        state.count += await step.run("b", () => 2);

        return loop.wake("soak", "30s");
      },
    );

    const { steps, data } = loopReturn(
      await run(fn, { partialOptions: partialOptions(1) }),
    );

    expect(checkpointStepsAsync).toHaveBeenCalledTimes(2);
    for (const [call] of checkpointStepsAsync.mock.calls) {
      expect(JSON.stringify(call.steps)).not.toContain(StepOpCode.LoopReturn);
    }

    expect(steps).toHaveLength(1);
    expect(data).toEqual({
      state: { count: 3 },
      version: 0,
      end: false,
      wake: {
        id: "soak",
        after: "30s",
      },
    });
  });

  test("steps that are not checkpointed yet come before the LoopReturn", async () => {
    const { client, checkpointStepsAsync } = checkpointingClient();
    const fn = createLoop(client, counterOpts, async ({ state, step }) => {
      state.count += await step.run("a", () => 1);
      state.count += await step.run("b", () => 2);
    });

    const { steps, data } = loopReturn(
      await run(fn, { partialOptions: partialOptions(10) }),
    );

    expect(checkpointStepsAsync).not.toHaveBeenCalled();
    expect(steps.map((step) => step.op)).toEqual([
      StepOpCode.StepRun,
      StepOpCode.StepRun,
      StepOpCode.LoopReturn,
    ]);
    expect(steps.map((step) => step.data).slice(0, 2)).toEqual([1, 2]);
    expect(data.state).toEqual({ count: 3 });
  });

  test("a failed checkpoint returns the steps without a LoopReturn", async () => {
    const { client, checkpointStepsAsync } = checkpointingClient();
    checkpointStepsAsync.mockRejectedValue(new Error("down"));
    vi.useFakeTimers({ shouldAdvanceTime: true });

    try {
      const fn = createLoop(client, counterOpts, async ({ state, step }) => {
        state.count += await step.run("a", () => 1);
      });

      const pending = run(fn, { partialOptions: partialOptions(1) });
      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(1000);
      }
      const result = await pending;

      expect(result).toMatchObject({
        type: "steps-found",
        steps: [{ op: StepOpCode.StepRun, data: 1 }],
      });
      expect(JSON.stringify(result)).not.toContain(StepOpCode.LoopReturn);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("serve", () => {
  const fn = createLoop(
    client,
    {
      ...counterOpts,
      checkpointing: false,
    },
    ({ state, input, loop }) => {
      state.count++;

      if (input.kind === "tick") {
        return loop.end();
      }

      return loop.wake("soak", "30s");
    },
  );
  const handler = serve({ client, functions: [fn] });

  const post = async (body: Record<string, unknown>) => {
    const req = httpMocks.createRequest({
      method: "POST",
      url: "/api/inngest?fnId=test-counter&stepId=step",
      headers: {
        host: "localhost:3000",
        "content-type": "application/json",
        "content-length": `${JSON.stringify(body).length}`,
        [headerKeys.InngestRunId]: "run-123",
        [headerKeys.Signature]: "",
      },
      body,
    });
    const res = httpMocks.createResponse();

    await (handler as (...args: unknown[]) => Promise<unknown>)(req, res);

    return {
      status: res.statusCode,
      body: res._getData() as string,
      headers: res.getHeaders(),
    };
  };

  const body = (loop?: unknown, event = triggerEvent) => ({
    ctx: {
      fn_id: "internal-fn",
      run_id: "run-123",
      step_id: "step",
    },
    event,
    events: [event],
    steps: {},
    use_api: false,
    ...(loop === undefined ? {} : { loop }),
  });

  test("a request with a loop block gets a 206 with one LoopReturn", async () => {
    const res = await post(
      body({
        state: { count: 2 },
        version: 3,
        key: "a",
        input: {
          kind: "event",
          id: "",
        },
      }),
    );

    expect(res.status).toBe(206);
    expect(JSON.parse(res.body)).toEqual([
      {
        op: "LoopReturn",
        id: _internals.hashId("loop"),
        name: "loop",
        data: {
          state: { count: 3 },
          version: 3,
          end: false,
          wake: {
            id: "soak",
            after: "30s",
          },
        },
      },
    ]);
  });

  test("a tick request with a null state", async () => {
    const res = await post(
      body(
        {
          state: null,
          version: 0,
          key: "a",
          input: {
            kind: "tick",
            id: "",
          },
        },
        {
          name: "inngest/loop.tick",
          data: { key: "a" } as unknown as typeof triggerEvent.data,
        },
      ),
    );

    expect(res.status).toBe(206);
    expect(JSON.parse(res.body)[0].data).toEqual({
      state: { count: 1 },
      version: 0,
      end: true,
    });
  });

  test("a request without a loop block fails without retry", async () => {
    const res = await post(body());

    expect(res.status).toBe(400);
    expect(res.headers[headerKeys.NoRetry.toLowerCase()]).toBe("true");
    expect(res.body).toContain("was invoked without a loop block");
  });
});

describe("types", () => {
  test("the handler context", () => {
    createLoop(
      client,
      {
        id: "typed",
        triggers: [{ event: "app/thing" }],
        key: "event.data.id",
        state: { count: 0, tags: [] as string[] },
      },
      ({ event, events, state, input, loop, step }) => {
        expectTypeOf(state).toEqualTypeOf<{ count: number; tags: string[] }>();
        expectTypeOf(input).toEqualTypeOf<LoopInput>();
        expectTypeOf(loop).toEqualTypeOf<LoopTools>();
        expectTypeOf(events).toEqualTypeOf<[typeof event]>();

        expectTypeOf(step).toHaveProperty("run");
        expectTypeOf(step).toHaveProperty("invoke");
        expectTypeOf(step).toHaveProperty("sendEvent");
        expectTypeOf(step).not.toHaveProperty("sleep");
        expectTypeOf(step).not.toHaveProperty("sleepUntil");
        expectTypeOf(step).not.toHaveProperty("waitForEvent");
        expectTypeOf(step).not.toHaveProperty("waitForSignal");

        expectTypeOf(loop.wake("a", "1m")).toEqualTypeOf<void>();
        expectTypeOf(loop.end()).toEqualTypeOf<void>();
      },
    );
  });

  test("an fsm has no subscribe, and its event is one of its inputs", () => {
    createFSM(
      client,
      {
        id: "typed-fsm",
        triggers: [{ event: "app/thing" }],
        key: "event.data.id",
        state: { phase: "stable" as "stable" | "rolling" },
      },
      ({ event, state, loop }) => {
        expectTypeOf(loop).toEqualTypeOf<FSMTools>();
        expectTypeOf(loop).not.toHaveProperty("subscribe");
        expectTypeOf(state.phase).toEqualTypeOf<"stable" | "rolling">();

        expectTypeOf(event.name).toEqualTypeOf<
          | "app/thing"
          | "inngest/function.invoked"
          | "inngest/loop.tick"
          | "inngest/loop.wake"
        >();

        if (event.name === "inngest/loop.tick") {
          expectTypeOf(event).toEqualTypeOf<LoopTickEvent>();
        }
        if (event.name === "inngest/loop.wake") {
          expectTypeOf(event).toEqualTypeOf<LoopWakeEvent>();
          expectTypeOf(event.data.id).toEqualTypeOf<string>();
        }
      },
    );
  });

  test("a loop event can have any name", () => {
    createLoop(client, counterOpts, ({ event }) => {
      expectTypeOf(event.name).toEqualTypeOf<string>();
    });
  });

  test("the handler cannot return a value", () => {
    // @ts-expect-error a loop keeps data in `state`
    createLoop(client, counterOpts, () => ({ count: 1 }));

    // @ts-expect-error a loop keeps data in `state`
    createFSM(client, counterOpts, async () => 1);
  });

  test("options that a loop cannot have are rejected", () => {
    // the calls throw at runtime, so they are only type checked.
    const _typesOnly = () => {
      createLoop(
        client,
        {
          ...counterOpts,
          // @ts-expect-error a loop takes one input per run
          batchEvents: { maxSize: 2, timeout: "1s" },
        },
        () => {},
      );

      // @ts-expect-error a loop needs a key
      createLoop(client, { id: "a", triggers: [], state: {} }, () => {});
    };
  });
});
