import { $ } from "@inngest/ci";
import { z } from "zod";

import { ci, trigger } from "../client.ts";

const normalised = ci.job(
  {
    id: "norm-base",
    cache: { key: "v1" },
    input: z.object({ name: z.string().trim().toLowerCase() }),
  },
  async ({ name }) => {
    await $`echo ${name}`;
  },
);

const useA = ci.job(
  { id: "norm-a", from: normalised.with({ name: "  AbC " }) },
  async () => {
    await $`echo a`;
  },
);

const useB = ci.job(
  { id: "norm-b", from: normalised.with({ name: "abc" }) },
  async () => {
    await $`echo b`;
  },
);

/** A normalising schema: both spellings share one cache key, so one build. */
export const inputsNormalise = ci.pipeline(
  { id: "inputs-normalise", on: trigger("inputs-normalise") },
  async () => {
    await useA();
    await useB();
  },
);

const dated = ci.job(
  {
    id: "json-date",
    cache: { key: "v1" },
    input: z.object({ at: z.string().transform((value) => new Date(value)) }),
  },
  async () => {
    await $`echo date`;
  },
);

const useDated = ci.job(
  { id: "json-date-child", from: dated.with({ at: "2026-01-01" as never }) },
  async () => {
    await $`echo child`;
  },
);

/** A schema whose output isn't JSON (a `Date`): expect a clear error. */
export const inputsJsonOnly = ci.pipeline(
  { id: "inputs-json-only", on: trigger("inputs-json-only") },
  async () => {
    await useDated();
  },
);
