/**
 * @module
 * Two agent functions on the experimental inbox, each with a scripted model so
 * the example needs no API key.
 *
 * - `chat` keeps its thread open: every inbox message is a turn, the history
 *   lives in thread KV, and steering and stop requests reach a running turn.
 * - `quick` answers one message and ends, so anything sent while it works is
 *   handed to the thread's next run.
 */
import { Inngest } from "inngest";
import { z } from "zod";
import { agent, createAgentFunction, kv, tool } from "inngest/experimental";

export const client = new Inngest({ id: "agents-f" });

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

const scriptedModel = () => {
  return agent.model(async (request) => {
    const { messages } = request;
    const last = messages.at(-1);
    const afterTool = messages.at(-2)?.role === "tool";

    // A fresh prompt gets one tool call; a tool result or a steer gets the answer.
    if (last?.role === "user" && !afterTool) {
      const call = { id: `think${messages.length}`, name: "think", input: {} };

      return {
        message: {
          role: "assistant",
          content: [{ type: "tool_use", ...call }],
        },
        toolCalls: [call],
        done: false,
      };
    }

    const lastUser = messages.findLast((m) => m.role === "user");
    const text = `echo: ${lastUser?.role === "user" ? lastUser.content : ""}`;

    return {
      message: { role: "assistant", content: [{ type: "text", text }] },
      text,
      toolCalls: [],
      done: true,
    };
  });
};

export const chat = createAgentFunction(
  client,
  { id: "chat", event: "agents-f/chat", recheck: "30s" },
  async ({ inbox, thread, control }) => {
    for await (const message of inbox) {
      const history = await kv.get<never[]>("history", { scope: "thread" });
      const result = await agent.loop({
        id: `turn${message.seq}`,
        model: scriptedModel(),
        prompt: message.data.content,
        history: history ?? [],
        tools: { think },
        ...control,
      });

      await kv.set("history", result.history, { scope: "thread" });
      await kv.set("last", { seq: message.seq, text: result.text }, {
        scope: "thread",
      });
      await kv.set("scratch", message.seq);
      void thread;
    }
  },
);

export const quick = createAgentFunction(
  client,
  { id: "quick", event: "agents-f/quick" },
  async ({ inbox }) => {
    const message = await inbox.next();
    if (!message) {
      return null;
    }

    const result = await agent.loop({
      id: `turn${message.seq}`,
      model: scriptedModel(),
      prompt: message.data.content,
      tools: { think },
    });
    await kv.set("last", { seq: message.seq, text: result.text }, {
      scope: "thread",
    });

    return result.text;
  },
);
