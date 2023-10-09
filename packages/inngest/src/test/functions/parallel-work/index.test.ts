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
    const name = `${scoreStep} score`;

    test(`ran "${name}" step`, async () => {
      const step = await runHasTimeline(runId, {
        __typename: "StepEvent",
        stepType: "COMPLETED",
        name,
      });

      expect(step).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      expect(step.output).toEqual(expect.any(String));
    }, 60000);
  });

  const fruits = ["Apple", "Banana", "Orange"];

  fruits.forEach((fruit) => {
    const name = `Get ${fruit.toLowerCase()}`;

    test(`ran "${name}" step`, async () => {
      await expect(
        runHasTimeline(runId, {
          __typename: "StepEvent",
          stepType: "COMPLETED",
          name,
          output: JSON.stringify({ data: fruit }),
        })
      ).resolves.toBeDefined();
    }, 60000);
  });

  test("Returned correct data", async () => {
    await expect(
      runHasTimeline(runId, {
        __typename: "StepEvent",
        stepType: "COMPLETED",
        output: JSON.stringify([6, `${fruits.join(", ")}`]),
      })
    ).resolves.toBeDefined();
  }, 60000);
});
