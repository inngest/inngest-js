/**
 * @module
 * How a delivery wakes a reader. The executor does not know whether the
 * function is blocked on `next()`: a delivery saves the message and enqueues a
 * discovery for the run, and the SDK either has something to do with it or
 * runs to the same wait again. `kit/matrix.ts` crosses user code shapes with
 * message timings; this scenario adds the cells it cannot reach:
 *
 * - `blocked`: a burst of messages arrives while flow control (function
 *   concurrency taken by another run) keeps the wake from starting. Every
 *   message is read, and the discoveries the run gets are bounded by the burst,
 *   not by the number of messages.
 * - `unawaited`: a `next()` nobody awaits does not hold the function.
 * - `limit`: more messages than a subscription may save close it, and the
 *   reader that is waiting sees the end after the messages already saved.
 *
 * Each cell runs with checkpointing on and off.
 */
import { appendFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Inngest } from "inngest";
import { type Ctx, scenario } from "../kit/driver.ts";

const sleep = (ms: number) => {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

const logFile = (t: string) => {
  return join(tmpdir(), `subscribe-wake-${t}.log`);
};

const lines = (t: string) => {
  return existsSync(logFile(t))
    ? readFileSync(logFile(t), "utf8").trim().split("\n")
    : [];
};

const configs = [
  { checkpointing: false, optimize: true },
  { checkpointing: true, optimize: false },
];

const tagOf = (c: (typeof configs)[number]) => {
  return `c${c.checkpointing ? 1 : 0}o${c.optimize ? 1 : 0}`;
};

const burst = 20;
const saveLimit = 200;

export const subscribeWake = scenario({
  id: "subscribe-wake",
  owner: "subscribe-wake",
  needs: { oss: "jack/step-subscribe-wake" },
  functions: ({ client, event }) => {
    return configs.map((config) => {
      const id = `wake-${tagOf(config)}`;

      return client.createFunction(
        {
          id,
          triggers: [{ event: event(`go-${id}`) }],
          checkpointing: config.checkpointing,
          optimizeParallelism: config.optimize,
          // One run at a time may execute: a long step of one run keeps the
          // wake of another from starting.
          concurrency: { limit: 1, key: "event.data.k" },
        },
        async ({ event: trigger, step }) => {
          const t = trigger.data.t as string;
          const cell = trigger.data.cell as string;
          const log = (line: string) => {
            appendFileSync(logFile(t), `${line}\n`);
          };

          log(`body:${cell}`);

          if (cell === "hold") {
            await step.run("hold", async () => {
              log("hold:start");
              await sleep(trigger.data.ms as number);
              log("hold:end");
            });

            return { held: true };
          }

          const inbox = await step.subscribe("inbox", {
            event: event("msg"),
            if: `async.data.t == '${t}'`,
          });

          log("opened");

          if (cell === "unawaited") {
            void inbox.next();
            await step.run("work", async () => {
              log("work:start");
              await sleep(1000);

              return "done";
            });
            await inbox.close();

            return { finished: true };
          }

          const reads: number[] = [];

          for (;;) {
            log("at-next");
            const message = await inbox.next();

            if (!message) {
              break;
            }

            reads.push((message.data as { n: number }).n);

            if (cell === "blocked" && reads.length === burst) {
              break;
            }
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
        const tag = tagOf(config);

        await blocked(ctx, client, tag, `blocked-${tag}-${stamp}`);
        await unawaited(ctx, tag, `unawaited-${tag}-${stamp}`);
        await limit(ctx, client, tag, `limit-${tag}-${stamp}`);
      }),
    );
  },
});

const waitFor = async (ctx: Ctx, t: string, line: string) => {
  await ctx.until(
    async () => {
      return lines(t).includes(line);
    },
    (found) => {
      return found;
    },
  );
};

const finishedRun = async (ctx: Ctx, start: string) => {
  await ctx.finished(start);

  return ctx.until(
    async () => {
      const [found] = await ctx.runsOf(start);

      return found as NonNullable<typeof found>;
    },
    (r) => {
      return r.output !== null && r.output !== undefined;
    },
  );
};

const blocked = async (ctx: Ctx, client: Inngest, tag: string, t: string) => {
  const name = `blocked/${tag}`;
  const id = `wake-${tag}`;

  try {
    const reader = await ctx.send(
      `go-${id}`,
      { t, cell: "blocked", k: t },
      { startsRun: true },
    );

    await waitFor(ctx, t, "at-next");

    // Another run takes the function's only concurrency slot for a while.
    await ctx.send(
      `go-${id}`,
      { t: `${t}-hold`, cell: "hold", k: t, ms: 6000 },
      { startsRun: true },
    );
    await waitFor(ctx, `${t}-hold`, "hold:start");

    const before = lines(t).filter((l) => {
      return l === "body:blocked";
    }).length;

    await client.send(
      Array.from({ length: burst }, (_, i) => {
        return { name: ctx.event("msg"), data: { t, n: i + 1 } };
      }),
    );

    const run = await finishedRun(ctx, reader);
    const reads = ((run.output as { reads?: number[] }).reads ??
      []) as number[];
    const bodies =
      lines(t).filter((l) => {
        return l === "body:blocked";
      }).length - before;
    const failures: string[] = [];

    if (
      JSON.stringify([...reads].sort((a, b) => a - b)) !==
      JSON.stringify(
        Array.from({ length: burst }, (_, i) => {
          return i + 1;
        }),
      )
    ) {
      failures.push(`read ${JSON.stringify(reads)}`);
    }

    // The wake, then the discovery after the close: never one per message.
    if (bodies > 4) {
      failures.push(`${bodies} discoveries for a burst of ${burst}`);
    }

    ctx.check(name, failures.length === 0, failures);
  } catch (error) {
    ctx.check(name, false, (error as Error).message);
  } finally {
    for (const file of [t, `${t}-hold`]) {
      if (existsSync(logFile(file))) {
        unlinkSync(logFile(file));
      }
    }
  }
};

const unawaited = async (ctx: Ctx, tag: string, t: string) => {
  const name = `unawaited/${tag}`;

  try {
    const start = await ctx.send(
      `go-wake-${tag}`,
      { t, cell: "unawaited", k: t },
      { startsRun: true },
    );
    const run = await finishedRun(ctx, start);

    ctx.check(
      name,
      run.status.toLowerCase() === "completed" &&
        (run.output as { finished?: boolean }).finished === true,
      run.output,
    );
  } catch (error) {
    ctx.check(name, false, (error as Error).message);
  } finally {
    if (existsSync(logFile(t))) {
      unlinkSync(logFile(t));
    }
  }
};

const limit = async (ctx: Ctx, client: Inngest, tag: string, t: string) => {
  const name = `limit/${tag}`;

  try {
    const start = await ctx.send(
      `go-wake-${tag}`,
      { t, cell: "limit", k: t },
      { startsRun: true },
    );

    await waitFor(ctx, t, "at-next");

    const total = saveLimit + 10;

    for (let from = 0; from < total; from += 50) {
      await client.send(
        Array.from({ length: Math.min(50, total - from) }, (_, i) => {
          return { name: ctx.event("msg"), data: { t, n: from + i + 1 } };
        }),
      );
    }

    // The first message over the limit is dropped and closes the subscription:
    // the reader sees every message saved before that, then the end. Deliveries
    // run side by side and each checks the limit before it saves, so a few
    // messages may squeeze in over it.
    const run = await finishedRun(ctx, start);
    const reads = ((run.output as { reads?: number[] }).reads ??
      []) as number[];

    ctx.check(
      name,
      run.status.toLowerCase() === "completed" &&
        reads.length >= saveLimit &&
        reads.length <= saveLimit + 20 &&
        new Set(reads).size === reads.length,
      { status: run.status, reads: reads.length },
    );
  } catch (error) {
    ctx.check(name, false, (error as Error).message);
  } finally {
    if (existsSync(logFile(t))) {
      unlinkSync(logFile(t));
    }
  }
};
