/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { StepOpCode } from "../types";
import { createStepTools, StepFlowInterrupt } from "./InngestStepTools";

describe("waitForEvent", () => {
  let waitForEvent: ReturnType<typeof createStepTools>[0]["waitForEvent"];
  let state: ReturnType<typeof createStepTools>[1];

  beforeEach(() => {
    [{ waitForEvent }, state] = createStepTools({});
  });

  test("return WaitForEvent step op code", async () => {
    expect(() => waitForEvent("event")).toThrow(StepFlowInterrupt);
    await expect(state.nextOp).resolves.toMatchObject({
      op: StepOpCode.WaitForEvent,
    });
  });

  test("returns `event` as ID", async () => {
    expect(() => waitForEvent("event")).toThrow(StepFlowInterrupt);
    await expect(state.nextOp).resolves.toMatchObject({
      id: "event",
    });
  });

  test("return blank opts if none given", async () => {
    expect(() => waitForEvent("event")).toThrow(StepFlowInterrupt);
    await expect(state.nextOp).resolves.toMatchObject({
      opts: {},
    });
  });

  test("return a hash of the op", async () => {
    expect(() => waitForEvent("event")).toThrow(StepFlowInterrupt);
    await expect(state.nextOp).resolves.toMatchObject({
      hash: "17ffb6f7b5118797c77057e5176fdc2412e275fe",
    });
  });

  test("return TTL if string `timeout` given", async () => {
    expect(() => waitForEvent("event", { timeout: "1m" })).toThrow(
      StepFlowInterrupt
    );
    await expect(state.nextOp).resolves.toMatchObject({
      opts: {
        ttl: "1m",
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
        ttl: expect.stringContaining("6d"),
      },
    });
  });

  test("return simple field match if `match` string given", async () => {
    expect(() => waitForEvent("event", { match: "name" })).toThrow(
      StepFlowInterrupt
    );
    await expect(state.nextOp).resolves.toMatchObject({
      opts: {
        match: "event.name == async.name",
      },
      hash: "b3702cc0450f2e014e1ea9b9d2438e8f3127c95a",
    });
  });

  test("return custom field match if `match` array given", async () => {
    expect(() => waitForEvent("event", { match: ["name", 123] })).toThrow(
      StepFlowInterrupt
    );
    await expect(state.nextOp).resolves.toMatchObject({
      opts: {
        match: "async.name == 123",
      },
      hash: "392ba5e9ca54ebda8759ff1ca251d6e7d12d1587",
    });
  });

  test("wrap custom field match is `match` array comparison is a string", async () => {
    expect(() => waitForEvent("event", { match: ["name", "123"] })).toThrow(
      StepFlowInterrupt
    );
    await expect(state.nextOp).resolves.toMatchObject({
      opts: {
        match: "async.name == '123'",
      },
      hash: "1765e55ef0fd0589442a5dffe79e8c317de16b8c",
    });
  });

  test("return custom match statement if `if` given", async () => {
    expect(() => waitForEvent("event", { if: "name == 123" })).toThrow(
      StepFlowInterrupt
    );
    await expect(state.nextOp).resolves.toMatchObject({
      opts: {
        match: "name == 123",
      },
      hash: "9d3fe213c82f60f52e91b036388fa7851b7ef6b3",
    });
  });

  test("prioritise `match` statement if both `match` and `if` given", async () => {
    expect(() =>
      waitForEvent("event", { match: "name", if: "name == 123" })
    ).toThrow(StepFlowInterrupt);
    await expect(state.nextOp).resolves.toMatchObject({
      opts: {
        match: "event.name == async.name",
      },
      hash: "b3702cc0450f2e014e1ea9b9d2438e8f3127c95a",
    });
  });
});

describe("step", () => {
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

  test("return step name as ID", async () => {
    expect(() => run("step", () => undefined)).toThrow(StepFlowInterrupt);
    await expect(state.nextOp).resolves.toMatchObject({
      id: "step",
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

  test("return time string as ID", async () => {
    expect(() => sleep("1m")).toThrow(StepFlowInterrupt);
    await expect(state.nextOp).resolves.toMatchObject({
      id: "1m",
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

  test("return time string as ID given a date", async () => {
    const upcoming = new Date();
    upcoming.setDate(upcoming.getDate() + 6);
    upcoming.setHours(upcoming.getHours() + 1);

    expect(() => sleepUntil(upcoming)).toThrow(StepFlowInterrupt);
    await expect(state.nextOp).resolves.toMatchObject({
      id: expect.stringContaining("6d"),
    });
  });
});
