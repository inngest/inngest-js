/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import {
  checkIntrospection,
  eventRunWithName,
  runHasTimeline,
  sendEvent,
} from "../../test/helpers";

checkIntrospection({
  name: "Parallel Work",
  triggers: [{ event: "demo/parallel.work" }],
});

describe("run", () => {
  let eventId: string;
  let runId: string;

  beforeAll(async () => {
    eventId = await sendEvent("demo/parallel.work");
  });

  test("runs in response to 'demo/parallel.work'", async () => {
    runId = await eventRunWithName(eventId, "Parallel Work");
    expect(runId).toEqual(expect.any(String));
  });

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
    });
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
          output: `"${fruit}"`,
        })
      ).resolves.toBeDefined();
    });
  });

  test("Returned correct data", async () => {
    await expect(
      runHasTimeline(runId, {
        __typename: "StepEvent",
        stepType: "COMPLETED",
        output: JSON.stringify({
          body: [6, `${fruits.join(", ")}`],
          status: 200,
        }),
      })
    ).resolves.toBeDefined();
  });
});
