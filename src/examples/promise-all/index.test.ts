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
        name: "Promise.all",
        id: expect.stringMatching(/^.*-promise-all$/),
        triggers: [{ event: "demo/promise.all" }],
        steps: {
          step: {
            id: "step",
            name: "step",
            runtime: {
              type: "http",
              url: expect.stringMatching(
                /^http.+\?fnId=.+-promise-all&stepId=step$/
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
    eventId = await sendEvent("demo/promise.all");
  });

  test("runs in response to 'demo/promise.all'", async () => {
    runId = await eventRunWithName(eventId, "Promise.all");
    expect(runId).toEqual(expect.any(String));
  });

  test("ran Step 1", async () => {
    await expect(
      runHasTimeline(runId, {
        __typename: "StepEvent",
        stepType: "COMPLETED",
        name: "Step 1",
        output: "1",
      })
    ).resolves.toBeDefined();
  });

  test("ran Step 2", async () => {
    await expect(
      runHasTimeline(runId, {
        __typename: "StepEvent",
        stepType: "COMPLETED",
        name: "Step 2",
        output: "2",
      })
    ).resolves.toBeDefined();
  });

  test("ran Step 3", async () => {
    await expect(
      runHasTimeline(runId, {
        __typename: "StepEvent",
        stepType: "COMPLETED",
        name: "Step 3",
        output: "3",
      })
    ).resolves.toBeDefined();
  });
});
