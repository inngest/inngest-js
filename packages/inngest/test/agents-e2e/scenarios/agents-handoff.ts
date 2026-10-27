/**
 * @module
 * Unread messages are handed to the thread's next run: a message that arrives
 * while a run finishes, and one that arrives while a run fails.
 */
import { Inngest, NonRetriableError } from "inngest";
import {
  createKv,
  getThread,
  kv,
  redisKvAdapter,
} from "inngest/experimental/agents";
import { scenario } from "../kit/driver.ts";

const sleep = (ms: number) => {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

const seen = (state: Record<string, unknown>) => {
  return (state.seen as string[] | undefined) ?? [];
};

export const agentsHandoff = scenario({
  id: "agents-handoff",
  owner: "agents-f",
  needs: { oss: "jack/step-subscribe" },
  functions: ({ client }) => {
    const record = async (content: string | undefined) => {
      await kv.thread.update<string[]>("seen", function (found) {
        return [...(found ?? []), content ?? ""];
      });
    };

    const quick = client.agent({ id: "agents-quick" }, async ({ inbox }) => {
      const message = await inbox.next();
      await sleep(2500);
      await record(message?.data.content);

      return message?.data.content;
    });
    const boom = client.agent({ id: "agents-boom" }, async ({ inbox }) => {
      const message = await inbox.next();
      await sleep(2000);
      await record(message?.data.content);

      throw new NonRetriableError("boom");
    });

    return [...quick.functions, ...boom.functions];
  },
  run: async (ctx) => {
    const store = createKv({ adapter: redisKvAdapter(ctx.redisUrl) });
    const client = new Inngest({
      id: "agents-e2e",
      baseUrl: ctx.devUrl,
      isDev: true,
    });
    const handle = (agentId: string) => {
      return getThread(
        client,
        `agents-e2e/${agentId}`,
        `${agentId}-${Date.now()}`,
        { kv: store },
      );
    };

    // A message that arrives while a run finishes is handed to the next run.
    const quick = handle("agents-quick");
    await quick.send("one");
    await sleep(800);
    await quick.send("two");
    const handed = await ctx.eventually(
      "unread message handed to the next run",
      quick.state,
      (s) => {
        return seen(s).length >= 2;
      },
    );
    ctx.check(
      "both messages handled once, in order",
      JSON.stringify(seen(handed)) === JSON.stringify(["one", "two"]),
      handed,
    );

    // A failed run does not strand messages either.
    const boom = handle("agents-boom");
    await boom.send("a");
    await sleep(800);
    await boom.send("b");
    const failed = await ctx.eventually(
      "failed run hands unread messages to the next run",
      boom.state,
      (s) => {
        return seen(s).length >= 2;
      },
    );
    ctx.check(
      "both messages handled once after a failure",
      JSON.stringify(seen(failed)) === JSON.stringify(["a", "b"]),
      failed,
    );
  },
});
