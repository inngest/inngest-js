/**
 * Run `inngest/ci` end to end against real sandboxes.
 *
 * Needs `inngest dev --cloud-sandboxes` running, connected to a Cloud
 * environment, and the token it prints:
 *
 * ```bash
 * INNGEST_SANDBOX_DEV_TOKEN=... pnpm ci:e2e            # every case
 * INNGEST_SANDBOX_DEV_TOKEN=... pnpm ci:e2e commands   # just these
 * ```
 *
 * Each case sends a pull request event for `e2e/<case>` built from a small
 * throwaway git repository, waits for the run on the Dev Server, and checks
 * its output.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deepStrictEqual, equal, ok } from "node:assert/strict";

import { fixtures } from "inngest/ci";
import { serve } from "inngest/node";

const devUrl = process.env.INNGEST_DEV ?? "http://127.0.0.1:8288";
const port = Number(process.env.PORT ?? 3940);
const appUrl = `http://127.0.0.1:${port}/api/inngest`;

process.env.INNGEST_DEV = devUrl;

if (!process.env.INNGEST_SANDBOX_DEV_TOKEN) {
  console.error(
    "Set INNGEST_SANDBOX_DEV_TOKEN to the token `inngest dev --cloud-sandboxes` prints.",
  );
  process.exit(1);
}

// ---------------------------------------------------------------- fixture

const makeFixture = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "inngest-ci-e2e-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "pipe" }).toString().trim();
  const write = (path: string, body: string) => {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), body);
  };

  git("init", "-q", "-b", "main");
  git("config", "user.email", "e2e@example.com");
  git("config", "user.name", "e2e");
  write(
    "package.json",
    JSON.stringify({ name: "ci-e2e-fixture", type: "module" }, null, 2),
  );
  write("src/sum.js", "export const sum = (a, b) => a + b;\n");
  write(
    "src/sum.test.js",
    [
      'import { test } from "node:test";',
      'import { equal } from "node:assert/strict";',
      'import { sum } from "./sum.js";',
      'test("sum", () => equal(sum(1, 2), 3));',
      "",
    ].join("\n"),
  );
  write("docs/guide.md", "# Guide\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");

  // The pull request changes only `src/`.
  git("checkout", "-q", "-b", "feature");
  write(
    "src/sum.js",
    "// changed on the branch\nexport const sum = (a, b) => a + b;\n",
  );
  git("commit", "-q", "-am", "change src");

  // Untracked but not ignored: `checkout()` uploads the working tree.
  write("uncommitted.txt", "from the working tree\n");

  return dir;
};

// ---------------------------------------------------------------- dev server

interface Run {
  run_id: string;
  status: string;
  output?: unknown;
}

const devApi = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(new URL(path, devUrl), init);
  if (!res.ok) {
    throw new Error(
      `${init?.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`,
    );
  }
  return (await res.json()) as T;
};

const gql = <T>(query: string, variables: Record<string, unknown>) =>
  devApi<{ data: T }>("/v0/gql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  }).then(({ data }) => data);

/**
 * The run's status and output, from the trace.
 *
 * The REST runs API isn't used for either: it reports `output: ""` for
 * checkpointed runs, and can report a run that's still retrying as
 * terminal. In the trace, output is a list of ops ending in `RunComplete`.
 */
const runState = async (
  runId: string,
): Promise<{ status: string; output: unknown }> => {
  const { run } = await gql<{ run: { status: string; output: string | null } }>(
    "query ($id: String!) { run(runID: $id) { status output } }",
    { id: runId },
  );

  if (!run.output) {
    return { status: run.status, output: undefined };
  }

  try {
    const parsed = JSON.parse(run.output) as unknown;
    if (Array.isArray(parsed)) {
      const done = parsed.find((op) => op?.op === "RunComplete");
      return { status: run.status, output: done ? done.data : parsed };
    }
    return { status: run.status, output: parsed };
  } catch {
    return { status: run.status, output: run.output };
  }
};

const terminal = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

const statusName = (status: string) =>
  status.charAt(0) + status.slice(1).toLowerCase();

const waitForRun = async (eventId: string, timeoutMs: number): Promise<Run> => {
  const deadline = Date.now() + timeoutMs;
  let runId: string | undefined;
  let status = "no run";

  while (Date.now() < deadline) {
    if (!runId) {
      const { data } = await devApi<{ data: Run[] }>(
        `/v1/events/${eventId}/runs`,
      );
      if (data.length > 1) {
        throw new Error(
          `event ${eventId} started ${data.length} runs; expected 1`,
        );
      }
      runId = data[0]?.run_id;
    }

    if (runId) {
      const state = await runState(runId);
      status = state.status;
      if (terminal.has(state.status)) {
        return {
          run_id: runId,
          status: statusName(state.status),
          output: state.output,
        };
      }
    }

    await new Promise((r) => setTimeout(r, 3000));
  }

  // Cancel rather than abandon it, so CI's cleanup runs while the app is
  // still up and its machines are destroyed.
  if (runId) {
    await gql("mutation ($id: ULID!) { cancelRun(runID: $id) { id } }", {
      id: runId,
    }).catch(() => undefined);
  }

  throw new Error(
    `timed out after ${timeoutMs / 1000}s waiting for event ${eventId} (last status: ${status})`,
  );
};

/** Run `fn` over `items`, at most `limit` at a time, keeping their order. */
const mapLimit = async <T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> => {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
};

// ---------------------------------------------------------------- cases

type Output = Record<string, unknown>;

interface Case {
  id: string;
  timeoutMs?: number;
  /** How many events to send, one after another. Checks see every run. */
  sends?: number;
  check(runs: Run[]): void;
}

const completed = (run: Run): Output => {
  equal(run.status, "Completed", `run failed: ${JSON.stringify(run.output)}`);
  return run.output as Output;
};

const cases: Case[] = [
  {
    id: "commands",
    check: ([run]) => {
      const out = completed(run!);
      equal(out.pkgName, "ci-e2e-fixture");
      equal(out.echoed, "one argument");
      deepStrictEqual(out.srcFiles, ["sum.js", "sum.test.js"]);
      equal(out.piped, "3");
      equal(out.env, "hi");
      equal(out.cwd, "/work/src");
      equal(out.softExit, 3);
      equal(out.spread, "a b c");
      ok(
        !String(out.secret).includes("s3cr3t-value"),
        `secret leaked: ${out.secret}`,
      );
      equal(out.namedExit, 0);
      deepStrictEqual(out.failure, {
        name: "CommandFailedError",
        isCommandFailed: true,
        exitCode: 2,
        stderrTail: (out.failure as Output | undefined)?.stderrTail,
      });
      ok(String((out.failure as Output).stderrTail).includes("boom"));
    },
  },
  {
    id: "timeout",
    timeoutMs: 5 * 60_000,
    check: ([run]) => {
      const out = completed(run!);
      equal(out.captured, "CommandTimeoutError");
      equal(out.capturedIsTimeout, "true");
      equal(out.process, "CommandTimeoutError");
      equal(out.processIsTimeout, "true");
    },
  },
  {
    id: "retries",
    check: ([run]) => {
      deepStrictEqual(completed(run!), { stdout: "second", exitCode: 0 });
    },
  },
  {
    id: "from",
    check: ([run]) => {
      const out = completed(run!) as { a: Output; b: Output };
      deepStrictEqual(out.a, {
        parent: { built: "yes" },
        marker: "from-setup",
      });
      deepStrictEqual(out.b, { marker: "from-setup", seesA: false });
    },
  },
  {
    id: "services",
    check: ([run]) => {
      const out = completed(run!);
      equal(out.body, "pong");
      ok(out.killedExit !== 0, "killed process should exit non-zero");
      ok(out.waitError, "waitForPort on a closed port should throw");
    },
  },
  {
    id: "two-machines",
    check: ([run]) => {
      const out = completed(run!);
      equal(out.differentMachines, true);
      equal(out.jobSeesApiPort, false);
    },
  },
  {
    id: "matrix",
    check: ([run]) => {
      const out = completed(run!);
      const all = JSON.stringify(out.all);
      for (const combo of ["a-s", "a-l", "b-s"]) {
        ok(all.includes(combo), `matrix missing ${combo}: ${all}`);
      }
      ok(!all.includes("b-l"), `excluded combo ran: ${all}`);
      ok(JSON.stringify(out.one).includes("a-l"));
    },
  },
  {
    id: "changed",
    check: ([run]) => {
      const out = completed(run!);
      ok(
        JSON.stringify(out).includes("src=true ignoringSrc=false"),
        `unexpected skip output: ${JSON.stringify(out)}`,
      );
    },
  },
  {
    id: "cache",
    sends: 2,
    check: ([first, second]) => {
      const a = completed(first!);
      const b = completed(second!);
      deepStrictEqual(b, a, "second run should restore the first run's result");
    },
  },
  {
    id: "pause",
    timeoutMs: 3 * 60_000,
    check: ([run]) => {
      deepStrictEqual(completed(run!), { approved: false, state: "before" });
    },
  },
  {
    id: "no-machine",
    check: ([run]) => {
      deepStrictEqual(completed(run!), {
        value: 42,
        owner: "e2e",
        repo: "no-machine",
        hasSha: true,
        number: 1,
      });
    },
  },
  {
    id: "failure",
    timeoutMs: 10 * 60_000,
    check: ([run]) => {
      equal(run!.status, "Failed");
      const text = JSON.stringify(run!.output);
      ok(
        text.includes("CommandFailedError") || text.includes("exited with 7"),
        text,
      );
    },
  },
  {
    id: "checkout",
    check: ([run]) => {
      deepStrictEqual(completed(run!), {
        hasSum: true,
        uncommitted: "from the working tree",
        testExit: 0,
      });
    },
  },
];

// ---------------------------------------------------------------- main

const main = async () => {
  const only = process.argv.slice(2);
  const selected = only.length
    ? cases.filter((c) => only.includes(c.id))
    : cases;
  const unknown = only.filter((id) => !cases.some((c) => c.id === id));
  if (unknown.length) {
    throw new Error(`unknown cases: ${unknown.join(", ")}`);
  }

  const fixture = makeFixture();
  console.log({ fixture, devUrl, appUrl }, "fixture ready");

  // Imported here rather than at the top so the client sees INNGEST_DEV: it
  // reads its environment when it's constructed.
  const { ci, inngest } = await import("./pipelines.ts");
  const handler = serve({ client: inngest, functions: ci.functions() });
  const server = createServer((req, res) => handler(req, res)).listen(port);

  // Register the app with the Dev Server.
  const sync = await fetch(appUrl, { method: "PUT" });
  if (!sync.ok) {
    throw new Error(`sync failed: ${sync.status} ${await sync.text()}`);
  }

  // Several machines at once is fine; a dozen can run into compute limits.
  const concurrency = Number(process.env.E2E_CONCURRENCY ?? 3);

  const results = await mapLimit(selected, concurrency, async (c) => {
    const started = Date.now();
    try {
      const runs: Run[] = [];
      for (let i = 0; i < (c.sends ?? 1); i++) {
        const event = await fixtures.pullRequest({
          cwd: fixture,
          repo: `e2e/${c.id}`,
        });
        const { ids } = await inngest.send(event);
        runs.push(await waitForRun(ids[0]!, c.timeoutMs ?? 4 * 60_000));
      }
      c.check(runs);
      return { id: c.id, ok: true, secs: (Date.now() - started) / 1000 };
    } catch (error) {
      return {
        id: c.id,
        ok: false,
        secs: (Date.now() - started) / 1000,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  server.close();

  for (const r of results) {
    console.log(
      `${r.ok ? "PASS" : "FAIL"}  ${r.id.padEnd(14)} ${r.secs.toFixed(0)}s${r.ok ? "" : `\n      ${r.error}`}`,
    );
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
