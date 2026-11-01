/**
 * @module
 * Three agent functions on `step.subscribe`, each with a scripted model so the
 * example needs no API key.
 *
 * - `chat` keeps its thread open: every message is a turn, the history lives in
 *   thread KV, and steering and stop messages reach a running turn.
 * - `quick` answers one message and ends, so anything sent while it works is
 *   handed to the thread's next run.
 * - `boom` fails on every message it reads.
 */
import { Inngest, NonRetriableError } from "inngest";
import { tool } from "inngest/experimental";
import { agent, createAgents, kv, kvKey } from "inngest/experimental/agents";
import { z } from "zod";

export const client = new Inngest({ id: "agents-f" });
export const agents = createAgents(client);

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

    const lastUser = messages.findLast(function (m) {
      return m.role === "user";
    });
    const text = `echo: ${lastUser?.role === "user" ? lastUser.content : ""}`;

    return {
      message: { role: "assistant", content: [{ type: "text", text }] },
      text,
      toolCalls: [],
      done: true,
    };
  });
};

const textOf = (message: { data: object } | null | undefined) => {
  const data = message?.data;

  return data && "text" in data && typeof data.text === "string"
    ? data.text
    : "";
};

export const chat = agents.agent({ id: "chat" }, async ({ inbox, control }) => {
  for await (const message of inbox) {
    const history = await kv.thread.get(kvKey<never[]>("history"));
    const result = await agent.loop({
      id: `turn${message.seq}`,
      model: scriptedModel(),
      prompt: message,
      history: history ?? [],
      tools: { think },
      ...control,
    });

    await kv.thread.set("history", result.history);
    await kv.thread.set("last", { seq: message.seq, text: result.text });
    await kv.thread.update(kvKey<string[]>("turns"), function (turns) {
      return [...(turns ?? []), textOf(message)];
    });
  }
});

export const quick = agents.agent({ id: "quick" }, async ({ inbox }) => {
  const message = await inbox.next();
  await sleep(3000);
  await kv.thread.update(kvKey<string[]>("seen"), function (seen) {
    return [...(seen ?? []), textOf(message)];
  });

  return textOf(message);
});

export const boom = agents.agent({ id: "boom" }, async ({ inbox }) => {
  const message = await inbox.next();
  await sleep(2500);
  await kv.thread.update(kvKey<string[]>("seen"), function (seen) {
    return [...(seen ?? []), textOf(message)];
  });

  throw new NonRetriableError("boom");
});
