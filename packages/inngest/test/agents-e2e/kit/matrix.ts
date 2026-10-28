/**
 * @module
 * The `step.subscribe` matrix. One scenario file per (checkpointing,
 * optimizeParallelism) pair builds its scenario here. A scenario runs one run
 * per cell: a user code shape crossed with a message timing. Every cell
 * asserts the same things:
 *
 * - every message is read exactly once, `seq` counts 1..k in read order, and
 *   (outside a burst, which has no defined arrival order) values arrive in
 *   the order they were sent;
 * - no step body ran twice;
 * - the run ends;
 * - the replays returned the same values (every read and race winner a body
 *   logged is identical in all the bodies that logged it);
 * - nothing is left behind: a message sent after the run ended starts no work.
 *   The kit cannot list pauses; the pause layer has its own Go test.
 *
 * Each cell prints one `PASS`/`FAIL` line named `<shape>/<timing>`.
 */
import { appendFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { group, Inngest } from "inngest";
import { type Ctx, scenario } from "./driver.ts";

const sleep = (ms: number) => {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

export const shapes = [
  "seq",
  "loop",
  "poll",
  "two",
  "all",
  "group",
  "race",
] as const;

export type Shape = (typeof shapes)[number];

export const timings = [
  "preopen",
  "inline",
  "parked",
  "parallel",
  "burst",
  "dup",
  "afterclose",
] as const;

export type Timing = (typeof timings)[number];

const parallelShapes: readonly Shape[] = ["all", "group", "race"];

const applies = (shape: Shape, timing: Timing) => {
  return timing !== "parallel" || parallelShapes.includes(shape);
};

const logFile = (t: string) => {
  return join(tmpdir(), `subscribe-matrix-${t}.log`);
};

const lines = (t: string) => {
  return existsSync(logFile(t))
    ? readFileSync(logFile(t), "utf8").trim().split("\n")
    : [];
};

const count = (t: string, line: string) => {
  return lines(t).filter((l) => {
    return l === line;
  }).length;
};

type Read = { seq: number; value: number };

/**
 * Builds the scenario of one configuration.
 */
export const matrixScenario = (config: {
  checkpointing: boolean;
  optimize: boolean;
  oss?: string;
}) => {
  const tag = `c${config.checkpointing ? 1 : 0}o${config.optimize ? 1 : 0}`;
  const id = `subscribe-matrix-${tag}`;
  const fnId = (shape: Shape) => {
    return `mx-${shape}-${tag}`;
  };

  return scenario({
    id,
    owner: "subscribe-park",
    needs: { oss: config.oss ?? "jack/step-subscribe" },
    functions: ({ client, event }) => {
      return shapes.map((shape) => {
        return client.createFunction(
          {
            id: fnId(shape),
            triggers: [{ event: event(`go-${fnId(shape)}`) }],
            checkpointing: config.checkpointing,
            optimizeParallelism: config.optimize,
          },
          async ({ event: trigger, step }) => {
            const t = trigger.data.t as string;
            const want = trigger.data.want as number;
            const slow = trigger.data.slow as number;
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

            log("body");

            await timed("pre", slow);

            const options = (name: string) => {
              return {
                event: event(name),
                if: `async.data.t == '${t}'`,
              };
            };
            const inbox = await step.subscribe("inbox", options("msg"));
            const inbox2 =
              shape === "two"
                ? await step.subscribe("inbox2", options("msg2"))
                : undefined;

            log("opened");

            const reads: Read[] = [];
            const valueOf = (m: { data: unknown } | null, offset = 0) => {
              return (
                ((m?.data as { data?: { n?: number } } | undefined)?.data?.n ??
                  -1) + offset
              );
            };
            const record = (
              m: { seq: number; data: unknown } | null,
              o = 0,
            ) => {
              if (!m) {
                return;
              }

              const value = valueOf(m, o);

              reads.push({ seq: m.seq + o, value });
              log(`read:${reads.length - 1}:${value}`);
            };

            await timed("A", 1200);
            log("at-next");

            if (shape === "seq") {
              for (let i = 0; i < want; i++) {
                await timed(`before-${i}`, 100);
                record(await inbox.next());
              }
            } else if (shape === "loop") {
              for (let i = 0; i < want; i++) {
                record(await inbox.next());
                await timed(`work-${i}`, 100);
              }
            } else if (shape === "poll") {
              while (reads.length < want) {
                const polled = await inbox.poll();

                record(polled ?? (await inbox.next()));
              }
            } else if (shape === "two" && inbox2) {
              for (let i = 0; i < want; i++) {
                record(await inbox.next());
                record(await inbox2.next(), 1000);
              }
            } else if (shape === "race") {
              const winner = await Promise.race([
                inbox.next(),
                timed("p", 2000).then(() => {
                  return "p" as const;
                }),
              ]);

              log(`winner:${winner === "p" ? "p" : "msg"}`);

              if (winner !== "p") {
                record(winner);
              }
            } else {
              const both = () => {
                return Promise.all([inbox.next(), timed("p", 2000)]);
              };
              const [first] =
                shape === "group" ? await group.parallel(both) : await both();

              record(first as { seq: number; data: unknown } | null);

              while (reads.length < want) {
                record(await inbox.next());
              }
            }

            await inbox.close();
            await inbox2?.close();
            await timed("after", slow);

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
      const jobs: Promise<void>[] = [];

      for (const shape of shapes) {
        for (const timing of timings) {
          if (!applies(shape, timing)) {
            continue;
          }

          jobs.push(
            runCell(ctx, client, fnId(shape), shape, timing, `${tag}-${stamp}`),
          );
        }
      }

      await Promise.all(jobs);
    },
  });
};

const runCell = async (
  ctx: Ctx,
  client: Inngest,
  fn: string,
  shape: Shape,
  timing: Timing,
  stamp: string,
) => {
  const name = `${shape}/${timing}`;
  const t = `${shape}-${timing}-${stamp}`;
  const burst = timing === "burst";
  const want = burst ? 8 : 1;
  const failures: string[] = [];

  try {
    const waitFor = async (line: string, afterMs = 0) => {
      await ctx.until(
        async () => {
          return count(t, line);
        },
        (c) => {
          return c >= 1;
        },
      );
      await sleep(afterMs);
    };
    const send = async (n: number, id?: string) => {
      const names = shape === "two" ? ["msg", "msg2"] : ["msg"];

      await client.send(
        names.map((eventName) => {
          return {
            ...(id ? { id: `${id}-${eventName}` } : {}),
            name: ctx.event(eventName),
            data: { t, n },
          };
        }),
      );
    };

    const start = await ctx.send(
      `go-${fn}`,
      {
        t,
        want,
        slow: timing === "preopen" || timing === "afterclose" ? 1500 : 100,
      },
      { startsRun: true },
    );
    const sent: number[] = [];

    if (timing === "preopen") {
      await waitFor("pre:start", 300);
      await send(0);
      await waitFor("at-next", 800);
      await send(1);
      sent.push(1);
    } else if (timing === "inline") {
      await waitFor("A:start", 300);
      await send(1);
      sent.push(1);
    } else if (timing === "parked") {
      if (parallelShapes.includes(shape)) {
        await waitFor("p:end", 800);
      } else {
        await waitFor("at-next", 800);
      }

      await send(1);
      sent.push(1);
    } else if (timing === "parallel") {
      await waitFor("p:start", 300);
      await send(1);
      sent.push(1);
    } else if (burst) {
      await waitFor("at-next", 800);

      await client.send(
        Array.from({ length: 8 }, (_, i) => {
          return (shape === "two" ? ["msg", "msg2"] : ["msg"]).map(
            (eventName) => {
              return {
                name: ctx.event(eventName),
                data: { t, n: i + 1 },
              };
            },
          );
        }).flat(),
      );
      sent.push(...Array.from({ length: 8 }, (_, i) => i + 1));
    } else if (timing === "dup") {
      await waitFor("at-next", 800);
      await send(1, `dup-${t}`);
      await send(1, `dup-${t}`);
      await sleep(300);
      await send(1, `dup-${t}`);
      sent.push(1);
    } else {
      await waitFor("at-next", 800);
      await send(1);
      sent.push(1);
      await waitFor("after:start", 300);
      await send(99);
    }

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

    if (run.status.toLowerCase() !== "completed") {
      failures.push(`run ended ${run.status}`);
    }

    const reads = ((run.output as { reads?: Read[] } | undefined)?.reads ??
      []) as Read[];
    const values = reads.map((r) => {
      return r.value;
    });
    const expected =
      shape === "two" ? [...sent, ...sent.map((n) => n + 1000)] : sent;

    if (new Set(values).size !== values.length) {
      failures.push(`a message was read twice: ${JSON.stringify(values)}`);
    }

    if (shape === "race") {
      if (
        values.some((v) => {
          return !expected.includes(v);
        })
      ) {
        failures.push(`unexpected values ${JSON.stringify(values)}`);
      }
    } else if (
      JSON.stringify([...values].sort((a, b) => a - b)) !==
      JSON.stringify([...expected].sort((a, b) => a - b))
    ) {
      failures.push(
        `read ${JSON.stringify(values)}, wanted ${JSON.stringify(expected)}`,
      );
    }

    if (shape !== "two") {
      const seqs = reads.map((r) => {
        return r.seq;
      });

      if (JSON.stringify(seqs) !== JSON.stringify(seqs.map((_, i) => i + 1))) {
        failures.push(`seq not 1..k: ${JSON.stringify(seqs)}`);
      }

      if (
        !burst &&
        JSON.stringify(values) !== JSON.stringify(expected) &&
        shape !== "race"
      ) {
        failures.push(`out of send order: ${JSON.stringify(values)}`);
      }
    }

    const log = lines(t);
    const doubled = [
      ...new Set(
        log
          .filter((l) => {
            return l.startsWith("step:");
          })
          .filter((l, i, all) => {
            return all.indexOf(l) !== i;
          }),
      ),
    ];

    if (doubled.length > 0) {
      failures.push(`step bodies ran twice: ${doubled.join(",")}`);
    }

    const seen = new Map<string, Set<string>>();

    for (const l of log) {
      const m = /^(read:\d+|winner):(.*)$/.exec(l);

      if (m?.[1] && m[2] !== undefined) {
        const set = seen.get(m[1]) ?? new Set<string>();

        set.add(m[2]);
        seen.set(m[1], set);
      }
    }

    const unstable = [...seen].filter(([, set]) => {
      return set.size > 1;
    });

    if (unstable.length > 0) {
      failures.push(
        `replays differ: ${unstable.map(([k, s]) => `${k}=${[...s].join("|")}`).join(", ")}`,
      );
    }

    // Nothing is left behind: a message after the end starts no more work.
    const bodies = count(t, "body");
    const steps = run.steps.length;

    await sleep(500);
    await send(777);
    await sleep(1500);

    const [after] = await ctx.runsOf(start);

    if (
      count(t, "body") !== bodies ||
      (after?.steps.length ?? 0) > steps ||
      after?.status.toLowerCase() !== "completed"
    ) {
      failures.push(
        `a message after the end changed the run: bodies ${bodies} to ${count(t, "body")}, steps ${steps} to ${after?.steps.length}, ${after?.status}`,
      );
    }
  } catch (error) {
    failures.push(`error: ${(error as Error).message}`);
  }

  ctx.check(name, failures.length === 0, failures);

  if (existsSync(logFile(t))) {
    unlinkSync(logFile(t));
  }
};
