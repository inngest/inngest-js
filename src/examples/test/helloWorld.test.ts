/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import fetch from "cross-fetch";
import { z } from "zod";

const introspectionSchema = z.object({
  functions: z.array(
    z.object({
      name: z.string(),
      id: z.string(),
      triggers: z.array(
        z.object({ event: z.string() }).or(
          z.object({
            cron: z.string(),
          })
        )
      ),
      steps: z.object({
        step: z.object({
          id: z.literal("step"),
          name: z.literal("step"),
          runtime: z.object({
            type: z.literal("http"),
            url: z.string().url(),
          }),
        }),
      }),
    })
  ),
});

describe("introspection", () => {
  const specs = [
    { label: "SDK UI", url: "http://localhost:3000/api/inngest?introspect" },
    { label: "Dev server UI", url: "http://localhost:8288/dev" },
  ];

  specs.forEach(({ label, url }) => {
    test(`should show registered functions in ${label}`, async () => {
      const res = await fetch(url);
      const data = introspectionSchema.parse(await res.json());

    expect(data.functions).toContainEqual({
      name: "Hello World",
      id: expect.stringMatching(/^.*-hello-world$/),
      triggers: [{ event: "demo/event.sent" }],
      steps: {
        step: {
          id: "step",
          name: "step",
          runtime: {
            type: "http",
              url: expect.stringMatching(
                /^http:\/\/(localhost|127\.0\.0\.1):3000\/api\/inngest\?fnId=.+-hello-world&stepId=step$/
            ),
          },
        },
      },
    });
    });
  });
});

describe("run", () => {
  test.todo("runs in response to 'demo/event.sent'");
  test.todo("returns 'Hello, Inngest!'");
});
