/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import ms from "ms";
import { assertType } from "type-plus";
import { StepOpCode } from "../types";
import { createStepTools, StepFlowInterrupt } from "./InngestStepTools";

describe("waitForEvent", () => {
  let waitForEvent: ReturnType<typeof createStepTools>[0]["waitForEvent"];
  let state: ReturnType<typeof createStepTools>[1];

  beforeEach(() => {
    [{ waitForEvent }, state] = createStepTools({});
  });

  test("return WaitForEvent step op code", async () => {
    expect(() => waitForEvent("event", { timeout: "2h" })).toThrow(
      StepFlowInterrupt
    );
    await expect(state.nextOp).resolves.toMatchObject({
      op: StepOpCode.WaitForEvent,
    });
  });

  test("returns `event` as ID", async () => {
    expect(() => waitForEvent("event", { timeout: "2h" })).toThrow(
      StepFlowInterrupt
    );
    await expect(state.nextOp).resolves.toMatchObject({
      name: "event",
    });
  });

  test("return blank opts if none given", async () => {
    expect(() => waitForEvent("event", { timeout: "2h" })).toThrow(
      StepFlowInterrupt
    );
    await expect(state.nextOp).resolves.toMatchObject({
      opts: {},
    });
  });

  test("return a hash of the op", async () => {
    expect(() => waitForEvent("event", { timeout: "2h" })).toThrow(
      StepFlowInterrupt
    );
    await expect(state.nextOp).resolves.toMatchObject({
      name: "event",
      op: "WaitForEvent",
      opts: {},
    });
  });

  test("return TTL if string `timeout` given", async () => {
    expect(() => waitForEvent("event", { timeout: "1m" })).toThrow(
      StepFlowInterrupt
    );
    await expect(state.nextOp).resolves.toMatchObject({
      opts: {
        timeout: "1m",
      },
    });
  });

  test("return TTL if date `timeout` given", async () => {
    const upcoming = new Date();
    upcoming.setDate(upcoming.getDate() + 6);
    upcoming.setHours(upcoming.getHours() + 1);

    expect(() => waitForEvent("event", { timeout: upcoming })).toThrow(
      StepFlowInterrupt
    );
    await expect(state.nextOp).resolves.toMatchObject({
      opts: {
        timeout: expect.stringContaining("6d"),
      },
    });
  });

  test("return simple field match if `match` string given", async () => {
    expect(() =>
      waitForEvent("event", { match: "name", timeout: "2h" })
    ).toThrow(StepFlowInterrupt);
    await expect(state.nextOp).resolves.toMatchObject({
      opts: {
        if: "event.name == async.name",
      },
    });
  });

  test("return custom match statement if `if` given", async () => {
    expect(() =>
      waitForEvent("event", { if: "name == 123", timeout: "2h" })
    ).toThrow(StepFlowInterrupt);
    await expect(state.nextOp).resolves.toMatchObject({
      opts: {
        if: "name == 123",
      },
    });
  });
});

describe("run", () => {
  let run: ReturnType<typeof createStepTools>[0]["run"];
  let state: ReturnType<typeof createStepTools>[1];

  beforeEach(() => {
    [{ run }, state] = createStepTools({});
  });

  test("return Step step op code", async () => {
    expect(() => run("step", () => undefined)).toThrow(StepFlowInterrupt);
    await expect(state.nextOp).resolves.toMatchObject({
      op: StepOpCode.RunStep,
    });
  });

  test("return step name as name", async () => {
    expect(() => run("step", () => undefined)).toThrow(StepFlowInterrupt);
    await expect(state.nextOp).resolves.toMatchObject({
      name: "step",
    });
  });

  test("return promisified pending op when synchronous function given", async () => {
    expect(() => run("step", () => "foo")).toThrow(StepFlowInterrupt);
    await expect(state.nextOp).resolves.toMatchObject({
      data: "foo",
    });
  });

  test("return promisified pending op when asynchronous function given", async () => {
    expect(() =>
      run(
        "step",
        () => new Promise((resolve) => setTimeout(() => resolve("foo")))
      )
    ).toThrow(StepFlowInterrupt);
    await expect(state.nextOp).resolves.toMatchObject({
      data: "foo",
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

    const fn = () => run("step", () => input);

    let output: ReturnType<typeof fn>;

    expect(() => {
      output = fn();
    }).toThrow(StepFlowInterrupt);

    assertType<{
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
    }>(output!);
  });
});

describe("sleep", () => {
  let sleep: ReturnType<typeof createStepTools>[0]["sleep"];
  let state: ReturnType<typeof createStepTools>[1];

  beforeEach(() => {
    [{ sleep }, state] = createStepTools({});
  });

  test("return Sleep step op code", async () => {
    expect(() => sleep("1m")).toThrow(StepFlowInterrupt);
    await expect(state.nextOp).resolves.toMatchObject({
      op: StepOpCode.Sleep,
    });
  });

  test("return time string as name", async () => {
    expect(() => sleep("1m")).toThrow(StepFlowInterrupt);
    await expect(state.nextOp).resolves.toMatchObject({
      name: "1m",
    });
  });
});

describe("sleepUntil", () => {
  let sleepUntil: ReturnType<typeof createStepTools>[0]["sleepUntil"];
  let state: ReturnType<typeof createStepTools>[1];

  beforeEach(() => {
    [{ sleepUntil }, state] = createStepTools({});
  });

  test("return Sleep step op code", async () => {
    const future = new Date();
    future.setDate(future.getDate() + 1);
    expect(() => sleepUntil(future)).toThrow(StepFlowInterrupt);
    await expect(state.nextOp).resolves.toMatchObject({
      op: StepOpCode.Sleep,
    });
  });

  test("parses dates", async () => {
    const next = new Date();

    expect(() => sleepUntil(next)).toThrow(StepFlowInterrupt);
    await expect(state.nextOp).resolves.toMatchObject({
      name: next.toISOString(),
    });
  });

  test("parses ISO strings", async () => {
    const next = new Date(new Date().valueOf() + ms("6d")).toISOString();

    expect(() => sleepUntil(next)).toThrow(StepFlowInterrupt);
    await expect(state.nextOp).resolves.toMatchObject({
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
