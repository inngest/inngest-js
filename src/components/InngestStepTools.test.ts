/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import ms from "ms";
import { assertType } from "type-plus";
import { StepOpCode } from "../types";
import { createStepTools, TickOp } from "./InngestStepTools";

describe("waitForEvent", () => {
  let waitForEvent: ReturnType<typeof createStepTools>[0]["waitForEvent"];
  let state: ReturnType<typeof createStepTools>[1];
  let getOp: () => TickOp | undefined;

  beforeEach(() => {
    [{ waitForEvent }, state] = createStepTools();
    getOp = () => Object.values(state.tickOps)[0];
  });

  test("return WaitForEvent step op code", () => {
    void waitForEvent("event", { timeout: "2h" });
    expect(getOp()).toMatchObject({
      op: StepOpCode.WaitForEvent,
    });
  });

  test("returns `event` as ID", () => {
    void waitForEvent("event", { timeout: "2h" });
    expect(getOp()).toMatchObject({
      name: "event",
    });
  });

  test("return blank opts if none given", () => {
    void waitForEvent("event", { timeout: "2h" });
    expect(getOp()).toMatchObject({
      opts: {},
    });
  });

  test("return a hash of the op", () => {
    void waitForEvent("event", { timeout: "2h" });
    expect(getOp()).toMatchObject({
      name: "event",
      op: "WaitForEvent",
      opts: {},
    });
  });

  test("return TTL if string `timeout` given", () => {
    void waitForEvent("event", { timeout: "1m" });
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

    void waitForEvent("event", { timeout: upcoming });
    expect(getOp()).toMatchObject({
      opts: {
        timeout: expect.stringContaining("6d"),
      },
    });
  });

  test("return simple field match if `match` string given", () => {
    void waitForEvent("event", { match: "name", timeout: "2h" });
    expect(getOp()).toMatchObject({
      opts: {
        if: "event.name == async.name",
      },
    });
  });

  test("return custom match statement if `if` given", () => {
    void waitForEvent("event", { if: "name == 123", timeout: "2h" });
    expect(getOp()).toMatchObject({
      opts: {
        if: "name == 123",
      },
    });
  });
});

describe("run", () => {
  let run: ReturnType<typeof createStepTools>[0]["run"];
  let state: ReturnType<typeof createStepTools>[1];
  let getOp: () => TickOp | undefined;

  beforeEach(() => {
    [{ run }, state] = createStepTools();
    getOp = () => Object.values(state.tickOps)[0];
  });

  test("return Step step op code", () => {
    void run("step", () => undefined);
    expect(getOp()).toMatchObject({
      op: StepOpCode.ReportStep,
    });
  });

  test("return step name as name", () => {
    void run("step", () => undefined);
    expect(getOp()).toMatchObject({
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
  let sleep: ReturnType<typeof createStepTools>[0]["sleep"];
  let state: ReturnType<typeof createStepTools>[1];
  let getOp: () => TickOp | undefined;

  beforeEach(() => {
    [{ sleep }, state] = createStepTools();
    getOp = () => Object.values(state.tickOps)[0];
  });

  test("return Sleep step op code", () => {
    void sleep("1m");
    expect(getOp()).toMatchObject({
      op: StepOpCode.Sleep,
    });
  });

  test("return time string as name", () => {
    void sleep("1m");
    expect(getOp()).toMatchObject({
      name: "1m",
    });
  });
});

describe("sleepUntil", () => {
  let sleepUntil: ReturnType<typeof createStepTools>[0]["sleepUntil"];
  let state: ReturnType<typeof createStepTools>[1];
  let getOp: () => TickOp | undefined;

  beforeEach(() => {
    [{ sleepUntil }, state] = createStepTools();
    getOp = () => Object.values(state.tickOps)[0];
  });

  test("return Sleep step op code", () => {
    const future = new Date();
    future.setDate(future.getDate() + 1);

    void sleepUntil(future);
    expect(getOp()).toMatchObject({
      op: StepOpCode.Sleep,
    });
  });

  test("parses dates", () => {
    const next = new Date();

    void sleepUntil(next);
    expect(getOp()).toMatchObject({
      name: next.toISOString(),
    });
  });

  test("parses ISO strings", () => {
    const next = new Date(new Date().valueOf() + ms("6d")).toISOString();

    void sleepUntil(next);
    expect(getOp()).toMatchObject({
      name: next,
    });
  });

  test("throws if invalid date given", () => {
    const next = new Date("bad");

    expect(() => sleepUntil(next)).toThrow(
      "Invalid date or date string passed"
    );
  });

  test("throws if invalid time string given", () => {
    const next = "bad";

    expect(() => sleepUntil(next)).toThrow(
      "Invalid date or date string passed"
    );
  });
});
