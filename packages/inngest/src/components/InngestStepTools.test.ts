/* eslint-disable @typescript-eslint/ban-types */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { EventSchemas } from "@local/components/EventSchemas";
import { type EventsFromOpts } from "@local/components/Inngest";
import {
  createStepTools,
  getStepOptions,
} from "@local/components/InngestStepTools";
import { StepOpCode, type ClientOptions } from "@local/types";
import ms from "ms";
import { assertType } from "type-plus";
import { createClient } from "../test/helpers";

const getStepTools = () => {
  const step = createStepTools(
    createClient({ id: "test" }),
    {},
    ({ args, matchOp }) => {
      const stepOptions = getStepOptions(args[0]);
      return Promise.resolve(matchOp(stepOptions, ...args.slice(1)));
    }
  );

  return step;
};

type StepTools = ReturnType<typeof getStepTools>;

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
    };

    const output = step.run("step", () => input);

    assertType<
      Promise<{
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
      }>
    >(output);
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
          name: "bar";
          data: { bar: string };
        };
      }>();

      const opts = (<T extends ClientOptions>(x: T): T => x)({
        id: "",
        schemas,
      });

      const sendEvent: ReturnType<
        typeof createStepTools<
          typeof opts,
          EventsFromOpts<typeof opts>,
          "foo",
          {}
        >
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      >["sendEvent"] = (() => undefined) as any;

      test("disallows sending a single unknown event with a string", () => {
        // @ts-expect-error Unknown event
        void sendEvent({ name: "unknown", data: { foo: "" } });
      });

      test("disallows sending a single unknown event with an object", () => {
        // @ts-expect-error Unknown event
        void sendEvent({ name: "unknown", data: { foo: "" } });
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
        void sendEvent({ name: "foo", data: { foo: 1 } });
      });

      test("disallows sending a single known event with an object and invalid data", () => {
        // @ts-expect-error Invalid data
        void sendEvent({ name: "foo", data: { foo: 1 } });
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
