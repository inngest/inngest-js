import { $, invalidateEvent } from "@inngest/ci";

import { ci, inngest, trigger } from "../client.ts";

export const cacheBase = ci.job(
  { id: "cache-base", cache: { key: "v1" } },
  async () => {
    await $`echo built cache-base`;
  },
);

export const cacheChild = ci.job(
  { id: "cache-child", from: cacheBase },
  async () => {
    await $`echo cache-child`;
  },
);

/** Run twice: the first run builds `cache-base`, the second reuses it. */
export const cacheBasic = ci.pipeline(
  { id: "cache-basic", on: trigger("cache-basic") },
  async () => {
    await cacheChild();
  },
);

export const maxAgeBase = ci.job(
  { id: "cache-maxage-base", cache: { key: "v1", maxAge: "5m" } },
  async () => {
    await $`echo built cache-maxage-base`;
  },
);

export const maxAgeChild = ci.job(
  { id: "cache-maxage-child", from: maxAgeBase },
  async () => {
    await $`echo cache-maxage-child`;
  },
);

/** Run, run again at once (hit), run again after maxAge (miss). */
export const cacheMaxAge = ci.pipeline(
  { id: "cache-maxage", on: trigger("cache-maxage") },
  async () => {
    await maxAgeChild();
  },
);

/** Sends `ci/base-image.invalidate` for `cache-base`, then lingers so the delete lands. */
export const cacheInvalidate = ci.pipeline(
  { id: "cache-invalidate", on: trigger("cache-invalidate") },
  async () => {
    await inngest.send(invalidateEvent("cache-base"));

    const wait = ci.job("cache-invalidate-wait", async () => {
      await $`sleep 8`;
    });

    await wait();
  },
);

export const uncachedParent = ci.job("uncached-parent", async () => {
  await $`echo uncached-parent`;
});

export const cachedBelowUncached = ci.job(
  { id: "cached-below-uncached", from: uncachedParent, cache: { key: "v1" } },
  async () => {
    await $`echo cached-below-uncached`;
  },
);

/** A cached job below an uncached parent: no named snapshot, and a warning. */
export const cacheUncachedParent = ci.pipeline(
  { id: "cache-uncached-parent", on: trigger("cache-uncached-parent") },
  async () => {
    await cachedBelowUncached();
  },
);
