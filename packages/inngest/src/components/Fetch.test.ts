import { runFnWithStack } from "../test/helpers.ts";
import { Inngest } from "./Inngest.ts";

describe("step.fetch", () => {
  test.each([
    { status: 204, body: "", hasBody: false },
    { status: 205, body: "", hasBody: false },
    { status: 304, body: "", hasBody: false },
    { status: 200, body: "", hasBody: true },
    { status: 200, body: "response", hasBody: true },
    { status: 401, body: "unauthorized", hasBody: true },
  ])(
    "replays a $status gateway response with body '$body'",
    async ({ status, body, hasBody }) => {
      const client = new Inngest({ id: "fetch-test" });
      const fn = client.createFunction(
        { id: "fetch", triggers: [{ event: "fetch/test" }] },
        async ({ step }) => {
          const response = await step.fetch("https://example.test/");

          return {
            status: response.status,
            hasBody: response.body !== null,
            body: await response.text(),
            header: response.headers.get("x-test"),
          };
        },
      );

      const discovery = await runFnWithStack(fn, {});
      expect(discovery.type).toBe("steps-found");
      if (discovery.type !== "steps-found") {
        return;
      }

      expect(discovery.steps).toHaveLength(1);
      const gateway = discovery.steps[0]!;
      expect(gateway.op).toBe("Gateway");

      // The gateway serializes an absent HTTP response body as an empty string.
      const result = await runFnWithStack(fn, {
        [gateway.id]: {
          id: gateway.id,
          data: {
            status_code: status,
            headers: { "x-test": "preserved" },
            body,
          },
        },
      });

      expect(result).toMatchObject({
        type: "function-resolved",
        data: { status, hasBody, body, header: "preserved" },
      });
    },
  );
});
