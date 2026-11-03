/**
 * @module
 * Drives every page through a running tour server's HTTP API, the way the
 * site does: opens it, runs its starting code, performs the action its
 * manifest promises (`start`, then `verify.then`), and checks the promised
 * outcome (`verify.runs`). Without a promise a page must start and none of
 * its runs may fail. An exercise must also fail with its stub and pass with
 * its solution. Returns what is wrong, one line each.
 */
import { isDeepStrictEqual } from "node:util";
import type {
  CheckResult,
  Page,
  PageFile,
  Start,
  TourEvent,
  TraceRun,
  TraceStep,
} from "../shared/types.ts";

export interface VerifyOptions {
  // How long a promised run may take to show up. Default: 30 seconds.
  waitMs?: number;
}

const sleep = (ms: number) => {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

const defaultWaitMs = 30_000;
const pollMs = 200;
// A run that has not changed for this long, with nothing running, is waiting.
const stillMs = 800;

const api = async <T>(base: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`${path} answered ${res.status}`);
  }

  return (await res.json()) as T;
};

interface Seen {
  state: string;
  runs: TraceRun[];
  errors: string[];
}

/**
 * What the event stream last said: the status, the runs and the app's errors.
 */
const watch = async (base: string) => {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/stream`, { signal: controller.signal });
  const reader = res.body?.getReader();
  const decoder = new TextDecoder();
  const seen: Seen = { state: "idle", runs: [], errors: [] };

  void (async () => {
    let buffer = "";

    try {
      for (;;) {
        const chunk = await reader?.read();

        if (!chunk || chunk.done) {
          return;
        }

        buffer += decoder.decode(chunk.value);

        for (;;) {
          const end = buffer.indexOf("\n\n");

          if (end < 0) {
            break;
          }

          const event = JSON.parse(
            buffer.slice(0, end).replace(/^data: /, ""),
          ) as TourEvent;

          buffer = buffer.slice(end + 2);

          if (event.type === "status") {
            seen.state = event.state;
          } else if (event.type === "runs") {
            seen.runs = event.runs;
          } else if (event.type === "clear") {
            seen.errors = [];
          } else if (event.type === "log" && event.kind === "err") {
            seen.errors.push(event.text);
          }
        }
      }
    } catch {
      // The stream was closed.
    }
  })();

  return {
    seen,
    stop: () => {
      controller.abort();
    },
  };
};

const filesOf = (files: PageFile[]) => {
  return Object.fromEntries(
    files
      .filter((file) => {
        return file.editable;
      })
      .map((file) => {
        return [file.name, file.content];
      }),
  );
};

const perform = async (base: string, start: Start) => {
  if ("event" in start) {
    await api(base, "/api/event", start.event);
  } else if ("slack" in start) {
    await api(base, "/api/slack/messages", start.slack);
  } else {
    await api(base, "/api/send", {
      agent: start.agent,
      thread: start.thread,
      message: start.content,
    });
  }
};

const stepsOf = (steps: TraceStep[]): TraceStep[] => {
  return steps.flatMap((step) => {
    return [step, ...stepsOf(step.children)];
  });
};

const terminal = new Set(["COMPLETED", "FAILED", "CANCELLED", "SKIPPED"]);

/**
 * The runs have nothing left to do for now: each has ended, or is waiting.
 * A run waits when the Dev Server shows a step waiting, or when it is running
 * with no step running and nothing has changed for `stillMs`. Call it often
 * with the same `memory`.
 */
const idle = (
  runs: TraceRun[],
  memory: { signature: string; since: number },
) => {
  const signature = JSON.stringify(
    runs.map((run) => {
      return [
        run.id,
        run.status,
        stepsOf(run.steps).map((step) => {
          return [step.id, step.status];
        }),
      ];
    }),
  );

  if (signature !== memory.signature) {
    memory.signature = signature;
    memory.since = Date.now();
  }

  const settled = Date.now() - memory.since >= stillMs;

  return (
    runs.length > 0 &&
    runs.every((run) => {
      const steps = stepsOf(run.steps);

      return (
        terminal.has(run.status) ||
        steps.some((step) => {
          return step.status === "WAITING";
        }) ||
        (settled &&
          !steps.some((step) => {
            return step.status === "RUNNING";
          }))
      );
    })
  );
};

const untilIdle = async (seen: Seen, waitMs: number) => {
  const memory = { signature: "", since: Date.now() };
  const end = Date.now() + waitMs;

  while (Date.now() < end) {
    if (idle(seen.runs, memory)) {
      return true;
    }

    await sleep(pollMs);
  }

  return false;
};

const outputOf = async (base: string, run: TraceRun) => {
  const out = run.output
    ? await api<{ data: string | null }>(
        base,
        `/api/output?id=${encodeURIComponent(run.output)}`,
      )
    : { data: null };

  return out.data === null ? null : (JSON.parse(out.data) as unknown);
};

// What is wrong with the runs of `want.fn` right now; empty when it holds.
const mismatch = async (
  base: string,
  seen: Seen,
  want: { fn: string; status?: string; output?: unknown },
) => {
  const runs = seen.runs.filter((run) => {
    return run.fn === want.fn;
  });
  const run = runs.find((candidate) => {
    return want.status
      ? candidate.status === want.status
      : !["FAILED", "CANCELLED"].includes(candidate.status);
  });

  if (!run) {
    return runs.length
      ? `${want.fn} ran but its status is ${runs
          .map((other) => {
            return other.status;
          })
          .join(", ")}, not ${want.status ?? "a good one"}`
      : `no run of ${want.fn}`;
  }

  if ("output" in want) {
    const got = await outputOf(base, run);

    if (!isDeepStrictEqual(got, want.output)) {
      return `${want.fn} returned ${JSON.stringify(got)}, not ${JSON.stringify(want.output)}`;
    }
  }

  return "";
};

const verifyPage = async (base: string, id: string, waitMs: number) => {
  const page = await api<Page>(base, `/api/page?id=${encodeURIComponent(id)}`);

  await api(base, "/api/open", { id });

  if (page.manifest.code === false) {
    return [];
  }

  const watching = await watch(base);
  const { seen } = watching;
  const problems: string[] = [];

  try {
    await api(base, "/api/run", { id, files: filesOf(page.files) });

    const end = Date.now() + 5000;

    while (
      (seen.state === "idle" || seen.state === "starting") &&
      Date.now() < end
    ) {
      await sleep(50);
    }

    if (seen.state !== "live") {
      return [
        `the page did not start: ${seen.errors.join(" ").trim() || seen.state}`,
      ];
    }

    for (const start of page.manifest.verify?.then ?? []) {
      // A reader acts once the run is waiting for the next message.
      if (!(await untilIdle(seen, waitMs))) {
        return ["the run never waited for the next message"];
      }

      await perform(base, start);
    }

    const expected = page.manifest.verify?.runs ?? [];

    // Judge the runs once they have ended or are waiting, not mid-way.
    await untilIdle(seen, waitMs);

    if (expected.length === 0) {
      for (const run of seen.runs) {
        if (run.status === "FAILED") {
          problems.push(`the run of ${run.fn} failed`);
        }
      }
    }

    for (const want of expected) {
      const deadline = Date.now() + waitMs;
      let why = await mismatch(base, seen, want);

      while (why && Date.now() < deadline) {
        await sleep(300);
        why = await mismatch(base, seen, want);
      }

      if (why) {
        problems.push(why);
      }
    }
  } finally {
    watching.stop();
  }

  if (page.manifest.exercise && problems.length === 0) {
    const stub = await api<CheckResult>(base, "/api/check", {
      id,
      files: filesOf(page.files),
    });

    if (stub.pass) {
      problems.push("the stub passes its check");
    } else if (stub.broken) {
      problems.push(`the check is broken: ${stub.reason}`);
    }

    const solution = await api<PageFile[]>(
      base,
      `/api/solution?id=${encodeURIComponent(id)}`,
    );
    const solved = await api<CheckResult>(base, "/api/check", {
      id,
      files: Object.fromEntries(
        solution.map((file) => {
          return [file.name, file.content];
        }),
      ),
    });

    if (!solved.pass) {
      problems.push(`the solution fails its check: ${solved.reason}`);
    }
  }

  return problems;
};

/**
 * Verifies every page, or the pages of one module. Returns `<page>: <what
 * is wrong>`, one line each; empty when every page holds.
 */
export const verifyPages = async (
  base: string,
  onlyModule?: string,
  options: VerifyOptions = {},
) => {
  const index = await api<{
    modules: { id: string; pages: { id: string }[] }[];
  }>(base, "/api/index");
  const problems: string[] = [];

  if (
    onlyModule &&
    !index.modules.some((module) => {
      return module.id === onlyModule;
    })
  ) {
    return [`no module named ${onlyModule}`];
  }

  for (const module of index.modules) {
    if (onlyModule && module.id !== onlyModule) {
      continue;
    }

    for (const page of module.pages) {
      let found: string[];

      try {
        found = await verifyPage(
          base,
          page.id,
          options.waitMs ?? defaultWaitMs,
        );
      } catch (error) {
        found = [String(error)];
      }

      for (const problem of found) {
        problems.push(`${page.id}: ${problem}`);
      }
    }
  }

  return problems;
};
