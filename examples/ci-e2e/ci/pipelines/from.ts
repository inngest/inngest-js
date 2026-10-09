import { $, type Job } from "@inngest/ci";
import { z } from "zod";

import { ci, trigger } from "../client.ts";

const chainA = ci.job("chain-a", async () => {
  await $.sh`echo a > /tmp/chain`;
});

const chainB = ci.job({ id: "chain-b", from: chainA }, async () => {
  await $.sh`echo b >> /tmp/chain`;
});

const chainC = ci.job({ id: "chain-c", from: chainB }, async () => {
  await $.sh`test "$(wc -l < /tmp/chain)" = 2`;
});

/** Three jobs in a chain: `chain-c` sees what `chain-a` and `chain-b` wrote. */
export const fromChain = ci.pipeline(
  { id: "from-chain", on: trigger("from-chain") },
  async () => {
    await chainC();
  },
);

const diamondTop = ci.job("diamond-top", async () => {
  await $.sh`echo top > /tmp/top`;
});

const diamondLeft = ci.job({ id: "diamond-left", from: diamondTop }, async () => {
  await $`test -f /tmp/top`;
});

const diamondRight = ci.job(
  { id: "diamond-right", from: diamondTop },
  async () => {
    await $`test -f /tmp/top`;
  },
);

/** Two jobs start from one parent: it builds once. */
export const fromDiamond = ci.pipeline(
  { id: "from-diamond", on: trigger("from-diamond") },
  async () => {
    await Promise.all([diamondLeft(), diamondRight()]);
  },
);

const buildTarget = ci.job(
  { id: "build-target", input: z.object({ target: z.enum(["web", "api"]) }) },
  async ({ target }) => {
    await $.sh`echo ${target} > /tmp/target`;
  },
);

const useWeb = ci.job(
  { id: "use-web", from: buildTarget.with({ target: "web" }) },
  async () => {
    await $.sh`test "$(cat /tmp/target)" = web`;
  },
);

const useApi = ci.job(
  { id: "use-api", from: buildTarget.with({ target: "api" }) },
  async () => {
    await $.sh`test "$(cat /tmp/target)" = api`;
  },
);

/** `.with(input)`: one build per distinct input. */
export const fromWithInput = ci.pipeline(
  { id: "from-with-input", on: trigger("from-with-input") },
  async () => {
    await Promise.all([useWeb(), useApi()]);
  },
);

const matrixTarget = ci.matrix(
  {
    id: "matrix-target",
    axes: { target: ["web", "api"] as const },
    from: ({ input }) => {
      return buildTarget.with({ target: input.target });
    },
  },
  async ({ target }) => {
    await $.sh`test "$(cat /tmp/target)" = ${target}`;
  },
);

/** A matrix whose `from` is chosen by the combination. */
export const fromMatrix = ci.pipeline(
  { id: "from-matrix", on: trigger("from-matrix") },
  async () => {
    await matrixTarget();
  },
);

const cycleA: Job = ci.job({ id: "cycle-a", from: () => cycleB }, async () => {
  await $`echo a`;
});

const cycleB: Job = ci.job({ id: "cycle-b", from: cycleA }, async () => {
  await $`echo b`;
});

/** A cycle: expect a fast CiUsageError naming the cycle, never a hang. */
export const fromCycle = ci.pipeline(
  { id: "from-cycle", on: trigger("from-cycle") },
  async () => {
    await cycleB();
  },
);
