/**
 * @module
 * The flow matrix. A flow is a function body plus a script that drives it
 * (sends events at the right moments) plus what a correct run looks like. The
 * helper runs every flow in all 8 cells: checkpointing on and off, served and
 * connected, `optimizeParallelism` true and false, and asserts the run's
 * output, how many times each step body ran, and the trace rows.
 *
 * Output is read through GraphQL (the driver does this): the REST `output` is
 * empty with checkpointing on and `optimizeParallelism: true`.
 *
 * Each cell prints one `PASS`/`FAIL` line named `<flow>/<mode>/c<0|1>o<0|1>`.
 *
 * A scenario using it adds a flow to the `flows` list and nothing else.
 */
import { appendFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GetStepTools } from "inngest";
import { Inngest, Middleware } from "inngest";
import { type Ctx, type KitClient, scenario } from "./driver.ts";

export const sleep = (ms: number) => {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

export type FlowStep = GetStepTools<KitClient>;

export interface FlowHandle {
  step: FlowStep;

  /**
   * Unique to this run. Put it in the data of every event the flow waits on,
   * so cells never receive each other's events.
   */
  key: string;

  /**
   * The name of an event only this scenario listens to.
   */
  event: (name: string) => string;

  /**
   * Writes a line to this run's log, from inside or outside a step body. The
   * driver script waits on lines with `reached`.
   */
  mark: (line: string) => void;

  /**
   * Marks `ran:<id>` and returns. Call it first in a step body: the matrix
   * asserts how many times each body ran.
   */
  ran: (id: string) => void;

  /**
   * Resolves once the driver has marked `line`, or fails after 30s. Call it
   * between steps to hold the function until the driver has done something.
   */
  until: (line: string) => Promise<void>;
}

export interface FlowDriver {
  key: string;

  /**
   * Sends the scenario's event `name` with the cell's key in `data.key`.
   */
  send: (name: string, data?: Record<string, unknown>) => Promise<void>;

  /**
   * Sends the scenario's event `name` once for each item of `items`, in one
   * request, with the cell's key in `data.key`.
   */
  sendAll: (name: string, items: Record<string, unknown>[]) => Promise<void>;

  /**
   * Resolves once the run's trace shows a step with this display name. A
   * step's pauses are written before its row appears, so an event sent after
   * `opened("inbox")` is received by the inbox.
   */
  opened: (row: string) => Promise<void>;

  /**
   * Writes a line to the run's log, for the function's `until`.
   */
  mark: (line: string) => void;

  /**
   * Resolves once the function has marked `line`, or fails after 30s.
   */
  reached: (line: string) => Promise<void>;
}

export interface Flow {
  name: string;
  run: (handle: FlowHandle) => Promise<unknown>;

  /**
   * Called once the run has started.
   */
  drive: (driver: FlowDriver) => Promise<void>;
  expect: {
    output: unknown;

    /**
     * How many times each step body ran, by step id. A step not listed must
     * not have run.
     */
    bodies: Record<string, number>;

    /**
     * The step ids the trace shows, each once however many spans it has.
     */
    rows: string[];

    /**
     * How many steps the run holds when its function last ran: every step
     * saved in its state, messages included.
     */
    steps?: number;
  };
}

export const modes = ["serve", "connect"] as const;

export const cells = modes.flatMap((mode) => {
  return [true, false].flatMap((checkpointing) => {
    return [true, false].map((optimize) => {
      return { mode, checkpointing, optimize };
    });
  });
});

export type Cell = (typeof cells)[number];

export const cellTag = (cell: Cell) => {
  return `${cell.mode}/c${cell.checkpointing ? 1 : 0}o${cell.optimize ? 1 : 0}`;
};

const functionId = (flow: Flow, cell: Cell) => {
  return `flow-${flow.name}-${cellTag(cell).replace("/", "-")}`;
};

const logFile = (key: string) => {
  return join(tmpdir(), `agents-e2e-flow-${key}.log`);
};

/**
 * Writes how many steps the run's state holds each time the function starts a
 * request. The last line is the run's total, since every flow sends all its
 * events before the function reads the last one.
 */
class StepTally extends Middleware.BaseMiddleware {
  readonly id = "step-tally";

  override transformFunctionInput(arg: Middleware.TransformFunctionInputArgs) {
    const key = (arg.ctx.event as { data?: { key?: string } }).data?.key;

    if (key) {
      appendFileSync(logFile(key), `steps:${Object.keys(arg.steps).length}\n`);
    }

    return arg;
  }
}

const readLog = (key: string) => {
  return existsSync(logFile(key))
    ? readFileSync(logFile(key), "utf8").trim().split("\n")
    : [];
};

// The spans the Dev Server adds around the function's own steps.
const internalRow = /^(executor\.nonstep|Finalization|Execution|Attempt \d+)$/;

const distinct = (values: string[]) => {
  return [...new Set(values)].sort();
};

/**
 * Builds a scenario that runs every flow in all 8 cells.
 */
export const flowScenario = (definition: {
  id: string;
  owner: string;
  needs?: { oss?: string };
  flows: Flow[];
}) => {
  return scenario({
    id: definition.id,
    owner: definition.owner,
    needs: definition.needs,
    connect: true,
    capMs: 150_000,
    functions: ({ client, event, mode }) => {
      return definition.flows.flatMap((flow) => {
        return cells
          .filter((cell) => {
            return cell.mode === mode;
          })
          .map((cell) => {
            const id = functionId(flow, cell);

            return client.createFunction(
              {
                id,
                triggers: [{ event: event(`go-${id}`) }],
                checkpointing: cell.checkpointing,
                optimizeParallelism: cell.optimize,
                middleware: [StepTally],
              },
              async ({ event: trigger, step }) => {
                const key = trigger.data.key as string;
                const mark = (line: string) => {
                  appendFileSync(logFile(key), `${line}\n`);
                };

                mark("handler");

                return flow.run({
                  step,
                  key,
                  event,
                  mark,
                  ran: (stepId) => {
                    mark(`ran:${stepId}`);
                  },
                  until: async (line) => {
                    const end = Date.now() + 30_000;

                    while (!readLog(key).includes(line)) {
                      if (Date.now() > end) {
                        throw new Error(`the driver never marked ${line}`);
                      }

                      await sleep(50);
                    }
                  },
                });
              },
            );
          });
      });
    },
    run: async (ctx) => {
      const client = new Inngest({
        id: "agents-e2e-driver",
        baseUrl: ctx.devUrl,
        isDev: true,
      });
      const stamp = Date.now();
      const queue = definition.flows.flatMap((flow) => {
        return cells.map((cell) => {
          return { flow, cell };
        });
      });

      // Eight runs at a time: the Dev Server is shared with the app.
      await Promise.all(
        Array.from({ length: 8 }, async () => {
          for (let next = queue.shift(); next; next = queue.shift()) {
            await runCell(ctx, client, next.flow, next.cell, stamp);
          }
        }),
      );
    },
  });
};

const runCell = async (
  ctx: Ctx,
  client: Inngest,
  flow: Flow,
  cell: Cell,
  stamp: number,
) => {
  const name = `${flow.name}/${cellTag(cell)}`;
  const key = `${flow.name}-${cellTag(cell).replace("/", "-")}-${stamp}`;
  const failures: string[] = [];

  try {
    const start = await ctx.send(
      `go-${functionId(flow, cell)}`,
      { key },
      { startsRun: true },
    );

    await flow.drive({
      key,
      send: async (eventName, data = {}) => {
        await client.send({
          name: ctx.event(eventName),
          data: { ...data, key },
        });
      },
      sendAll: async (eventName, items) => {
        await client.send(
          items.map((data) => {
            return { name: ctx.event(eventName), data: { ...data, key } };
          }),
        );
      },
      opened: async (row) => {
        await ctx.until(
          async () => {
            const [found] = await ctx.runsOf(start);

            return found?.steps ?? [];
          },
          (steps) => {
            return steps.includes(row);
          },
        );
      },
      mark: (line) => {
        appendFileSync(logFile(key), `${line}\n`);
      },
      reached: async (line) => {
        await ctx.until(
          async () => {
            return readLog(key).includes(line);
          },
          (seen) => {
            return seen;
          },
        );
      },
    });

    await ctx.finished(start);

    // The status can turn terminal before the output is readable.
    const run = await ctx.until(
      async () => {
        const [found] = await ctx.runsOf(start);

        return found as NonNullable<typeof found>;
      },
      (r) => {
        return r.output !== null && r.output !== undefined;
      },
    );

    if (run.status !== "COMPLETED") {
      failures.push(`run ended ${run.status}`);
    }

    if (
      JSON.stringify(sortKeys(run.output)) !==
      JSON.stringify(sortKeys(flow.expect.output))
    ) {
      failures.push(
        `output ${JSON.stringify(run.output)}, wanted ${JSON.stringify(flow.expect.output)}`,
      );
    }

    // Let a late duplicate body show up before counting.
    await sleep(500);

    const log = readLog(key);
    const bodies: Record<string, number> = {};

    for (const line of log) {
      if (line.startsWith("ran:")) {
        const id = line.slice(4);

        bodies[id] = (bodies[id] ?? 0) + 1;
      }
    }

    if (
      JSON.stringify(sortKeys(bodies)) !==
      JSON.stringify(sortKeys(flow.expect.bodies))
    ) {
      failures.push(
        `step bodies ran ${JSON.stringify(bodies)}, wanted ${JSON.stringify(flow.expect.bodies)}`,
      );
    }

    if (flow.expect.steps !== undefined) {
      const tally = log
        .filter((line) => {
          return line.startsWith("steps:");
        })
        .at(-1);

      if (tally !== `steps:${flow.expect.steps}`) {
        failures.push(
          `${tally ?? "no steps line"}, wanted steps:${flow.expect.steps}`,
        );
      }
    }

    const rows = distinct(
      run.steps.filter((row) => {
        return !internalRow.test(row);
      }),
    );

    if (JSON.stringify(rows) !== JSON.stringify(distinct(flow.expect.rows))) {
      failures.push(
        `trace rows ${JSON.stringify(rows)}, wanted ${JSON.stringify(distinct(flow.expect.rows))}`,
      );
    }
  } catch (error) {
    failures.push(`error: ${(error as Error).message}`);
  }

  ctx.check(name, failures.length === 0, failures);

  if (existsSync(logFile(key))) {
    unlinkSync(logFile(key));
  }
};

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => {
          return a.localeCompare(b);
        })
        .map(([k, v]) => {
          return [k, sortKeys(v)];
        }),
    );
  }

  return value;
};
