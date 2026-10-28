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
import { destroyQuietly, sandboxCreateDefaults } from "../sandbox/group.ts";
import type { SandboxImage } from "../sandbox/image.ts";
import { image } from "../sandbox/image.ts";
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
  type SandboxDuration,
  type SandboxHandle,
  SandboxValidationError,
} from "../sandbox/types.ts";
import { type GitPushToolOptions, gitPushTool } from "./gitPush.ts";

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
}

/**
 * A sandbox defined with `sandbox()`. Nothing exists until an agent uses it.
 */
export interface SandboxDefinition extends SandboxDefinitionOptions {
  readonly kind: "inngest/sandbox.definition";
}

export type SandboxStart = "lazy" | "eager";

/**
 * How an agent holds a sandbox: when it starts, and whether it stays up
 * between runs. In an agent's config `start` may also be a function of the
 * run's context, such as `({ event }) => "eager"`.
 */
export interface SandboxBinding<TStart = SandboxStart> {
  sandbox: SandboxDefinition;

  /**
   * `"lazy"` (default) creates the sandbox on the first call that needs it.
   * `"eager"` starts creating it as soon as the agent opens its sandboxes.
   */
  start?: TStart;

  /**
   * Keep the sandbox running between runs and stop it after it has been idle
   * this long. Off by default. The idle check itself belongs to the thread
   * that owns the sandbox; here it is validated and carried.
   */
  keepAlive?: { idle: SandboxDuration };
}

/**
 * An agent's `sandboxes`, by name: a value, or a function of the run's context
 * that picks them.
 */
export type SandboxesConfig<Ctx> = ConfigValue<
  Record<
    string,
    SandboxDefinition | SandboxBinding<ConfigValue<SandboxStart, Ctx>>
  >,
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

const startModes: readonly unknown[] = ["lazy", "eager"];

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

const lazySandbox = (
  name: string,
  binding: SandboxDefinition | SandboxBinding,
  sandboxes: DurableSandboxTools,
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

  let created: Promise<DurableSandbox> | undefined;
  let closed: Promise<void> | undefined;

  // Whether anything has seen the create's outcome. An eager create that
  // failed before anything asked for the sandbox is raised by `close()`.
  let observed = false;

  const create = (): Promise<DurableSandbox> => {
    const options: SandboxCreateFreshOptions = {
      ...sandboxCreateDefaults(name),
      ...(definition.image && { from: definition.image }),
      ...(definition.vcpu && { vcpu: definition.vcpu }),
      ...(definition.memoryMb && { memoryMb: definition.memoryMb }),
      ...(definition.environment && { environment: definition.environment }),
      ...(definition.secrets && { secrets: definition.secrets }),
    };

    created ??= sandboxes.create(name, options);

    return created;
  };

  const get = (): Promise<DurableSandbox> => {
    observed = true;

    return create();
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

  const lazy: LazySandbox = {
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
        const sandbox = await created?.catch((error) => {
          if (!observed) {
            throw error;
          }

          return undefined;
        });

        if (sandbox) {
          await destroyQuietly(sandbox, `${name}:destroy`);
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
 *
 * @param config The agent's `sandboxes`, as written.
 * @param ctx What the functions receive, such as `{ event }`.
 */
export const resolveSandboxes = async <Ctx>(
  config: SandboxesConfig<Ctx> | undefined,
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
 * creating at once. If an eager create fails and nothing used the sandbox,
 * `close()` raises the failure.
 *
 * @param bindings The agent's `sandboxes`, by name.
 * @param sandboxes The `step.sandbox` of the running function.
 */
export const openSandboxes = (
  bindings: Record<string, SandboxDefinition | SandboxBinding>,
  sandboxes: DurableSandboxTools,
): Record<string, LazySandbox> => {
  const opened: Record<string, LazySandbox> = {};
  const begins: (() => void)[] = [];

  // Every binding is validated before any eager one starts, so a bad binding
  // leaves nothing running.
  for (const [name, binding] of Object.entries(bindings)) {
    const { lazy, begin } = lazySandbox(name, binding, sandboxes);

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
 * @param entries Name and tool pairs.
 */
const toolsByName = (
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
 *
 * @param step The function's step tools.
 */
export const stepSandboxes = (step: object): DurableSandboxTools => {
  const sandboxes = (step as { sandbox?: DurableSandboxTools }).sandbox;

  if (!sandboxes) {
    throw new SandboxValidationError(
      "An agent with sandboxes needs the client's sandbox middleware: new Inngest({ middleware: [sandboxMiddleware()] })",
    );
  }

  return sandboxes;
};
