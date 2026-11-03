/**
 * @module
 * Shared setup of the agents type tests: a client, its agents, two event
 * types, and the small type helpers the tests share. It runs nothing.
 */
import { z } from "zod";
import { Inngest } from "../../../components/Inngest.ts";
import type { SandboxTool } from "../../../components/sandbox/tools.ts";
import { eventType } from "../../../components/triggers/triggers.ts";
import { createKv, memoryKvAdapter } from "../kv/kv.ts";
import { createAgents } from "./agents.ts";

export const inngest = new Inngest({ id: "types" });

export const agents = createAgents(inngest, { store: memoryKvAdapter() });

export const kvStore = createKv({ adapter: memoryKvAdapter() });

export const created = eventType("order/created", {
  schema: z.object({ id: z.string(), total: z.number() }),
});

export const closed = eventType("order/closed", {
  schema: z.object({ id: z.string() }),
});

/**
 * Runs nothing: the body only has to compile.
 */
export const typesOnly = (check: () => unknown): void => {
  expect(check).toBeTypeOf("function");
};

/**
 * The keys of `T` (one level) whose type is `any`. `never` means none.
 */
export type AnyMembers<T> = {
  [K in keyof T]-?: 0 extends 1 & T[K] ? K : never;
}[keyof T];

/**
 * What a tool takes, from its declared types.
 */
export type InputOf<T> = T extends SandboxTool<infer TInput, unknown>
  ? TInput
  : never;

/**
 * What a tool gives back, from its declared types.
 */
export type OutputOf<T> = T extends SandboxTool<unknown, infer TOutput>
  ? TOutput
  : never;
