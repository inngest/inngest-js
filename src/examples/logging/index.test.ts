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
        name: "Logging",
        id: expect.stringMatching(/^.*-logging$/),
        triggers: [{ event: "demo/logging" }],
        steps: {
          step: {
            id: "step",
            name: "step",
            runtime: {
              type: "http",
              url: expect.stringMatching(
                /^http.+\?fnId=.+-logging&stepId=step$/
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
    eventId = await sendEvent("demo/logging");
  });

  test("runs in response to 'demo/logging'", async () => {
    runId = await eventRunWithName(eventId, "Logging");
    expect(runId).toEqual(expect.any(String));
  });

  test.todo("logs using `console.log()`");
  test.todo("logs using `console.debug()`");
  test.todo("logs using `console.error()`");
  test.todo("logs using `console.info()`");
  test.todo("logs using `console.trace()`");
  test.todo("logs using `console.warn()`");
  test.todo("logs inside a step to run");
  test.todo("only logs each log once");
});
