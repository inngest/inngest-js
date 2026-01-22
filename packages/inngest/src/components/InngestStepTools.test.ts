import { openai } from "@inngest/ai";
import ms from "ms";
import { Temporal } from "temporal-polyfill";
import { z } from "zod/v3";
import type { IsEqual } from "../helpers/types.ts";
import {
  createClient,
  getStepTools,
  type StepTools,
  testClientId,
} from "../test/helpers.ts";
import { type InvocationResult, StepOpCode } from "../types.ts";
import { InngestFunction } from "./InngestFunction.ts";
import { referenceFunction } from "./InngestFunctionReference.ts";
import type { createStepTools } from "./InngestStepTools.ts";

describe("waitForEvent", () => {
  let step: StepTools;

  beforeEach(() => {
    step = getStepTools();
  });

  test("return WaitForEvent step op code", async () => {
    await expect(
      step.waitForEvent("id", { event: "event", timeout: "2h" }),
    ).resolves.toMatchObject({
      op: StepOpCode.WaitForEvent,
    });
  });

  test("returns `id` as ID", async () => {
    await expect(
      step.waitForEvent("id", { event: "event", timeout: "2h" }),
    ).resolves.toMatchObject({
      id: "id",
    });
  });

  test("returns ID by default", async () => {
    await expect(
      step.waitForEvent("id", { event: "event", timeout: "2h" }),
    ).resolves.toMatchObject({
      displayName: "id",
    });
  });

  test("returns specific name if given", async () => {
    await expect(
      step.waitForEvent(
        { id: "id", name: "name" },
        { event: "event", timeout: "2h" },
      ),
    ).resolves.toMatchObject({
      displayName: "name",
    });
  });

  test("return event name as name", async () => {
    await expect(
      step.waitForEvent("id", { event: "event", timeout: "2h" }),
    ).resolves.toMatchObject({
      name: "event",
    });
  });

  test("return blank opts if none given", async () => {
    await expect(
      step.waitForEvent("id", { event: "event", timeout: "2h" }),
    ).resolves.toMatchObject({
      opts: {},
    });
  });

  test("return TTL if string `timeout` given", async () => {
    await expect(
      step.waitForEvent("id", { event: "event", timeout: "1m" }),
    ).resolves.toMatchObject({
      opts: {
        timeout: "1m",
      },
    });
  });

  test("return TTL if date `timeout` given", async () => {
    const upcoming = new Date();
    upcoming.setDate(upcoming.getDate() + 6);
    upcoming.setHours(upcoming.getHours() + 1);

    await expect(
      step.waitForEvent("id", { event: "event", timeout: upcoming }),
    ).resolves.toMatchObject({
      opts: {
        timeout: expect.stringMatching(upcoming.toISOString()),
      },
    });
  });

  test("return simple field match if `match` string given", async () => {
    await expect(
      step.waitForEvent("id", { event: "event", match: "name", timeout: "2h" }),
    ).resolves.toMatchObject({
      opts: {
        if: "event.name == async.name",
      },
    });
  });

  test("return custom match statement if `if` given", async () => {
    await expect(
      step.waitForEvent("id", {
        event: "event",
        if: "name == 123",
        timeout: "2h",
      }),
    ).resolves.toMatchObject({
      opts: {
        if: "name == 123",
      },
    });
  });

  describe("type errors", () => {
    test("does not allow both `match` and `if`", () => {
      // @ts-expect-error `match` and `if` cannot be defined together
      void step.waitForEvent("id", {
        event: "event",
        match: "name",
        if: "name",
        timeout: "2h",
      });
    });
  });

  test("returns userland", async () => {
    await expect(
      step.waitForEvent("id", { event: "event", timeout: "2h" }),
    ).resolves.toMatchObject({
      userland: { id: "id" },
    });
  });
});

describe("run", () => {
  let step: StepTools;

  beforeEach(() => {
    step = getStepTools();
  });

  test("return Step step op code", async () => {
    await expect(step.run("step", () => undefined)).resolves.toMatchObject({
      op: StepOpCode.StepPlanned,
    });
  });

  test("returns `id` as ID", async () => {
    await expect(step.run("id", () => undefined)).resolves.toMatchObject({
      id: "id",
    });
  });

  test("return ID by default", async () => {
    await expect(step.run("id", () => undefined)).resolves.toMatchObject({
      displayName: "id",
    });
  });

  test("return specific name if given", async () => {
    await expect(
      step.run({ id: "id", name: "name" }, () => undefined),
    ).resolves.toMatchObject({
      displayName: "name",
    });
  });

  test("types allow named function", () => {
    void step.run("", function named() {});
  });

  test("types returned from run are the result of (de)serialization", () => {
    const input = {
      str: "",
      num: 0,
      bool: false,
      date: new Date(),
      fn: () => undefined,
      obj: {
        str: "",
        num: 0,
      },
      arr: [0, 1, 2, () => undefined, true],
      infinity: Number.POSITIVE_INFINITY,
      nan: Number.NaN,
      undef: undefined,
      null: null,
      symbol: Symbol("foo"),
      map: new Map(),
      set: new Set(),
      bigint: BigInt(123),
      typedArray: new Int8Array(2),
      promise: Promise.resolve(),
      weakMap: new WeakMap([[{}, "test"]]),
      weakSet: new WeakSet([{}]),
    };

    const output = step.run("step", () => input);

    type Expected = {
      str: string;
      num: number;
      bool: boolean;
      date: string;
      obj: {
        str: string;
        num: number;
      };
      arr: (number | null | boolean)[];
      infinity: number;
      nan: number;
      null: null;
      map: Record<string, never>;
      set: Record<string, never>;
      bigint: never;
      typedArray: Record<string, number>;
      promise: {};
      weakMap: {};
      weakSet: {};
    };

    assertType<Promise<Expected>>(output);

    /**
     * Used to ensure that stripped base properties are also adhered to.
     */
    type KeysMatchExactly<T, U> = keyof T extends keyof U
      ? keyof U extends keyof T
        ? true
        : false
      : false;

    assertType<KeysMatchExactly<Expected, Awaited<typeof output>>>(true);
  });

  test("returns userland", async () => {
    await expect(step.run("id", () => undefined)).resolves.toMatchObject({
      userland: { id: "id" },
    });
  });
});

describe("ai", () => {
  describe("infer", () => {
    let step: StepTools;

    beforeEach(() => {
      step = getStepTools();
    });

    test("return Step step op code", async () => {
      await expect(
        step.ai.infer("step", {
          model: openai({ model: "gpt-3.5-turbo" }),
          body: {
            messages: [],
          },
        }),
      ).resolves.toMatchObject({
        op: StepOpCode.AiGateway,
      });
    });

    test("returns `id` as ID", async () => {
      await expect(
        step.ai.infer("id", {
          model: openai({ model: "gpt-3.5-turbo" }),
          body: {
            messages: [],
          },
        }),
      ).resolves.toMatchObject({
        id: "id",
      });
    });

    test("return ID by default", async () => {
      await expect(
        step.ai.infer("id", {
          model: openai({ model: "gpt-3.5-turbo" }),
          body: {
            messages: [],
          },
        }),
      ).resolves.toMatchObject({
        displayName: "id",
      });
    });

    test("return specific name if given", async () => {
      await expect(
        step.ai.infer(
          { id: "id", name: "name" },
          {
            model: openai({ model: "gpt-3.5-turbo" }),
            body: {
              messages: [],
            },
          },
        ),
      ).resolves.toMatchObject({
        displayName: "name",
      });
    });

    test("requires a model", () => {
      // @ts-expect-error Missing model
      () => step.ai.infer("id", { body: { messages: [] } });
    });

    test("requires a body", () => {
      () =>
        // @ts-expect-error Missing body
        step.ai.infer("id", {
          model: openai({ model: "gpt-3.5-turbo" }),
        });
    });

    test("model requires the correct body", () => {
      () =>
        step.ai.infer("id", {
          model: openai({ model: "gpt-3.5-turbo" }),
          // @ts-expect-error Invalid body
          body: {},
        });
    });

    test("accepts the correct body", () => {
      () =>
        step.ai.infer("id", {
          model: openai({ model: "gpt-3.5-turbo" }),
          body: {
            messages: [],
          },
        });
    });

    test("uses default model if none given", async () => {
      await expect(
        step.ai.infer("id", {
          model: openai({ model: "gpt-3.5-turbo" }),
          body: {
            messages: [],
          },
        }),
      ).resolves.toMatchObject({
        opts: {
          body: {
            model: "gpt-3.5-turbo",
          },
        },
      });
    });

    test("can overwrite model", async () => {
      await expect(
        step.ai.infer("id", {
          model: openai({ model: "gpt-3.5-turbo" }),
          body: {
            model: "gpt-3.5-something-else",
            messages: [],
          },
        }),
      ).resolves.toMatchObject({
        opts: {
          body: {
            model: "gpt-3.5-something-else",
          },
        },
      });
    });
  });

  describe("wrap", () => {
    let step: StepTools;

    beforeEach(() => {
      step = getStepTools();
    });

    test("return Step step op code", async () => {
      await expect(
        step.ai.wrap("step", () => undefined),
      ).resolves.toMatchObject({
        op: StepOpCode.StepPlanned,
      });
    });

    test("returns `id` as ID", async () => {
      await expect(step.ai.wrap("id", () => undefined)).resolves.toMatchObject({
        id: "id",
      });
    });

    test("return ID by default", async () => {
      await expect(step.ai.wrap("id", () => undefined)).resolves.toMatchObject({
        displayName: "id",
      });
    });

    test("return specific name if given", async () => {
      await expect(
        step.ai.wrap({ id: "id", name: "name" }, () => undefined),
      ).resolves.toMatchObject({
        displayName: "name",
      });
    });

    test("no input", async () => {
      await expect(step.ai.wrap("", () => {})).resolves.toMatchObject({});
    });

    test("single input", async () => {
      await expect(
        step.ai.wrap("", (_flag: boolean) => {}, true),
      ).resolves.toMatchObject({});
    });

    test("multiple input", async () => {
      await expect(
        step.ai.wrap("", (_flag: boolean, _value: number) => {}, true, 10),
      ).resolves.toMatchObject({});
    });

    test("disallow missing step inputs when function expects them", () => {
      // @ts-expect-error Invalid data
      void step.ai.wrap("", (_flag: boolean, _value: number) => {});

      // @ts-expect-error Invalid data
      void step.ai.wrap("", (_flag: boolean, _value: number) => {});
    });

    test("disallow step inputs when function does not expect them", () => {
      // @ts-expect-error Invalid data
      void step.ai.wrap("", () => {}, true);

      // @ts-expect-error Invalid data
      void step.ai.wrap("", () => {}, true);
    });

    test("disallow step inputs that don't match what function expects", () => {
      // @ts-expect-error Invalid data
      void step.ai.wrap("", (_flag: boolean, _value: number) => {}, 10, true);

      void step.ai.wrap(
        "",
        (_flag: boolean, _value: number) => {},
        // @ts-expect-error Invalid data
        10,
        true,
      );
    });

    test("optional input", async () => {
      await expect(
        step.run(
          "",
          (_flag: boolean, _value?: number) => {
            // valid - enough arguments given - missing arg is optional
          },
          true,
        ),
      ).resolves.toMatchObject({});

      await expect(
        step.run(
          "",
          (_flag: boolean, _value?: number) => {
            // valid - enough arguments given - missing arg is optional
          },
          true,
        ),
      ).resolves.toMatchObject({});
    });

    test("types returned from ai are the result of (de)serialization", () => {
      const input = {
        str: "",
        num: 0,
        bool: false,
        date: new Date(),
        fn: () => undefined,
        obj: {
          str: "",
          num: 0,
        },
        arr: [0, 1, 2, () => undefined, true],
        infinity: Number.POSITIVE_INFINITY,
        nan: Number.NaN,
        undef: undefined,
        null: null,
        symbol: Symbol("foo"),
        map: new Map(),
        set: new Set(),
        bigint: BigInt(123),
        typedArray: new Int8Array(2),
        promise: Promise.resolve(),
        weakMap: new WeakMap([[{}, "test"]]),
        weakSet: new WeakSet([{}]),
      };

      const output = step.ai.wrap("step", () => input);

      type Expected = {
        str: string;
        num: number;
        bool: boolean;
        date: string;
        obj: {
          str: string;
          num: number;
        };
        arr: (number | null | boolean)[];
        infinity: number;
        nan: number;
        null: null;
        map: Record<string, never>;
        set: Record<string, never>;
        bigint: never;
        typedArray: Record<string, number>;
        promise: {};
        weakMap: {};
        weakSet: {};
      };

      assertType<Promise<Expected>>(output);

      /**
       * Used to ensure that stripped base properties are also adhered to.
       */
      type KeysMatchExactly<T, U> = keyof T extends keyof U
        ? keyof U extends keyof T
          ? true
          : false
        : false;

      assertType<KeysMatchExactly<Expected, Awaited<typeof output>>>(true);
    });
  });
});

describe("sleep", () => {
  let step: StepTools;

  beforeEach(() => {
    step = getStepTools();
  });

  test("return id", async () => {
    await expect(step.sleep("id", "1m")).resolves.toMatchObject({
      id: "id",
    });
  });

  test("return Sleep step op code", async () => {
    await expect(step.sleep("id", "1m")).resolves.toMatchObject({
      op: StepOpCode.Sleep,
    });
  });

  test("return ID by default", async () => {
    await expect(step.sleep("id", "1m")).resolves.toMatchObject({
      displayName: "id",
    });
  });

  test("return specific name if given", async () => {
    await expect(
      step.sleep({ id: "id", name: "name" }, "1m"),
    ).resolves.toMatchObject({
      displayName: "name",
    });
  });

  test("parses number of milliseconds", async () => {
    await expect(step.sleep("id", 60000)).resolves.toMatchObject({
      name: "1m",
    });
  });

  test("parses ms time string", async () => {
    await expect(step.sleep("id", "1m")).resolves.toMatchObject({
      name: "1m",
    });
  });

  test("parses Temporal.Duration", async () => {
    const duration = Temporal.Duration.from({ minutes: 1 });

    await expect(step.sleep("id", duration)).resolves.toMatchObject({
      name: "1m",
    });
  });

  test("returns userland", async () => {
    await expect(step.sleep("id", "1m")).resolves.toMatchObject({
      userland: { id: "id" },
    });
  });
});

describe("sleepUntil", () => {
  let step: StepTools;

  beforeEach(() => {
    step = getStepTools();
  });

  test("return id", async () => {
    const future = new Date();
    future.setDate(future.getDate() + 1);

    await expect(step.sleepUntil("id", future)).resolves.toMatchObject({
      id: "id",
    });
  });

  test("return ID by default", async () => {
    const future = new Date();
    future.setDate(future.getDate() + 1);

    await expect(step.sleepUntil("id", future)).resolves.toMatchObject({
      displayName: "id",
    });
  });

  test("return specific name if given", async () => {
    const future = new Date();
    future.setDate(future.getDate() + 1);

    await expect(
      step.sleepUntil({ id: "id", name: "name" }, future),
    ).resolves.toMatchObject({
      displayName: "name",
    });
  });

  test("return Sleep step op code", async () => {
    const future = new Date();
    future.setDate(future.getDate() + 1);

    await expect(step.sleepUntil("id", future)).resolves.toMatchObject({
      op: StepOpCode.Sleep,
    });
  });

  test("parses dates", async () => {
    const next = new Date();

    await expect(step.sleepUntil("id", next)).resolves.toMatchObject({
      name: next.toISOString(),
    });
  });

  test("parses ISO strings", async () => {
    const next = new Date(new Date().valueOf() + ms("6d")).toISOString();

    await expect(step.sleepUntil("id", next)).resolves.toMatchObject({
      name: next,
    });
  });

  test("parses Temporal.Instant", async () => {
    const instant = Temporal.Instant.from(new Date().toISOString());

    await expect(step.sleepUntil("id", instant)).resolves.toMatchObject({
      name: instant.toString(),
    });
  });

  test("parses Temporal.ZonedDateTime", async () => {
    const zonedDateTime = Temporal.ZonedDateTime.from({
      year: 2023,
      month: 10,
      day: 1,
      hour: 12,
      minute: 0,
      second: 0,
      timeZone: "UTC",
    });

    await expect(step.sleepUntil("id", zonedDateTime)).resolves.toMatchObject({
      name: zonedDateTime.toInstant().toString(),
    });
  });

  test("throws if invalid date given", async () => {
    const next = new Date("bad");

    await expect(() => step.sleepUntil("id", next)).rejects.toThrow(
      "Invalid `Date`, date string, `Temporal.Instant`, or `Temporal.ZonedDateTime` passed to sleepUntil",
    );
  });

  test("throws if invalid time string given", async () => {
    const next = "bad";

    await expect(() => step.sleepUntil("id", next)).rejects.toThrow(
      "Invalid `Date`, date string, `Temporal.Instant`, or `Temporal.ZonedDateTime` passed to sleepUntil",
    );
  });

  test("returns userland", async () => {
    const future = new Date();
    future.setDate(future.getDate() + 1);

    await expect(step.sleepUntil("id", future)).resolves.toMatchObject({
      userland: { id: "id" },
    });
  });
});

describe("sendEvent", () => {
  describe("runtime", () => {
    let step: StepTools;
    beforeEach(() => {
      step = getStepTools();
    });

    test("return id", async () => {
      await expect(
        step.sendEvent("id", { name: "step", data: "foo" }),
      ).resolves.toMatchObject({
        id: "id",
      });
    });

    test("return Step step op code", async () => {
      await expect(
        step.sendEvent("id", { name: "step", data: "foo" }),
      ).resolves.toMatchObject({
        op: StepOpCode.StepPlanned,
      });
    });

    test("return ID by default", async () => {
      await expect(
        step.sendEvent("id", { name: "step", data: "foo" }),
      ).resolves.toMatchObject({ displayName: "id" });
    });

    test("return specific name if given", async () => {
      await expect(
        step.sendEvent(
          { id: "id", name: "name" },
          { name: "step", data: "foo" },
        ),
      ).resolves.toMatchObject({ displayName: "name" });
    });

    test("retain legacy `name` field for backwards compatibility with <=v2", async () => {
      await expect(
        step.sendEvent(
          { id: "id", name: "name" },
          { name: "step", data: "foo" },
        ),
      ).resolves.toMatchObject({ name: "sendEvent" });
    });

    test("returns userland", async () => {
      await expect(
        step.sendEvent("id", { name: "step", data: "foo" }),
      ).resolves.toMatchObject({
        userland: { id: "id" },
      });
    });
  });

  describe("types", () => {
    describe("no custom types", () => {
      const sendEvent: ReturnType<typeof createStepTools>["sendEvent"] =
        // biome-ignore lint/suspicious/noExplicitAny: intentional
        (() => undefined) as any;

      test("allows sending a single event with a string", () => {
        void sendEvent("id", { name: "anything", data: "foo" });
      });

      test("allows sending a single event with an object", () => {
        void sendEvent("id", { name: "anything", data: "foo" });
      });

      test("allows sending multiple events", () => {
        void sendEvent("id", [
          { name: "anything", data: "foo" },
          { name: "anything", data: "foo" },
        ]);
      });
    });
  });
});

describe("invoke", () => {
  let step: StepTools;
  beforeEach(() => {
    step = getStepTools();
  });

  describe("runtime", () => {
    const fn = new InngestFunction(
      createClient({ id: testClientId }),
      { id: "test-fn", triggers: [{ event: "test-event" }] },
      () => "test-return",
    );

    test("return id", async () => {
      await expect(
        step.invoke("id", { function: fn, data: { foo: "foo" } }),
      ).resolves.toMatchObject({
        id: "id",
      });
    });

    test("return Invoke step op code", async () => {
      await expect(
        step.invoke("id", { function: fn, data: { foo: "foo" } }),
      ).resolves.toMatchObject({
        op: StepOpCode.InvokeFunction,
      });
    });

    test("return ID by default", async () => {
      await expect(
        step.invoke("id", { function: fn, data: { foo: "foo" } }),
      ).resolves.toMatchObject({ displayName: "id" });
    });

    test("return specific name if given", async () => {
      await expect(
        step.invoke(
          { id: "id", name: "name" },
          { function: fn, data: { foo: "foo" } },
        ),
      ).resolves.toMatchObject({ displayName: "name" });
    });

    describe("return function ID to run", () => {
      test("with `function` instance", async () => {
        await expect(
          step.invoke("id", { function: fn, data: { foo: "foo" } }),
        ).resolves.toMatchObject({
          opts: {
            function_id: fn.id(testClientId),
          },
        });
      });

      test("with `function` string", async () => {
        await expect(
          step.invoke("id", {
            function: "some-client-some-fn",
            data: { foo: "foo" },
          }),
        ).resolves.toMatchObject({
          opts: {
            function_id: "some-client-some-fn",
          },
        });
      });

      test("with `function` ref instance", async () => {
        await expect(
          step.invoke("id", {
            function: referenceFunction<typeof fn>({ functionId: "test-fn" }),
          }),
        ).resolves.toMatchObject({
          opts: {
            function_id: `${testClientId}-test-fn`,
          },
        });
      });

      test("with `function` ref instance with `appId`", async () => {
        await expect(
          step.invoke("id", {
            function: referenceFunction({
              functionId: "some-fn",
              appId: "some-client",
            }),
            data: { foo: "foo" },
          }),
        ).resolves.toMatchObject({
          opts: {
            function_id: "some-client-some-fn",
          },
        });
      });
    });

    describe("timeouts", () => {
      test("return correct timeout if string `timeout` given", async () => {
        await expect(
          step.invoke("id", {
            function: fn,
            data: { foo: "foo" },
            timeout: "1m",
          }),
        ).resolves.toMatchObject({
          opts: {
            timeout: "1m",
          },
        });
      });

      test("return correct timeout if date `timeout` given", async () => {
        const upcoming = new Date();
        upcoming.setDate(upcoming.getDate() + 6);
        upcoming.setHours(upcoming.getHours() + 1);

        await expect(
          step.invoke("id", {
            function: fn,
            data: { foo: "foo" },
            timeout: upcoming,
          }),
        ).resolves.toMatchObject({
          opts: {
            timeout: expect.stringMatching(upcoming.toISOString()),
          },
        });
      });

      test("return correct timeout if `number` `timeout` given", async () => {
        await expect(
          step.invoke("id", {
            function: fn,
            data: { foo: "foo" },
            timeout: 60000,
          }),
        ).resolves.toMatchObject({
          opts: {
            timeout: "1m",
          },
        });
      });

      test("return userland", async () => {
        await expect(
          step.invoke("id", { function: fn, data: { foo: "foo" } }),
        ).resolves.toMatchObject({ userland: { id: "id" } });
      });
    });
  });

  describe("types", () => {
    const client = createClient({ id: "test-client" });

    const invoke = null as unknown as ReturnType<
      typeof createStepTools<typeof client>
    >["invoke"];

    // biome-ignore lint/suspicious/noExplicitAny: intentional
    type GetTestReturn<T extends () => InvocationResult<any>> = Awaited<
      ReturnType<T>
    >;

    test("allows specifying function as a string", () => {
      const _test = () => invoke("id", { function: "test-fn", data: "foo" });
    });

    test("allows specifying function as an instance", () => {
      const fn = client.createFunction(
        { id: "fn" },
        { event: "foo" },
        () => "return",
      );

      const _test = () => invoke("id", { function: fn, data: { foo: "" } });
    });

    test("allows specifying function as a string", () => {
      const _test = () => invoke("id", { function: "fn", data: { foo: "" } });
    });

    test("allows specifying function as a reference function", () => {
      const _test = () =>
        invoke("id", {
          function: referenceFunction({ functionId: "fn" }),
          data: { foo: "" },
        });
    });

    test("allows no payload if a cron", () => {
      const fn = client.createFunction(
        { id: "fn" },
        { cron: "* * * * *" },
        () => "return",
      );

      // Allowed
      const _test = () => invoke("id", { function: fn });
    });

    test("disallows no `function` given", () => {
      // @ts-expect-error No function provided
      const _test = () => invoke("id", { data: { foo: "" } });
    });

    test("disallows missing payload with a reference function and schema", () => {
      const _test = () =>
        // @ts-expect-error No `data` provided
        invoke("id", {
          function: referenceFunction({
            functionId: "fn",
            schemas: {
              data: z.object({ wowza: z.string() }),
            },
          }),
        });
    });

    test("disallows incorrect payload with a reference function and schema", () => {
      const _test = () =>
        invoke("id", {
          function: referenceFunction({
            functionId: "fn",
            schemas: {
              data: z.object({ wowza: z.string() }),
            },
          }),
          // @ts-expect-error Invalid payload provided
          data: { bar: "" },
        });
    });

    test("allows any data shape when invoking a function with multiple triggers", () => {
      const fn = client.createFunction(
        { id: "fn" },
        [{ event: "foo" }, { event: "bar" }, { cron: "* * * * *" }],
        () => "return",
      );

      const _test = () =>
        invoke("id", {
          function: fn,
          data: {
            foo: "",
            bar: "",
            cron: "",
          },
        });
    });

    test("returns correct output type for function", () => {
      const fn = client.createFunction(
        { id: "fn" },
        { event: "foo" },
        () => "return",
      );

      const _test = () => invoke("id", { function: fn, data: { foo: "" } });

      type Actual = GetTestReturn<typeof _test>;
      assertType<IsEqual<Actual, string>>(true);
    });

    test("returns correct output type for function with reference", () => {
      const fn = client.createFunction(
        { id: "fn" },
        { event: "foo" },
        () => "return",
      );

      const _test = () =>
        invoke("id", {
          function: referenceFunction<typeof fn>({ functionId: "fn" }),
          data: { foo: "" },
        });

      type Actual = GetTestReturn<typeof _test>;
      assertType<IsEqual<Actual, string>>(true);
    });

    test("returns correct output type for function with reference and schema", () => {
      const _test = () =>
        invoke("id", {
          function: referenceFunction({
            functionId: "fn",
            schemas: {
              return: z.string(),
            },
          }),
          data: { foo: "" },
        });

      type Actual = GetTestReturn<typeof _test>;
      assertType<IsEqual<Actual, string>>(true);
    });

    test("returns correct input type for function with reference and schema", () => {
      const _test = () =>
        invoke("id", {
          function: referenceFunction({
            functionId: "fn",
            schemas: {
              data: z.object({ wowza: z.string() }),
            },
          }),
          data: { wowza: "" },
        });
    });

    test("returns correct output const type for function", () => {
      const fn = client.createFunction(
        { id: "fn" },
        { event: "foo" },
        () => "return" as const,
      );

      const _test = () => invoke("id", { function: fn, data: { foo: "" } });

      type Actual = GetTestReturn<typeof _test>;
      assertType<IsEqual<Actual, "return">>(true);
    });

    test("returns correct output const type for function with reference", () => {
      const fn = client.createFunction(
        { id: "fn" },
        { event: "foo" },
        () => "return" as const,
      );

      const _test = () =>
        invoke("id", {
          function: referenceFunction<typeof fn>({ functionId: "fn" }),
          data: { foo: "" },
        });

      type Actual = GetTestReturn<typeof _test>;
      assertType<IsEqual<Actual, "return">>(true);
    });

    test("returns null if function returns undefined|void", () => {
      const fn = client.createFunction({ id: "fn" }, { event: "foo" }, () => {
        // no-op
      });

      const _test = () => invoke("id", { function: fn, data: { foo: "" } });

      type Actual = GetTestReturn<typeof _test>;
      assertType<IsEqual<Actual, null>>(true);
    });

    test("returns null if function returns undefined|void with reference", () => {
      const fn = client.createFunction({ id: "fn" }, { event: "foo" }, () => {
        // no-op
      });

      const _test = () =>
        invoke("id", {
          function: referenceFunction<typeof fn>({ functionId: "fn" }),
          data: { foo: "" },
        });

      type Actual = GetTestReturn<typeof _test>;
      assertType<IsEqual<Actual, null>>(true);
    });

    test("returns null if function returns undefined|void with reference and schema", () => {
      const _test = () =>
        invoke("id", {
          function: referenceFunction({
            functionId: "fn",
            schemas: {
              return: z.void(),
            },
          }),
        });

      type Actual = GetTestReturn<typeof _test>;
      assertType<IsEqual<Actual, null>>(true);
    });
  });
});
