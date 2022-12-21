/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { StepOpCode } from "../types";
import { createStepTools } from "./InngestStepTools";

describe("waitForEvent", () => {
  let waitForEvent: ReturnType<typeof createStepTools>[0]["waitForEvent"];
  let state: ReturnType<typeof createStepTools>[1];

  beforeEach(() => {
    [{ waitForEvent }, state] = createStepTools();
  });

  test("return WaitForEvent step op code", () => {
    void waitForEvent("event", { timeout: "2h" });
    expect(state.tickOps[0]).toMatchObject({
      op: StepOpCode.WaitForEvent,
    });
  });

  test("returns `event` as ID", () => {
    void waitForEvent("event", { timeout: "2h" });
    expect(state.tickOps[0]).toMatchObject({
      name: "event",
    });
  });

  test("return blank opts if none given", () => {
    void waitForEvent("event", { timeout: "2h" });
    expect(state.tickOps[0]).toMatchObject({
      opts: {},
    });
  });

  test("return a hash of the op", () => {
    void waitForEvent("event", { timeout: "2h" });
    expect(state.tickOps[0]).toMatchObject({
      name: "event",
      op: "WaitForEvent",
      opts: {},
    });
  });

  test("return TTL if string `timeout` given", () => {
    void waitForEvent("event", { timeout: "1m" });
    expect(state.tickOps[0]).toMatchObject({
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
    expect(state.tickOps[0]).toMatchObject({
      opts: {
        timeout: expect.stringContaining("6d"),
      },
    });
  });

  test("return simple field match if `match` string given", () => {
    void waitForEvent("event", { match: "name", timeout: "2h" });
    expect(state.tickOps[0]).toMatchObject({
      opts: {
        if: "event.name == async.name",
      },
    });
  });

  test("return custom match statement if `if` given", () => {
    void waitForEvent("event", { if: "name == 123", timeout: "2h" });
    expect(state.tickOps[0]).toMatchObject({
      opts: {
        if: "name == 123",
      },
    });
  });
});

describe("step", () => {
  let run: ReturnType<typeof createStepTools>[0]["run"];
  let state: ReturnType<typeof createStepTools>[1];

  beforeEach(() => {
    [{ run }, state] = createStepTools();
  });

  test("return Step step op code", () => {
    void run("step", () => undefined);
    expect(state.tickOps[0]).toMatchObject({
      op: StepOpCode.RunStep,
    });
  });

  test("return step name as name", () => {
    void run("step", () => undefined);
    expect(state.tickOps[0]).toMatchObject({
      name: "step",
    });
  });
});

describe("sleep", () => {
  let sleep: ReturnType<typeof createStepTools>[0]["sleep"];
  let state: ReturnType<typeof createStepTools>[1];

  beforeEach(() => {
    [{ sleep }, state] = createStepTools();
  });

  test("return Sleep step op code", () => {
    void sleep("1m");
    expect(state.tickOps[0]).toMatchObject({
      op: StepOpCode.Sleep,
    });
  });

  test("return time string as name", () => {
    void sleep("1m");
    expect(state.tickOps[0]).toMatchObject({
      name: "1m",
    });
  });
});

describe("sleepUntil", () => {
  let sleepUntil: ReturnType<typeof createStepTools>[0]["sleepUntil"];
  let state: ReturnType<typeof createStepTools>[1];

  beforeEach(() => {
    [{ sleepUntil }, state] = createStepTools();
  });

  test("return Sleep step op code", () => {
    const future = new Date();
    future.setDate(future.getDate() + 1);

    void sleepUntil(future);
    expect(state.tickOps[0]).toMatchObject({
      op: StepOpCode.Sleep,
    });
  });

  test("return time string as ID given a date", () => {
    const upcoming = new Date();
    upcoming.setDate(upcoming.getDate() + 6);
    upcoming.setHours(upcoming.getHours() + 1);

    void sleepUntil(upcoming);
    expect(state.tickOps[0]).toMatchObject({
      name: expect.stringContaining("6d"),
    });
  });
});
