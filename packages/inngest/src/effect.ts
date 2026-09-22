import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { Middleware } from "./components/middleware/middleware.ts";
import { createDeferredPromise } from "./helpers/promises.ts";

/**
 * Effect v4 tools scoped to one SDK execution, not to an entire durable run.
 * Obtain these from `ctx.effect` by installing {@link EffectMiddleware}.
 */
export interface EffectTools {
  /**
   * Run a fully provided Effect as an Inngest handler. Provide Layers and close
   * scopes with `Effect.provide` / `Effect.scoped` before crossing this boundary.
   * Pending fibers are interrupted and their finalizers awaited when Inngest
   * suspends this invocation. Finalizers must not schedule durable steps.
   */
  run<A, E>(
    program: Effect.Effect<A, E>,
    options?: { signal?: AbortSignal },
  ): Promise<A>;

  /**
   * Lazily bridge a native Promise API into Effect without wrapping its error.
   * Use this for native durable tools such as `step.sleep`, `step.invoke`, and
   * `step.waitForEvent`. A registered durable operation cannot be unscheduled by
   * interrupting the waiting Effect.
   */
  promise<A>(
    thunk: (signal: AbortSignal) => PromiseLike<A>,
  ): Effect.Effect<A, unknown>;

  /**
   * Execute an Effect inside a native durable step, inheriting the current
   * Effect services. `register` receives the Promise callback to pass to
   * `step.run` (or `step.ai.wrap`). Both callbacks are lazy; `body` runs only
   * when Inngest executes the step, never when replaying a memoized result.
   *
   * Keeping the native step call explicit preserves its input editing,
   * serialization, middleware transforms, and inferred output type `B`.
   * Terminal/replayed step failures use an `unknown` error channel: serialized
   * errors cannot honestly retain the original Effect error type `E`.
   *
   * @example
   * ```ts
   * const value = yield* effect.step(
   *   (id: string) => loadUser(id),
   *   (run) => step.run("load-user", run, event.data.userId),
   * );
   * ```
   */
  step<Args extends unknown[], A, E, R, B>(
    body: (...args: Args) => Effect.Effect<A, E, R>,
    register: (run: (...args: Args) => Promise<A>) => PromiseLike<B>,
  ): Effect.Effect<B, unknown, R>;
}

/**
 * Opt-in Effect v4 integration. Import from the ESM-only `inngest/effect`
 * entrypoint and add this class to the client's or function's middleware.
 *
 * Use `ctx.effect.run(program)` as the handler's return value. Effect work
 * outside a native durable step is replayed on every invocation. Effect.sleep,
 * retries, and fibers are in-process operations, not durable Inngest steps;
 * use native `step.sleep` / `step.waitForEvent` for durable suspension.
 *
 * This middleware uses only platform-neutral Effect APIs. It does not install
 * a Node/Bun runtime, own application ManagedRuntimes, or require AsyncLocalStorage.
 */
export class EffectMiddleware extends Middleware.BaseMiddleware {
  readonly id = "inngest:effect";

  readonly #fibers = new Set<Fiber.Fiber<unknown, unknown>>();
  readonly #finalizationFailures: unknown[] = [];
  #closed = false;

  readonly #tools: EffectTools = {
    run: (program, options) => this.#run(program, options?.signal),
    promise: (thunk) =>
      Effect.tryPromise({ try: thunk, catch: (error) => error }),
    step: (body, register) =>
      Effect.contextWith((context) => {
        const children = new Set<Fiber.Fiber<unknown, unknown>>();
        return Effect.tryPromise({
          try: (signal) =>
            register((...args) =>
              this.#run(
                Effect.provideContext(
                  Effect.suspend(() => body(...args)),
                  context,
                ),
                signal,
                children,
              ),
            ),
          catch: (error) => error,
        }).pipe(
          // A step callback runs in a separate fiber because Inngest controls
          // when it starts. Join its cleanup before releasing parent services.
          Effect.onInterrupt(() => Fiber.interruptAll(children)),
        );
      }),
  };

  override transformFunctionInput(
    arg: Middleware.TransformFunctionInputArgs,
  ): Middleware.TransformFunctionInputArgs & { ctx: { effect: EffectTools } } {
    return { ...arg, ctx: { ...arg.ctx, effect: this.#tools } };
  }

  override async onExecutionEnd(): Promise<void> {
    this.#closed = true;
    await Effect.runPromise(Fiber.interruptAll(this.#fibers));
    if (this.#finalizationFailures.length > 0) {
      // The lifecycle hook reports cleanup errors without replacing a durable
      // result that has already been selected by the execution engine.
      throw new AggregateError(
        this.#finalizationFailures,
        "Effect finalization failed",
      );
    }
  }

  #run<A, E>(
    program: Effect.Effect<A, E>,
    signal?: AbortSignal,
    children?: Set<Fiber.Fiber<unknown, unknown>>,
  ): Promise<A> {
    if (this.#closed) {
      return Promise.reject(
        new Error("This Inngest execution has already ended"),
      );
    }

    // Effect starts synchronous work before checking RunOptions.signal.
    const fiber = Effect.runFork(signal?.aborted ? Effect.interrupt : program, {
      signal,
    });
    this.#fibers.add(fiber);
    children?.add(fiber);
    // Use the SDK's deferred helper: Promise.withResolvers is not in Node 20.
    const { promise, resolve, reject } = createDeferredPromise<A>();
    fiber.addObserver((exit) => {
      this.#fibers.delete(fiber);
      children?.delete(fiber);
      if (this.#closed) {
        if (Exit.isFailure(exit)) {
          for (const reason of exit.cause.reasons) {
            if (Cause.isFailReason(reason))
              this.#finalizationFailures.push(reason.error);
            else if (Cause.isDieReason(reason))
              this.#finalizationFailures.push(reason.defect);
          }
        }
        // Durable suspension is not a handler failure. Keep the native handler
        // pending, as step tools do, while releasing all fiber resources.
        return;
      }
      if (Exit.isSuccess(exit)) {
        resolve(exit.value);
      } else {
        // Preserve NonRetriableError, RetryAfterError, and replayed StepError
        // identity rather than hiding retry policy behind a wrapper error.
        reject(Cause.squash(exit.cause));
      }
    });
    return promise;
  }
}
