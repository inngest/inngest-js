/**
 * The framework examples, each run against the packed `inngest` package by
 * the same test runner the GitHub workflow uses. The examples are read from
 * the commit being tested, so a new one is picked up without editing CI, and
 * each runs as a child run of its own. Four run again with streaming forced.
 *
 * @module
 */

import { checkout, github } from "@inngest/ci";

import { ci } from "../client.ts";
import { pack } from "./base.ts";

const skipped = new Set([
  "framework-hono",
  "framework-nextjs-starter",
  "bun-sync",
]);

/** Like `examples/.inngestignore`, which GitHub matches as a substring, so it skips `framework-nestjs-fastify` too. */
const ignored = ["framework-nestjs"];

export const examples = ci.job(
  {
    id: "examples",
    from: pack,
    matrix: {
      axes: async ({ repo }) => {
        const entries = await github.rest.repos.getContent({
          path: "examples",
          ref: repo?.sha ?? "",
        });

        return {
          example: (Array.isArray(entries) ? entries : [])
            .filter((entry) => {
              return (
                entry.type === "dir" && /^(framework-|bun)/.test(entry.name)
              );
            })
            .map((entry) => {
              return entry.name;
            })
            .filter((name) => {
              return (
                !skipped.has(name) &&
                !ignored.some((part) => {
                  return name.includes(part);
                })
              );
            }),
        };
      },
    },
  },
  async ({ matrix, from }) => {
    await checkout();

    await from.$.itest.env({ EXAMPLE: matrix.example });
  },
);

export const examplesStreaming = ci.job(
  {
    id: "examples-streaming",
    from: pack,
    matrix: {
      axes: {
        example: [
          "framework-express",
          "framework-nextjs-app-router",
          "framework-remix",
          "node",
        ],
      },
    },
  },
  async ({ matrix, from }) => {
    await checkout();

    await from.$.itest.env({
      EXAMPLE: matrix.example,
      INNGEST_STREAMING: "force",
    });
  },
);
