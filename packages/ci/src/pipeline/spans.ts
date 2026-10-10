/**
 * The one place CI touches the SDK's experimental trace-span API: spans group
 * the steps run inside them in the trace, and an origin marks work as CI's.
 * Step IDs and names never depend on either. Everything else in CI goes
 * through these helpers rather than reaching for the SDK's span API itself.
 *
 * @module
 */

import { group } from "inngest";

/** What a span stands for. Every span CI opens has one. */
export type SpanKind =
  | "job"
  | "sandbox"
  | "command"
  | "snapshot"
  | "github"
  | "attempt";

/** A trace span, as the SDK's span API takes it. */
export interface SpanInfo {
  /** The span's stable ID, from which its rows are grouped. */
  id: string;
  /** What the span is called in the trace. */
  name: string;
  /** What kind of span it is. */
  kind: SpanKind;
  /** Who did the work in it, inherited by the steps and spans inside. */
  origin?: string;
}

/** Run `fn` in a trace span. */
export const inSpan = <R>(
  /** The span to run `fn` in. */
  span: SpanInfo,
  /** What to run. */
  fn: () => R,
): R => {
  return group["~span"](span, fn);
};

/** The step option that marks a step as work `origin` did. */
export const originOption = (
  /** Who did the work. */
  origin: string,
): { "~origin": string } => {
  return { "~origin": origin };
};
