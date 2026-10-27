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

const bindingOptions = (binding: SandboxBinding): SandboxBindingOptions => {
  return "sandbox" in binding ? binding : { sandbox: binding };
};

const lazySandbox = (
  name: string,
  binding: SandboxBinding,
  sandboxes: DurableSandboxTools,
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
  } = bindingOptions(binding);
  if (keepAlive && !keepAlive.idle) {
    throw new SandboxValidationError(
      `keepAlive on sandbox "${name}" needs an idle time, such as { idle: "10m" }`,
    );
  }

  let created: Promise<DurableSandbox> | undefined;
  let closed: Promise<void> | undefined;

  const get = (): Promise<DurableSandbox> => {
    created ??= sandboxes.create(name, {
      ...withoutId(sandboxDefaults(name)),
      ...(definition.image && { from: definition.image }),
      ...(definition.vcpu && { vcpu: definition.vcpu }),
      ...(definition.memoryMb && { memoryMb: definition.memoryMb }),
      ...(definition.environment && { environment: definition.environment }),
      ...(definition.secrets && { secrets: definition.secrets }),
    } as Parameters<DurableSandboxTools["create"]>[1]);

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
 * EXPERIMENTAL: Opens the sandboxes an agent is allowed to use. Nothing is
 * created yet, except for sandboxes bound with `start: "eager"`, which begin
 * creating at once.
 *
 * @param bindings The agent's `sandboxes`, by name.
 * @param sandboxes The `step.sandbox` of the running function.
 */
export const openSandboxes = (
  bindings: Record<string, SandboxBinding>,
  sandboxes: DurableSandboxTools,
): Record<string, LazySandbox> => {
  const opened: Record<string, LazySandbox> = {};

  for (const [name, binding] of Object.entries(bindings)) {
    opened[name] = lazySandbox(name, binding, sandboxes);

    if (opened[name].start === "eager") {
      // A failure surfaces to whoever calls get(); here it only must not go
      // unhandled.
      opened[name].get().catch(() => {});
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
