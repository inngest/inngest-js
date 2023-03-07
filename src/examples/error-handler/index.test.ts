/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import fetch from "cross-fetch";
import {
  eventRunWithName,
  introspectionSchema,
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
        name: "Error Handler",
        id: expect.stringMatching(/^.*-error-handler$/),
        triggers: [{ event: "demo/error.handler" }],
        steps: {
          step: {
            id: "step",
            name: "step",
            runtime: {
              type: "http",
              url: expect.stringMatching(
                /^http.+\?fnId=.+-error-handler&stepId=step$/
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
  let failureRunId: string;

  beforeAll(async () => {
    eventId = await sendEvent("demo/error.handler");
  });

  test("runs in response to 'demo/error.handler'", async () => {
    runId = await eventRunWithName(eventId, "Error Handler");
    expect(runId).toEqual(expect.any(String));
  });

  test("runs failure fn in response to 'inngest/function.failed'", async () => {
    failureRunId = await eventRunWithName(eventId, "Error Handler (failure)");
    expect(failureRunId).toEqual(expect.any(String));
  });
});
