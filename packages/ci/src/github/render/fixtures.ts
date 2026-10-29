/**
 * Data the render tests share: the mockups' pull request and pipeline.
 *
 * @module
 */

import type { GraphJob } from "./graph.ts";
import type { CheckLinks } from "./types.ts";

export const links: CheckLinks = {
  run: "https://app.inngest.com/env/dogfood/runs/RUN",
  step: "https://app.inngest.com/env/dogfood/runs/RUN?step=s",
  commit: { sha: "5fed4bf", url: "https://github.com/o/r/commit/5fed4bf" },
  pullRequest: { number: 1819, url: "https://github.com/o/r/pull/1819" },
};

const s = 1000;

export const passedJobs: GraphJob[] = [
  {
    id: "build",
    name: "build",
    parents: [],
    startMs: 0,
    endMs: 3 * s,
    state: "cached",
    savedMs: 247 * s,
  },
  {
    id: "lint",
    name: "lint",
    parents: ["build"],
    startMs: 3 * s,
    endMs: 31 * s,
    state: "ok",
  },
  {
    id: "audit",
    name: "audit",
    parents: ["build"],
    startMs: 3 * s,
    endMs: 142 * s,
    state: "ok",
  },
  {
    id: "pkgs",
    name: "packages build",
    parents: ["build"],
    startMs: 3 * s,
    endMs: 6 * s,
    state: "cached",
    savedMs: 212 * s,
  },
  {
    id: "ms",
    name: "middleware-sentry",
    parents: ["pkgs"],
    startMs: 6 * s,
    endMs: 163 * s,
    state: "ok",
  },
  {
    id: "exb",
    name: "examples build",
    parents: ["build"],
    startMs: 3 * s,
    endMs: 6 * s,
    state: "cached",
    savedMs: 221 * s,
  },
  {
    id: "ex",
    name: "examples (nextjs)",
    parents: ["exb"],
    startMs: 6 * s,
    endMs: 408 * s,
    state: "ok",
  },
];
