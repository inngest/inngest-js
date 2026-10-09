import { $ } from "@inngest/ci";
import { Temporal } from "temporal-polyfill";

import { ci, trigger } from "../client.ts";

const cached = (id: string, maxAge: number | string | Temporal.Duration) => {
  return ci.job({ id, cache: { key: "v1", maxAge } }, async () => {
    await $`echo ${id}`;
  });
};

/** Timeouts and cache `maxAge` as a number, an `ms` string and a `Temporal.Duration`. */
export const durations = ci.pipeline(
  { id: "durations", on: trigger("durations") },
  async () => {
    const asNumber = cached("dur-number", 3_600_000);
    const asString = cached("dur-string", "1h");
    const asTemporal = cached("dur-temporal", Temporal.Duration.from({ hours: 1 }));

    await asNumber();
    await asString();
    await asTemporal();

    const timeouts = ci.job("dur-timeouts", async () => {
      await $`sleep 1`.timeout(30_000);
      await $`sleep 1`.timeout("30s");
      await $`sleep 1`.timeout(Temporal.Duration.from({ seconds: 30 }));
    });

    await timeouts();
  },
);

/** A timeout that is too short for the command: expect CommandTimeoutError. */
export const durationTimeout = ci.pipeline(
  { id: "duration-timeout", on: trigger("duration-timeout") },
  async () => {
    const slow = ci.job("dur-slow", async () => {
      await $`sleep 20`.timeout(Temporal.Duration.from({ seconds: 3 }));
    });

    await slow();
  },
);
