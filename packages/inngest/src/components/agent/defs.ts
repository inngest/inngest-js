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

import type { StepOptionsOrId } from "../../types.ts";
import { type CodeToolsOptions, codeTools } from "../sandbox/codeTools.ts";
import { destroyQuietly, sandboxDefaults } from "../sandbox/group.ts";
import type { SandboxImage } from "../sandbox/image.ts";
import { image } from "../sandbox/image.ts";
import {
  type AgentTool,
  type SandboxTool,
  type SandboxTools,
  validateTools,
} from "../sandbox/tools.ts";
import {
  type DurableSandbox,
  type DurableSandboxTools,
  type SandboxDuration,
  SandboxValidationError,
} from "../sandbox/types.ts";
import { type GitPushToolOptions, gitPushTool } from "./gitPush.ts";
import {
  createWithSkills,
  isSkillsSource,
  type SkillsRuntime,
  type SkillsSource,
} from "./skills.ts";

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
const resolveConfigValue = async <T, Ctx>(
  value: ConfigValue<T, Ctx>,
  ctx: Ctx,
): Promise<T> => {
  if (typeof value === "function") {
    return await (value as (ctx: Ctx) => T | Promise<T>)(ctx);
  }

  return value;
};

/**
 * The parts of a sandbox that a definition's tools use. Calls through it
 * create the sandbox first if it doesn't exist yet.
 */
export type SandboxHandle = Pick<DurableSandbox, "commands" | "files">;

/**
 * Builds the tools a sandbox brings, such as `sandbox.tools.code()`.
 */
export type SandboxToolsFactory = (sandbox: SandboxHandle) => SandboxTools;

export interface SandboxDefinitionOptions {
  /**
   * Names the sandbox. Letters, digits, underscores and hyphens.
   */
  id: string;

  /**
   * The image to start from. Default: the base image.
   */
  image?: SandboxImage;
  vcpu?: number;
  memoryMb?: number;
  environment?: Record<string, string>;

  /**
   * Workspace secret names to inject. See the `secrets` create option.
   */
  secrets?: string[];

  /**
   * The tools every agent that uses this sandbox gets, such as
   * `sandbox.tools.code()`.
   */
  tools?: SandboxToolsFactory;

  /**
   * Git sources of skills, made with `skills.git()`. Each is fetched when the
   * sandbox is created or baked into a snapshot, by its `freshness`. A baked
   * source can't be combined with `environment` or `secrets`: a sandbox
   * started from a snapshot takes neither.
   */
  skills?: SkillsSource[];
}

/**
 * A sandbox defined with `sandbox()`. Nothing exists until an agent uses it.
 */
export interface SandboxDefinition extends SandboxDefinitionOptions {
  readonly kind: "inngest/sandbox.definition";
}

/**
 * How an agent holds a sandbox: when it starts, and whether it stays up
 * between runs.
 */
export interface SandboxBindingOptions {
  sandbox: SandboxDefinition;

  /**
   * `"lazy"` (default) creates the sandbox on the first call that needs it.
   * `"eager"` starts creating it as soon as the agent opens its sandboxes.
   */
  start?: "lazy" | "eager";

  /**
   * Keep the sandbox running between runs and stop it after it has been idle
   * this long. Off by default. The idle check itself belongs to the thread
   * that owns the sandbox; here it is validated and carried.
   */
  keepAlive?: { idle: SandboxDuration };
}

export type SandboxBinding = SandboxDefinition | SandboxBindingOptions;

/**
 * A binding as written in an agent's config, where `start` may also be a
 * function of the run's context, such as `({ event }) => "eager"`.
 */
export type SandboxBindingInput<Ctx> =
  | SandboxDefinition
  | (Omit<SandboxBindingOptions, "start"> & {
      start?: ConfigValue<"lazy" | "eager", Ctx>;
    });

/**
 * An agent's `sandboxes`, by name: a value, or a function of the run's context
 * that picks them.
 */
export type SandboxesConfig<Ctx> = ConfigValue<
  Record<string, SandboxBindingInput<Ctx>>,
  Ctx
>;

const namePattern = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

const idPattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

const defineSandbox = (
  options: SandboxDefinitionOptions,
): SandboxDefinition => {
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
    code: (options?: CodeToolsOptions): SandboxToolsFactory => {
      return (handle) => {
        return codeTools(handle, options);
      };
    },
    /**
     * `git_push`: the model pushes a branch, checked by your policy and sent
     * with a token only your app holds. See `gitPushTool()`.
     */
    git: (options: GitPushToolOptions): SandboxToolsFactory => {
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
  readonly definition: SandboxDefinition;
  readonly start: "lazy" | "eager";
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
}

/**
 * The separator in a sandbox tool's name. Tool names allow no dots.
 */
export const toolNamespaceSeparator = "_";

const bindingOptions = (
  name: string,
  binding: SandboxBinding,
): SandboxBindingOptions => {
  const options =
    typeof binding === "object" && binding && "sandbox" in binding
      ? binding
      : { sandbox: binding };

  if (
    (options.sandbox as SandboxDefinition | undefined)?.kind !==
    "inngest/sandbox.definition"
  ) {
    throw new SandboxValidationError(
      `Sandbox "${name}" must be a definition made with sandbox(), or { sandbox, start, keepAlive }`,
    );
  }

  const start = (options as { start?: unknown }).start;
  if (start !== undefined && start !== "lazy" && start !== "eager") {
    throw new SandboxValidationError(
      `Sandbox "${name}" has start "${String(start)}": use "lazy" or "eager"`,
    );
  }

  return options as SandboxBindingOptions;
};

const lazySandbox = (
  name: string,
  binding: SandboxBinding,
  sandboxes: DurableSandboxTools,
  skillsRuntime?: SkillsRuntime,
): LazySandbox => {
  if (!namePattern.test(name)) {
    throw new SandboxValidationError(
      `Invalid sandbox name "${name}": use letters, digits and underscores, starting with a letter, up to 64 characters`,
    );
  }

  const {
    sandbox: definition,
    start = "lazy",
    keepAlive,
  } = bindingOptions(name, binding);
  if (keepAlive && !keepAlive.idle) {
    throw new SandboxValidationError(
      `keepAlive on sandbox "${name}" needs an idle time, such as { idle: "10m" }`,
    );
  }

  let created: Promise<DurableSandbox> | undefined;
  let closed: Promise<void> | undefined;

  const get = (): Promise<DurableSandbox> => {
    const fresh = {
      ...withoutId(sandboxDefaults(name)),
      ...(definition.image && { from: definition.image }),
      ...(definition.vcpu && { vcpu: definition.vcpu }),
      ...(definition.memoryMb && { memoryMb: definition.memoryMb }),
      ...(definition.environment && { environment: definition.environment }),
      ...(definition.secrets && { secrets: definition.secrets }),
    };

    if (definition.skills?.length && !skillsRuntime) {
      return Promise.reject(
        new SandboxValidationError(
          `Sandbox "${name}" has skills, which need the agent's run: open it through an agent's sandboxes`,
        ),
      );
    }

    created ??= definition.skills?.length
      ? createWithSkills({
          name,
          sources: definition.skills,
          fresh,
          image: definition.image,
          sandboxes,
          runtime: skillsRuntime as SkillsRuntime,
        })
      : sandboxes.create(
          name,
          fresh as Parameters<DurableSandboxTools["create"]>[1],
        );

    return created;
  };

  // Step IDs from the definition's tools (`run`, `edit:read`) are prefixed
  // with the binding name, so two sandboxes never share one.
  const scoped = (idOrOptions: StepOptionsOrId): StepOptionsOrId => {
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

  return {
    name,
    definition,
    start,
    ...(keepAlive && { keepAlive }),
    get started() {
      return created !== undefined;
    },
    tools,
    get,
    close: () => {
      closed ??= (async () => {
        const sandbox = await created?.catch(() => {
          return undefined;
        });

        if (sandbox) {
          await destroyQuietly(sandbox, `${name}:destroy`);
        }
      })();

      return closed;
    },
  };
};

/**
 * EXPERIMENTAL: Resolves an agent's `sandboxes` config for one run: the config
 * itself, if it is a function, and each binding's `start`, if it is a function.
 * Functions run on every replay, so they must be pure functions of `ctx`.
 *
 * @param config The agent's `sandboxes`, as written.
 * @param ctx What the functions receive, such as `{ event }`.
 */
export const resolveSandboxes = async <Ctx>(
  config: SandboxesConfig<Ctx> | undefined,
  ctx: Ctx,
): Promise<Record<string, SandboxBinding>> => {
  const bindings = (await resolveConfigValue(config ?? {}, ctx)) as unknown;

  if (typeof bindings !== "object" || bindings === null) {
    throw new SandboxValidationError(
      "sandboxes must be an object of sandbox bindings by name",
    );
  }

  const entries = await Promise.all(
    Object.entries(bindings).map(async ([name, binding]) => {
      const input = binding as SandboxBindingInput<Ctx>;

      if (typeof input !== "object" || !input || !("sandbox" in input)) {
        return [name, input as SandboxDefinition] as const;
      }

      const start = await resolveConfigValue(input.start, ctx);

      return [name, { ...input, start } as SandboxBindingOptions] as const;
    }),
  );

  return Object.fromEntries(entries);
};

/**
 * EXPERIMENTAL: One opened sandbox by name. Throws a clear error, naming the
 * sandboxes the agent does have, when there is none by that name.
 *
 * @param opened What `openSandboxes()` returned.
 * @param name The name in the agent's `sandboxes`.
 */
export const getSandbox = (
  opened: Record<string, LazySandbox>,
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
 * creating at once.
 *
 * @param bindings The agent's `sandboxes`, by name.
 * @param sandboxes The `step.sandbox` of the running function.
 * @param skillsRuntime What sandboxes with skills need from the run.
 */
export const openSandboxes = (
  bindings: Record<string, SandboxBinding>,
  sandboxes: DurableSandboxTools,
  skillsRuntime?: SkillsRuntime,
): Record<string, LazySandbox> => {
  const opened: Record<string, LazySandbox> = {};

  // Every binding is validated before any eager one starts, so a bad binding
  // leaves nothing running.
  for (const [name, binding] of Object.entries(bindings)) {
    opened[name] = lazySandbox(name, binding, sandboxes, skillsRuntime);
  }

  for (const handle of Object.values(opened)) {
    if (handle.start === "eager") {
      // A failure surfaces to whoever calls get(); here it only must not go
      // unhandled.
      handle.get().catch(() => {});
    }
  }

  return opened;
};

/**
 * Every opened sandbox's tools, namespaced, for `agent.loop()`.
 */
export const sandboxTools = (
  opened: Record<string, LazySandbox>,
): SandboxTools => {
  const all: SandboxTools = {};

  for (const handle of Object.values(opened)) {
    for (const [key, entry] of Object.entries(handle.tools)) {
      if (Object.hasOwn(all, key)) {
        throw new SandboxValidationError(
          `Two sandbox tools are named "${key}"`,
        );
      }

      all[key] = entry;
    }
  }

  return all;
};

/**
 * Agent tools by name, for `agent.loop()`. The name is the tool's `id`.
 */
export const agentTools = (tools: readonly AgentTool[]): SandboxTools => {
  const byId: Record<string, SandboxTool> = {};

  for (const entry of tools) {
    if (Object.hasOwn(byId, entry.id)) {
      throw new SandboxValidationError(`Two tools are named "${entry.id}"`);
    }

    byId[entry.id] = entry;
  }

  return byId;
};

const withoutId = <T extends { id: string }>({ id: _id, ...rest }: T) => {
  return rest;
};
