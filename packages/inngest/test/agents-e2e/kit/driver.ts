/**
 * @module
 * The scenario contract and the driver API. A scenario file declares the
 * functions the kit app serves (`functions`, run inside the app) and the
 * checks to make (`run`, run by the CLI). The driver sends events, waits for
 * runs, and asserts on runs, steps, Redis keys and what the fake channels
 * received. Every assertion prints a PASS or FAIL line.
 */
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { Inngest, type InngestFunction } from "inngest";
import type { sandboxMiddleware } from "inngest/experimental";
import type { CallFilter, Fakes } from "./channels.ts";
import { redisCommand } from "./redis.ts";

export { script } from "./model.ts";

/**
 * What a scenario's `functions` gets, inside the app.
 */
export type KitClient = Inngest<{
  id: string;
  middleware: [ReturnType<typeof sandboxMiddleware>];
}>;

export interface AppEnv {
  client: KitClient;
  fakes: { url: string };
  redisUrl: string | undefined;

  /**
   * The name of an event only this scenario listens to.
   */
  event: (name: string) => string;
}

export interface RunInfo {
  id: string;
  status: string;
  output: unknown;

  /**
   * The display names of the run's steps, in the order they started.
   */
  steps: string[];

  /**
   * The Dev Server's IDs for the steps: the SHA-1 of the ID the function gave
   * them. `toHaveSteps` hashes the IDs you pass, so you never read these.
   */
  stepHashes: string[];
}

/**
 * The scores a run was given, as the Dev Server shows them in its trace.
 */
export interface RunScores {
  /**
   * The scores on the step the function gave this ID, by score name. A step
   * with none gives `{}`.
   */
  step: (id: string) => Record<string, number>;

  /**
   * The scores on the run itself.
   */
  run: Record<string, number>;
}

export interface Ctx {
  id: string;

  /**
   * Kills the app process and starts it again (the Dev Server and Redis
   * stay), then returns once it has synced. In-flight requests are lost, as in
   * a worker deploy or crash.
   */
  restartApp: () => Promise<void>;
  devUrl: string;
  redisUrl: string;
  fakes: Fakes;
  event: (name: string) => string;

  /**
   * Sends the scenario's event `name` and returns the event ID. Pass
   * `startsRun: true` for an event that starts a run you will wait for with
   * `finished()`: it is sent once more, with the same id, if no run starts.
   * Leave it off for a message a running thread consumes, which a resend
   * would deliver twice.
   */
  send: (
    name: string,
    data?: Record<string, unknown>,
    options?: { startsRun?: boolean },
  ) => Promise<string>;

  /**
   * Waits for the run the event started to leave `Running`.
   */
  finished: (eventId: string) => Promise<RunInfo>;
  runsOf: (eventId: string) => Promise<RunInfo[]>;

  /**
   * Reads the scores of a run from the Dev Server's trace.
   */
  scores: (runId: string) => Promise<RunScores>;
  check: (name: string, ok: boolean, detail?: unknown) => void;

  /**
   * Polls `read` until `ok` accepts the value (30s at most), then checks it.
   */
  eventually: <T>(
    name: string,
    read: () => Promise<T>,
    ok: (value: T) => boolean,
  ) => Promise<T>;
  until: <T>(
    read: () => Promise<T>,
    ok: (value: T) => boolean,
    ms?: number,
  ) => Promise<T>;
  expect: {
    run: (run: RunInfo) => {
      toComplete: () => void;
      toHaveSteps: (...names: string[]) => void;
      toOutput: (output: unknown) => void;
    };
    kv: (key: string) => { toEqual: (value: unknown) => Promise<unknown> };
    posts: (filter: CallFilter) => {
      toHaveCount: (count: number) => Promise<unknown>;
      toInclude: (match: Record<string, unknown>) => Promise<unknown>;
    };
  };
}

export interface Scenario {
  id: string;

  /**
   * Who to ask when this scenario fails.
   */
  owner?: string;

  /**
   * A backend branch (a key of `kit/oss-pins.json`) or sha this scenario
   * needs. The CLI builds it and starts the Dev Server from it.
   */
  needs?: { oss?: string };

  /**
   * How long the scenario may run, in milliseconds. Default 110s. A scenario
   * that waits for a cron tick (at most a minute away, several times) needs
   * more.
   */
  capMs?: number;

  /**
   * `"fake"` serves the Sandboxes API from memory in the app.
   */
  sandbox?: "fake";
  sandboxCommands?: Record<
    string,
    { stdout?: string; stderr?: string; exitCode?: number }
  >;

  /**
   * Commands in these directories that no `sandboxCommands` entry matches run
   * on this machine, so a scenario can use real git.
   */
  sandboxLocalDirs?: string[];

  functions: (env: AppEnv) => InngestFunction.Any[];
  run: (ctx: Ctx) => Promise<void>;
}

export const scenario = (definition: Scenario): Scenario => {
  return definition;
};

export const eventName = (id: string, name: string) => {
  return `agents-e2e/${id}/${name}`;
};

const gql = async (devUrl: string, query: string, variables: object) => {
  const res = await fetch(`${devUrl}/v0/gql`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as { data?: any; errors?: unknown };

  if (!res.ok || json.errors) {
    throw new Error(`GraphQL failed: ${JSON.stringify(json.errors)}`);
  }

  return json.data;
};

const spans = (span: any): { name: string; stepID: string | null }[] => {
  return (span.childrenSpans ?? []).flatMap((child: any) => {
    return [child, ...spans(child)];
  });
};

const scoreKind = "inngest.score.";

const scoresIn = (metadata: any[] | null | undefined) => {
  return Object.fromEntries(
    (metadata ?? [])
      .filter((update) => {
        return update.kind.startsWith(scoreKind);
      })
      .map((update) => {
        return [update.kind.slice(scoreKind.length), update.values.value];
      }),
  ) as Record<string, number>;
};

const readScores = async (
  devUrl: string,
  runId: string,
): Promise<RunScores> => {
  const meta = "metadata { kind values }";
  const data = await gql(
    devUrl,
    `query ($id: String!) { runTrace(runID: $id) { ${meta} childrenSpans { stepID ${meta} childrenSpans { stepID ${meta} childrenSpans { stepID ${meta} } } } } }`,
    { id: runId },
  );
  const found = [data.runTrace, ...spans(data.runTrace)] as any[];

  const byHash: Record<string, Record<string, number>> = {};

  for (const span of found.slice(1)) {
    if (span.stepID) {
      byHash[span.stepID] = {
        ...byHash[span.stepID],
        ...scoresIn(span.metadata),
      };
    }
  }

  return {
    run: scoresIn(data.runTrace.metadata),
    step: (id) => {
      return byHash[hash(id)] ?? {};
    },
  };
};

const terminal = new Set(["COMPLETED", "FAILED", "CANCELLED", "SKIPPED"]);

const hash = (id: string) => {
  return createHash("sha1").update(id).digest("hex");
};

const readRun = async (devUrl: string, id: string): Promise<RunInfo | null> => {
  const data = await gql(
    devUrl,
    `query ($id: String!) { run(runID: $id) { status output trace { childrenSpans { name stepID childrenSpans { name stepID childrenSpans { name stepID childrenSpans { name stepID } } } } } } }`,
    { id },
  );
  const run = data.run;

  if (!run) {
    return null;
  }

  let output: unknown = run.output;

  try {
    output = JSON.parse(run.output);
  } catch {}

  // The Dev Server wraps a run's output in the ops it recorded.
  if (Array.isArray(output)) {
    output = output.find((op) => {
      return op?.op === "RunComplete";
    })?.data;
  }

  const found = run.trace ? spans(run.trace) : [];

  return {
    id,
    status: run.status,
    output,
    steps: found.map((span) => {
      return span.name;
    }),
    stepHashes: found.flatMap((span) => {
      return span.stepID ? [span.stepID] : [];
    }),
  };
};

export const createCtx = (
  id: string,
  devUrl: string,
  redisUrl: string,
  fakes: Fakes,
  onFail: () => void,
  restartApp: () => Promise<void>,
): Ctx => {
  const client = new Inngest({
    id: "agents-e2e-driver",
    baseUrl: devUrl,
    isDev: true,
  });

  // Scenarios of one `--all` run share the fakes, so each sees only the calls
  // made since it began.
  const since = fakes.calls.length;
  const scoped: Fakes = {
    ...fakes,
    posts: (filter) => {
      return fakes.posts(filter).filter((call) => {
        return fakes.calls.indexOf(call) >= since;
      });
    },
  };

  const check: Ctx["check"] = (name, ok, detail) => {
    console.log(
      `${ok ? "PASS" : "FAIL"} ${id}: ${name}`,
      ok ? "" : JSON.stringify(detail),
    );

    if (!ok) {
      onFail();
    }
  };

  const until: Ctx["until"] = async (read, ok, ms = 30_000) => {
    const end = Date.now() + ms;
    let lastError: unknown;
    let value: Awaited<ReturnType<typeof read>> | undefined;
    let have = false;

    // A read that throws (the Dev Server not knowing a run yet) is retried.
    while (Date.now() < end) {
      try {
        value = await read();
        have = true;

        if (ok(value)) {
          return value;
        }
      } catch (error) {
        lastError = error;
      }

      await sleep(300);
    }

    if (!have) {
      throw lastError ?? new Error("nothing was read");
    }

    return value as Awaited<ReturnType<typeof read>>;
  };

  const eventually: Ctx["eventually"] = async (name, read, ok) => {
    const value = await until(read, ok);
    check(name, ok(value), value);

    return value;
  };

  const runsOf: Ctx["runsOf"] = async (eventId) => {
    const res = await fetch(`${devUrl}/v1/events/${eventId}/runs`);

    if (!res.ok) {
      throw new Error(
        `The Dev Server answered ${res.status} for the runs of ${eventId}`,
      );
    }

    const json = (await res.json()) as { data?: { run_id: string }[] };
    const runs = await Promise.all(
      (json.data ?? []).map((run) => {
        return readRun(devUrl, run.run_id);
      }),
    );

    return runs.filter((run): run is RunInfo => {
      return run !== null;
    });
  };

  // What each run-starting event was sent as, to send it once more if it
  // started no run. Only sends that declare `startsRun` are resent: the copy
  // carries the same `id`, and the Dev Server starts one run per `id` (a
  // repeat is stored as another event but starts no second run; checked on
  // Dev Server 1.49). A message for a running thread would be delivered twice,
  // so those are never resent. Each copy is a separate stored event, so the
  // runs of every copy are read.
  const sent = new Map<
    string,
    {
      event: { id: string; name: string; data: Record<string, unknown> };
      copies: string[];
    }
  >();

  const lookupFailed = new Set<string>();

  const finished: Ctx["finished"] = async (eventId) => {
    const again = sent.get(eventId);
    const runsOfCopies = async () => {
      const found = await Promise.all(
        [eventId, ...(again?.copies ?? [])].map((copy) => {
          // A lookup that fails is no runs yet, so the resend can still happen.
          return runsOf(copy).catch((error) => {
            if (!lookupFailed.has(copy)) {
              lookupFailed.add(copy);
              console.log(
                `note ${id}: looking up the runs of event ${copy} failed: ${error instanceof Error ? error.message : String(error)}`,
              );
            }

            return [];
          });
        }),
      );
      const byId = new Map(
        found.flat().map((run) => {
          return [run.id, run] as const;
        }),
      );

      return [...byId.values()];
    };
    const began = await until(
      () => {
        return runsOfCopies();
      },
      (found) => {
        return found.length > 0;
      },
      15_000,
    );
    // The app is synced before a scenario starts, so this is a backstop: an
    // event that started no run within the window is sent once more.
    if (began.length === 0 && again) {
      console.log(
        `note ${id}: event ${eventId} (${again.event.name}) started no run in 15s; sending it once more with the same id`,
      );

      again.copies.push((await client.send(again.event)).ids[0] as string);
    }

    const runs = await until(
      () => {
        return runsOfCopies();
      },
      (found) => {
        return (
          found.length > 0 &&
          found.every((run) => {
            return terminal.has(run.status);
          })
        );
      },
    );
    const first = runs[0];

    if (!first) {
      throw new Error(`Event ${eventId} started no run`);
    }

    // The trace and the output can trail the status for a moment.
    return until(
      async () => {
        return (await readRun(devUrl, first.id)) ?? first;
      },
      (run) => {
        return run.output !== undefined && run.stepHashes.length > 0;
      },
      10_000,
    );
  };

  return {
    id,
    restartApp,
    devUrl,
    redisUrl,
    fakes: scoped,
    scores: (runId) => {
      return readScores(devUrl, runId);
    },
    event: (name) => {
      return eventName(id, name);
    },
    send: async (name, data = {}, options = {}) => {
      const event = { id: randomUUID(), name: eventName(id, name), data };
      const eventId = (await client.send(event)).ids[0] as string;

      if (options.startsRun) {
        sent.set(eventId, { event, copies: [] });
      }

      return eventId;
    },
    finished,
    runsOf,
    check,
    eventually,
    until,
    expect: {
      run: (run) => {
        return {
          toComplete: () => {
            check("run completes", run.status === "COMPLETED", run);
          },
          toHaveSteps: (...names) => {
            const missing = names.filter((name) => {
              return !run.stepHashes.includes(hash(name));
            });
            check(`run has steps ${names.join(", ")}`, missing.length === 0, {
              missing,
              steps: run.steps,
            });
          },
          toOutput: (output) => {
            check(
              "run output",
              isDeepStrictEqual(run.output, output),
              run.output,
            );
          },
        };
      },
      kv: (key) => {
        return {
          toEqual: (value) => {
            return eventually(
              `redis ${key} equals ${JSON.stringify(value)}`,
              async () => {
                const raw = await redisCommand(redisUrl, ["GET", key]);

                try {
                  return typeof raw === "string" ? JSON.parse(raw) : raw;
                } catch {
                  return raw;
                }
              },
              (found) => {
                return isDeepStrictEqual(found, value);
              },
            );
          },
        };
      },
      posts: (filter) => {
        return {
          toHaveCount: (count) => {
            return eventually(
              `${count} calls match ${JSON.stringify(filter)}`,
              async () => {
                const found = scoped.posts(filter);

                // Exactly n: a late extra call must not slip past the check.
                if (found.length === count) {
                  await sleep(1000);

                  return scoped.posts(filter);
                }

                return found;
              },
              (found) => {
                return found.length === count;
              },
            );
          },
          toInclude: (match) => {
            return eventually(
              `a call matches ${JSON.stringify(filter)} with ${JSON.stringify(match)}`,
              async () => {
                return scoped.posts(filter);
              },
              (found) => {
                return found.some((call) => {
                  return Object.entries(match).every(([key, value]) => {
                    return (
                      JSON.stringify(call.body[key]) === JSON.stringify(value)
                    );
                  });
                });
              },
            );
          },
        };
      },
    },
  };
};
