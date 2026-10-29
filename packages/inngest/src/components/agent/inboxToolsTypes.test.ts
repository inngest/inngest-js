/**
 * @module
 * Type tests for `inboxTools`: a source takes an event name or an
 * `eventType()` with a schema, and the tools reach the loop.
 */
import { z } from "zod";
import { testClientId } from "../../test/helpers.ts";
import { Inngest } from "../Inngest.ts";
import { eventType } from "../triggers/triggers.ts";
import { createAgents } from "./agents.ts";
import { agent } from "./loop.ts";

const check = eventType("github/check_run", {
  schema: z.object({ pr: z.number() }),
});
const agents = createAgents(new Inngest({ id: testClientId }));

describe("inboxTools types", () => {
  test("a source is a name or an event type, and the tools spread into the loop", () => {
    const run = () => {
      agents.agent(
        {
          id: "listener",
          on: { cron: "0 * * * *" },
          inboxTools: {
            listen: [
              { event: check, thread: "string(int(event.data.pr))" },
              { event: "ci/status", thread: "event.data.deployId" },
            ],
          },
        },
        async ({ inboxTools }) => {
          return agent.loop({
            model: async () => {
              return {
                message: { role: "assistant", content: "" },
                toolCalls: [],
              };
            },
            prompt: "go",
            tools: { ...inboxTools },
          });
        },
      );
    };

    expect(run).toBeTypeOf("function");
  });
});
