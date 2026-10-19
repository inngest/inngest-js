/**
 * The framework examples, each run against the packed `inngest` package by
 * the same test runner the GitHub workflow uses. The examples are read from
 * the commit being tested, so a new one is picked up without editing CI.
 * Every example runs once, and four of them run again with streaming forced.
 *
 * @module
 */

import { github } from "@inngest/ci";

import { ci } from "../client.ts";
import { pack } from "./base.ts";

const skipped = [
  "framework-hono",
  "framework-nestjs",
  "framework-nextjs-starter",
  "bun-sync",
];

const streaming = [
  "framework-express",
  "framework-nextjs-app-router",
  "framework-remix",
  "node",
];

const listExamples = async (): Promise<string[]> => {
  const entries = await github.rest.repos.getContent({
    path: "examples",
    ref: github.repo().sha,
  });

  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => {
      return entry.type === "dir" && /^(framework-|bun)/.test(entry.name);
    })
    .map((entry) => {
      return entry.name;
    })
    .filter((name) => {
      return !skipped.includes(name);
    });
};

const itests = (id: string, example: string[], force: "" | "force") => {
  return ci.matrix(
    { id, from: pack, axes: { example } },
    async ({ matrix, $from }) => {
      await $from.itest.env({
        EXAMPLE: matrix.example,
        INNGEST_STREAMING: force,
      });
    },
  )();
};

export const examples = async (): Promise<void> => {
  await Promise.all([
    itests("examples", await listExamples(), ""),
    itests("examples-streaming", streaming, "force"),
  ]);
};
