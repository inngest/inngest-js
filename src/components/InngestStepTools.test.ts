/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { StepOpCode } from "../types";
import { createStepTools, StepFlowInterrupt } from "./InngestStepTools";

describe("waitForEvent", () => {
  let waitForEvent: ReturnType<typeof createStepTools>[0]["waitForEvent"];
  let state: ReturnType<typeof createStepTools>[1];

  beforeEach(() => {
    [{ waitForEvent }, state] = createStepTools([]);
  });

  test("return WaitForEvent step op code", () => {
    expect(() => waitForEvent("event")).toThrow(StepFlowInterrupt);
    expect(state.nextOp).toMatchObject({
      op: StepOpCode.WaitForEvent,
    });
  });

  test("returns `event` as ID", () => {
    expect(() => waitForEvent("event")).toThrow(StepFlowInterrupt);
    expect(state.nextOp).toMatchObject({
      id: "event",
    });
  });

  test("return blank opts if none given", () => {
    expect(() => waitForEvent("event")).toThrow(StepFlowInterrupt);
    expect(state.nextOp).toMatchObject({
      opts: {},
    });
  });

  test("return TTL if string `timeout` given", () => {
    expect(() => waitForEvent("event", { timeout: "1m" })).toThrow(
      StepFlowInterrupt
    );
    expect(state.nextOp).toMatchObject({
      opts: {
        ttl: "1m",
      },
    });
  });

  test("return TTL if date `timeout` given", () => {
    const upcoming = new Date();
    upcoming.setDate(upcoming.getDate() + 6);
    upcoming.setHours(upcoming.getHours() + 1);

    expect(() => waitForEvent("event", { timeout: upcoming })).toThrow(
      StepFlowInterrupt
    );
    expect(state.nextOp).toMatchObject({
      opts: {
        ttl: expect.stringContaining("6d"),
      },
    });
  });

  test("return simple field match if `match` string given", () => {
    expect(() => waitForEvent("event", { match: "name" })).toThrow(
      StepFlowInterrupt
    );
    expect(state.nextOp).toMatchObject({
      opts: {
        match: "event.name == async.name",
      },
    });
  });

  test("return custom field match if `match` array given", () => {
    expect(() => waitForEvent("event", { match: ["name", 123] })).toThrow(
      StepFlowInterrupt
    );
    expect(state.nextOp).toMatchObject({
      opts: {
        match: "async.name == 123",
      },
    });
  });

  test("wrap custom field match is `match` array comparison is a string", () => {
    expect(() => waitForEvent("event", { match: ["name", "123"] })).toThrow(
      StepFlowInterrupt
    );
    expect(state.nextOp).toMatchObject({
      opts: {
        match: "async.name == '123'",
      },
    });
  });

  test("return custom match statement if `if` given", () => {
    expect(() => waitForEvent("event", { if: "name == 123" })).toThrow(
      StepFlowInterrupt
    );
    expect(state.nextOp).toMatchObject({
      opts: {
        match: "name == 123",
      },
    });
  });

  test("prioritise `match` statement if both `match` and `if` given", () => {
    expect(() =>
      waitForEvent("event", { match: "name", if: "name == 123" })
    ).toThrow(StepFlowInterrupt);
    expect(state.nextOp).toMatchObject({
      opts: {
        match: "event.name == async.name",
      },
    });
  });
});

describe("step", () => {
  test.todo("...");
});

describe("sleep", () => {
  test.todo("...");
});

describe("sleepUntil", () => {
  test.todo("...");
});
