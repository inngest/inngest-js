/**
 * @module
 * Driver of the live sandbox runner suite: starts a Dev Server (with the
 * Cloud sandbox proxy) and `app.ts` through devstack, sends the one event
 * that runs every case, prints a pass/fail table, stops what it started and
 * exits non-zero if anything failed. See `README.md` in this folder.
 *
 *   pnpm -C packages/inngest test:sandbox-live [--list] [--dry] [--only TEXT]
 */

import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { caseId, cases } from "./cases.ts";

const { values: flags } = parseArgs({
  options: {
    list: { type: "boolean", default: false },
    dry: { type: "boolean", default: false },
    only: { type: "string", default: "" },
  },
});

const devstack =
  process.env.DEVSTACK ?? join(homedir(), "repo/inngest/devstack/bin/devstack");
const ossRepo =
  process.env.INNGEST_OSS_REPO ?? join(homedir(), "repo/inngest/inngest");
const stack = `sandbox-live-${process.pid}`;

/**
 * Run devstack, echoing its output, and return what it printed.
 */
const run = (args: string[]): Promise<{ code: number; out: string }> => {
  return new Promise((resolve) => {
    const child = spawn(devstack, args, {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";

    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk;
      process.stdout.write(chunk);
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, out });
    });
  });
};

const devServerUrl = (): string => {
  const { stdout } = spawnSync(devstack, [
    "status",
    "--json",
    "--stack",
    stack,
  ]);
  const { instances } = JSON.parse(stdout.toString()) as {
    instances: { kind: string; stack: string; url: string }[];
  };

  return instances.find((i) => {
    return i.kind === "dev" && i.stack === stack;
  })!.url;
};

const getJson = async <T>(url: string): Promise<T> => {
  return (await fetch(url)).json() as Promise<T>;
};

interface Verdict {
  name: string;
  pass: boolean;
  detail: string;
}

const execute = async (): Promise<Verdict[]> => {
  await run(["build-local", ossRepo, "--ref", "origin/main"]);
  await run(["dev", "start", "--stack", stack, "--bin", "local"]);
  const url = devServerUrl();

  const { data: cloud, errors } = await getJson<{
    data?: { accountName: string; environmentName: string };
    errors?: unknown;
  }>(`${url}/dev/cloud/status`);
  if (!cloud) {
    throw new Error(`Cloud sandboxes unavailable: ${JSON.stringify(errors)}`);
  }
  console.log(`Cloud: ${cloud.accountName} / ${cloud.environmentName}`);

  const started = await run([
    "app",
    "start",
    "--stack",
    stack,
    "--name",
    "live",
    "--cwd",
    process.cwd(),
    "--cmd",
    "npx tsx src/components/sandbox/live/app.ts",
    "--path",
    "/api/inngest",
  ]);
  if (started.code !== 0) {
    throw new Error("The app failed to start");
  }

  const sent = await run([
    "send",
    "sandbox-runners-live/run",
    "--stack",
    stack,
    "--data",
    JSON.stringify({ only: flags.only, dry: flags.dry }),
    "--expect-runs",
    "1",
    "--timeout",
    "15m",
  ]);
  const runId = / run (\w{26}) /.exec(sent.out)?.[1];
  const response = await fetch(`${url}/v0/gql`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: `{ run(runID: "${runId}") { status output } }`,
    }),
  });
  const { run: finished } = (await response.json()).data as {
    run: { status: string; output: string };
  };
  if (sent.code !== 0 || finished.status !== "COMPLETED") {
    throw new Error(`The run ended ${finished.status}: ${finished.output}`);
  }

  // The output is the run's result op, which wraps the function's return.
  const output = (JSON.parse(finished.output) as { data: unknown }[])[0]?.data;

  return flags.dry
    ? (output as string[]).map((name) => {
        return { name, pass: true, detail: "listed, not run" };
      })
    : (output as Verdict[]);
};

const main = async (): Promise<number> => {
  if (flags.list) {
    for (const c of cases) {
      console.log(caseId(c));
    }

    return 0;
  }

  let verdicts: Verdict[] = [];
  try {
    verdicts = await execute();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
  } finally {
    await run(["stop", stack]);
  }

  const width = Math.max(0, ...verdicts.map((v) => v.name.length));
  for (const v of verdicts) {
    console.log(
      `${v.pass ? "PASS" : "FAIL"}  ${v.name.padEnd(width)}  ${v.detail}`,
    );
  }
  const failed = verdicts.filter((v) => {
    return !v.pass;
  });
  console.log(`${verdicts.length - failed.length}/${verdicts.length} passed`);

  return verdicts.length && !failed.length ? 0 : 1;
};

process.on("SIGINT", () => {
  spawnSync(devstack, ["stop", stack], { stdio: "inherit" });
  process.exit(130);
});

process.exitCode = await main();
