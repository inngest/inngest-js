/**
 * @module
 * A race that the step wins, with no message ever sent, followed by `close()`
 * and the end of the run. The `next()` that lost is still parked; the close must
 * end that park so it blocks neither discovery nor completion. The race is a
 * plain `Promise.race` and a `group.parallel({ mode: "race" })`, with
 * checkpointing and `optimizeParallelism` on and off.
 *
 * A plain `Promise.race` with `optimizeParallelism` on is not run: the step's
 * completion sees the parked `next()` as a pending step, as it does a pending
 * `waitForEvent`, so nothing continues the function and the close is never
 * reached. Use `group.parallel({ mode: "race" })`, which continues on the first
 * finisher.
 */
import { appendFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { group } from "inngest";
import { scenario } from "../kit/driver.ts";

const sleep = (ms: number) => {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

const logFile = (t: string) => {
  return join(tmpdir(), `subscribe-close-${t}.log`);
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

const races = ["plain", "group"] as const;

const tagOf = (c: (typeof configs)[number]) => {
  return `c${c.checkpointing ? 1 : 0}o${c.optimize ? 1 : 0}`;
};

export const subscribeClose = scenario({
  id: "subscribe-close",
  owner: "subscribe-park",
  needs: { oss: "jack/step-subscribe" },
  functions: ({ client, event }) => {
    return configs.flatMap((config) => {
      return races.map((race) => {
        const id = `close-${race}-${tagOf(config)}`;

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
            const work = () => {
              return step.run("p", async () => {
                log("step:p");
                await sleep(500);

                return "p" as const;
              });
            };
            const winner =
              race === "plain"
                ? await Promise.race([inbox.next(), work()])
                : await group.parallel({ mode: "race" }, async () => {
                    return Promise.race([inbox.next(), work()]);
                  });

            log("raced");

            const unread = await inbox.close();

            return {
              winner: winner === "p" ? "p" : "msg",
              unread: unread.length,
            };
          },
        );
      });
    });
  },
  run: async (ctx) => {
    const stamp = Date.now();

    await Promise.all(
      configs.flatMap((config) => {
        return races.map(async (race) => {
          if (race === "plain" && config.optimize) {
            return;
          }

          const name = `${race}/${tagOf(config)}`;
          const t = `${race}-${tagOf(config)}-${stamp}`;
          const start = await ctx.send(
            `go-close-${race}-${tagOf(config)}`,
            { t },
            { startsRun: true },
          );
          let status = "timeout";
          let output: unknown;

          try {
            await ctx.finished(start);
            const [found] = await ctx.runsOf(start);

            status = found?.status ?? "none";
            output = found?.output;
          } catch (error) {
            status = (error as Error).message;
          }

          const doubled = lines(t).filter((l, i, all) => {
            return l.startsWith("step:") && all.indexOf(l) !== i;
          });

          ctx.check(
            name,
            status.toLowerCase() === "completed" && doubled.length === 0,
            { status, output, doubled },
          );

          if (existsSync(logFile(t))) {
            unlinkSync(logFile(t));
          }
        });
      }),
    );
  },
});
