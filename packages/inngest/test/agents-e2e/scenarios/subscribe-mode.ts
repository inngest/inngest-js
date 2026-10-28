/**
 * @module
 * A wake while the run has switched from parallel to inline. The first read
 * is a parallel batch (`next()` beside a step), after which the run's mode
 * flips back to inline steps. A message arrives while the batch is in flight,
 * another at the moment the batch ends or while the first inline step runs,
 * and the third while the run is parked again. Every message must be read
 * once, in order, and no step body may run twice, with checkpointing and
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
  return join(tmpdir(), `subscribe-mode-${t}.log`);
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

const when = ["batch-end", "inline-step"] as const;

export const subscribeMode = scenario({
  id: "subscribe-mode",
  owner: "subscribe-park",
  needs: { oss: "jack/step-subscribe" },
  functions: ({ client, event }) => {
    return configs.map((config) => {
      const id = `mode-${tagOf(config)}`;

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
          const timed = (stepId: string, ms: number) => {
            return step.run(stepId, async () => {
              log(`${stepId}:start`);
              log(`step:${stepId}`);
              await sleep(ms);
              log(`${stepId}:end`);
            });
          };
          const inbox = await step.subscribe("inbox", {
            event: event("msg"),
            if: `async.data.t == '${t}'`,
          });
          const value = (m: { data: unknown } | null) => {
            return (m?.data as { data?: { n?: number } } | undefined)?.data?.n;
          };

          const [first] = await Promise.all([inbox.next(), timed("p", 2000)]);

          await timed("X", 2000);

          const second = await inbox.next();

          await timed("Y", 100);
          log("before-third");

          const third = await inbox.next();

          await inbox.close();

          return { reads: [value(first), value(second), value(third)] };
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
      configs.flatMap((config) => {
        return when.map(async (moment) => {
          const name = `${tagOf(config)}/${moment}`;
          const t = `${tagOf(config)}-${moment}-${stamp}`;
          const send = async (n: number) => {
            await client.send({
              name: ctx.event("msg"),
              data: { t, n },
            });
          };
          const waitFor = async (line: string, afterMs: number) => {
            await ctx.until(
              async () => {
                return lines(t).filter((l) => {
                  return l === line;
                }).length;
              },
              (c) => {
                return c >= 1;
              },
            );
            await sleep(afterMs);
          };

          const start = await ctx.send(
            `go-mode-${tagOf(config)}`,
            { t },
            { startsRun: true },
          );

          await waitFor("p:start", 300);
          await send(1);

          if (moment === "batch-end") {
            await waitFor("p:end", 0);
          } else {
            await waitFor("X:start", 300);
          }

          await send(2);
          await waitFor("before-third", 800);
          await send(3);

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
          const reads = (run.output as { reads?: number[] }).reads;
          const doubled = lines(t).filter((l, i, all) => {
            return l.startsWith("step:") && all.indexOf(l) !== i;
          });

          ctx.check(
            name,
            run.status.toLowerCase() === "completed" &&
              JSON.stringify(reads) === JSON.stringify([1, 2, 3]) &&
              doubled.length === 0,
            { status: run.status, reads, doubled },
          );

          if (existsSync(logFile(t))) {
            unlinkSync(logFile(t));
          }
        });
      }),
    );
  },
});
