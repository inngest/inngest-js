/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import fetch from "cross-fetch";
import {
  eventRunWithName,
  introspectionSchema,
  runHasTimeline,
  sendEvent,
} from "../../test/helpers";

describe("introspection", () => {
  const specs = [
    { label: "SDK UI", url: "http://127.0.0.1:3000/api/inngest?introspect" },
    { label: "Dev server UI", url: "http://localhost:8288/dev" },
  ];

  specs.forEach(({ label, url }) => {
    test(`should show registered functions in ${label}`, async () => {
      const res = await fetch(url);
      const data = introspectionSchema.parse(await res.json());

      expect(data.functions).toContainEqual({
        name: "Parallel Work",
        id: expect.stringMatching(/^.*-parallel-work$/),
        triggers: [{ event: "demo/parallel.work" }],
        steps: {
          step: {
            id: "step",
            name: "step",
            runtime: {
              type: "http",
              url: expect.stringMatching(
                /^http.+\?fnId=.+-parallel-work&stepId=step$/
              ),
            },
          },
        },
      });
    });
  });
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
      await expect(
        runHasTimeline(runId, {
          __typename: "StepEvent",
          stepType: "COMPLETED",
          name,
          output: expect.any(String),
        })
      ).resolves.toBeDefined();
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
          output: `"${fruit}}"`,
        })
      ).resolves.toBeDefined();
    });
  });

  test("Returned correct data", async () => {
    await expect(
      runHasTimeline(runId, {
        __typename: "StepEvent",
        stepType: "COMPLETED",
        output: `[6,"${fruits.join(", ")}"]`,
      })
    ).resolves.toBeDefined();
  });
});
