/**
 * @module
 * Playground app for the parked `step.subscribe`. One function, `park-demo`,
 * reads messages one at a time and does a slow step for each. Every request
 * of the body and every step prints a line, so the app log shows when the run
 * wakes and what it reads. Started by devstack; see `README` in the design
 * note for the commands.
 */
import { createServer } from "node:http";
import { Inngest } from "inngest";
import { serve } from "inngest/node";

const client = new Inngest({ id: "park-playground" });

const say = (t: string, line: string) => {
  console.log(`${new Date().toISOString().slice(11, 23)} [${t}] ${line}`);
};

const sleep = (ms: number) => {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

const demo = client.createFunction(
  {
    id: "park-demo",
    triggers: [{ event: "park/go" }],
    checkpointing: process.env.CHECKPOINTING === "1",
  },
  async ({ event, step }) => {
    const t = event.data.t as string;

    say(t, "body request");

    const inbox = await step.subscribe("inbox", {
      event: "park/msg",
      if: `async.data.t == '${t}'`,
    });

    for (;;) {
      const message = await inbox.next();
      const text = (message?.data as { data?: { text?: string } } | undefined)
        ?.data?.text;

      say(t, `next() returned message ${message?.seq}: ${text}`);

      if (!message || text === "stop") {
        break;
      }

      await step.run(`work-${message.seq}`, async () => {
        say(t, `step work-${message.seq} start`);
        await sleep(Number(process.env.WORK_MS ?? 2000));
        say(t, `step work-${message.seq} end`);
      });
    }

    await inbox.close();
    say(t, "done");

    return "done";
  },
);

createServer(serve({ client, functions: [demo] })).listen(
  Number(process.env.PORT),
);
