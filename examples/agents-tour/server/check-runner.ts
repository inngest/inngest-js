/**
 * @module
 * Runs an exercise's check script against the running app. The script is
 * given the small API in `shared/check.ts`; it ends by returning (a pass) or
 * by calling `fail` with one sentence (a fail). Anything else it throws is
 * reported as a broken check, never as the reader's failure.
 */
import { pathToFileURL } from "node:url";
import type {
  Check,
  CheckApi,
  SeenPost,
  SeenRun,
  SeenThread,
} from "../shared/check.ts";
import type { CheckResult, TraceRun, TraceStep } from "../shared/types.ts";
import type { TourContext } from "./area.ts";
import { botUser } from "./fakes/settings.ts";
import { readOutput, readRuns, terminal } from "./runs.ts";

class CheckFailed extends Error {}

export interface CheckTiming {
  // How long to wait for the first run to appear.
  firstRunTimeoutMs: number;
  // Runs that wait for more messages never finish; they count as settled
  // once nothing has changed for this long.
  quietMs: number;
  // How long the runs may keep changing before the check gives up.
  settleTimeoutMs: number;
}

export const defaultTiming: CheckTiming = {
  firstRunTimeoutMs: 10_000,
  quietMs: 1_500,
  settleTimeoutMs: 20_000,
};

const pollMs = 200;

const sleep = (ms: number) => {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

const seconds = (ms: number) => {
  return `${ms / 1000} seconds`;
};

const shape = (steps: TraceStep[]): unknown[] => {
  return steps.map((step) => {
    return [step.id, step.status, shape(step.children)];
  });
};

const signature = (runs: TraceRun[]) => {
  return JSON.stringify(
    runs.map((run) => {
      return [run.id, run.status, shape(run.steps)];
    }),
  );
};

const parse = (data: string | null) => {
  if (data === null) {
    return null;
  }

  try {
    return JSON.parse(data) as unknown;
  } catch {
    return data;
  }
};

export const createCheckApi = (
  ctx: TourContext,
  since: string,
  timing: CheckTiming = defaultTiming,
): CheckApi => {
  const call = async (method: "GET" | "POST", path: string, body?: unknown) => {
    const res = await fetch(`${ctx.publicUrl}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
    });

    if (!res.ok) {
      throw new Error(`${method} ${path} answered ${res.status}`);
    }

    return (await res.json()) as unknown;
  };

  const posts = async (): Promise<SeenPost[]> => {
    const state = (await call("GET", "/api/slack/state")) as {
      messages: {
        user: string;
        channel: string;
        threadTs?: string;
        text: string;
      }[];
    };

    return state.messages
      .filter((message) => {
        return message.user === botUser;
      })
      .map((message) => {
        return {
          channel: message.channel,
          threadTs: message.threadTs,
          text: message.text,
        };
      });
  };

  const seenRuns = async (fn?: string) => {
    const all = await readRuns(ctx.devServer, since);
    const wanted = fn
      ? all.filter((run) => {
          return run.fn === fn;
        })
      : all;

    return Promise.all(
      wanted.map(async (run): Promise<SeenRun> => {
        const out =
          run.output && terminal.has(run.status)
            ? await readOutput(ctx.devServer, run.output)
            : undefined;
        const thread = run.trigger?.data.thread;

        return {
          id: run.id,
          fn: run.fn,
          status: run.status,
          thread: typeof thread === "string" ? thread : null,
          output: parse(out?.data ?? null),
          error: out?.error?.message ?? null,
        };
      }),
    );
  };

  const api: CheckApi = {
    send: async (agent, thread, content) => {
      await ctx.worker.send(agent, thread, content);
    },
    start: async (agent, thread, content) => {
      await ctx.worker.start(agent, thread, content);
    },
    event: async (name, data = {}) => {
      await ctx.devServer.send(name, data);
    },
    press: (path, body) => {
      return call("POST", path, body);
    },
    posts,
    fail: (reason) => {
      throw new CheckFailed(reason);
    },
    runs: seenRuns,
    threads: async () => {
      const byKey = new Map<string, SeenRun[]>();

      for (const run of await seenRuns()) {
        if (run.thread !== null) {
          byKey.set(run.thread, [...(byKey.get(run.thread) ?? []), run]);
        }
      }

      return [...byKey].map(([key, runs]): SeenThread => {
        return { key, runs };
      });
    },
    settle: async (options = {}) => {
      const quietMs = options.quietMs ?? timing.quietMs;
      const timeoutMs = options.timeoutMs ?? timing.settleTimeoutMs;
      const firstRunBy = Date.now() + timing.firstRunTimeoutMs;

      while ((await readRuns(ctx.devServer, since)).length === 0) {
        if (Date.now() > firstRunBy) {
          throw new CheckFailed(
            `No run started within ${seconds(timing.firstRunTimeoutMs)}.`,
          );
        }

        await sleep(pollMs);
      }

      const end = Date.now() + timeoutMs;
      let last = "";
      let changedAt = Date.now();

      while (Date.now() < end) {
        const now = signature(await readRuns(ctx.devServer, since));

        if (now !== last) {
          last = now;
          changedAt = Date.now();
        }

        if (Date.now() - changedAt >= quietMs) {
          return;
        }

        await sleep(pollMs);
      }

      throw new CheckFailed(
        `The runs were still changing after ${seconds(timeoutMs)}.`,
      );
    },
  };

  return api;
};

/**
 * Runs the check script at `file`. Call it once the reader's app is serving.
 */
export const runCheck = async (
  ctx: TourContext,
  file: string,
): Promise<CheckResult> => {
  const since = new Date().toISOString();

  try {
    const module = (await import(
      `${pathToFileURL(file).href}?t=${Date.now()}`
    )) as { check?: Check };

    if (!module.check) {
      return {
        pass: false,
        reason: "The check does not export check.",
        broken: true,
      };
    }

    await module.check(createCheckApi(ctx, since, ctx.checkTiming));

    return { pass: true };
  } catch (error) {
    if (error instanceof CheckFailed) {
      return { pass: false, reason: error.message };
    }

    return {
      pass: false,
      reason: `The check itself broke: ${String(error)}`,
      broken: true,
    };
  }
};
