/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
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
        name: "Promise.race",
        id: expect.stringMatching(/^.*-promise-race$/),
        triggers: [{ event: "demo/promise.race" }],
        steps: {
          step: {
            id: "step",
            name: "step",
            runtime: {
              type: "http",
              url: expect.stringMatching(
                /^http.+\?fnId=.+-promise-race&stepId=step$/
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
    eventId = await sendEvent("demo/promise.race");
  });

  test("runs in response to 'demo/promise.race'", async () => {
    runId = await eventRunWithName(eventId, "Promise.race");
    expect(runId).toEqual(expect.any(String));
  });

  test("ran Step A", async () => {
    await expect(
      runHasTimeline(runId, {
        __typename: "StepEvent",
        stepType: "COMPLETED",
        name: "Step A",
        output: '"A"',
      })
    ).resolves.toBeDefined();
  });

  test("ran Step B", async () => {
    await expect(
      runHasTimeline(runId, {
        __typename: "StepEvent",
        stepType: "COMPLETED",
        name: "Step B",
        output: '"B"',
      })
    ).resolves.toBeDefined();
  });

  let winner: "A" | "B" | undefined;

  test("ran Step C", async () => {
    const timelineItem = await runHasTimeline(runId, {
      __typename: "StepEvent",
      stepType: "COMPLETED",
      name: "Step C",
    });

    expect(timelineItem).toBeDefined();
    const output = JSON.parse(timelineItem.output);
    winner =
      output === "A is the winner!"
        ? "A"
        : output === "B is the winner!"
        ? "B"
        : undefined;
    expect(["A", "B"]).toContain(winner);
  });
});
