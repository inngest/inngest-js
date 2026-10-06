import { changed, github } from "@inngest/ci";

import { ci } from "./client.ts";
import {
  cachedReader,
  checkoutJob,
  commandsJob,
  childA,
  childB,
  failingJob,
  matrix,
  noMachineJob,
  pauseJob,
  retriesJob,
  servicesJob,
  timeoutJob,
  twoMachinesJob,
} from "./jobs.ts";

function on(id: string) {
  return github.pullRequest({ repo: `e2e/${id}` });
}

export const pipelines = [
  ci.pipeline({ id: "e2e-commands", on: on("commands") }, () => {
    return commandsJob();
  }),
  ci.pipeline({ id: "e2e-timeout", on: on("timeout") }, () => {
    return timeoutJob();
  }),
  ci.pipeline({ id: "e2e-retries", on: on("retries") }, () => {
    return retriesJob();
  }),
  ci.pipeline({ id: "e2e-from", on: on("from") }, async () => {
    const [a, b] = await Promise.all([childA(), childB()]);
    return { a, b };
  }),
  ci.pipeline({ id: "e2e-services", on: on("services") }, () => {
    return servicesJob();
  }),
  ci.pipeline({ id: "e2e-two-machines", on: on("two-machines") }, () => {
    return twoMachinesJob();
  }),
  ci.pipeline({ id: "e2e-matrix", on: on("matrix") }, async () => {
    const all = await matrix();
    const one = await matrix({ os: "a", size: "l" });
    return { all, one };
  }),
  ci.pipeline({ id: "e2e-changed", on: on("changed") }, async () => {
    const src = await changed("src/**");
    const docs = await changed("docs/**");

    const ignoringSrc = await changed({
      ignore: ["src/**", "uncommitted.txt"],
    });

    if (!docs) {
      return ci.skip(`src=${src} ignoringSrc=${ignoringSrc}`);
    }

    return { unexpected: "docs changed" };
  }),
  ci.pipeline({ id: "e2e-cache", on: on("cache") }, () => {
    return cachedReader();
  }),
  ci.pipeline({ id: "e2e-pause", on: on("pause") }, () => {
    return pauseJob();
  }),
  ci.pipeline({ id: "e2e-no-machine", on: on("no-machine") }, () => {
    return noMachineJob();
  }),
  ci.pipeline(
    {
      id: "e2e-failure",
      on: on("failure"),
      retries: 0,
    },
    () => {
      return failingJob();
    },
  ),
  ci.pipeline({ id: "e2e-checkout", on: on("checkout") }, () => {
    return checkoutJob();
  }),
];
