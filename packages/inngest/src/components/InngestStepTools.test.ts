/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { EventSchemas } from "@local/components/EventSchemas";
import { type Inngest } from "@local/components/Inngest";
import { InngestFunction } from "@local/components/InngestFunction";
import { referenceFunction } from "@local/components/InngestFunctionReference";
import { type createStepTools } from "@local/components/InngestStepTools";
import {
  StepOpCode,
  type ClientOptions,
  type InvocationResult,
} from "@local/types";
import ms from "ms";
import { assertType, type IsEqual } from "type-plus";
import { z } from "zod";
import {
  createClient,
  getStepTools,
  testClientId,
  type StepTools,
} from "../test/helpers";

describe("waitForEvent", () => {
  let step: StepTools;

  beforeEach(() => {
    step = getStepTools();
  });

  test("return WaitForEvent step op code", async () => {
    await expect(
      step.waitForEvent("id", { event: "event", timeout: "2h" })
    ).resolves.toMatchObject({
      op: StepOpCode.WaitForEvent,
    });
  });

  test("returns `id` as ID", async () => {
    await expect(
      step.waitForEvent("id", { event: "event", timeout: "2h" })
    ).resolves.toMatchObject({
      id: "id",
    });
  });

  test("returns ID by default", async () => {
    await expect(
      step.waitForEvent("id", { event: "event", timeout: "2h" })
    ).resolves.toMatchObject({
      displayName: "id",
    });
  });

  test("returns specific name if given", async () => {
    await expect(
      step.waitForEvent(
        { id: "id", name: "name" },
        { event: "event", timeout: "2h" }
      )
    ).resolves.toMatchObject({
      displayName: "name",
    });
  });

  test("return event name as name", async () => {
    await expect(
      step.waitForEvent("id", { event: "event", timeout: "2h" })
    ).resolves.toMatchObject({
      name: "event",
    });
  });

  test("return blank opts if none given", async () => {
    await expect(
      step.waitForEvent("id", { event: "event", timeout: "2h" })
    ).resolves.toMatchObject({
      opts: {},
    });
  });

  test("return TTL if string `timeout` given", async () => {
    await expect(
      step.waitForEvent("id", { event: "event", timeout: "1m" })
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
      step.waitForEvent("id", { event: "event", timeout: upcoming })
    ).resolves.toMatchObject({
      opts: {
        timeout: expect.stringMatching(upcoming.toISOString()),
      },
    });
  });

  test("return simple field match if `match` string given", async () => {
    await expect(
      step.waitForEvent("id", { event: "event", match: "name", timeout: "2h" })
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
      })
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
      step.run({ id: "id", name: "name" }, () => undefined)
    ).resolves.toMatchObject({
      displayName: "name",
    });
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
      infinity: Infinity,
      nan: NaN,
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
      // eslint-disable-next-line @typescript-eslint/ban-types
      promise: {};
      // eslint-disable-next-line @typescript-eslint/ban-types
      weakMap: {};
      // eslint-disable-next-line @typescript-eslint/ban-types
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
      step.sleep({ id: "id", name: "name" }, "1m")
    ).resolves.toMatchObject({
      displayName: "name",
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
      step.sleepUntil({ id: "id", name: "name" }, future)
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

  test("throws if invalid date given", async () => {
    const next = new Date("bad");

    await expect(() => step.sleepUntil("id", next)).rejects.toThrow(
      "Invalid date or date string passed"
    );
  });

  test("throws if invalid time string given", async () => {
    const next = "bad";

    await expect(() => step.sleepUntil("id", next)).rejects.toThrow(
      "Invalid date or date string passed"
    );
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
        step.sendEvent("id", { name: "step", data: "foo" })
      ).resolves.toMatchObject({
        id: "id",
      });
    });

    test("return Step step op code", async () => {
      await expect(
        step.sendEvent("id", { name: "step", data: "foo" })
      ).resolves.toMatchObject({
        op: StepOpCode.StepPlanned,
      });
    });

    test("return ID by default", async () => {
      await expect(
        step.sendEvent("id", { name: "step", data: "foo" })
      ).resolves.toMatchObject({ displayName: "id" });
    });

    test("return specific name if given", async () => {
      await expect(
        step.sendEvent(
          { id: "id", name: "name" },
          { name: "step", data: "foo" }
        )
      ).resolves.toMatchObject({ displayName: "name" });
    });

    test("retain legacy `name` field for backwards compatibility with <=v2", async () => {
      await expect(
        step.sendEvent(
          { id: "id", name: "name" },
          { name: "step", data: "foo" }
        )
      ).resolves.toMatchObject({ name: "sendEvent" });
    });
  });

  describe("types", () => {
    describe("no custom types", () => {
      const sendEvent: ReturnType<typeof createStepTools>["sendEvent"] =
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

    describe("multiple custom types", () => {
      const schemas = new EventSchemas().fromRecord<{
        foo: {
          name: "foo";
          data: { foo: string };
        };
        bar: {
          data: { bar: string };
        };
        // eslint-disable-next-line @typescript-eslint/ban-types
        baz: {};
      }>();

      const opts = (<T extends ClientOptions>(x: T): T => x)({
        id: "",
        schemas,
      });

      type Client = Inngest<typeof opts>;

      const sendEvent: ReturnType<
        typeof createStepTools<Client>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      >["sendEvent"] = (() => undefined) as any;

      test("disallows sending a single unknown event with a string", () => {
        // @ts-expect-error Unknown event
        void sendEvent("id", { name: "unknown", data: { foo: "" } });
      });

      test("disallows sending a single unknown event with an object", () => {
        // @ts-expect-error Unknown event
        void sendEvent("id", { name: "unknown", data: { foo: "" } });
      });

      test("disallows sending multiple unknown events", () => {
        void sendEvent("id", [
          // @ts-expect-error Unknown event
          { name: "unknown", data: { foo: "" } },
          // @ts-expect-error Unknown event
          { name: "unknown2", data: { foo: "" } },
        ]);
      });

      test("disallows sending one unknown event with multiple known events", () => {
        void sendEvent("id", [
          { name: "foo", data: { foo: "" } },
          // @ts-expect-error Unknown event
          { name: "unknown", data: { foo: "" } },
        ]);
      });

      test("disallows sending a single known event with a string and invalid data", () => {
        // @ts-expect-error Invalid data
        void sendEvent("id", { name: "foo", data: { foo: 1 } });
      });

      test("disallows sending a single known event with an object and invalid data", () => {
        // @ts-expect-error Invalid data
        void sendEvent("id", { name: "foo", data: { foo: 1 } });
      });

      test("disallows sending multiple known events with invalid data", () => {
        void sendEvent("id", [
          // @ts-expect-error Invalid data
          { name: "foo", data: { bar: "" } },
          // @ts-expect-error Invalid data
          { name: "bar", data: { foo: "" } },
        ]);
      });

      test("allows sending a single known event with a string", () => {
        void sendEvent("id", { name: "foo", data: { foo: "" } });
      });

      test("allows sending a single known event with an object", () => {
        void sendEvent("id", { name: "foo", data: { foo: "" } });
      });

      test("allows sending multiple known events", () => {
        void sendEvent("id", [
          { name: "foo", data: { foo: "" } },
          { name: "bar", data: { bar: "" } },
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
      () => "test-return"
    );

    test("return id", async () => {
      await expect(
        step.invoke("id", { function: fn, data: { foo: "foo" } })
      ).resolves.toMatchObject({
        id: "id",
      });
    });

    test("return Invoke step op code", async () => {
      await expect(
        step.invoke("id", { function: fn, data: { foo: "foo" } })
      ).resolves.toMatchObject({
        op: StepOpCode.InvokeFunction,
      });
    });

    test("return ID by default", async () => {
      await expect(
        step.invoke("id", { function: fn, data: { foo: "foo" } })
      ).resolves.toMatchObject({ displayName: "id" });
    });

    test("return specific name if given", async () => {
      await expect(
        step.invoke(
          { id: "id", name: "name" },
          { function: fn, data: { foo: "foo" } }
        )
      ).resolves.toMatchObject({ displayName: "name" });
    });

    describe("return function ID to run", () => {
      test("with `function` instance", async () => {
        await expect(
          step.invoke("id", { function: fn, data: { foo: "foo" } })
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
          })
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
          })
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
          })
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
          })
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
          })
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
          })
        ).resolves.toMatchObject({
          opts: {
            timeout: "1m",
          },
        });
      });
    });
  });

  describe("types", () => {
    const schemas = new EventSchemas().fromRecord<{
      foo: {
        name: "foo";
        data: { foo: string };
      };
      bar: {
        data: { bar: string };
      };
      // eslint-disable-next-line @typescript-eslint/ban-types
      baz: {};
    }>();

    const opts = (<T extends ClientOptions>(x: T): T => x)({
      id: "test-client",
      schemas,
    });

    const client = createClient(opts);

    const invoke = null as unknown as ReturnType<
      typeof createStepTools<typeof client>
    >["invoke"];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
        () => "return"
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

    test("requires no payload if a cron", () => {
      const fn = client.createFunction(
        { id: "fn" },
        { cron: "* * * * *" },
        () => "return"
      );

      // Allowed
      const _test = () => invoke("id", { function: fn });

      // Disallowed
      // @ts-expect-error No payload should be provided for a cron
      const _test2 = () => invoke("id", { function: fn, data: { foo: "" } });
    });

    test("disallows no `function` given", () => {
      // @ts-expect-error No function provided
      const _test = () => invoke("id", { data: { foo: "" } });
    });

    test("disallows no payload if an event", () => {
      const fn = client.createFunction(
        { id: "fn" },
        { event: "foo" },
        () => "return"
      );

      // @ts-expect-error No payload provided
      const _test = () => invoke("id", { function: fn });
    });

    test("disallows incorrect payload with an event", () => {
      const fn = client.createFunction(
        { id: "fn" },
        { event: "foo" },
        () => "return"
      );

      // @ts-expect-error Invalid payload provided
      const _test = () => invoke("id", { function: fn, data: { bar: "" } });
    });

    test("disallows incorrect payload with a reference function", () => {
      const fn = client.createFunction(
        { id: "fn" },
        { event: "foo" },
        () => "return"
      );

      const _test = () =>
        invoke("id", {
          function: referenceFunction<typeof fn>({ functionId: "fn" }),
          // @ts-expect-error Invalid payload provided
          data: { bar: "" },
        });
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

    /**
     * This test is a trade-off for not yet allowing local invocation schemas
     * but adding multiple triggers.
     *
     * In the future, I foresee this being disallowed and requiring that either
     * an invocation schema exists or that the user must provide a `name` to
     * represent the payload they are trying to send.
     */
    test("allows any data shape when invoking a function with multiple triggers", () => {
      const fn = client.createFunction(
        { id: "fn" },
        [{ event: "foo" }, { event: "bar" }, { cron: "* * * * *" }],
        () => "return"
      );

      const _test = () =>
        invoke("id", {
          function: fn,
          data: {
            foo: "",
            bar: "",
            cron: "",
            // @ts-expect-error Make sure this still fails, so that we're
            // definitely only picking up expected properties
            boof: "",
          },
        });
    });

    test("returns correct output type for function", () => {
      const fn = client.createFunction(
        { id: "fn" },
        { event: "foo" },
        () => "return"
      );

      const _test = () => invoke("id", { function: fn, data: { foo: "" } });

      type Actual = GetTestReturn<typeof _test>;
      assertType<IsEqual<Actual, string>>(true);
    });

    test("returns correct output type for function with reference", () => {
      const fn = client.createFunction(
        { id: "fn" },
        { event: "foo" },
        () => "return"
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
        () => "return" as const
      );

      const _test = () => invoke("id", { function: fn, data: { foo: "" } });

      type Actual = GetTestReturn<typeof _test>;
      assertType<IsEqual<Actual, "return">>(true);
    });

    test("returns correct output const type for function with reference", () => {
      const fn = client.createFunction(
        { id: "fn" },
        { event: "foo" },
        () => "return" as const
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
