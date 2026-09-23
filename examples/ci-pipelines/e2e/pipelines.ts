/**
 * End-to-end cases for `inngest/ci`, run against real sandboxes through the
 * Dev Server's Cloud sandbox bridge.
 *
 * Each case is its own pipeline, triggered by a pull request event for the
 * repository `e2e/<case>`, so one event runs exactly one case. The pipeline
 * returns what it saw, and `run.ts` checks it.
 */

import { Inngest, step } from "inngest";
import {
  $,
  CommandFailedError,
  CommandTimeoutError,
  changed,
  checkout,
  createCi,
  files,
  from,
  github,
  memoryCacheStore,
  report,
  sandbox,
  waitForHttp,
  waitForPort,
} from "inngest/ci";

export const inngest = new Inngest({ id: "ci-e2e" });

export const ci = createCi(inngest, { cacheStore: memoryCacheStore() });

const on = (id: string) => github.pullRequest({ repo: `e2e/${id}` });

const errorName = (error: unknown) =>
  error instanceof Error ? error.name : String(error);

/**
 * `$`: output helpers, interpolation, env, cwd, `$.sh`, nothrow, failures,
 * and secret masking — the command builder end to end on one machine.
 */
const commandsJob = ci.job("commands", async () => {
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
  const secret = await $`sh -c ${"echo token=$TOKEN"}`
    .withSecret("TOKEN", "s3cr3t-value")
    .text();
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

ci.pipeline({ id: "e2e-commands", on: on("commands") }, () => commandsJob());

/**
 * `.timeout()` on both paths: a short one runs as a captured exec, a longer
 * one as a polled process.
 */
const timeoutJob = ci.job("timeout", async () => {
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

ci.pipeline({ id: "e2e-timeout", on: on("timeout") }, () => timeoutJob());

/**
 * `.retries()`: fails the first time (no marker file yet), passes the second.
 */
const retriesJob = ci.job("retries", async () => {
  const result = await $.sh`
    if [ -f /tmp/attempted ]; then echo second; else touch /tmp/attempted; exit 1; fi
  `.retries(1);

  return { stdout: result.stdout.trim(), exitCode: result.exitCode };
});

ci.pipeline({ id: "e2e-retries", on: on("retries") }, () => retriesJob());

/**
 * `from()`: a copy of setup's machine, with setup's return value, and two
 * children that can't see each other's changes.
 */
const setupJob = ci.job("setup", async () => {
  await checkout();
  await $.sh`echo from-setup > /work/marker`;
  return { built: "yes" };
});

const childA = ci.job("child-a", async () => {
  const parent = await from(setupJob);
  const marker = await $`cat /work/marker`.text();
  await $.sh`echo a > /work/only-a`;
  return { parent, marker };
});

const childB = ci.job("child-b", async () => {
  await from(setupJob);
  const marker = await $`cat /work/marker`.text();
  const seesA = await $`test -f /work/only-a`.nothrow();
  return { marker, seesA: seesA.exitCode === 0 };
});

ci.pipeline({ id: "e2e-from", on: on("from") }, async () => {
  const [a, b] = await Promise.all([childA(), childB()]);
  return { a, b };
});

/**
 * `.background()` + `waitForHttp` + `waitForPort` on the job's machine, and
 * the background process handle.
 */
const servicesJob = ci.job("services", async () => {
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

ci.pipeline({ id: "e2e-services", on: on("services") }, () => servicesJob());

/**
 * `sandbox()`: a second machine alongside the job's own.
 */
const twoMachinesJob = ci.job("two-machines", async () => {
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

ci.pipeline({ id: "e2e-two-machines", on: on("two-machines") }, () =>
  twoMachinesJob(),
);

/**
 * `ci.matrix`: every combination minus exclusions, each on its own machine.
 */
const matrix = ci.matrix(
  {
    id: "matrix",
    axes: { os: ["a", "b"], size: ["s", "l"] },
    exclude: [{ os: "b", size: "l" }],
  },
  async ({ os, size }) => {
    return $`sh -c ${"echo $OS-$SIZE"}`.env({ OS: os, SIZE: size }).text();
  },
);

ci.pipeline({ id: "e2e-matrix", on: on("matrix") }, async () => {
  const all = await matrix();
  const one = await matrix({ os: "a", size: "l" });
  return { all, one };
});

/**
 * `changed()` against the fixture's base branch, and `ci.skip()`.
 */
ci.pipeline({ id: "e2e-changed", on: on("changed") }, async () => {
  const src = await changed("src/**");
  const docs = await changed("docs/**");
  const ignoringSrc = await changed({ ignore: ["src/**", "uncommitted.txt"] });

  if (!docs) {
    return ci.skip(`src=${src} ignoringSrc=${ignoringSrc}`);
  }

  return { unexpected: "docs changed" };
});

/**
 * Cache: the first run builds, a second run with the same key is restored
 * without a machine. The store is in memory, so both runs must hit the same
 * app process — `run.ts` sends them back to back.
 */
const cachedJob = ci.job(
  { id: "cached", cache: { key: [files("package.json"), "v1"] } },
  async () => {
    await checkout();
    const stamp = await $`date +%s%N`.text();
    return { stamp };
  },
);

ci.pipeline({ id: "e2e-cache", on: on("cache") }, () => cachedJob());

/**
 * A durable wait inside a job: the machine is paused while it waits, and the
 * commands either side still share a filesystem.
 */
const pauseJob = ci.job("pause", async () => {
  await $.sh`echo before > /tmp/state`;

  const approval = await step.waitForEvent("approval", {
    event: "ci-e2e/approved",
    timeout: "10s",
  });

  const state = await $`cat /tmp/state`.text();
  return { approved: Boolean(approval), state };
});

ci.pipeline({ id: "e2e-pause", on: on("pause") }, () => pauseJob());

/**
 * A job that never runs a command, and a step inside a job.
 */
const noMachineJob = ci.job("no-machine", async () => {
  const value = await step.run("compute", () => 21 * 2);
  const { owner, repo, sha, number } = github.repo();
  await report.summary(`computed ${value}`);
  return { value, owner, repo, hasSha: sha.length === 40, number };
});

ci.pipeline({ id: "e2e-no-machine", on: on("no-machine") }, () =>
  noMachineJob(),
);

/**
 * A failing command that isn't caught fails the job and the pipeline.
 */
const failingJob = ci.job("failing", async () => {
  await $`sh -c ${"echo about to fail; exit 7"}`;
});

// No retries, so the run fails straight away rather than after backoff.
ci.pipeline({ id: "e2e-failure", on: on("failure"), retries: 0 }, () =>
  failingJob(),
);

/**
 * `checkout()` of the local working tree, including an uncommitted file.
 */
const checkoutJob = ci.job("checkout", async () => {
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

ci.pipeline({ id: "e2e-checkout", on: on("checkout") }, () => checkoutJob());
