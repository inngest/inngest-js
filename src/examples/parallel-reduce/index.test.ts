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
        name: "Parallel Reduce",
        id: expect.stringMatching(/^.*-parallel-reduce$/),
        triggers: [{ event: "demo/parallel.reduce" }],
        steps: {
          step: {
            id: "step",
            name: "step",
            runtime: {
              type: "http",
              url: expect.stringMatching(
                /^http.+\?fnId=.+-parallel-reduce&stepId=step$/
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
    eventId = await sendEvent("demo/parallel.reduce");
  });

  test("runs in response to 'demo/parallel.reduce'", async () => {
    runId = await eventRunWithName(eventId, "Parallel Reduce");
    expect(runId).toEqual(expect.any(String));
  });

  ["blue", "red", "green"].forEach((team) => {
    test(`ran "Get ${team} team score" step`, async () => {
      const step = await runHasTimeline(runId, {
        __typename: "StepEvent",
        stepType: "COMPLETED",
        name: `Get ${team} team score`,
      });

      expect(step).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      expect(step.output).toEqual(expect.any(String));
    });
  });

  test("Returned total score", async () => {
    await expect(
      runHasTimeline(runId, {
        __typename: "StepEvent",
        stepType: "COMPLETED",
        output: JSON.stringify({ body: "150", status: 200 }),
      })
    ).resolves.toBeDefined();
  });
});
