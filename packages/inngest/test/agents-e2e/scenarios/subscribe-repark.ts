/**
 * @module
 * A reader that waits again at once after a wake. Messages arrive in pairs
 * while it waits, so a wake for message 1 is followed by reads of messages
 * 1 and 2 from the state and a wait for message 3, which the next pair must
 * wake. Every message is read once and the run ends, with checkpointing and
 * `optimizeParallelism` on and off.
 */
import { Inngest } from "inngest";
import { scenario } from "../kit/driver.ts";

const sleep = (ms: number) => {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

const configs = [
  { checkpointing: false, optimize: false },
  { checkpointing: false, optimize: true },
  { checkpointing: true, optimize: false },
  { checkpointing: true, optimize: true },
];

const tagOf = (c: (typeof configs)[number]) => {
  return `c${c.checkpointing ? 1 : 0}o${c.optimize ? 1 : 0}`;
};

const rounds = 4;
const total = rounds * 2;

export const subscribeRepark = scenario({
  id: "subscribe-repark",
  owner: "subscribe-park",
  needs: { oss: "jack/step-subscribe-wake" },
  functions: ({ client, event }) => {
    return configs.map((config) => {
      const id = `repark-${tagOf(config)}`;

      return client.createFunction(
        {
          id,
          triggers: [{ event: event(`go-${id}`) }],
          checkpointing: config.checkpointing,
          optimizeParallelism: config.optimize,
        },
        async ({ event: trigger, step }) => {
          const t = trigger.data.t as string;
          const inbox = await step.subscribe("inbox", {
            event: event("msg"),
            if: `async.data.t == '${t}'`,
          });
          const reads: (number | undefined)[] = [];

          while (reads.length < total) {
            const m = await inbox.next();

            reads.push((m?.data as { n?: number } | undefined)?.n);
          }

          await inbox.close();

          return { reads };
        },
      );
    });
  },
  run: async (ctx) => {
    const client = new Inngest({
      id: "agents-e2e-driver",
      baseUrl: ctx.devUrl,
      isDev: true,
    });
    const stamp = Date.now();

    await Promise.all(
      configs.map(async (config) => {
        const name = tagOf(config);
        const t = `${name}-${stamp}`;
        const start = await ctx.send(
          `go-repark-${name}`,
          { t },
          { startsRun: true },
        );

        await sleep(2000);

        for (let round = 0; round < rounds; round++) {
          await client.send([
            { name: ctx.event("msg"), data: { t, n: round * 2 + 1 } },
            { name: ctx.event("msg"), data: { t, n: round * 2 + 2 } },
          ]);
          await sleep(700);
        }

        let reads: number[] = [];
        let status = "timeout";

        try {
          await ctx.finished(start);
          const [found] = await ctx.runsOf(start);

          status = found?.status ?? "none";
          reads = ((found?.output as { reads?: number[] } | undefined)?.reads ??
            []) as number[];
        } catch (error) {
          status = (error as Error).message;
        }

        ctx.check(
          name,
          status.toLowerCase() === "completed" &&
            JSON.stringify([...reads].sort((a, b) => a - b)) ===
              JSON.stringify(
                Array.from({ length: total }, (_, i) => {
                  return i + 1;
                }),
              ),
          { status, reads },
        );
      }),
    );
  },
});
