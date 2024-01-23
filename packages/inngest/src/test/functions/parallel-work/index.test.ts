/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import {
  checkIntrospection,
  eventRunWithName,
  runHasTimeline,
  sendEvent,
} from "@local/test/helpers";

checkIntrospection({
  name: "parallel-work",
  triggers: [{ event: "demo/parallel.work" }],
});

describe("run", () => {
  let eventId: string;
  let runId: string;

  beforeAll(async () => {
    eventId = await sendEvent("demo/parallel.work");
  });

  test("runs in response to 'demo/parallel.work'", async () => {
    runId = await eventRunWithName(eventId, "parallel-work");
    expect(runId).toEqual(expect.any(String));
  }, 60000);

  ["First", "Second", "Third"].forEach((scoreStep) => {
    const stepName = `${scoreStep} score`;

    test(`ran "${stepName}" step`, async () => {
      const item = await runHasTimeline(runId, {
        type: "StepCompleted",
        stepName,
      });
      expect(item).toBeDefined();

      const output = await item?.getOutput();
      expect(output).toEqual({ data: expect.any(Number) });
    }, 60000);
  });

  const fruits = ["Apple", "Banana", "Orange"];

  fruits.forEach((fruit) => {
    const stepName = `Get ${fruit.toLowerCase()}`;

    test(`ran "${stepName}" step`, async () => {
      const item = await runHasTimeline(runId, {
        type: "StepCompleted",
        stepName,
      });
      expect(item).toBeDefined();

      const output = await item?.getOutput();
      expect(output).toEqual({ data: fruit });
    }, 60000);
  });

  test("Returned correct data", async () => {
    const item = await runHasTimeline(runId, {
      type: "FunctionCompleted",
    });
    expect(item).toBeDefined();

    const output = await item?.getOutput();
    expect(output).toEqual([6, `${fruits.join(", ")}`]);
  }, 60000);
});
