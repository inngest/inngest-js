import { getAsyncCtx } from "../execution/als.ts";
import { CiUsageError } from "./errors.ts";
import { getJobScope, getRunScope, nextStepId } from "./scope.ts";

export type DurableBehaviour = "step" | "direct" | "unsupported";

/**
 * Reading this property off a durable proxy returns the property path it
 * stands for, rather than another proxy.
 */
export const durablePathKey = "__durablePath";

/**
 * The property path a durable proxy stands for, or `undefined` if the value
 * isn't one.
 */
export const durablePath = (value: unknown): string[] | undefined => {
  const path = (value as Record<string, unknown> | undefined)?.[durablePathKey];
  return Array.isArray(path) ? (path as string[]) : undefined;
};

export interface DurableOptions {
  /** Step ID prefix, like "github". */
  name: string;

  /**
   * Patterns matched in order against the dotted property path. `*` matches one
   * segment. The first match wins. Unmatched paths default to "direct".
   */
  rules: Array<[pattern: string, behaviour: DurableBehaviour]>;

  /** Transform arguments before the call, like adding defaults. */
  args?: (args: unknown[], ctx: { path: string[] }) => unknown[];

  /**
   * Transform arguments once the method is resolved, for defaults that depend
   * on the method itself. Runs inside the step, after the client is built.
   */
  argsWithMethod?: (
    args: unknown[],
    ctx: { path: string[]; method: unknown },
  ) => unknown[];

  /** Transform each result before it's returned and memoized, like picking `data`. */
  result?: (value: unknown, ctx: { path: string[] }) => unknown;

  /** Map errors to Inngest errors. Return a falsy value to rethrow the original. */
  onError?: (
    error: unknown,
    ctx: { path: string[] },
    // biome-ignore lint/suspicious/noConfusingVoidType: a handler that maps nothing can just return
  ) => Error | undefined | null | false | void;

  /** The message thrown for `unsupported` paths. */
  unsupportedMessage?: (path: string[]) => string;

  // biome-ignore lint/suspicious/noExplicitAny: any logger-ish
  logger?: { warn: (...args: any[]) => void };
}

interface CallOverrides {
  id?: string;
  name?: string;
}

/**
 * Counters for executions that aren't inside a CI run scope, so repeated calls
 * to the same method still get unique step IDs.
 */
const looseCounters = new WeakMap<object, Map<string, number>>();

const warnedDirect = new Set<string>();

/**
 * Wrap an SDK client so the methods its rules select run as steps.
 *
 * Wrapping every method of an arbitrary SDK would be wrong: SDKs mix network
 * calls, local helpers, streams, and methods that return other clients, and a
 * proxy can't tell them apart before calling. So rules are required, and
 * anything unmatched is called directly.
 *
 * This is internal. `github.rest` is built on it, and it's kept generic so
 * other built-in clients could use it later.
 */
export function durable<TShape>(
  client: object | (() => Promise<object>),
  options: DurableOptions,
): TShape {
  return makeProxy([], {}, client, options) as TShape;
}

const makeProxy = (
  path: string[],
  overrides: CallOverrides,
  client: object | (() => Promise<object>),
  options: DurableOptions,
): unknown => {
  // The target is a function so the proxy is callable at any depth.
  const target = () => undefined;

  return new Proxy(target, {
    get(_target, prop) {
      // Never let a proxy be mistaken for a promise.
      if (prop === "then") {
        return undefined;
      }

      if (typeof prop === "symbol") {
        return undefined;
      }

      // Lets helpers like `github.paginate()` find which method they were
      // handed without calling it.
      if (prop === durablePathKey) {
        return path;
      }

      // `.with()` is reserved on the root proxy. It sets the ID for the next
      // call without advancing the counter.
      if (prop === "with" && path.length === 0) {
        return (opts: CallOverrides) => makeProxy([], opts, client, options);
      }

      return makeProxy([...path, prop], overrides, client, options);
    },

    apply(_target, _thisArg, args: unknown[]) {
      return call(path, overrides, client, options, args);
    },
  });
};

const call = async (
  path: string[],
  overrides: CallOverrides,
  client: object | (() => Promise<object>),
  options: DurableOptions,
  rawArgs: unknown[],
): Promise<unknown> => {
  const behaviour = behaviourFor(path, options.rules);

  if (behaviour === "unsupported") {
    throw new CiUsageError(
      options.unsupportedMessage?.(path) ??
        `\`${options.name}.${path.join(".")}\` can't run as a step. Call it inside \`step.run\` with the underlying client.`,
    );
  }

  const args = options.args?.(rawArgs, { path }) ?? rawArgs;
  const invoke = () => invokeOnClient(client, path, args, options);

  const asyncCtx = await getAsyncCtx();
  const execution = asyncCtx?.execution;

  if (behaviour === "direct" || !execution || execution.executingStep) {
    if (behaviour === "direct" && execution && !execution.executingStep) {
      warnDirect(path, options);
    }
    return invoke();
  }

  const label = `${options.name}.${path.join(".")}`;
  const id = overrides.id
    ? scopedId(overrides.id)
    : stepIdFor(label, options, execution.instance);

  return execution.ctx.step.run({ id, name: overrides.name ?? label }, invoke);
};

const invokeOnClient = async (
  client: object | (() => Promise<object>),
  path: string[],
  args: unknown[],
  options: DurableOptions,
): Promise<unknown> => {
  // The client may be lazy, so the real client and its credentials are only
  // created inside the step.
  const resolved =
    typeof client === "function"
      ? await (client as () => Promise<object>)()
      : client;

  let owner: object = resolved;
  let value: unknown = resolved;

  for (const segment of path) {
    owner = value as object;
    value = (owner as Record<string, unknown>)[segment];
  }

  if (typeof value !== "function") {
    throw new CiUsageError(
      `\`${options.name}.${path.join(".")}\` isn't a method on this client.`,
    );
  }

  const finalArgs =
    options.argsWithMethod?.(args, { path, method: value }) ?? args;

  try {
    const result = await (value as (...a: unknown[]) => unknown).apply(
      owner,
      finalArgs,
    );
    return options.result ? options.result(result, { path }) : result;
  } catch (error) {
    const mapped = options.onError?.(error, { path });
    if (mapped) {
      throw mapped;
    }
    throw error;
  }
};

/**
 * Match a dotted path against rules in order, where `*` matches one segment.
 * The first match wins, and anything unmatched is "direct".
 */
export const behaviourFor = (
  path: string[],
  rules: Array<[string, DurableBehaviour]>,
): DurableBehaviour => {
  for (const [pattern, behaviour] of rules) {
    if (matchesPattern(path, pattern)) {
      return behaviour;
    }
  }
  return "direct";
};

const matchesPattern = (path: string[], pattern: string): boolean => {
  const segments = pattern.split(".");
  if (segments.length !== path.length) {
    return false;
  }
  return segments.every(
    (segment, index) => segment === "*" || segment === path[index],
  );
};

const stepIdFor = (
  label: string,
  options: DurableOptions,
  execution: object,
): string => {
  const run = getRunScope();
  if (run) {
    return nextStepId(run, getJobScope()?.path, label);
  }

  let counters = looseCounters.get(execution);
  if (!counters) {
    counters = new Map();
    looseCounters.set(execution, counters);
  }

  const seen = (counters.get(label) ?? 0) + 1;
  counters.set(label, seen);
  return seen === 1 ? label : `${label} #${seen}`;
};

const scopedId = (id: string): string => {
  const job = getJobScope();
  return job ? `${job.path} › ${id}` : id;
};

const warnDirect = (path: string[], options: DurableOptions): void => {
  const key = `${options.name}.${path.join(".")}`;
  if (warnedDirect.has(key)) {
    return;
  }
  warnedDirect.add(key);
  (options.logger ?? console).warn(
    { path: key },
    `\`${key}()\` ran outside a step.`,
  );
};

/**
 * Only for tests: forget which direct-call warnings have been emitted.
 */
export const resetDurableWarnings = (): void => {
  warnedDirect.clear();
};
