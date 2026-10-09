/**
 * A stand-in for the SDK's experimental trace-span API, for tests that run
 * against an SDK that doesn't have it yet. It does what the real one does
 * where tests can see it: a span opened with `inSpan` is kept in the async
 * context, so a step called inside it is recorded under the span path, and a
 * step's origin is its own `"~origin"` option or the innermost span's. Where
 * the real SDK stamps a step's `opts.span` and `opts.origin` onto the step
 * the executor reports, the stub records them by step ID for `runFunction` to
 * read back. It installs nothing when the SDK has the span API itself.
 *
 * @module
 */

import { group, Middleware } from "inngest";
import type { AsyncContext } from "inngest/experimental";
import { runWithAsyncCtx } from "inngest/experimental";
import type { SpanInfo } from "../pipeline/spans.ts";
import { hasSpanApi } from "../pipeline/spans.ts";

/** What the stub knows about a step: its spans, outermost first, and origin. */
export interface StepStamp {
  span: SpanInfo[];
  origin?: string;
}

/** Where a span stack lives in an async context. Contexts copied by spread keep it. */
const spanStackKey = Symbol("ci.spanStub.spans");

interface SpannedContext extends AsyncContext {
  [spanStackKey]?: SpanInfo[];
}

const stamps = new Map<string, StepStamp>();

let installed = false;

/**
 * The current async context, read synchronously like the real span API does.
 * The SDK keeps its async storage on a global, and only offers an async getter,
 * which would delay every span by a tick and reorder concurrent work.
 */
const currentContext = (): SpannedContext | undefined => {
  const cache = (
    globalThis as Record<
      symbol,
      { resolved?: { getStore: () => AsyncContext | undefined } } | undefined
    >
  )[Symbol.for("inngest:als")];

  return cache?.resolved?.getStore();
};

const spanOf = <R>(span: SpanInfo, fn: () => R): R => {
  const ctx = currentContext();

  if (!ctx) {
    return fn();
  }

  const spans = [...(ctx[spanStackKey] ?? []), span];

  const spanned: SpannedContext = { ...ctx, [spanStackKey]: spans };

  return runWithAsyncCtx(spanned, fn);
};

/** The SDK's own `"~span"`, while `removeSpanStub` has it taken off. */
let hidden: PropertyDescriptor | undefined;

/** Give the SDK's `group` a `"~span"`, unless it already has one. */
export const installSpanStub = (): void => {
  if (hidden) {
    Object.defineProperty(group, "~span", hidden);

    hidden = undefined;

    return;
  }

  if (hasSpanApi()) {
    return;
  }

  Object.defineProperty(group, "~span", {
    value: spanOf,
    configurable: true,
    writable: true,
  });

  installed = true;
};

/**
 * Take the stub off again, so the SDK looks as it does without the span API.
 * An SDK that has the span API itself has it taken off too, until
 * `installSpanStub` puts it back.
 */
export const removeSpanStub = (): void => {
  if (installed) {
    Reflect.deleteProperty(group, "~span");

    installed = false;

    return;
  }

  hidden ??= Object.getOwnPropertyDescriptor(group, "~span");

  Reflect.deleteProperty(group, "~span");
};

/** Whether the stub is what's providing the span API. */
export const spanStubInstalled = (): boolean => {
  return installed;
};

/** What the stub recorded for a step, by the ID CI gave it. */
export const stampOf = (stepId: string): StepStamp | undefined => {
  return stamps.get(stepId);
};

/** Record the step `args` is about to run, from the span stack in effect now. */
const record = (args: unknown[]): void => {
  const first = args[0];

  const options =
    typeof first === "string"
      ? { id: first }
      : (first as { id?: unknown; "~origin"?: unknown } | undefined);

  if (typeof options?.id !== "string") {
    return;
  }

  const span = currentContext()?.[spanStackKey] ?? [];

  const inherited = [...span].reverse().find((entry) => {
    return entry.origin;
  })?.origin;

  const own = (options as { "~origin"?: unknown })["~origin"];

  stamps.set(options.id, {
    span,
    origin: typeof own === "string" ? own : inherited,
  });
};

/**
 * Wrap step tools so every call is recorded. The SDK's middleware hooks don't
 * hand a step's unknown options to middleware, so the calls are watched where
 * they're made.
 */
const recording = <T extends object>(tools: T): T => {
  return new Proxy(tools, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;

      if (typeof value === "function") {
        return (...args: unknown[]) => {
          record(args);

          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }

      if (value && typeof value === "object") {
        return recording(value);
      }

      return value;
    },
  });
};

/** Records each step's span path and origin as it's called. */
export class SpanStubMiddleware extends Middleware.BaseMiddleware {
  readonly id = "ci-span-stub";

  override transformFunctionInput(
    arg: Middleware.TransformFunctionInputArgs,
  ): Middleware.TransformFunctionInputArgs {
    return { ...arg, ctx: { ...arg.ctx, step: recording(arg.ctx.step) } };
  }
}
