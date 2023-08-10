import { EventSchemas, type EventsFromOpts } from "@local";
import { InngestExecution } from "@local/components/InngestExecution";
import { FoundStep, createStepTools } from "@local/components/InngestStepTools";
import { StepOpCode, type ClientOptions } from "@local/types";
import ms from "ms";
import { assertType } from "type-plus";
import { createClient } from "../test/helpers";

const getStepTools = (): {
  tools: ReturnType<typeof createStepTools>;
  getOp: GetOp;
} => {
  const client = createClient({ name: "test" });

  const fn = client.createFunction({ name: "test" }, { event: "any" }, () => {
    /** no-op */
  });

  const execution = new InngestExecution({
    client,
    fn,
    data: {},
    stepState: {},
  });

  const tools = createStepTools(client, execution.state);
  const getOp = () => Object.values(execution.state.steps)[0];

  return { tools, getOp };
};

type StepTools = ReturnType<typeof getStepTools>["tools"];
type GetOp = () => FoundStep | undefined;

describe("waitForEvent", () => {
  let waitForEvent: StepTools["waitForEvent"];
  let getOp: GetOp;

  beforeEach(() => {
    ({
      tools: { waitForEvent },
      getOp,
    } = getStepTools());
  });

  test("return WaitForEvent step op code", () => {
    void waitForEvent("id", "event", { timeout: "2h" });
    expect(getOp()).toMatchObject({
      op: StepOpCode.WaitForEvent,
    });
  });

  test("returns `event` as ID", () => {
    void waitForEvent("id", "event", { timeout: "2h" });
    expect(getOp()).toMatchObject({
      id: "id",
      name: "event",
    });
  });

  test("return blank opts if none given", () => {
    void waitForEvent("id", "event", { timeout: "2h" });
    expect(getOp()).toMatchObject({
      opts: {},
    });
  });

  test("return TTL if string `timeout` given", () => {
    void waitForEvent("id", "event", { timeout: "1m" });
    expect(getOp()).toMatchObject({
      opts: {
        timeout: "1m",
      },
    });
  });

  test("return TTL if date `timeout` given", () => {
    const upcoming = new Date();
    upcoming.setDate(upcoming.getDate() + 6);
    upcoming.setHours(upcoming.getHours() + 1);

    void waitForEvent("id", "event", { timeout: upcoming });
    expect(getOp()).toMatchObject({
      opts: {
        timeout: expect.stringMatching(upcoming.toISOString()),
      },
    });
  });

  test("return simple field match if `match` string given", () => {
    void waitForEvent("id", "event", { match: "name", timeout: "2h" });
    expect(getOp()).toMatchObject({
      opts: {
        if: "event.name == async.name",
      },
    });
  });

  test("return custom match statement if `if` given", () => {
    void waitForEvent("id", "event", { if: "name == 123", timeout: "2h" });
    expect(getOp()).toMatchObject({
      opts: {
        if: "name == 123",
      },
    });
  });
});

describe("run", () => {
  let run: StepTools["run"];
  let getOp: GetOp;

  beforeEach(() => {
    ({
      tools: { run },
      getOp,
    } = getStepTools());
  });

  test("return Step step op code", () => {
    void run("step", () => undefined);
    expect(getOp()).toMatchObject({
      op: StepOpCode.StepPlanned,
    });
  });

  test("return step name as name", () => {
    void run("step", () => undefined);
    expect(getOp()).toMatchObject({
      id: "step",
      name: "step",
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

    const output = run("step", () => input);

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
  let sleep: StepTools["sleep"];
  let getOp: GetOp;

  beforeEach(() => {
    ({
      tools: { sleep },
      getOp,
    } = getStepTools());
  });

  test("return id", () => {
    void sleep("id", "1m");
    expect(getOp()).toMatchObject({
      id: "id",
    });
  });

  test("return Sleep step op code", () => {
    void sleep("id", "1m");
    expect(getOp()).toMatchObject({
      op: StepOpCode.Sleep,
    });
  });

  test("return time string as name", () => {
    void sleep("id", "1m");
    expect(getOp()).toMatchObject({
      name: "1m",
    });
  });
});

describe("sleepUntil", () => {
  let sleepUntil: StepTools["sleepUntil"];
  let getOp: GetOp;

  beforeEach(() => {
    ({
      tools: { sleepUntil },
      getOp,
    } = getStepTools());
  });

  test("return id", () => {
    const future = new Date();
    future.setDate(future.getDate() + 1);

    void sleepUntil("id", future);
    expect(getOp()).toMatchObject({
      id: "id",
    });
  });

  test("return Sleep step op code", () => {
    const future = new Date();
    future.setDate(future.getDate() + 1);

    void sleepUntil("id", future);
    expect(getOp()).toMatchObject({
      op: StepOpCode.Sleep,
    });
  });

  test("parses dates", () => {
    const next = new Date();

    void sleepUntil("id", next);
    expect(getOp()).toMatchObject({
      name: next.toISOString(),
    });
  });

  test("parses ISO strings", () => {
    const next = new Date(new Date().valueOf() + ms("6d")).toISOString();

    void sleepUntil("id", next);
    expect(getOp()).toMatchObject({
      name: next,
    });
  });

  test("throws if invalid date given", () => {
    const next = new Date("bad");

    expect(() => sleepUntil("id", next)).toThrow(
      "Invalid date or date string passed"
    );
  });

  test("throws if invalid time string given", () => {
    const next = "bad";

    expect(() => sleepUntil("id", next)).toThrow(
      "Invalid date or date string passed"
    );
  });
});

describe("sendEvent", () => {
  describe("runtime", () => {
    const fetchMock = jest.fn(() =>
      Promise.resolve({ status: 200 })
    ) as unknown as typeof fetch;

    const client = createClient({
      name: "test",
      fetch: fetchMock,
      eventKey: "123",
    });
    const sendSpy = jest.spyOn(client, "send");

    let sendEvent: StepTools["sendEvent"];
    let getOp: GetOp;

    beforeEach(() => {
      ({
        tools: { sendEvent },
        getOp,
      } = getStepTools());
    });

    test("return id", () => {
      void sendEvent("id", { name: "step", data: "foo" });

      expect(getOp()).toMatchObject({
        id: "id",
      });
    });

    test("return Step step op code", () => {
      void sendEvent("id", { name: "step", data: "foo" });

      expect(getOp()).toMatchObject({ op: StepOpCode.StepPlanned });
      expect(sendSpy).not.toHaveBeenCalled();
    });

    test('return "sendEvent" as name', () => {
      void sendEvent("id", { name: "step", data: "foo" });

      expect(getOp()).toMatchObject({ name: "sendEvent" });
      expect(sendSpy).not.toHaveBeenCalled();
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
        name: "",
        schemas,
      });

      const sendEvent: ReturnType<
        typeof createStepTools<typeof opts, EventsFromOpts<typeof opts>, "foo">
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
