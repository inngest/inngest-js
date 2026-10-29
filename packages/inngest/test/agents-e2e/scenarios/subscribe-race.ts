/**
 * @module
 * A read after `Promise.race([next(), step])` where the step wins. The parked
 * read of the lost race must not eat a message or wedge the next `next()`: the
 * next read gets the first message, and the run ends. With checkpointing and
 * `optimizeParallelism` on and off.
 */
import { appendFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Inngest } from "inngest";
import { scenario } from "../kit/driver.ts";

const sleep = (ms: number) => {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

const logFile = (t: string) => {
  return join(tmpdir(), `subscribe-race-${t}.log`);
};

const lines = (t: string) => {
  return existsSync(logFile(t))
    ? readFileSync(logFile(t), "utf8").trim().split("\n")
    : [];
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

export const subscribeRace = scenario({
  id: "subscribe-race",
  owner: "subscribe-park",
  needs: { oss: "jack/step-subscribe" },
  functions: ({ client, event }) => {
    return configs.map((config) => {
      const id = `race-${tagOf(config)}`;

      return client.createFunction(
        {
          id,
          triggers: [{ event: event(`go-${id}`) }],
          checkpointing: config.checkpointing,
          optimizeParallelism: config.optimize,
        },
        async ({ event: trigger, step }) => {
          const t = trigger.data.t as string;
          const log = (line: string) => {
            appendFileSync(logFile(t), `${line}\n`);
          };
          const inbox = await step.subscribe("inbox", {
            event: event("msg"),
            if: `async.data.t == '${t}'`,
          });
          const value = (m: { data: unknown } | null) => {
            return (m?.data as { n?: number } | undefined)?.n;
          };

          const winner = await Promise.race([
            inbox.next(),
            step.run("p", async () => {
              log("step:p");
              log("p:start");
              await sleep(1000);
              log("p:end");

              return "p" as const;
            }),
          ]);

          log("raced");

          const reads: (number | undefined)[] = [];

          if (winner !== "p") {
            reads.push(value(winner));
          }

          reads.push(value(await inbox.next()));
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
        const send = async (n: number) => {
          await client.send({ name: ctx.event("msg"), data: { t, n } });
        };

        const start = await ctx.send(
          `go-race-${name}`,
          { t },
          { startsRun: true },
        );

        await ctx.until(
          async () => {
            return lines(t).filter((l) => {
              return l === "p:end";
            }).length;
          },
          (c) => {
            return c >= 1;
          },
        );
        await sleep(800);
        await send(1);
        await sleep(700);
        await send(2);

        await ctx.finished(start);

        const run = await ctx.until(
          async () => {
            const [found] = await ctx.runsOf(start);

            return found as NonNullable<typeof found>;
          },
          (r) => {
            return r.output !== null && r.output !== undefined;
          },
        );
        const reads = (run.output as { reads?: number[] }).reads ?? [];
        const doubled = lines(t).filter((l, i, all) => {
          return l.startsWith("step:") && all.indexOf(l) !== i;
        });
        const ok =
          run.status.toLowerCase() === "completed" &&
          reads[0] === 1 &&
          (reads.length === 1 || (reads.length === 2 && reads[1] === 2)) &&
          doubled.length === 0;

        ctx.check(name, ok, { status: run.status, reads, doubled });

        if (existsSync(logFile(t))) {
          unlinkSync(logFile(t));
        }
      }),
    );
  },
});
