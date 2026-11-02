/**
 * @module
 * EXPERIMENTAL: the fields of an agent that are read at run time. Each takes a
 * value, or a pure, possibly async function of `{ event, thread }` that is
 * evaluated once per run, at its start. The function re-runs when the run
 * replays, so it must have no side effects; it may read `kv`, which runs as
 * memoized steps.
 */

import { type DurationInput, durationToMs } from "../../../helpers/duration.ts";

/**
 * What a run-time field's function receives: the event that started the run
 * and the thread's key. The thread is never a handle, so the function stays
 * free of side effects.
 */
export interface RunFieldContext<TEvent = unknown> {
  /**
   * The event that started the run. Deliberate unknown as the default: a field
   * written without a type gets an event only its reader can check.
   */
  event: TEvent;

  /**
   * The thread the run belongs to.
   */
  thread: { key: string };
}

/**
 * A run-time field: a value, or a function of the run's start returning it. A
 * `T` that is itself a function can't be used as a value, since a function is
 * always called.
 */
export type RunField<T, TContext = RunFieldContext> =
  | T
  | ((context: TContext) => T | Promise<T>);

/**
 * Resolves a run-time field: calls it with `context` if it is a function,
 * passes anything else through.
 * @param field The value or function.
 * @param context What the function receives.
 */
export const resolveRunField = async <T, TContext>(
  field: RunField<T, TContext>,
  context: TContext,
): Promise<T> => {
  if (typeof field === "function") {
    return await (field as (context: TContext) => T | Promise<T>)(context);
  }

  return field;
};

/**
 * The run-time fields of one run. A field's function runs once, the first
 * time the field is read, and every later read gets the same result.
 */
export interface RunFields<TContext = RunFieldContext> {
  /**
   * What the fields' functions receive.
   */
  context: TContext;

  get: <T>(name: string, field: RunField<T, TContext>) => Promise<T>;
}

/**
 * Makes the run-time fields of one run.
 * @param context The run's start: its event and thread.
 */
export const createRunFields = <TContext>(
  context: TContext,
): RunFields<TContext> => {
  const resolved = new Map<string, Promise<unknown>>();

  return {
    context,
    get: <T>(name: string, field: RunField<T, TContext>) => {
      const known = resolved.get(name);

      if (known) {
        return known as Promise<T>;
      }

      const made = resolveRunField(field, context);

      resolved.set(name, made);

      return made;
    },
  };
};

/**
 * How long a run waits in quiet before it ends, when the agent sets no `idle`:
 * 10 minutes.
 */
export const defaultIdle = 600_000;

/**
 * The `idle` of a run in milliseconds. `0` means the run never waits.
 * @param fields The run's fields.
 * @param idle The agent's `idle`: a duration, or a function returning one.
 */
export const idleMs = async <TContext>(
  fields: RunFields<TContext>,
  idle: RunField<DurationInput, TContext> | undefined,
): Promise<number> => {
  if (idle === undefined) {
    return defaultIdle;
  }

  const duration = await fields.get("idle", idle);

  // Zero is allowed here (a run opened through a handle never waits), though
  // a duration must be positive everywhere else.
  return duration === 0 ? 0 : durationToMs(duration, { name: "idle" });
};
