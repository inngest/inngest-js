import { $ } from "@inngest/ci";

import { ci, trigger } from "../client.ts";

const okFast = ci.job("fail-ok-fast", async () => {
  await $`echo fast`;
});

const okSlow = ci.job("fail-ok-slow", async () => {
  await $`sleep 5`;
  await $`echo slow done`;
});

const boom = ci.job("fail-boom", async () => {
  await $.sh`echo about to fail; exit 3`;
});

/** One job fails: the others still finish, and the pipeline fails. */
export const failJob = ci.pipeline(
  { id: "fail-job", on: trigger("fail-job") },
  async () => {
    await Promise.all([okFast(), okSlow(), boom()]);
  },
);

const failFastMatrix = ci.matrix(
  {
    id: "failfast",
    axes: { n: ["1", "2", "3"] as const },
    failFast: true,
  },
  async ({ n }) => {
    if (n === "1") {
      await $.sh`exit 1`;
    }

    await $`sleep 30`;
  },
);

/** A matrix with `failFast`: combination 1 fails, the others should stop short of 30s. */
export const failFast = ci.pipeline(
  { id: "fail-fast", on: trigger("fail-fast") },
  async () => {
    await failFastMatrix();
  },
);

const cancelBase = ci.job("cancel-base", async () => {
  await $`echo cancel-base`;
});

const cancelChild = ci.job({ id: "cancel-child", from: cancelBase }, async () => {
  await $`sleep 120`;
});

/** Runs for two minutes: cancel it and check cleanup deletes its snapshots and machines. */
export const cancelRunning = ci.pipeline(
  { id: "cancel-running", on: trigger("cancel-running") },
  async () => {
    await cancelChild();
  },
);

const keepBase = ci.job("keep-base", async () => {
  await $`echo keep-base`;
});

const keepJob = ci.job(
  { id: "keep-job", from: keepBase, keepOnFailure: "10m" },
  async () => {
    await $.sh`echo failing on purpose; exit 1`;
  },
);

/** `keepOnFailure`: the failed job's machine snapshot is kept. */
export const keepOnFailure = ci.pipeline(
  { id: "keep-on-failure", on: trigger("keep-on-failure") },
  async () => {
    await keepJob();
  },
);
