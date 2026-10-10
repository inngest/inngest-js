/**
 * The one place CI touches the SDK's experimental trace-span API. The span
 * API ships in newer SDKs than the oldest one CI supports, so it's
 * feature-detected here: where the SDK has it, spans and origins mark up the
 * trace, and where it doesn't, `inSpan` just runs the function and the origin
 * step option is an unknown key the SDK ignores. Step IDs and names never
 * depend on it. Everything else in CI goes through these helpers rather than
 * reaching for the SDK's span API itself.
 *
 * @module
 */

import { group, version as sdkVersion } from "inngest";

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

/** The part of the SDK's `group` this file uses, when the SDK has it. */
interface SpanApi {
  "~span"?: <R>(span: SpanInfo, fn: () => R) => R;
}

const spanApi = (): SpanApi => {
  return group as unknown as SpanApi;
};

/** Whether the SDK in use has the span API. */
export const hasSpanApi = (): boolean => {
  return typeof spanApi()["~span"] === "function";
};

/**
 * Run `fn` in a trace span, or just run it when the SDK has no span API.
 */
export const inSpan = <R>(
  /** The span to run `fn` in. */
  span: SpanInfo,
  /** What to run. */
  fn: () => R,
): R => {
  const api = spanApi();
  const open = api["~span"];

  if (typeof open !== "function") {
    return fn();
  }

  return open.call(api, span, fn) as R;
};

/**
 * The step option that marks a step as work `origin` did. A step option is
 * just a key on the options object, and an SDK without the span API ignores
 * it, so it's safe to always pass.
 */
export const originOption = (
  /** Who did the work. */
  origin: string,
): { "~origin": string } => {
  return { "~origin": origin };
};

/** The first SDK whose snapshot takes a caller's `"~span"` as its own span. */
const snapshotSpanSince = "4.23.1";

/** Whether `version` is `since` or later, as in `4.23.1`. */
export const versionAtLeast = (version: string, since: string): boolean => {
  const have = version.split(/[.-]/).map(Number);

  for (const [index, want] of since.split(".").map(Number).entries()) {
    const got = have[index] ?? 0;

    if (got !== want) {
      return got > want;
    }
  }

  return true;
};

/**
 * What the SDK in use can do beyond the span API. Older SDKs ignore the step
 * options they don't know, so each is detected here rather than assumed.
 */
export const sdk = {
  /**
   * Whether a snapshot step's `"~span"` option stands in for the span the SDK
   * would open around its create and wait. Older SDKs ignore the option and
   * open their own, which then sits inside the span CI opens.
   */
  takesSnapshotSpan: (): boolean => {
    return versionAtLeast(sdkVersion, snapshotSpanSince);
  },
};

/**
 * The step option that makes a snapshot one statement in `span`, where the
 * SDK takes one. Elsewhere there is none, and `inSnapshotSpan` opens it.
 */
export const snapshotSpanOption = (span: SpanInfo): { "~span"?: SpanInfo } => {
  return sdk.takesSnapshotSpan() ? { "~span": span } : {};
};

/** Run `fn`, which takes snapshots, in `span` unless the SDK does it itself. */
export const inSnapshotSpan = <R>(span: SpanInfo, fn: () => R): R => {
  return sdk.takesSnapshotSpan() ? fn() : inSpan(span, fn);
};
