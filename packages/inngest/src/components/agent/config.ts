/**
 * @module
 * EXPERIMENTAL: The one helper every agent config field goes through. A field
 * is a plain value or a function of the run's context (trigger, input, state),
 * sync or async, and each field is resolved eagerly (together with the other
 * eager fields, in parallel) or lazily on first use.
 *
 * Resolver functions are not memoized as a step. They re-run on every replay,
 * so they must be a pure function of the context. A lookup belongs in a
 * `step.run` inside the function, which returns a plain choice (an ID, a name,
 * a number), never a model wrapper, a sandbox or a channel adapter.
 */

/**
 * A config field: a value, or a function of `Ctx` returning it. A `T` that is
 * itself a function can't be used as a value, since a function is always
 * called.
 */
export type ConfigValue<T, Ctx> = T | ((ctx: Ctx) => T | Promise<T>);

/**
 * What a config field resolves to: the value, or what its function returns.
 */
export type ResolvedConfigValue<V> = V extends (...args: never[]) => infer R
  ? Awaited<R>
  : V;

/**
 * When a field is resolved. `"eager"` fields resolve together, in parallel,
 * when `ready()` is called. `"lazy"` fields resolve the first time they are
 * read, and never if nothing reads them.
 */
export type ConfigMode = "eager" | "lazy";

/**
 * One mode per config field, so a new field can't skip the decision.
 */
export type ConfigModes<Config> = { [K in keyof Config]-?: ConfigMode };

/**
 * A config with every field resolved.
 */
export type ResolvedConfig<Config> = {
  [K in keyof Config]: ResolvedConfigValue<Config[K]>;
};

type EagerKeys<Config, Modes> = {
  [K in keyof Config & keyof Modes]: Modes[K] extends "eager" ? K : never;
}[keyof Config & keyof Modes];

export interface ConfigResolver<Config, Modes> {
  /**
   * Starts every eager field in parallel and resolves to their values. Rejects
   * with the first failure. Calling it again returns the same promise.
   */
  ready(): Promise<Pick<ResolvedConfig<Config>, EagerKeys<Config, Modes>>>;

  /**
   * The resolved value of one field. A lazy field starts on the first call;
   * an eager field shares the work `ready()` started. Every call for a field
   * returns the same promise. Await or catch it: a rejection nobody handles
   * is an unhandled rejection.
   */
  get<K extends keyof Config>(key: K): Promise<ResolvedConfigValue<Config[K]>>;
}

/**
 * Thrown when a config field's function throws or rejects. The original error
 * is the `cause`.
 */
export class ConfigResolveError extends Error {
  /**
   * The config field that failed.
   */
  public readonly field: string;

  constructor(field: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);

    super(`Failed to resolve config "${field}": ${reason}`, { cause });
    this.name = "ConfigResolveError";
    this.field = field;
  }
}

/**
 * Resolves one config field: calls it with `ctx` if it is a function, passes
 * anything else through. This is the only place a field is called.
 */
export const resolveConfigValue = async <T, Ctx>(
  value: ConfigValue<T, Ctx>,
  ctx: Ctx,
): Promise<T> => {
  if (typeof value === "function") {
    return await (value as (ctx: Ctx) => T | Promise<T>)(ctx);
  }

  return value;
};

/**
 * Creates the resolver for one function execution. Make a new one on every
 * execution (a replay too) and don't share it between runs: nothing is
 * remembered across executions.
 *
 * Fields that are `undefined` resolve to `undefined` without being called.
 */
export const createConfigResolver = <
  Config extends {
    [K in keyof Config]:
      | Exclude<Config[K], (...args: never[]) => unknown>
      | ((ctx: Ctx) => unknown);
  },
  const Modes extends ConfigModes<Config>,
  Ctx,
>(options: {
  /**
   * The config, each field a value or a function of `ctx`.
   */
  config: Config;

  /**
   * What the functions receive: the trigger, the input, state.
   */
  ctx: Ctx;

  /**
   * When each field resolves.
   */
  modes: Modes & Record<Exclude<keyof Modes, keyof Config>, never>;
}): ConfigResolver<Config, Modes> => {
  const { config, ctx, modes } = options;
  const started = new Map<keyof Config, Promise<unknown>>();
  let ready: Promise<unknown> | undefined;

  const get = <K extends keyof Config>(
    key: K,
  ): Promise<ResolvedConfigValue<Config[K]>> => {
    const existing = started.get(key);

    if (existing) {
      return existing as Promise<ResolvedConfigValue<Config[K]>>;
    }

    const value = config[key];

    const resolving = (async () => {
      try {
        return await resolveConfigValue(value, ctx);
      } catch (err) {
        throw new ConfigResolveError(String(key), err);
      }
    })();

    started.set(key, resolving);

    return resolving as Promise<ResolvedConfigValue<Config[K]>>;
  };

  return {
    get,
    ready: () => {
      if (!ready) {
        const eager = (Object.keys(config) as (keyof Config)[]).filter(
          (key) => {
            return modes[key] === "eager";
          },
        );

        ready = Promise.all(
          eager.map(async (key) => {
            return [key, await get(key)] as const;
          }),
        ).then((entries) => {
          return Object.fromEntries(entries);
        });
      }

      return ready as ReturnType<ConfigResolver<Config, Modes>["ready"]>;
    },
  };
};
