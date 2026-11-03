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

import { z } from "zod/v4";
import { getAsyncCtxSync } from "../../../components/execution/als.ts";
import { NonRetriableError } from "../../../components/NonRetriableError.ts";
import { StepError } from "../../../components/StepError.ts";
import { builtinTools } from "../../../components/sandbox/codeTools.ts";
import { createDollar } from "../../../components/sandbox/dollar.ts";
import {
  destroyQuietly,
  sandboxCreateDefaults,
} from "../../../components/sandbox/group.ts";
import type { SandboxImage } from "../../../components/sandbox/image.ts";
import { image } from "../../../components/sandbox/image.ts";
import { createShell } from "../../../components/sandbox/shell.ts";
import type { SandboxShim } from "../../../components/sandbox/shims.ts";
import { hasCode } from "../../../components/sandbox/snapshotCache.ts";
import {
  type AgentTool,
  bindSandbox,
  type SandboxToolEntry,
  type SandboxTools,
  tool,
  validateTools,
} from "../../../components/sandbox/tools.ts";
import {
  type DurableSandbox,
  type DurableSandboxTools,
  type SandboxCreateFreshOptions,
  type SandboxCreateOptions,
  type SandboxHandle,
  type SandboxIO,
  SandboxValidationError,
} from "../../../components/sandbox/types.ts";
import type { DeferHandle, StepOptionsOrId } from "../../../types.ts";
import { type RunField, resolveRunField } from "../agent/runField.ts";
import { agent } from "../loop/loop.ts";
import { type Skill, skillsRoot } from "../skills/skills.ts";
import type { ShellPlace } from "../threads/threadState.ts";
import {
  checkoutRepo,
  createRepo,
  mintRepoToken,
  PushRefusedError,
  type Repo,
  type RepoConfig,
  type RepoValue,
  type ResolvedRepo,
} from "./repo.ts";
import {
  defaultSandboxIdle,
  type SandboxIdle,
  type ThreadSandboxOwner,
} from "./threadSandboxes.ts";

/**
 * Options of `sandbox()`: the sandbox's ID, image, size, environment, tools
 * and setup.
 */
export interface SandboxDefinitionOptions<
  TTools extends SandboxToolRecord = SandboxToolRecord,
> {
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
   * The tools every agent that uses this sandbox gets: a record of tools, such
   * as `{ run, read, edit, finish }` (the built-ins are `sandbox.tools.run` and
   * so on). The model sees them as `<sandbox key>_<tool key>`. Every tool in it
   * acts on this sandbox: its `context.sandbox` is this sandbox's handle,
   * whether the model or sandbox code calls it, and the SDK adds "Works on the
   * `<key>` sandbox." to its description. Without `tools` the sandbox brings
   * `sandbox.tools.defaults` (`run`).
   */
  tools?: TTools;

  /**
   * Where relative paths and commands start, and where the shell starts: the
   * repository's path when the sandbox has a `repo`. Default `/work`.
   */
  cwd?: string;

  /**
   * Programs on `PATH` that call a handler in your app, made with
   * `tool.shim()`. Every command run through the sandbox's handle has them
   * (the tools' commands and `sandboxes.work.commands`), so the program works
   * for the model as it does in a script. A shim is a program, never an entry
   * in the model's tool list.
   */
  shims?: readonly SandboxShim[];

  /**
   * Runs once, right after the sandbox is created and ready, before anything
   * else uses it: write files, restore a workspace, install packages. Use the
   * `sandbox` and `step` it receives, which are durable and need only a short
   * name per call (`"restore"`). A failure fails the `get()` that created the
   * sandbox.
   */
  setup?: SandboxSetup;

  /**
   * A git repository the sandbox starts with: checked out first (before skill
   * files and `setup`), with one push made by the host. A value, or a function
   * of `{ event, thread }` that is pure and may be async, evaluated once per
   * run at its start (a reviewer agent checks out the pull request it was
   * triggered by). One repo per sandbox; a second repo gets a second sandbox.
   */
  repo?: RepoValue;
}

/**
 * What a sandbox's `setup` receives.
 */
export interface SandboxSetupContext {
  /**
   * The new sandbox. Step IDs are prefixed with `<name>:setup:sandbox:`.
   */
  sandbox: SandboxIO & Pick<SandboxHandle, "$">;

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
  // Deliberate unknown: event data comes from outside; the reader checks it.
  event?: { name: string; data?: unknown };

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
 * What a sandbox's `setup` needs from the running function.
 */
export interface SandboxRuntime {
  /**
   * The event that started the run.
   */
  // Deliberate unknown: event data comes from outside; the reader checks it.
  event?: { name: string; data?: unknown };

  /**
   * Runs `fn` once per run, such as `(id, fn) => step.run(id, fn)`.
   */
  run: <T>(id: string, fn: () => Promise<T>) => Promise<T>;

  /**
   * Registers the cleanup that destroys a sandbox if the run ends without
   * closing it. Used when there's no thread owner (no KV store); an owner
   * guards its own sandboxes.
   */
  guard?: (name: string, sandbox: DurableSandbox, epoch: number) => DeferHandle;
}

/**
 * A sandbox defined with `sandbox()`. Nothing exists until an agent uses it.
 */
export interface SandboxDefinition<
  TTools extends SandboxToolRecord = SandboxToolRecord,
> extends SandboxDefinitionOptions<TTools> {
  /**
   * Marks the value as made by `sandbox()`.
   */
  readonly kind: "inngest/sandbox.definition";

  /**
   * Set by `with({ model })`: whether the model gets this sandbox's tools.
   * Unset means `true`.
   */
  readonly model?: boolean;

  /**
   * A copy of this sandbox with options for the agent that uses it. `model:
   * false` keeps it for code only: the model gets no tools on it, and the
   * handler's `sandboxes.work` still works.
   *
   * @example
   * ```ts
   * sandboxes: { grader: grader.with({ model: false }) }
   * ```
   */
  with(options: { model?: boolean }): SandboxDefinition<TTools>;
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
  TTools extends SandboxToolRecord = SandboxToolRecord,
> {
  /**
   * The definition's `repo` as this run resolved it. Set by the SDK.
   */
  resolvedRepo?: RepoConfig;

  /**
   * The sandbox to use, made with `sandbox()`.
   */
  sandbox: SandboxDefinition<TTools>;

  /**
   * `"lazy"` (default) creates the sandbox on the first call that needs it.
   * `"eager"` starts creating it as soon as the agent opens its sandboxes.
   */
  start?: TStart;

  /**
   * Whether the model gets this sandbox's tools (`work_run`). `false` keeps the
   * sandbox for code only: the handler's `sandboxes.work` still works.
   * Default `true`.
   */
  model?: boolean;

  /**
   * What a thread's sandbox becomes when its run is done with it (the run
   * ended, or `recycle()` was called).
   *
   * - `"pause"` (default): the platform pauses it and the thread's next run
   *   resumes it, so the workspace (a checkout, `node_modules`) is there as
   *   it was, with no snapshot and no size cap. A sandbox that can't be paused
   *   is saved as a snapshot and destroyed instead, and a paused one that is
   *   gone by the next run falls back to the thread's newest snapshot, then to
   *   a fresh sandbox.
   * - `"snapshot"`: it is saved as a snapshot and destroyed, and the next run
   *   creates a new sandbox from the snapshot. Pick it when a paused sandbox
   *   should not be held, at the cost of a snapshot per thread.
   *
   * A resumed sandbox runs `setup` again with `restored` true. A sandbox that belongs to no thread is destroyed.
   */
  idle?: SandboxIdle;
}

/**
 * An agent's `sandboxes`, by name: a value, or a function of the run's context
 * that picks them.
 */
export type SandboxesConfig<
  Ctx,
  TSandboxes extends SandboxToolNames = SandboxToolNames,
> = RunField<SandboxRecord<Ctx, TSandboxes>, Ctx>;

/**
 * The tools a sandbox brings, by name.
 */
export type SandboxToolRecord = Record<string, SandboxToolEntry>;

/**
 * For each sandbox of an agent, by name, the tools its definition brings
 * (`sandbox.tools.defaults` brings `run`). An agent's config is generic over
 * it, so its body knows its sandboxes and the loop result knows their tools.
 */
export type SandboxToolNames = Record<string, SandboxToolRecord>;

/**
 * An agent's sandboxes by name, each a definition (optionally from
 * `sandbox.with()`) or a binding.
 */
export type SandboxRecord<
  Ctx = never,
  TSandboxes extends SandboxToolNames = SandboxToolNames,
> = {
  [K in keyof TSandboxes & string]:
    | SandboxDefinition<TSandboxes[K]>
    | SandboxBinding<RunField<SandboxStart, Ctx>, TSandboxes[K]>;
};

type UnionToIntersection<U> = (
  U extends unknown
    ? (x: U) => void
    : never
) extends (x: infer I) => void
  ? I
  : never;

/**
 * The tools of an agent's sandboxes, keyed `<sandbox>_<tool>` (`work_run`),
 * with their own types, so a loop result's runs narrow by name.
 */
export type SandboxToolsOf<TSandboxes extends SandboxToolNames> =
  UnionToIntersection<
    {
      [K in keyof TSandboxes & string]: {
        [T in Exclude<keyof TSandboxes[K], "~repo"> &
          string as `${K}_${T}`]: TSandboxes[K][T];
      };
    }[keyof TSandboxes & string]
  > &
    Record<never, never>;

const namePattern = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

const idPattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/**
 * What a `repo` adds to a definition's tools: a marker that the sandbox has a
 * repo (`"~repo"`, never a model tool), and `push` unless the repo is written
 * with `push: false`.
 */
export type RepoMarker<TRepo> = [TRepo] extends [undefined]
  ? Record<never, never>
  : TRepo extends { push: false }
    ? { "~repo": SandboxToolEntry }
    : { "~repo": SandboxToolEntry; push: SandboxToolEntry };

const defineSandbox = (
  options: SandboxDefinitionOptions,
): SandboxDefinition => {
  if (!idPattern.test(options.id)) {
    throw new SandboxValidationError(
      `Invalid sandbox id "${options.id}": use letters, digits, underscores and hyphens, starting with a letter, up to 64 characters`,
    );
  }

  const definition: SandboxDefinition = Object.freeze({
    ...options,
    kind: "inngest/sandbox.definition" as const,
    with: (withOptions: { model?: boolean }) => {
      return Object.freeze({
        ...definition,
        ...(withOptions.model !== undefined && { model: withOptions.model }),
      });
    },
  });

  return definition;
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
 *   tools: sandbox.tools.defaults,
 * });
 * ```
 */
export const sandbox = Object.assign(
  defineSandbox as {
    <TTools extends SandboxToolRecord = (typeof builtinTools)["defaults"]>(
      options: SandboxDefinitionOptions<TTools> & { repo?: undefined },
    ): SandboxDefinition<TTools>;
    <
      TTools extends SandboxToolRecord = (typeof builtinTools)["defaults"],
      const TRepo extends RepoValue = RepoValue,
    >(
      options: SandboxDefinitionOptions<TTools> & { repo: TRepo },
    ): SandboxDefinition<TTools & RepoMarker<TRepo>>;
  },
  {
    image,
    tools: builtinTools,
  },
);

/**
 * The shell's place in a thread's sandbox: read when the shell starts, and
 * kept when the sandbox is closed or recycled.
 */
export interface SandboxShellPlace {
  /**
   * Opens the sandbox and returns where the thread's last run left the shell.
   * Undefined for a sandbox that is new (not resumed or restored).
   */
  load(): Promise<ShellPlace | undefined>;

  /**
   * Gives the place to keep when the sandbox is closed or recycled.
   */
  track(read: () => ShellPlace | undefined): void;
}

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
   * What happens to the sandbox when the run is done with it. See
   * `SandboxBinding.idle`.
   */
  readonly idle: SandboxIdle;

  /**
   * Whether the model gets this sandbox's tools.
   */
  readonly model: boolean;

  /**
   * Whether creation has begun.
   */
  readonly started: boolean;

  /**
   * Where the thread's shell was left, for the handle's shell.
   */
  readonly place: SandboxShellPlace;

  /**
   * The repository, when the definition has one.
   */
  readonly repo?: Repo;

  /**
   * The directory commands start in: the repo's path, else the definition's
   * `cwd`.
   */
  readonly cwd: string;

  /**
   * Runs commands in the sandbox, opening it on first use.
   */
  readonly commands: SandboxHandle["commands"];

  /**
   * Runs a command as one step, from a tagged template, opening it on first use.
   */
  readonly $: SandboxHandle["$"];

  /**
   * Reads and writes files in the sandbox, opening it on first use.
   */
  readonly files: SandboxHandle["files"];

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
   * Sets the sandbox aside now (paused, or saved and destroyed: see `idle`),
   * so the run can go on without it. The next `get()` (or a tool call) brings
   * it back, with the files as they were, and the run is none the wiser.
   * Use it to drop an idle sandbox mid-run, for example while the thread waits
   * for its next message. Does nothing when no sandbox was created, one that
   * was never used is destroyed without a snapshot, and a failed create stays
   * failed. The snapshot is a generation of this run, so the thread's next
   * run restores the newest one. Call it only when nothing is using the
   * sandbox: a command still running in it is lost. Durable: a replay
   * returns the same saves, pauses and destroys.
   *
   * It needs a sandbox that belongs to a thread; without one it throws, since
   * nothing would keep the files. It throws, and leaves the sandbox as it
   * was, when the snapshot could not be taken or the sandbox could not be
   * destroyed. The brought-back sandbox runs the definition's `setup` again
   * (with `restored` true).
   */
  recycle(): Promise<void>;
}

/**
 * A listed sandbox as the handler sees it, such as `sandboxes.work`: it opens
 * on first use, and has the core sandbox's `commands` and `files`.
 */
export interface AgentSandbox {
  /**
   * Runs commands in the sandbox, opening it on first use.
   */
  readonly commands: SandboxHandle["commands"];

  /**
   * Runs a command as one step, from a tagged template: `` $`git status` ``,
   * `` $.sh`a | b` ``, `$(options)`. Starts in the sandbox's `cwd`.
   */
  readonly $: SandboxHandle["$"];

  /**
   * Reads and writes files in the sandbox, opening it on first use.
   */
  readonly files: SandboxHandle["files"];

  /**
   * EXPERIMENTAL: The sandbox's tools, named `<name>_<tool>` (`work_run`), to
   * lend to a child: `agent.start(input, { tools: sandboxes.work.tools })`.
   * The child runs them as steps of its own run against this machine. Only
   * the built-in machine tools (`run`, `read`, `edit`, `write`, `search`,
   * `runCode`) can be lent; `<name>_push` and management are never lent.
   */
  readonly tools: SandboxTools;

  /**
   * Sets the sandbox aside now (paused, or saved and destroyed) and brings a
   * fresh one on the next use. See the thread's sandbox `idle`.
   */
  recycle(): Promise<void>;

  /**
   * Destroys or pauses the sandbox if it was opened. Call it when the run is
   * ending.
   */
  close(): Promise<void>;
}

/**
 * A listed sandbox whose definition has a `repo`.
 */
export interface AgentSandboxWithRepo extends AgentSandbox {
  /**
   * The checked-out repository, and the one push made by the host.
   */
  readonly repo: Repo;
}

/**
 * What the handler gets from an opened sandbox: the handle, and nothing of the
 * SDK's own bookkeeping.
 */
export const agentSandbox = (lazy: LazySandbox): AgentSandbox => {
  const handed: AgentSandbox = {
    ...(lazy.repo && { repo: lazy.repo }),
    commands: lazy.commands,
    $: lazy.$,
    files: lazy.files,
    tools: lazy.tools,
    recycle: () => {
      return lazy.recycle();
    },
    close: () => {
      return lazy.close();
    },
  };

  lendableSandboxes.set(handed, lazy);

  return handed;
};

/**
 * The sandbox behind each `AgentSandbox` the handler got, so a start can lend
 * it by what it is.
 */
const lendableSandboxes = new WeakMap<object, LazySandbox>();

/**
 * The tools of a sandbox and what each is, so a start can lend them: the
 * sandbox it works on, and the built-in tool it is (unset for a tool that
 * can't be lent, such as `push`).
 */
const lendableTools = new WeakMap<
  object,
  { lazy: LazySandbox; builtin?: string; never?: true }
>();

/**
 * What a start lends of one sandbox: where it is and which of its tools.
 */
export interface LentMachine {
  /**
   * The sandbox's ID on the platform.
   */
  id: string;

  /**
   * The directory the child's shell starts in.
   */
  cwd: string;

  /**
   * Whether the child's code gets the sandbox as `sandboxes.<name>`.
   */
  code: boolean;

  /**
   * The tools the child's model gets: the tool's name, and the built-in tool
   * it is.
   */
  tools: { name: string; builtin: string }[];
}

/**
 * The sandbox an `AgentSandbox` of the handler is, for lending.
 */
export const lendableSandbox = (value: unknown): LazySandbox | undefined => {
  return typeof value === "object" && value !== null
    ? lendableSandboxes.get(value)
    : undefined;
};

/**
 * Where a tool of a sandbox is from, for lending. `undefined` for anything
 * that is not a tool of a sandbox.
 */
export const lendableTool = (value: unknown) => {
  return typeof value === "object" && value !== null
    ? lendableTools.get(value)
    : undefined;
};

/**
 * The built-in tool an entry is, by identity: `run`, `read`, and so on. A tool
 * made with `.with()` is a different object and is not one.
 */
export const builtinNameOf = (entry: unknown): string | undefined => {
  return Object.entries(builtinTools).find(([key, value]) => {
    return key !== "defaults" && value === entry;
  })?.[0];
};

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
      : {
          sandbox: binding,
          ...(binding?.model !== undefined && { model: binding.model }),
        };

  if (options.sandbox?.kind !== "inngest/sandbox.definition") {
    throw new SandboxValidationError(
      `Sandbox "${name}" must be a definition made with sandbox(), or { sandbox, start, idle }`,
    );
  }

  if (options.start !== undefined && !startModes.includes(options.start)) {
    throw new SandboxValidationError(
      `Sandbox "${name}" has start "${String(options.start)}": use "lazy" or "eager"`,
    );
  }

  // `{ sandbox, model }` wins; otherwise `sandbox.with({ model })` applies.
  const model = options.model ?? options.sandbox.model;

  if (model !== undefined && typeof model !== "boolean") {
    throw new SandboxValidationError(
      `Sandbox "${name}" has model ${String(model)}: use true or false`,
    );
  }

  if (
    options.idle !== undefined &&
    options.idle !== "pause" &&
    options.idle !== "snapshot"
  ) {
    throw new SandboxValidationError(
      `Sandbox "${name}" has idle "${String(options.idle)}": use "pause" or "snapshot"`,
    );
  }

  return { ...options, model };
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
  const setupRun: DurableSandbox["commands"]["run"] = (...args) => {
    return sandbox.commands.run(scoped(args[0]), args[1], args[2]);
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
      commands: { run: setupRun },
      $: createDollar(setupRun),
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

  /**
   * The skills whose files this sandbox gets, after the checkout and before
   * `setup`.
   */
  skills?: readonly Skill[],

  /**
   * A machine another run lent: the sandbox is adopted by its ID, never
   * created, recycled or destroyed here, and its tools are exactly the lent
   * ones.
   */
  lent?: LentMachine,
): { lazy: LazySandbox; begin: () => void } => {
  if (!namePattern.test(name)) {
    throw new SandboxValidationError(
      `Invalid sandbox name "${name}": use letters, digits and underscores, starting with a letter, up to 64 characters`,
    );
  }

  const {
    sandbox: definition,
    start = "lazy",
    idle = defaultSandboxIdle,
    model = true,
  } = toBinding(name, binding);

  const repoValue =
    toBinding(name, binding).resolvedRepo ??
    (typeof definition.repo === "function" ? undefined : definition.repo);

  if (typeof definition.repo === "function" && !repoValue) {
    throw new SandboxValidationError(
      `Sandbox "${name}" has a repo that is a function, which needs the run's event and thread: open it through an agent's sandboxes`,
    );
  }

  const resolvedRepo: ResolvedRepo | undefined = repoValue && {
    ...repoValue,
    path: repoValue.path ?? "/work",
  };

  let raw: Promise<DurableSandbox> | undefined;
  let created: Promise<DurableSandbox> | undefined;
  let closed: Promise<void> | undefined;
  let guard: DeferHandle | undefined;
  let restored = false;

  // Whether the sandbox was resumed from a pause. Its workspace has no other
  // copy, so it is kept (paused again) even when nothing used it.
  let fromPause = false;

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
  // It saves the sandbox only once `owner.ready()` says its setup has
  // finished.
  const arm = (sandbox: DurableSandbox) => {
    guard =
      owner?.guard(name, sandbox, epoch, idle) ??
      runtime?.guard?.(name, sandbox, epoch);
  };

  // The bare sandbox: restored from the thread's newest snapshot when it has
  // one, else fresh. Its cleanup is armed as soon as it exists.
  const acquire = async (
    options: SandboxCreateFreshOptions,
  ): Promise<DurableSandbox> => {
    if (lent) {
      const found = await sandboxes.get(`${name}:lent:get`, lent.id);

      if (!found) {
        throw new NonRetriableError(
          `The sandbox "${name}" lent to this run (${lent.id}) is gone`,
        );
      }

      return found;
    }

    // The platform takes only a name beside a snapshot (no image, size,
    // environment or secrets), so the definition's environment and secrets are
    // not applied to a restored sandbox. Platform ask: accept them with a
    // snapshotId.
    // Whether a sandbox exists: once it does, an error is not the restore's.
    let existed = false;

    // The thread's paused sandbox comes first: it has the workspace as it
    // was. One that is gone, or can't be resumed, is not an error: the
    // snapshots are next.
    const pausedId = owner ? await owner.takePaused(name) : undefined;

    if (pausedId) {
      try {
        const found = await sandboxes.get(
          `${name}:thread:resume:get`,
          pausedId,
        );

        if (found && ["PAUSED", "RUNNING"].includes(found.status)) {
          const sandbox =
            found.status === "PAUSED"
              ? await found.resume(`${name}:thread:resume`)
              : found;

          existed = true;
          restored = true;
          fromPause = true;
          // The workspace was ready when it was paused: a run cancelled from
          // here pauses it again.
          await owner?.ready(name);
          arm(sandbox);

          return sandbox;
        }
      } catch (error) {
        if (existed || !(error instanceof StepError)) {
          throw error;
        }
      }

      owner?.restoreFailed?.(
        name,
        new Error(`the paused sandbox ${pausedId} is gone or can't be resumed`),
      );
    }

    const candidates = owner ? await owner.restore(name) : [];

    restored = candidates.length > 0;

    const make = async (from: string | undefined) => {
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

    if ((definition.setup || resolvedRepo) && !runtime) {
      return Promise.reject(
        new SandboxValidationError(
          `Sandbox "${name}" has a setup or a repo, which needs the agent's run: open it through an agent's sandboxes`,
        ),
      );
    }

    const setup = definition.setup;

    raw = acquire(options);

    // A lent machine is the lender's: nothing is checked out, placed or set up.
    if (lent) {
      created = raw;

      return created;
    }

    // Setup runs after the sandbox exists. `raw` stays the bare sandbox, so close() destroys it even when setup
    // failed.
    created = raw.then(async (sandbox) => {
      // The checkout comes first, so skill files and setup can use it.
      if (resolvedRepo) {
        const run = (runtime as SandboxRuntime).run;

        await checkoutRepo(
          sandbox,
          resolvedRepo,
          async () => {
            // Minted inside a step, short-lived and read-only.
            return run(`${name}:repo:token`, async () => {
              return (await mintRepoToken(resolvedRepo.auth, "read")) ?? null;
            });
          },
          `${name}:repo:checkout`,
        );
      }

      for (const skill of skills ?? []) {
        for (const file of skill.files) {
          await sandbox.files.write(
            `${name}:skills:${skill.name}:${file.path}`,
            {
              path: `${skillsRoot}/${skill.name}/${file.path}`,
              data: file.data,
            },
          );
        }
      }

      if (setup) {
        await setup(
          setupContext(name, sandbox, runtime as SandboxRuntime, restored),
        );
      }

      return sandbox;
    });

    return created;
  };

  // Marks the sandbox ready to be saved by the run's cleanup: its setup is
  // done and something used it.
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
  let readPlace: (() => ShellPlace | undefined) | undefined;

  // Keeps the shell's place for the thread's next run. Variables named in the
  // definition's `secrets` are injected into every command anyway, so they
  // never land in the thread's KV.
  const keepPlace = async () => {
    const place = readPlace?.();

    if (!place || !owner) {
      return;
    }

    const secretNames = new Set(definition.secrets ?? []);

    await owner.saveShell(name, {
      ...place,
      env: Object.fromEntries(
        Object.entries(place.env).filter(([key]) => {
          return !secretNames.has(key);
        }),
      ),
    });
  };

  const cwd = lent?.cwd ?? definition.cwd ?? "/work";
  const shims = definition.shims?.length ? definition.shims : undefined;
  let shellMade: ReturnType<SandboxHandle["shell"]> | undefined;

  const run: SandboxHandle["commands"]["run"] = async (...args) => {
    // The sandbox's shims go with every command, besides the call's own.
    const options =
      shims === undefined
        ? args[2]
        : { ...args[2], shims: [...shims, ...(args[2]?.shims ?? [])] };

    return (await get()).commands.run(scoped(args[0]), args[1], options);
  };

  const handle: SandboxHandle = {
    cwd: resolvedRepo?.path ?? cwd,
    commands: { run },
    // The same commands as one step each, from a tagged template, starting in `cwd`.
    $: createDollar(run, { cwd: resolvedRepo?.path ?? cwd }),
    shell: () => {
      shellMade ??= (async () => {
        const saved = await place.load();
        const made = createShell(handle.commands.run, {
          cwd: saved?.cwd ?? handle.cwd,
          env: saved?.env,
          unset: saved?.unset,
        });

        readPlace = () => {
          return { cwd: made.cwd, env: made.env, unset: [...made.unset] };
        };

        return made;
      })();

      return shellMade;
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
  const place: SandboxShellPlace = {
    load: async () => {
      await get();

      const saved = restored && owner ? await owner.loadShell(name) : undefined;

      // A new thread's shell starts at the checkout.
      return (
        saved ??
        (resolvedRepo
          ? { cwd: resolvedRepo.path, env: {}, unset: [] }
          : undefined)
      );
    },
    track: (read) => {
      readPlace = read;
    },
  };

  // A sandbox with no `tools` brings `sandbox.tools.defaults`. Each tool acts
  // on this sandbox's handle, and the model can tell which sandbox it is on.
  const brought: Record<string, SandboxToolEntry> =
    definition.tools ?? builtinTools.defaults;

  // Each tool and the built-in tool it is, so a start can lend it.
  const origins: [object, string | undefined, true?][] = [];

  for (const [key, entry] of Object.entries(lent ? {} : brought)) {
    const bound = bindSandbox(entry, handle, name);

    tools[`${name}${toolNamespaceSeparator}${key}`] = bound;
    origins.push([bound as object, builtinNameOf(entry)]);
  }

  // The tools a lender gave: rebuilt from the built-in tools, on this handle.
  for (const given of lent?.tools ?? []) {
    const entry = (builtinTools as unknown as Record<string, SandboxToolEntry>)[
      given.builtin
    ];

    if (!entry || given.builtin === "defaults") {
      throw new NonRetriableError(
        `The tool "${given.name}" lent to this run is "${given.builtin}", which is not a built-in sandbox tool`,
      );
    }

    tools[given.name] = bindSandbox(entry, handle, name);
    origins.push([tools[given.name] as object, given.builtin]);
  }

  const repo = resolvedRepo && createRepo(handle, resolvedRepo);

  // The one push, made by the host: the model's `<sandbox>_push`.
  if (repo && resolvedRepo?.push !== false) {
    tools[`${name}${toolNamespaceSeparator}push`] = bindSandbox(
      tool.group({
        description:
          "Push a local branch of the repository to the remote under the same name. The push is checked first and may be refused. It never forces and never deletes.",
        input: z.object({
          branch: z
            .string()
            .describe("The local branch to push, such as agent/fix-typo"),
        }),
        run: async ({ branch }) => {
          try {
            return await repo.push(branch);
          } catch (error) {
            if (
              error instanceof PushRefusedError ||
              error instanceof NonRetriableError
            ) {
              return agent.toolError(error.message);
            }

            throw error;
          }
        },
      }),
      handle,
      name,
    );
    // Never lent: the push is made by the lender's host, with its token.
    origins.push([
      tools[`${name}${toolNamespaceSeparator}push`] as object,
      undefined,
      true,
    ]);
  }

  validateTools(tools);

  const lazy: LazySandbox = {
    name,
    definition,
    start,
    idle,
    model,
    get started() {
      return raw !== undefined;
    },
    commands: handle.commands,
    $: handle.$,
    files: handle.files,
    place,
    ...(repo && { repo }),
    cwd: handle.cwd,
    tools,
    get,
    recycle: () => {
      if (lent) {
        throw new SandboxValidationError(
          `Sandbox "${name}" was lent to this run, so it can't be recycled: it belongs to the run that lent it`,
        );
      }

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

        // With no owner (no KV store) nothing is kept: the sandbox is
        // destroyed and the next `get()` starts a fresh one.
        let saved = false;

        // The sandbox stays running when a recycle fails after a save, so its
        // cleanup defer moves to the new epoch: it must save what the sandbox
        // writes from here on as a later generation, not skip it as already
        // saved. The new defer is registered before the old one is dropped.
        const rearm = () => {
          const old = guard;

          guard =
            owner?.guard(name, sandbox, epoch, idle) ??
            runtime?.guard?.(name, sandbox, epoch);
          old?.abort();
        };

        let paused = false;

        if (owner && (used || fromPause)) {
          await keepPlace();
        }

        if (owner && (used || fromPause) && idle === "pause") {
          paused = await owner.pause(name, sandbox, epoch);

          // A pause that worked took its generation.
          if (paused) {
            epoch++;
          }
        }

        if (paused) {
          saved = true;
        } else if (owner && (used || fromPause)) {
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

        if (paused) {
          // Nothing to destroy: the pause is the thread's record of it.
          guard?.abort();
        } else {
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
        }

        // The next `get()` starts over, from the snapshot or pause just taken. This
        // comes first so that nothing after the destroy can leave a destroyed
        // sandbox as the current one.
        raw = undefined;
        shellMade = undefined;
        readPlace = undefined;
        created = undefined;
        ready = undefined;
        guard = undefined;
        used = false;
        restored = false;
        fromPause = false;

        if (!saved) {
          epoch++;
        }

        // If forgetting the ready mark fails for good, the mark stays and the
        // new sandbox looks ready while its setup runs. A run cancelled in
        // that window would save it half set up.
        await owner?.release(name);
      });

      recycling = next.catch(() => {});

      return next;
    },
    close: () => {
      // A lent machine is never destroyed or paused here.
      if (lent) {
        return Promise.resolve();
      }

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
          const worthKeeping = (!failed && used) || fromPause;

          // A pause keeps the sandbox for the thread's next run; one that
          // could not be paused is saved and destroyed like any other.
          let paused = false;

          if (worthKeeping) {
            await keepPlace();
          }

          if (worthKeeping && owner && idle === "pause") {
            paused = await owner.pause(name, sandbox, epoch);
          }

          if (worthKeeping && !paused) {
            await owner?.save(name, sandbox, epoch);
          }

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

          if (paused) {
            cleanup?.abort();
            // The run is over: a retry could not use a paused sandbox.
            getAsyncCtxSync()?.execution?.instance.failFinally();
          } else {
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

  for (const [entry, builtin, never] of origins) {
    lendableTools.set(entry, {
      lazy,
      ...(builtin && { builtin }),
      ...(never && { never }),
    });
  }

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
  const bindings = (await resolveRunField(config ?? {}, ctx)) as unknown;

  if (typeof bindings !== "object" || bindings === null) {
    throw new SandboxValidationError(
      "sandboxes must be an object of sandbox bindings by name",
    );
  }

  // A definition's repo, evaluated once for the run.
  const repoOf = async (
    definition: SandboxDefinition,
  ): Promise<RepoConfig | undefined> => {
    return typeof definition.repo === "function"
      ? await (definition.repo as (context: Ctx) => Promise<RepoConfig>)(ctx)
      : undefined;
  };

  const entries = await Promise.all(
    Object.entries(bindings).map(async ([name, binding]) => {
      if (typeof binding !== "object" || !binding || !("sandbox" in binding)) {
        const resolvedRepo = await repoOf(binding as SandboxDefinition);

        return [
          name,
          resolvedRepo
            ? ({
                sandbox: binding as SandboxDefinition,
                resolvedRepo,
              } as SandboxBinding)
            : (binding as SandboxDefinition),
        ] as const;
      }

      const start = await resolveRunField(
        (binding as SandboxBinding<RunField<SandboxStart, Ctx>>).start,
        ctx,
      );

      return [
        name,
        {
          ...binding,
          start,
          resolvedRepo: await repoOf(
            (binding as SandboxBinding).sandbox as SandboxDefinition,
          ),
        } as SandboxBinding,
      ] as const;
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
   * What a sandbox with a setup needs from the run.
   */
  runtime?: SandboxRuntime,

  /**
   * The thread the sandboxes belong to. With it, each sandbox is restored from the thread's newest snapshot on first use, and snapshotted when the run closes it.
   */
  owner?: ThreadSandboxOwner,

  /**
   * The agent's skills. Their files go to the first sandbox the model can use.
   */
  skills?: readonly Skill[],

  /**
   * Machines another run lent, by name. Each replaces the binding of the same
   * name: the sandbox is the lender's, adopted by its ID.
   */
  lent?: Record<string, LentMachine>,
): Record<string, LazySandbox> => {
  const opened: Record<string, LazySandbox> = {};
  const begins: (() => void)[] = [];
  let placed = false;

  // Every binding is validated before any eager one starts, so a bad binding
  // leaves nothing running.
  for (const [name, binding] of Object.entries(bindings)) {
    if (lent && Object.hasOwn(lent, name)) {
      continue;
    }

    const forModel = toBinding(name, binding).model !== false;
    const { lazy, begin } = lazySandbox(
      name,
      binding,
      sandboxes,
      runtime,
      owner,
      forModel && !placed ? skills : undefined,
    );

    placed = placed || forModel;

    opened[name] = lazy;
    begins.push(begin);
  }

  for (const [name, machine] of Object.entries(lent ?? {})) {
    const { lazy } = lazySandbox(
      name,
      { sandbox: defineSandbox({ id: name }), model: machine.tools.length > 0 },
      sandboxes,
      runtime,
      undefined,
      undefined,
      machine,
    );

    opened[name] = lazy;
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
      return handle.model ? Object.entries(handle.tools) : [];
    }),
  );
};

/**
 * Agent tools by name, for `agent.loop()`. The name is the tool's `id`, which a tool in
 * this list must have.
 */
export const agentTools = (tools: readonly AgentTool[]): SandboxTools => {
  return toolsByName(
    tools.map((entry) => {
      if (entry.id === undefined) {
        throw new SandboxValidationError(
          "A tool in a list needs an id: it has no key to name it",
        );
      }

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
