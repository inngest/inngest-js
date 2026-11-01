/**
 * @module
 * The scripted model records what each of its calls was shown, and the
 * scenario reads those recordings from the CLI while the app runs in another
 * process. A second message arrives while the first turn's tool works; the
 * model's next call is shown it and its first call was not.
 */
import { Inngest } from "inngest";
import { tool } from "inngest/experimental";
import {
  agent,
  createAgents,
  createKv,
  getThread,
  type Kv,
  kv,
  redisKvAdapter,
} from "inngest/experimental/agents";
import { z } from "zod/v4";
import { scenario } from "../kit/driver.ts";
import { withKeys } from "../kit/threads.ts";

const sleep = (ms: number) => {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

const think = tool.step({
  description: "Thinks for a moment",
  input: z.object({}),
  run: async () => {
    await sleep(1500);

    return "done thinking";
  },
});

const agentId = "model-recording-agent";
const ref = `agents-e2e/${agentId}`;
const modelName = "model-recording";

export const modelRecording = scenario({
  id: "model-recording",
  owner: "prim-05-kit",
  needs: { oss: "jack/step-subscribe-clean" },
  functions: ({ client, script }) => {
    const agents = createAgents(client);

    agents.agent({ id: agentId }, async ({ inbox, control }) => {
      for await (const message of inbox) {
        const result = await agent.loop({
          id: `turn:${message.id}`,
          model: script(modelName, [
            { call: { name: "think", input: {} } },
            { say: "echo: {{last}}" },
          ]),
          prompt: message,
          tools: { think },
          ...control,
        });

        await kv.thread.set("last", { id: message.id, text: result.text });
      }
    });

    return agents.functions();
  },
  run: async (ctx) => {
    const store: Kv = createKv({ adapter: redisKvAdapter(ctx.redisUrl) });
    const client = new Inngest({
      id: "agents-e2e",
      baseUrl: ctx.devUrl,
      isDev: true,
    });
    const thread = withKeys(
      getThread(client, ref, `model-recording-${Date.now()}`, { kv: store }),
    );

    await thread.send("work");
    await sleep(500);
    await thread.steer("faster please");

    await ctx.eventually("the steer is answered", thread.state, (state) => {
      return (state.last as { text?: string } | undefined)?.text ===
        "echo: faster please";
    });

    const calls = await ctx.model(modelName).calls();
    const shown = (turn: number) => {
      return JSON.stringify(calls.find((call) => call.turn === turn)?.messages);
    };

    ctx.check("the model was called twice", calls.length === 2, calls.length);
    ctx.check(
      "turn 1 was shown the first message and not the second",
      shown(1).includes("work") && !shown(1).includes("faster please"),
      shown(1),
    );
    ctx.check(
      "turn 2 was shown the message that arrived while the tool worked",
      shown(2).includes("faster please"),
      shown(2),
    );
    ctx.check(
      "the model was offered the tool",
      calls[0]?.tools.includes("think") === true,
      calls[0]?.tools,
    );
  },
});
