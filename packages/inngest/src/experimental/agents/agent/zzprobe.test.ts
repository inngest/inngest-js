import { appendFileSync } from "node:fs";
import { Inngest } from "../../../components/Inngest.ts";
import { testClientId } from "../../../test/helpers.ts";
import { createAgentFunction } from "./agentFunction.ts";
import { freshKv, run } from "./test-helpers.ts";

const trigger = (content: string) => {
  return {
    name: "agent/message",
    data: { agent: `${testClientId}/bot`, thread: "t1", content },
  };
};

const probe = async (forward: boolean) => {
  freshKv();

  const { fn } = createAgentFunction(
    new Inngest({ id: testClientId }),
    { id: "bot" },
    async ({ inbox, step }) => {
      const first = await inbox.drain();

      await step.run("work", async () => {
        return null;
      });

      const second = await inbox.drain();

      return {
        first: first.map((m) => (m.data as { content?: unknown }).content),
        second: second.map((m) => (m.data as { content?: unknown }).content),
      };
    },
  );
  const { output, saved, error } = await run(fn, {
    forward,
    event: trigger("go"),
    arrive: [{ event: trigger("late"), at: "work", when: "during" }],
  });

  appendFileSync(
    "/tmp/probe10.log",
    `forward=${forward} OUT ${JSON.stringify(output)} SAVED ${JSON.stringify(saved).slice(0, 160)} ERR ${String((error as { message?: string } | undefined)?.message)}\n`,
  );
};

test("probe mid-run delivery", async () => {
  await probe(false);
  await probe(true);
});
