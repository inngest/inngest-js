import {
  checkIntrospection,
  eventRunWithName,
  runHasTimeline,
  sendEvent,
} from "../../helpers";

checkIntrospection({
  name: "promise-all",
  triggers: [{ event: "demo/promise.all" }],
});

describe("run", () => {
  let eventId: string;
  let runId: string;

  beforeAll(async () => {
    eventId = await sendEvent("demo/promise.all");
  });

  test("runs in response to 'demo/promise.all'", async () => {
    runId = await eventRunWithName(eventId, "promise-all");
    expect(runId).toEqual(expect.any(String));
  }, 60000);

  test("ran Step 1", async () => {
    const item = await runHasTimeline(runId, {
      stepType: "RUN",
      status: "COMPLETED",
      name: "Step 1",
    });
    expect(item).toBeDefined();

    const output = await item?.getOutput();
    expect(output).toEqual({ data: 1 });
  }, 60000);

  test("ran Step 2", async () => {
    const item = await runHasTimeline(runId, {
      stepType: "RUN",
      status: "COMPLETED",
      name: "Step 2",
    });
    expect(item).toBeDefined();

    const output = await item?.getOutput();
    expect(output).toEqual({ data: 2 });
  }, 60000);

  test("ran Step 3", async () => {
    const item = await runHasTimeline(runId, {
      stepType: "RUN",
      status: "COMPLETED",
      name: "Step 3",
    });
    expect(item).toBeDefined();

    const output = await item?.getOutput();
    expect(output).toEqual({ data: 3 });
  }, 60000);
});
