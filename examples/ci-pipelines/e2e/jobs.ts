import {
  $,
  CommandFailedError,
  CommandTimeoutError,
  checkout,
  files,
  from,
  github,
  report,
  sandbox,
  waitForHttp,
  waitForPort,
} from "@inngest/ci";
import { step } from "inngest";

import { ci } from "./client.ts";

function errorName(error: unknown) {
  return error instanceof Error ? error.name : String(error);
}

export const commandsJob = ci.job("commands", async () => {
  await checkout();

  const pkg = await $`cat package.json`.json<{ name: string }>();
  const echoed = await $`echo ${"one argument"}`.text();
  const srcFiles = await $`ls src`.lines();
  const piped = await $.sh`printf 'a\nb\nc\n' | wc -l`.text();
  const env = await $`sh -c ${"echo $GREETING"}`.env({ GREETING: "hi" }).text();
  const cwd = await $`pwd`.cwd("/work/src").text();
  const soft = await $`sh -c ${"exit 3"}`.nothrow();
  const skipFlag = false;
  const spread = await $`echo a ${skipFlag && "--nope"} ${["b", "c"]}`.text();

  let secret: string;

  try {
    await $`true`.withSecret("TOKEN", "s3cr3t-value");

    secret = "no error";
  } catch (error) {
    secret = errorName(error);
  }

  const named = await $`true`.as("a named command");

  let failure: Record<string, unknown> | undefined;

  try {
    await $`sh -c ${"echo boom >&2; exit 2"}`;
  } catch (error) {
    failure = {
      name: errorName(error),
      isCommandFailed: error instanceof CommandFailedError,
      exitCode: (error as CommandFailedError).exitCode,
      stderrTail: (error as CommandFailedError).stderrTail,
    };
  }

  return {
    pkgName: pkg.name,
    echoed,
    srcFiles,
    piped: piped.trim(),
    env,
    cwd,
    softExit: soft.exitCode,
    spread,
    secret,
    namedExit: named.exitCode,
    failure,
  };
});

export const timeoutJob = ci.job("timeout", async () => {
  const outcomes: Record<string, string> = {};

  try {
    await $`sleep 30`.timeout("2s");

    outcomes.captured = "no error";
  } catch (error) {
    outcomes.captured = errorName(error);
    outcomes.capturedIsTimeout = String(error instanceof CommandTimeoutError);
  }

  try {
    await $`sleep 300`.timeout("70s");

    outcomes.process = "no error";
  } catch (error) {
    outcomes.process = errorName(error);
    outcomes.processIsTimeout = String(error instanceof CommandTimeoutError);
  }

  return outcomes;
});

export const retriesJob = ci.job("retries", async () => {
  const result = await $.sh`
    if [ -f /tmp/attempted ]; then echo second; else touch /tmp/attempted; exit 1; fi
  `.retries(1);

  return { stdout: result.stdout.trim(), exitCode: result.exitCode };
});

export const base = ci.job("base", async () => {
  await checkout();

  await $.sh`echo from-base > /work/marker`;

  return { built: "yes" };
});

export const childA = ci.job("child-a", async () => {
  const parent = await from(base);
  const marker = await $`cat /work/marker`.text();

  await $.sh`echo a > /work/only-a`;

  return { parent, marker };
});

export const childB = ci.job("child-b", async () => {
  await from(base);

  const marker = await $`cat /work/marker`.text();
  const seesA = await $`test -f /work/only-a`.nothrow();
  return { marker, seesA: seesA.exitCode === 0 };
});

export const servicesJob = ci.job("services", async () => {
  const server =
    await $`node -e ${"require('http').createServer((_,res)=>res.end('pong')).listen(3000)"}`.background();

  await waitForHttp("http://127.0.0.1:3000");

  await waitForPort(3000);

  const body = await $`curl -s http://127.0.0.1:3000`.text();

  await server.kill();

  const exited = await server.exited();

  let waitError: string | undefined;
  try {
    await waitForPort(3999, { timeout: "5s" });
  } catch (error) {
    waitError = errorName(error);
  }

  return { body, killedExit: exited.exitCode, waitError };
});

export const twoMachinesJob = ci.job("two-machines", async () => {
  const api = await sandbox("api");

  await api.$`node -e ${"require('http').createServer((_,res)=>res.end('api')).listen(3000)"}`.background();

  await api.waitForPort(3000);

  const apiHost = await api.$`hostname`.text();

  await checkout();

  const jobHost = await $`hostname`.text();
  const jobSeesServer = await $`sh -c ${"nc -z 127.0.0.1 3000"}`.nothrow();

  return {
    differentMachines: apiHost !== jobHost,
    jobSeesApiPort: jobSeesServer.exitCode === 0,
  };
});

export const matrix = ci.matrix(
  {
    id: "matrix",
    axes: { os: ["a", "b"], size: ["s", "l"] },
    exclude: [{ os: "b", size: "l" }],
  },
  async ({ os, size }) => {
    return $`sh -c ${"echo $OS-$SIZE"}`.env({ OS: os, SIZE: size }).text();
  },
);

export const cachedJob = ci.job(
  { id: "cached", cache: { key: [files("package.json"), "v1"] } },
  async () => {
    await checkout();

    await $.sh`date +%s%N > /tmp/stamp`;
  },
);

/** Reads the stamp `cached` left on its machine, which a restore keeps. */
export const cachedReader = ci.job("cached-reader", async () => {
  await from(cachedJob);

  const stamp = await $`cat /tmp/stamp`.text();

  return { stamp };
});

export const pauseJob = ci.job("pause", async () => {
  await $.sh`echo before > /tmp/state`;

  const approval = await step.waitForEvent("approval", {
    event: "ci-e2e/approved",
    timeout: "10s",
  });

  const state = await $`cat /tmp/state`.text();
  return { approved: Boolean(approval), state };
});

export const noMachineJob = ci.job("no-machine", async () => {
  const value = await step.run("compute", () => {
    return 21 * 2;
  });

  const { owner, repo, sha, number } = github.repo();

  await report.summary(`computed ${value}`);

  return { value, owner, repo, hasSha: sha.length === 40, number };
});

export const failingJob = ci.job("failing", async () => {
  await $`sh -c ${"echo about to fail; exit 7"}`;
});

export const checkoutJob = ci.job("checkout", async () => {
  await checkout();

  const tracked = await $`cat src/sum.js`.text();
  const uncommitted = await $`cat uncommitted.txt`.nothrow();
  const test = await $`node --test src/sum.test.js`.nothrow();

  return {
    hasSum: tracked.includes("export const sum"),
    uncommitted: uncommitted.stdout.trim(),
    testExit: test.exitCode,
  };
});
