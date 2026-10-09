import { $ } from "@inngest/ci";

import { ci, trigger } from "../client.ts";

/** A job defined inside the pipeline, and a child that starts from it. */
export const inlineParentChild = ci.pipeline(
  { id: "inline-parent-child", on: trigger("inline-parent-child") },
  async () => {
    const parent = ci.job("inline-parent", async () => {
      await $.sh`echo parent > /tmp/parent`;
    });

    const child = ci.job({ id: "inline-child", from: parent }, async () => {
      await $`test -f /tmp/parent`;
    });

    await child();
  },
);

/** An inline cached job: run twice, the second run finds it by name. */
export const inlineCached = ci.pipeline(
  { id: "inline-cached", on: trigger("inline-cached") },
  async () => {
    const base = ci.job(
      { id: "inline-cached-base", cache: { key: "v1" } },
      async () => {
        await $`echo built inline-cached-base`;
      },
    );

    const child = ci.job(
      { id: "inline-cached-child", from: base },
      async () => {
        await $`echo inline-cached-child`;
      },
    );

    await child();
  },
);

/** One inline job per item, in a loop. */
export const inlineFactory = ci.pipeline(
  { id: "inline-factory", on: trigger("inline-factory") },
  async () => {
    const items = ["one", "two", "three"];

    const jobs = items.map((item) => {
      return ci.job(`inline-item-${item}`, async () => {
        await $`echo ${item}`;
      });
    });

    await Promise.all(
      jobs.map((job) => {
        return job();
      }),
    );
  },
);

/** Two inline jobs with the same ID: expect a CiUsageError. */
export const inlineDuplicateId = ci.pipeline(
  { id: "inline-duplicate-id", on: trigger("inline-duplicate-id") },
  async () => {
    const first = ci.job("inline-dup", async () => {
      await $`echo first`;
    });

    ci.job("inline-dup", async () => {
      await $`echo second`;
    });

    await first();
  },
);
