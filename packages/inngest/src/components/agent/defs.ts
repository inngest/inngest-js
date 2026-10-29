/**
 * @module
 * EXPERIMENTAL: Top-level definitions for agents: `sandbox()` defines a
 * sandbox, `tool()` (in `sandbox/tools.ts`) defines an agent tool. A definition
 * is plain data. It needs no client and creates nothing; an agent that
 * references it supplies the client and decides when it is used.
 *
 * `openSandboxes()` turns an agent's sandbox bindings into lazy handles: the
 * sandbox is created, in one durable step, by the first thing that needs it.
 */

import type { DeferHandle, StepOptionsOrId } from "../../types.ts";
import {
  type CodeToolName,
  type CodeToolsOptions,
  codeTools,
} from "../sandbox/codeTools.ts";
import { destroyQuietly, sandboxCreateDefaults } from "../sandbox/group.ts";
import type { SandboxImage } from "../sandbox/image.ts";
import { image } from "../sandbox/image.ts";
import { hasCode } from "../sandbox/snapshotCache.ts";
import {
  type AgentTool,
  type SandboxToolEntry,
  type SandboxTools,
  validateTools,
} from "../sandbox/tools.ts";
import {
  type DurableSandbox,
  type DurableSandboxTools,
  type SandboxCreateFreshOptions,
  type SandboxCreateOptions,
  type SandboxDuration,
  type SandboxHandle,
  SandboxValidationError,
} from "../sandbox/types.ts";
import type { AgentConfigContext } from "./agentFunction.ts";
import { type GitPushToolOptions, gitPushTool } from "./gitPush.ts";
import {
  createWithSkills,
  isSkillsSource,
  maxBakeSize,
  type SkillsRuntime,
  type SkillsSource,
} from "./skills.ts";
import type { ThreadSandboxOwner } from "./threadSandboxes.ts";

/**
 * A config field: a value, or a function of `Ctx` returning it. A `T` that is
 * itself a function can't be used as a value, since a function is always
 * called.
 */
export type ConfigValue<T, Ctx> = T | ((ctx: Ctx) => T | Promise<T>);

/**
 * Resolves a config field: calls it with `ctx` if it is a function, passes
 * anything else through. Functions run on every replay, so they must be pure.
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
 * Builds the tools a sandbox brings, such as `sandbox.tools.code()`.
 */
export type SandboxToolsFactory<TTool extends string = string> = (
  sandbox: SandboxHandle,
) => Record<TTool, SandboxToolEntry>;

/**
 * Options of `sandbox()`: the sandbox's ID, image, size, environment, tools,
 * skills and setup.
 */
export interface SandboxDefinitionOptions<TTool extends string = string> {
  /**
   * Names the sandbox. Letters, digits, underscores and hyphens.
   */
  id: string;

  /**
   * The image to start from. Default: the base image.
   */
  image?: SandboxImage;
  /**
   * Virtual CPUs. Default: the platform's.
   */
  vcpu?: number;

  /**
   * Memory in megabytes. Default: the platform's.
   */
  memoryMb?: number;

  /**
   * Environment for a fresh sandbox. A sandbox restored from the thread's
   * snapshot does not get it again: the platform forbids `environment`
   * together with a snapshot.
   */
  environment?: Record<string, string>;

  /**
   * Workspace secret names to inject. See the `secrets` create option. Like
   * `environment`, they are not applied to a sandbox restored from the
   * thread's snapshot, because the platform forbids them together with one.
   */
  secrets?: string[];

  /**
   * The tools every agent that uses this sandbox gets, such as
   * `sandbox.tools.code()`.
   */
  tools?: SandboxToolsFactory<TTool>;

  /**
   * Git sources of skills, made with `skills.git()`. Each is fetched when the
   * sandbox is created or baked into a snapshot, by its `freshness`. A baked
   * source can't be combined with `environment` or `secrets`: a sandbox
   * started from a snapshot takes neither.
   */
  skills?: SkillsSource[];

  /**
   * Runs once, right after the sandbox is created and ready, before anything
   * else uses it: write files, restore a workspace, install packages. Use the
   * `sandbox` and `step` it receives, which are durable and need only a short
   * name per call (`"restore"`). A failure fails the `get()` that created the
   * sandbox.
   */
  setup?: SandboxSetup;
}

/**
 * What a sandbox's `setup` receives.
 */
export interface SandboxSetupContext {
  /**
   * The new sandbox. Step IDs are prefixed with `<name>:setup:sandbox:`.
   */
  sandbox: SandboxHandle;

  /**
   * Runs `fn` once per run, memoized, such as reading a saved workspace from
   * your store. Its ID is prefixed like the sandbox's.
   */
  step: {
    run: <T>(id: string, fn: () => Promise<T>) => Promise<T>;
  };

  /**
   * The event that started the run, when the agent function passed it.
   */
  event?: AgentConfigContext["event"];

  /**
   * The name the agent gives the sandbox, such as `work`.
   */
  name: string;

  /**
   * Whether the sandbox was restored from the thread's snapshot. What an
   * earlier run's setup put in is already there, so skip that work; per-run
   * state still needs writing.
   */
  restored?: boolean;
}

/**
 * Runs once after a sandbox is created and ready; see
 * `SandboxDefinitionOptions.setup`.
 */
export type SandboxSetup = (context: SandboxSetupContext) => Promise<void>;

/**
 * What a sandbox's skills and `setup` need from the running function.
 */
export interface SandboxRuntime extends SkillsRuntime {
  /**
   * The event that started the run.
   */
  event?: AgentConfigContext["event"];
}

/**
 * A sandbox defined with `sandbox()`. Nothing exists until an agent uses it.
 */
export interface SandboxDefinition<TTool extends string = string>
  extends SandboxDefinitionOptions<TTool> {
  /**
   * Marks the value as made by `sandbox()`.
   */
  readonly kind: "inngest/sandbox.definition";
}

/**
 * When a sandbox is created: `"lazy"` on the first call that needs it, or
 * `"eager"` as soon as the agent opens its sandboxes.
 */
export type SandboxStart = "lazy" | "eager";

/**
 * How an agent holds a sandbox: when it starts, and whether it stays up
 * between runs. In an agent's config `start` may also be a function of the
 * run's context, such as `({ event }) => "eager"`.
 */
export interface SandboxBinding<
  TStart = SandboxStart,
  TTool extends string = string,
> {
  /**
   * The sandbox to use, made with `sandbox()`.
   */
  sandbox: SandboxDefinition<TTool>;

  /**
   * `"lazy"` (default) creates the sandbox on the first call that needs it.
   * `"eager"` starts creating it as soon as the agent opens its sandboxes.
   */
  start?: TStart;

  /**
   * Keep the sandbox running between runs and stop it after it has been idle
   * this long. Off by default.
   *
   * It is validated and wired to the thread's sandbox owner, but it does
   * nothing yet: stopping an idle sandbox needs an idle timeout on the
   * platform's sandbox (a sandbox option such as `idleTimeout`), which does
   * not exist, and the SDK runs no idle check of its own. Until it does, a
   * sandbox with `keepAlive` is snapshotted and destroyed at run end like
   * any other, and the thread's next run restores it.
   * @deprecated Needs a platform idle timeout, which is not available yet.
   */
  keepAlive?: { idle: SandboxDuration };
}

/**
 * An agent's `sandboxes`, by name: a value, or a function of the run's context
 * that picks them.
 */
export type SandboxesConfig<
  Ctx,
  TSandboxes extends SandboxToolNames = SandboxToolNames,
> = ConfigValue<SandboxRecord<Ctx, TSandboxes>, Ctx>;

/**
 * For each sandbox of an agent, by name, the names of the tools its definition
 * brings (`sandbox.tools.code()` brings `read | write | edit | search | run`).
 * An agent's config is generic over it, so `sandboxes` and `sandboxTools` in
 * its body know their names.
 */
export type SandboxToolNames = Record<string, string>;

/**
 * An agent's sandboxes by name, each a definition or a binding.
 */
export type SandboxRecord<
  Ctx = never,
  TSandboxes extends SandboxToolNames = SandboxToolNames,
> = {
  [K in keyof TSandboxes & string]:
    | SandboxDefinition<TSandboxes[K]>
    | SandboxBinding<ConfigValue<SandboxStart, Ctx>, TSandboxes[K]>;
};

/**
 * The tools of an agent's sandboxes, keyed `<sandbox>_<tool>` (`work_run`).
 */
export type SandboxToolsOf<TSandboxes extends SandboxToolNames> = {
  [K in keyof TSandboxes & string as `${K}_${TSandboxes[K]}`]: SandboxToolEntry;
};

const namePattern = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

const idPattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

const defineSandbox = <TTool extends string = never>(
  options: SandboxDefinitionOptions<TTool>,
): SandboxDefinition<TTool> => {
  if (!idPattern.test(options.id)) {
    throw new SandboxValidationError(
      `Invalid sandbox id "${options.id}": use letters, digits, underscores and hyphens, starting with a letter, up to 64 characters`,
    );
  }

  const places = (options.skills ?? []).map((source) => {
    return source.into;
  });
  const overlapping = places.find((place, index) => {
    return places.some((other, otherIndex) => {
      return (
        otherIndex !== index &&
        (other === place || place.startsWith(`${other}/`))
      );
    });
  });

  if (overlapping) {
    throw new SandboxValidationError(
      `Sandbox "${options.id}" has skills that overlap at "${overlapping}": give each its own \`into\``,
    );
  }

  for (const source of options.skills ?? []) {
    if (!isSkillsSource(source)) {
      throw new SandboxValidationError(
        `Sandbox "${options.id}" has skills that were not made with skills.git()`,
      );
    }

    if (
      source.freshness === "bake" &&
      (options.environment || options.secrets)
    ) {
      throw new SandboxValidationError(
        `Sandbox "${options.id}" bakes skills, which can't be combined with environment or secrets: use freshness "boot" for "${source.repo}"`,
      );
    }

    if (
      source.freshness === "bake" &&
      ((options.vcpu ?? 0) > maxBakeSize.vcpu ||
        (options.memoryMb ?? 0) > maxBakeSize.memoryMb)
    ) {
      throw new SandboxValidationError(
        `Sandbox "${options.id}" bakes skills, which allows at most ${maxBakeSize.vcpu} vCPUs and ${maxBakeSize.memoryMb} MB: use freshness "boot" for "${source.repo}"`,
      );
    }
  }

  return Object.freeze({ ...options, kind: "inngest/sandbox.definition" });
};

/**
 * EXPERIMENTAL: Defines a sandbox for agents: its image and the tools it
 * brings. Define it at module scope and name it in an agent's `sandboxes`. It
 * is created lazily, on the first call that needs it.
 *
 * @example
 * ```ts
 * export const workbench = sandbox({
 *   id: "workbench",
 *   image: sandbox.image.custom("python-data:v1"),
 *   tools: sandbox.tools.code(),
 * });
 * ```
 */
export const sandbox = Object.assign(defineSandbox, {
  image,
  tools: {
    /**
     * `read`, `write`, `edit`, `search` and `run` in the sandbox.
     */
    code: ((options?: CodeToolsOptions) => {
      return (handle: SandboxHandle) => {
        return codeTools(handle, options);
      };
    }) as {
      <const TName extends CodeToolName = Exclude<CodeToolName, "run_code">>(
        options?: CodeToolsOptions<TName> & { tools?: undefined },
      ): SandboxToolsFactory<TName>;
      <const TName extends CodeToolName = CodeToolName>(
        options: CodeToolsOptions<TName> & { tools: SandboxTools },
      ): SandboxToolsFactory<TName>;
    },
    /**
     * `git_push`: the model pushes a branch, checked by your policy and sent
     * with a token only your app holds. See `gitPushTool()`.
     */
    git: (options: GitPushToolOptions): SandboxToolsFactory<"git_push"> => {
      return (handle) => {
        return { git_push: gitPushTool(handle, options) };
      };
    },
  },
});

/**
 * A sandbox an agent may use, created on first need.
 */
export interface LazySandbox {
  /**
   * The name the agent gives it, such as `work`.
   */
  readonly name: string;

  /**
   * The sandbox's definition.
   */
  readonly definition: SandboxDefinition;

  /**
   * When the sandbox is created: on first need (`"lazy"`) or at the start of
   * the run (`"eager"`).
   */
  readonly start: "lazy" | "eager";

  /**
   * Deprecated and inert: see `SandboxBinding.keepAlive`.
   * @deprecated Needs a platform idle timeout, which is not available yet.
   */
  readonly keepAlive?: { idle: SandboxDuration };

  /**
   * Whether creation has begun.
   */
  readonly started: boolean;

  /**
   * The definition's tools, named `<name>_<tool>` (`work_run`). Calling one
   * creates the sandbox if needed.
   */
  readonly tools: SandboxTools;

  /**
   * The sandbox, created in one step on the first call. Every call shares it.
   */
  get(): Promise<DurableSandbox>;

  /**
   * Destroys the sandbox if it was created. Does nothing otherwise, and a
   * failed create leaves nothing to destroy. Call it only when the run is
   * ending: a retry replays the memoized create, so a destroyed sandbox would
   * not come back.
   */
  close(): Promise<void>;

  /**
   * Saves the sandbox and destroys it now, so the run can go on without it.
   * The next `get()` (or a tool call) restores it from that snapshot into a
   * new sandbox, with the files as they were, and the run is none the wiser.
   * Use it to drop an idle sandbox mid-run, for example while the thread waits
   * for its next message. Does nothing when no sandbox was created, one that
   * was never used is destroyed without a snapshot, and a failed create stays
   * failed. The snapshot is a generation of this run, so the thread's next
   * run restores the newest one. Call it only when nothing is using the
   * sandbox: a command still running in it is lost. Durable: a replay
   * returns the same saves and destroys.
   *
   * It needs a sandbox that belongs to a thread; without one it throws, since
   * nothing would keep the files. It throws, and leaves the sandbox as it
   * was, when the snapshot could not be taken or the sandbox could not be
   * destroyed. The restored sandbox runs the definition's skills and `setup`
   * again (with `restored` true), and `keepAlive` is ignored: a recycle always
   * destroys.
   */
  recycle(): Promise<void>;
}

/**
 * The separator in a sandbox tool's name. Tool names allow no dots.
 */
export const toolNamespaceSeparator = "_";

const startModes: readonly unknown[] = ["lazy", "eager"];

/**
 * The definition of a binding, whichever form it is written in.
 */
export const definitionOf = <TStart>(
  binding: SandboxDefinition | SandboxBinding<TStart>,
): SandboxDefinition => {
  return "sandbox" in binding ? binding.sandbox : binding;
};

/**
 * A binding as `openSandboxes()` holds it: always the object form, with its
 * `start` checked. The one place bindings are validated.
 */
const toBinding = (
  name: string,
  binding: SandboxDefinition | SandboxBinding,
): SandboxBinding => {
  const options =
    typeof binding === "object" && binding && "sandbox" in binding
      ? binding
      : { sandbox: binding };

  if (options.sandbox?.kind !== "inngest/sandbox.definition") {
    throw new SandboxValidationError(
      `Sandbox "${name}" must be a definition made with sandbox(), or { sandbox, start, keepAlive }`,
    );
  }

  if (options.start !== undefined && !startModes.includes(options.start)) {
    throw new SandboxValidationError(
      `Sandbox "${name}" has start "${String(options.start)}": use "lazy" or "eager"`,
    );
  }

  return options;
};

const setupContext = (
  name: string,
  sandbox: DurableSandbox,
  runtime: SandboxRuntime,
  restored: boolean,
): SandboxSetupContext => {
  // Sandbox calls and steps get prefixes of their own, so one short name
  // can be used for each. Tool step IDs may not start with `setup:`.
  const prefixed = (rest: string) => {
    return `${name}:setup:sandbox:${rest}`;
  };
  const scoped = (idOrOptions: StepOptionsOrId): StepOptionsOrId => {
    return typeof idOrOptions === "string"
      ? prefixed(idOrOptions)
      : { ...idOrOptions, id: prefixed(idOrOptions.id) };
  };

  return {
    name,
    restored,
    event: runtime.event,
    step: {
      run: (id, fn) => {
        return runtime.run(`${name}:setup:step:${id}`, fn);
      },
    },
    sandbox: {
      commands: {
        run: (...args) => {
          return sandbox.commands.run(scoped(args[0]), args[1], args[2]);
        },
      },
      files: {
        write: (...args) => {
          return sandbox.files.write(scoped(args[0]), args[1]);
        },
        read: (...args) => {
          return sandbox.files.read(scoped(args[0]), args[1]);
        },
      },
    },
  };
};

const lazySandbox = (
  name: string,
  binding: SandboxDefinition | SandboxBinding,
  sandboxes: DurableSandboxTools,
  runtime?: SandboxRuntime,
  owner?: ThreadSandboxOwner,
): { lazy: LazySandbox; begin: () => void } => {
  if (!namePattern.test(name)) {
    throw new SandboxValidationError(
      `Invalid sandbox name "${name}": use letters, digits and underscores, starting with a letter, up to 64 characters`,
    );
  }

  const {
    sandbox: definition,
    start = "lazy",
    keepAlive,
  } = toBinding(name, binding);
  if (keepAlive && !keepAlive.idle) {
    throw new SandboxValidationError(
      `keepAlive on sandbox "${name}" needs an idle time, such as { idle: "10m" }`,
    );
  }

  let raw: Promise<DurableSandbox> | undefined;
  let created: Promise<DurableSandbox> | undefined;
  let closed: Promise<void> | undefined;
  let guard: DeferHandle | undefined;
  let restored = false;

  // Rises with every save and every recycle. It names the generation of each
  // save and the cleanup defer of each sandbox, so neither is ever reused: a
  // save whose destroy then failed has taken its generation, and the next save
  // is a later one.
  let epoch = 0;

  // The recycle in progress, which `get()` and `close()` wait for.
  let recycling: Promise<void> | undefined;

  // Whether anything used the sandbox. One that was only created (an eager
  // start nothing needed) has nothing worth a snapshot.
  let used = false;

  // Whether anything has seen the create's outcome. An eager create that
  // failed before anything asked for the sandbox is raised by `close()`.
  let observed = false;

  // The cleanup that destroys the sandbox if the run ends without closing it.
  // It saves the sandbox only once `owner.ready()` says its skills and setup
  // have finished.
  const arm = (sandbox: DurableSandbox) => {
    guard = owner?.guard(name, sandbox, epoch);
  };

  // The bare sandbox: restored from the thread's newest snapshot when it has
  // one, else fresh. Its cleanup is armed as soon as it exists.
  const acquire = async (
    options: SandboxCreateFreshOptions,
  ): Promise<DurableSandbox> => {
    // The platform takes only a name beside a snapshot (no image, size,
    // environment or secrets), so the definition's environment and secrets are
    // not applied to a restored sandbox. Platform ask: accept them with a
    // snapshotId.
    const candidates = owner ? await owner.restore(name) : [];
    // Whether a sandbox exists: once it does, an error is not the restore's.
    let existed = false;

    restored = candidates.length > 0;

    const withSkills = (from: string | undefined) => {
      return createWithSkills({
        name,
        sources: definition.skills ?? [],
        fresh: options,
        image: definition.image,
        sandboxes,
        runtime: runtime as SandboxRuntime,
        restoreFrom: from,
        onCreated: (sandbox) => {
          existed = true;
          arm(sandbox);
        },
      });
    };
    const make = async (from: string | undefined) => {
      if (definition.skills?.length) {
        return withSkills(from);
      }

      const sandbox = from
        ? await sandboxes.create(name, {
            name: options.name,
            snapshotId: from,
          } as SandboxCreateOptions)
        : await sandboxes.create(name, options);

      existed = true;
      arm(sandbox);

      return sandbox;
    };

    // A snapshot may be gone by now (a newer run deleted it as superseded, or
    // it expired): the next newest is tried, then a fresh sandbox, instead of
    // failing. Only a "snapshot not found" from the create counts; any other
    // failure (a platform error, a start that timed out) fails the run rather
    // than dropping the thread's state.
    //
    // UNVERIFIED against a real StepError: `hasCode` reads `cause.code` of the
    // failed create step, and the tests build that shape by hand. A real probe
    // (delete a snapshot of your own between the restore and the create) was
    // blocked by the environment's snapshot limit. If the code is not found
    // there, the fallback never fires and the run fails, which is the safe
    // direction.
    for (const candidate of candidates) {
      try {
        return await make(candidate);
      } catch (error) {
        if (existed || !hasCode(error, "sandbox_snapshot_not_found")) {
          throw error;
        }

        owner?.restoreFailed?.(name, error);
      }
    }

    restored = false;

    return make(undefined);
  };

  const create = (): Promise<DurableSandbox> => {
    const options: SandboxCreateFreshOptions = {
      ...sandboxCreateDefaults(name),
      ...(definition.image && { from: definition.image }),
      ...(definition.vcpu && { vcpu: definition.vcpu }),
      ...(definition.memoryMb && { memoryMb: definition.memoryMb }),
      ...(definition.environment && { environment: definition.environment }),
      ...(definition.secrets && { secrets: definition.secrets }),
    };

    if (created) {
      return created;
    }

    if ((definition.skills?.length || definition.setup) && !runtime) {
      return Promise.reject(
        new SandboxValidationError(
          `Sandbox "${name}" has skills or a setup, which need the agent's run: open it through an agent's sandboxes`,
        ),
      );
    }

    const setup = definition.setup;

    raw = acquire(options);

    // Setup runs after the sandbox exists, so after skills are in place.
    // `raw` stays the bare sandbox, so close() destroys it even when setup
    // failed.
    created = raw.then(async (sandbox) => {
      if (setup) {
        await setup(
          setupContext(name, sandbox, runtime as SandboxRuntime, restored),
        );
      }

      return sandbox;
    });

    return created;
  };

  // Marks the sandbox ready to be saved by the run's cleanup: its skills and
  // setup are done and something used it.
  let ready: Promise<void> | undefined;

  const get = async (): Promise<DurableSandbox> => {
    await recycling;

    observed = true;
    used = true;

    const sandbox = await create();

    ready ??= owner?.ready(name);
    await ready;

    return sandbox;
  };

  // Step IDs from the definition's tools (`run`, `edit:read`) are prefixed
  // with the binding name, so two sandboxes never share one.
  const scoped = (idOrOptions: StepOptionsOrId): StepOptionsOrId => {
    const id = typeof idOrOptions === "string" ? idOrOptions : idOrOptions.id;

    if (id.startsWith("setup:")) {
      throw new SandboxValidationError(
        `Step ID "${id}" on sandbox "${name}" is reserved: IDs starting with "setup:" belong to its setup`,
      );
    }

    return typeof idOrOptions === "string"
      ? `${name}:${idOrOptions}`
      : { ...idOrOptions, id: `${name}:${idOrOptions.id}` };
  };
  const handle: SandboxHandle = {
    commands: {
      run: async (...args) => {
        return (await get()).commands.run(scoped(args[0]), args[1], args[2]);
      },
    },
    files: {
      write: async (...args) => {
        return (await get()).files.write(scoped(args[0]), args[1]);
      },
      read: async (...args) => {
        return (await get()).files.read(scoped(args[0]), args[1]);
      },
    },
  };
  const tools: SandboxTools = {};

  for (const [key, entry] of Object.entries(definition.tools?.(handle) ?? {})) {
    tools[`${name}${toolNamespaceSeparator}${key}`] = entry;
  }

  validateTools(tools);

  const lazy: LazySandbox = {
    name,
    definition,
    start,
    ...(keepAlive && { keepAlive }),
    get started() {
      return raw !== undefined;
    },
    tools,
    get,
    recycle: () => {
      const previous = recycling ?? Promise.resolve();
      const next = previous.then(async () => {
        if (closed) {
          return;
        }

        // A setup still running must settle first, as at close.
        let failed = false;

        await created?.catch(() => {
          failed = true;
        });

        const sandbox = await raw?.catch(() => {
          return undefined;
        });

        // Nothing was created, or its creation failed: nothing to recycle.
        if (!sandbox || failed) {
          return;
        }

        if (!owner) {
          throw new SandboxValidationError(
            `Sandbox "${name}" can't be recycled: it doesn't belong to a thread, so nothing would keep its files`,
          );
        }

        let saved = false;

        // The sandbox stays running when a recycle fails after a save, so its
        // cleanup defer moves to the new epoch: it must save what the sandbox
        // writes from here on as a later generation, not skip it as already
        // saved. The new defer is registered before the old one is dropped.
        const rearm = () => {
          const old = guard;

          guard = owner.guard(name, sandbox, epoch);
          old?.abort();
        };

        if (used) {
          const ok = await owner.save(name, sandbox, epoch);

          // A save took its generation whether or not it worked.
          epoch++;

          if (ok === false) {
            rearm();

            throw new Error(
              `Sandbox "${name}" was not recycled: its snapshot could not be taken, so it is still running`,
            );
          }

          saved = true;
        }

        // Without a cleanup defer there is nothing to read the outcome from.
        let given = guard === undefined;
        const cleanup = guard && {
          abort: () => {
            given = true;
            guard?.abort();
          },
        };

        await destroyQuietly(sandbox, `${name}:destroy`, cleanup, {
          final: false,
        });

        if (!given) {
          if (saved) {
            rearm();
          }

          throw new Error(
            `Sandbox "${name}" was not recycled: it could not be destroyed, so it is still running`,
          );
        }

        // The next `get()` starts over, from the snapshot just taken. This
        // comes first so that nothing after the destroy can leave a destroyed
        // sandbox as the current one.
        raw = undefined;
        created = undefined;
        ready = undefined;
        guard = undefined;
        used = false;
        restored = false;

        if (!saved) {
          epoch++;
        }

        // If forgetting the ready mark fails for good, the mark stays and the
        // new sandbox looks ready while its setup runs. A run cancelled in
        // that window would save it half set up.
        await owner.release(name);
      });

      recycling = next.catch(() => {});

      return next;
    },
    close: () => {
      closed ??= (async () => {
        await recycling;

        // A setup still running must settle first, so its steps never meet a
        // destroyed sandbox.
        let failure: unknown;
        let failed = false;

        await created?.catch((error) => {
          failure = error;
          failed = true;
        });

        const sandbox = await raw?.catch(() => {
          return undefined;
        });

        if (sandbox) {
          // A sandbox whose creation or setup failed is not worth keeping.
          const worthKeeping = !failed && used;

          if (worthKeeping) {
            await owner?.save(name, sandbox, epoch);
          }

          // The owner may keep a keepAlive sandbox running for the thread's
          // next run. None does yet (see `keepAlive`). Anything but a
          // `true` from `keep`, including a throw, counts as declined.
          let kept = false;

          // Whether the cleanup defer was given up: only then is the run done
          // with the sandbox, so its ready mark may go. A save that failed
          // together with a destroy leaves the cleanup able to save.
          let given = false;
          const cleanup = guard && {
            abort: () => {
              given = true;
              guard?.abort();
            },
          };

          if (worthKeeping && keepAlive && cleanup) {
            try {
              kept =
                (await Promise.resolve(
                  owner?.keep?.(name, sandbox, keepAlive, cleanup),
                )) === true;
            } catch (error) {
              owner?.keepFailed?.(name, error);
            }
          }

          if (!kept) {
            await destroyQuietly(sandbox, `${name}:destroy`, cleanup);
          }

          if (given) {
            await owner?.release(name);
          }
        }

        if (failed && !observed) {
          throw failure;
        }
      })();

      return closed;
    },
  };

  return {
    lazy,
    begin: () => {
      if (start === "eager") {
        // The outcome is raised by the first use or by `close()`; here it only
        // must not go unhandled.
        create().catch(() => {});
      }
    },
  };
};

/**
 * EXPERIMENTAL: Resolves an agent's `sandboxes` config for one run: the config
 * itself, if it is a function, and each binding's `start`, if it is a function.
 * Functions run on every replay, so they must be pure functions of `ctx`.
 */
export const resolveSandboxes = async <Ctx>(
  /**
   * The agent's `sandboxes`, as written.
   */
  config: SandboxesConfig<Ctx> | undefined,

  /**
   * What the functions receive, such as `{ event }`.
   */
  ctx: Ctx,
): Promise<Record<string, SandboxDefinition | SandboxBinding>> => {
  const bindings = (await resolveConfigValue(config ?? {}, ctx)) as unknown;

  if (typeof bindings !== "object" || bindings === null) {
    throw new SandboxValidationError(
      "sandboxes must be an object of sandbox bindings by name",
    );
  }

  const entries = await Promise.all(
    Object.entries(bindings).map(async ([name, binding]) => {
      if (typeof binding !== "object" || !binding || !("sandbox" in binding)) {
        return [name, binding as SandboxDefinition] as const;
      }

      const start = await resolveConfigValue(
        (binding as SandboxBinding<ConfigValue<SandboxStart, Ctx>>).start,
        ctx,
      );

      return [name, { ...binding, start } as SandboxBinding] as const;
    }),
  );

  return Object.fromEntries(entries);
};

/**
 * EXPERIMENTAL: One opened sandbox by name. Throws a clear error, naming the
 * sandboxes the agent does have, when there is none by that name.
 */
export const getSandbox = (
  /**
   * What `openSandboxes()` returned.
   */
  opened: Record<string, LazySandbox>,

  /**
   * The name in the agent's `sandboxes`.
   */
  name: string,
): LazySandbox => {
  const found = Object.hasOwn(opened, name) ? opened[name] : undefined;

  if (!found) {
    const known = Object.keys(opened);

    throw new SandboxValidationError(
      `Unknown sandbox "${name}": this agent has ${
        known.length > 0 ? known.join(", ") : "no sandboxes"
      }`,
    );
  }

  return found;
};

/**
 * EXPERIMENTAL: Opens the sandboxes an agent is allowed to use. Nothing is
 * created yet, except for sandboxes bound with `start: "eager"`, which begin
 * creating at once. If an eager create fails and nothing used the sandbox,
 * `close()` raises the failure (the agent's run logs it as a warning). A
 * sandbox that was used raises its failure to the caller that used it.
 */
export const openSandboxes = (
  /**
   * The agent's `sandboxes`, by name.
   */
  bindings: Record<string, SandboxDefinition | SandboxBinding>,

  /**
   * The `step.sandbox` of the running function.
   */
  sandboxes: DurableSandboxTools,

  /**
   * What sandboxes with skills or a setup need from the run.
   */
  runtime?: SandboxRuntime,

  /**
   * The thread the sandboxes belong to. With it, each sandbox is restored from the thread's newest snapshot on first use, and snapshotted when the run closes it.
   */
  owner?: ThreadSandboxOwner,
): Record<string, LazySandbox> => {
  const opened: Record<string, LazySandbox> = {};
  const begins: (() => void)[] = [];

  // Every binding is validated before any eager one starts, so a bad binding
  // leaves nothing running.
  for (const [name, binding] of Object.entries(bindings)) {
    const { lazy, begin } = lazySandbox(
      name,
      binding,
      sandboxes,
      runtime,
      owner,
    );

    opened[name] = lazy;
    begins.push(begin);
  }

  for (const begin of begins) {
    begin();
  }

  return opened;
};

/**
 * Tools by name for `agent.loop()`, failing on two with one name.
 */
const toolsByName = (
  /**
   * Name and tool pairs.
   */
  entries: Iterable<readonly [string, SandboxToolEntry]>,
): SandboxTools => {
  const byName: SandboxTools = {};

  for (const [name, entry] of entries) {
    if (Object.hasOwn(byName, name)) {
      throw new SandboxValidationError(`Two tools are named "${name}"`);
    }

    byName[name] = entry;
  }

  return byName;
};

/**
 * Every opened sandbox's tools, namespaced, for `agent.loop()`.
 */
export const sandboxTools = (
  opened: Record<string, LazySandbox>,
): SandboxTools => {
  return toolsByName(
    Object.values(opened).flatMap((handle) => {
      return Object.entries(handle.tools);
    }),
  );
};

/**
 * Agent tools by name, for `agent.loop()`. The name is the tool's `id`.
 */
export const agentTools = (tools: readonly AgentTool[]): SandboxTools => {
  return toolsByName(
    tools.map((entry) => {
      return [entry.id, entry] as const;
    }),
  );
};

/**
 * EXPERIMENTAL: The `step.sandbox` of a running function, which only exists
 * when its client has the sandbox middleware.
 */
export const stepSandboxes = (
  /**
   * The function's step tools.
   */
  step: object,
): DurableSandboxTools => {
  const sandboxes = (step as { sandbox?: DurableSandboxTools }).sandbox;

  if (!sandboxes) {
    throw new SandboxValidationError(
      "An agent with sandboxes needs the client's sandbox middleware: new Inngest({ middleware: [sandboxMiddleware()] })",
    );
  }

  return sandboxes;
};
