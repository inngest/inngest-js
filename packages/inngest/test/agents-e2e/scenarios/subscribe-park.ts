/**
 * @module
 * `step.subscribe` waiting for a message. Messages only accumulate in the run's
 * state; `next()` reads the next one from there, and when there is none the
 * request ends with the read waiting. Every delivery gives the run a discovery
 * to see the message; a function with nothing to do with it waits again.
 *
 * Every shape runs with checkpointing on and off and with `optimizeParallelism`
 * on (coalesced discovery) and off:
 * - `seq`: two messages arrive while the run waits, so there is one wake;
 *   the body then runs two long steps and still reads the second message.
 * - `all`: `next()` and a step in one `Promise.all`.
 * - `group`: the same inside `group.parallel`.
 * - `wfe`: `waitForEvent` and a step in one `Promise.all`, for comparison.
 * - `window`: the message arrives while the body is running, after the SDK
 *   read its state and before it waits, so the delivery must still give it
 *   a discovery that sees the message.
 * - `pre`: the message arrives during a step, before any `next()`, so
 *   `next()` reads it from the state and the run never waits.
 * The parallel shapes get the message before the step finishes (early) and
 * after it (late). Each step body writes a line when it starts, so a step that
 * runs twice shows.
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
  return join(tmpdir(), `subscribe-park-${t}.log`);
};

const log = (t: string, line: string) => {
  appendFileSync(logFile(t), `${line}\n`);
};

const lines = (t: string) => {
  return existsSync(logFile(t))
    ? readFileSync(logFile(t), "utf8").trim().split("\n")
    : [];
};

const configs = [
  { checkpointing: false, optimize: true },
  { checkpointing: false, optimize: false },
  { checkpointing: true, optimize: true },
  { checkpointing: true, optimize: false },
];

const shapes = ["seq", "all", "group", "wfe", "window", "pre"] as const;

type Shape = (typeof shapes)[number];

const fnId = (shape: Shape, config: (typeof configs)[number]) => {
  return `park-${shape}-c${config.checkpointing ? 1 : 0}-o${config.optimize ? 1 : 0}`;
};

type Out = { got: unknown[] };

export const subscribePark = scenario({
  id: "subscribe-park",
  owner: "subscribe-park",
  needs: { oss: "jack/step-subscribe-wake" },
  functions: ({ client, event }) => {
    return shapes.flatMap((shape) => {
      return configs.map((config) => {
        const id = fnId(shape, config);

        return client.createFunction(
          {
            id,
            triggers: [{ event: event(`go-${id}`) }],
            checkpointing: config.checkpointing,
            optimizeParallelism: config.optimize,
          },
          async ({ event: trigger, step }): Promise<Out> => {
            const t = trigger.data.t as string;

            // Every execution of the body, to count requests.
            log(t, "body");

            const p = async () => {
              return step.run("p", async () => {
                log(t, "p:start");
                await sleep(3000);
                log(t, "p:end");

                return "p";
              });
            };

            if (shape === "wfe") {
              const [msg] = await Promise.all([
                step.waitForEvent("w", {
                  event: event("wmsg"),
                  timeout: "2m",
                  if: `async.data.t == '${t}'`,
                }),
                p(),
              ]);

              return { got: [(msg?.data as { n: number }).n] };
            }

            const inbox = await step.subscribe("inbox", {
              event: event("msg"),
              if: `async.data.t == '${t}'`,
            });

            const n = (message: { data: unknown } | null) => {
              return (message?.data as { n?: number } | undefined)?.n ?? null;
            };

            if (shape === "window") {
              log(t, "after-open");
              await sleep(1500);

              const a = await inbox.next();
              await inbox.close();

              return { got: [n(a)] };
            }

            if (shape === "pre") {
              await step.run("busy", async () => {
                log(t, "busy:start");
                await sleep(2000);
              });

              const a = await inbox.next();
              await inbox.close();

              return { got: [n(a)] };
            }

            if (shape === "seq") {
              const a = await inbox.next();

              await step.run("long1", async () => {
                log(t, "long1");
                await sleep(1500);
              });
              await step.run("long2", async () => {
                log(t, "long2");
                await sleep(1500);
              });

              const b = await inbox.next();

              await inbox.close();

              return { got: [n(a), n(b)] };
            }

            if (shape === "all") {
              const [msg] = await Promise.all([inbox.next(), p()]);

              await inbox.close();

              return { got: [n(msg)] };
            }

            const [msg] = await group.parallel(async () => {
              return Promise.all([inbox.next(), p()]);
            });

            await inbox.close();

            return { got: [n(msg as { data: unknown } | null)] };
          },
        );
      });
    });
  },
  run: async (ctx) => {
    const wait = (ms: number) => {
      return new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      });
    };

    const count = (t: string, line: string) => {
      return lines(t).filter((l) => {
        return l === line;
      }).length;
    };

    const stamp = Date.now();
    const jobs: Promise<void>[] = [];

    for (const shape of shapes) {
      for (const config of configs) {
        const id = fnId(shape, config);
        const modes =
          shape === "seq"
            ? ["both"]
            : shape === "window" || shape === "pre"
              ? [shape]
              : ["early", "late"];

        for (const mode of modes) {
          jobs.push(
            (async () => {
              const t = `${id}-${mode}-${stamp}`;
              const name = `${id}/${mode}`;
              const msgName = shape === "wfe" ? "wmsg" : "msg";
              const start = await ctx.send(
                `go-${id}`,
                { t },
                { startsRun: true },
              );

              // Wait until the run has had time to park.
              await ctx.until(
                async () => {
                  return count(t, "body");
                },
                (c) => {
                  return c >= 1;
                },
              );

              if (mode === "window" || mode === "pre") {
                const marker = mode === "window" ? "after-open" : "busy:start";

                await ctx.until(
                  async () => {
                    return count(t, marker);
                  },
                  (c) => {
                    return c >= 1;
                  },
                );
                await wait(300);
                await ctx.send(msgName, { t, n: 1 });
              } else if (mode === "both") {
                await wait(1500);
                await ctx.send(msgName, { t, n: 1 });
                await ctx.send(msgName, { t, n: 2 });
              } else if (mode === "early") {
                await ctx.until(
                  async () => {
                    return count(t, "p:start");
                  },
                  (c) => {
                    return c >= 1;
                  },
                );
                await wait(500);
                await ctx.send(msgName, { t, n: 1 });
              } else {
                await ctx.until(
                  async () => {
                    return count(t, "p:end");
                  },
                  (c) => {
                    return c >= 1;
                  },
                );
                await wait(1500);
                await ctx.send(msgName, { t, n: 1 });
              }

              await ctx.finished(start);

              // The run's output can land a moment after its status.
              const run = await ctx.until(
                async () => {
                  const [found] = await ctx.runsOf(start);

                  return found as NonNullable<typeof found>;
                },
                (r) => {
                  return r.output !== null && r.output !== undefined;
                },
              );
              const out = run.output as Out | undefined;
              const want = mode === "both" ? [1, 2] : [1];

              ctx.check(
                `${name}: completes with the messages`,
                run.status.toLowerCase() === "completed" &&
                  JSON.stringify([...(out?.got ?? [])].sort()) ===
                    JSON.stringify(want),
                { status: run.status, out },
              );

              const reruns =
                shape === "seq"
                  ? ["long1", "long2"].filter((s) => {
                      return count(t, s) !== 1;
                    })
                  : shape === "window" || shape === "pre"
                    ? []
                    : count(t, "p:start") === 1
                      ? []
                      : ["p"];

              ctx.check(`${name}: no step ran twice`, reruns.length === 0, {
                reruns,
                log: lines(t),
              });

              console.log(
                `INFO ${name}: bodies=${count(t, "body")} steps=${run.steps.length}`,
              );

              if (existsSync(logFile(t))) {
                unlinkSync(logFile(t));
              }
            })(),
          );
        }
      }
    }

    await Promise.all(jobs);
  },
});
