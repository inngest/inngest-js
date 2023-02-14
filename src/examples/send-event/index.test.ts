/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import fetch from "cross-fetch";
import {
  eventRunWithName,
  introspectionSchema,
  receivedEventWithName,
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
        name: "Send event",
        id: expect.stringMatching(/^.*-send-event$/),
        triggers: [{ event: "demo/send.event" }],
        steps: {
          step: {
            id: "step",
            name: "step",
            runtime: {
              type: "http",
              url: expect.stringMatching(
                /^http.+\?fnId=.+-send-event&stepId=step$/
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
    eventId = await sendEvent("demo/send.event");
  });

  test("runs in response to 'demo/send.event'", async () => {
    runId = await eventRunWithName(eventId, "Send event");
    expect(runId).toEqual(expect.any(String));
  });

  test("ran Step 'app/my.event.happened'", async () => {
    await expect(
      runHasTimeline(runId, {
        __typename: "StepEvent",
        stepType: "COMPLETED",
        name: "app/my.event.happened",
      })
    ).resolves.toBeDefined();
  });

  test("sent event 'app/my.event.happened'", async () => {
    const event = await receivedEventWithName("app/my.event.happened");
    expect(event).toBeDefined();
    expect(event?.payload?.data).toMatchObject({ foo: "bar" });
  });
});
