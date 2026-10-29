/**
 * @module
 * `next({ timeout })`. A read with a timeout that gets no message returns
 * `undefined` once it expires, the run goes on, and the message sent later is
 * read by the next call, not lost. A message that arrives before the timeout is
 * returned at once and the timeout does nothing afterwards. Replays return the
 * same answers. With checkpointing and `optimizeParallelism` on and off.
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
  return join(tmpdir(), `subscribe-timeout-${t}.log`);
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

const modes = ["expires", "arrives"] as const;

export const subscribeTimeout = scenario({
  id: "subscribe-timeout",
  owner: "subscribe-park",
  needs: { oss: "jack/step-subscribe-wake" },
  functions: ({ client, event }) => {
    return configs.map((config) => {
      const id = `timeout-${tagOf(config)}`;

      return client.createFunction(
        {
          id,
          triggers: [{ event: event(`go-${id}`) }],
          checkpointing: config.checkpointing,
          optimizeParallelism: config.optimize,
        },
        async ({ event: trigger, step }) => {
          const t = trigger.data.t as string;
          const mode = trigger.data.mode as (typeof modes)[number];
          const log = (line: string) => {
            appendFileSync(logFile(t), `${line}\n`);
          };
          const inbox = await step.subscribe("inbox", {
            event: event("msg"),
            if: `async.data.t == '${t}'`,
          });

          log("opened");

          const first = await inbox.next({
            timeout: mode === "expires" ? "2s" : "30s",
          });

          log(`first:${first === undefined ? "timeout" : first?.data.n}`);

          const second = await inbox.next();

          log(`second:${second?.data.n}`);
          await inbox.close();

          return {
            first: first === undefined ? "timeout" : first?.data.n,
            second: second?.data.n,
          };
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
        return modes.map(async (mode) => {
          const name = `${mode}/${tagOf(config)}`;
          const t = `${mode}-${tagOf(config)}-${stamp}`;
          const send = async (n: number) => {
            await client.send({ name: ctx.event("msg"), data: { t, n } });
          };
          const waitFor = async (prefix: string) => {
            await ctx.until(
              async () => {
                return lines(t).filter((l) => {
                  return l.startsWith(prefix);
                }).length;
              },
              (c) => {
                return c >= 1;
              },
              40_000,
            );
          };

          const start = await ctx.send(
            `go-timeout-${tagOf(config)}`,
            { t, mode },
            { startsRun: true },
          );

          await waitFor("opened");
          await sleep(1000);

          if (mode === "expires") {
            // The first read times out; only then is the message sent.
            await waitFor("first:");
            await sleep(500);
            await send(1);
          } else {
            await send(1);
            await waitFor("first:");
            await sleep(500);
            await send(2);
          }

          await ctx.finished(start);

          // The run's output can land a moment after its status.
          const run = await ctx.until(
            async () => {
              const [found] = await ctx.runsOf(start);

              return found;
            },
            (r) => {
              return r?.output !== null && r?.output !== undefined;
            },
          );
          const output = run?.output as
            | { first?: unknown; second?: unknown }
            | undefined;
          const want =
            mode === "expires"
              ? { first: "timeout", second: 1 }
              : { first: 1, second: 2 };
          const outcomes = new Map<string, Set<string>>();

          for (const l of lines(t)) {
            const [key, value] = l.split(":");

            if (key === "first" || key === "second") {
              outcomes.set(
                key,
                (outcomes.get(key) ?? new Set()).add(value ?? ""),
              );
            }
          }

          const unstable = [...outcomes].filter(([, set]) => {
            return set.size > 1;
          });

          ctx.check(
            name,
            run?.status.toLowerCase() === "completed" &&
              JSON.stringify(output) === JSON.stringify(want) &&
              unstable.length === 0,
            { status: run?.status, output, want, unstable },
          );

          if (existsSync(logFile(t))) {
            unlinkSync(logFile(t));
          }
        });
      }),
    );
  },
});
