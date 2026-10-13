/**
 * @module
 * `sandbox.python()`, `sandbox.ts()` and their `step.sandbox` forms: run a
 * snippet in a sandbox and get its `return` value back. The snippet's command
 * comes from `runnerScripts.ts`; this file runs it and unpacks the result.
 */

import type { StepOptionsOrId } from "../../types.ts";
import { NonRetriableError } from "../NonRetriableError.ts";
import { sandboxDefaults, withSandbox } from "./group.ts";
import {
  buildRunner,
  parseRunnerOutput,
  type RunnerLanguage,
} from "./runnerScripts.ts";
import {
  type DurableSandbox,
  type DurableSandboxTools,
  type SandboxCommandOptions,
  type SandboxCreateFreshOptions,
  SandboxValidationError,
} from "./types.ts";

export interface RunnerOptions extends SandboxCommandOptions {
  /**
   * JSON values, each available to the snippet as a global of the same name.
   */
  input?: Record<string, unknown>;
}

/**
 * Run `code` in this sandbox. A top-level `return` is the result.
 */
export type SandboxRunner = <T = unknown>(
  idOrOptions: StepOptionsOrId,
  code: string,
  options?: RunnerOptions,
) => Promise<T>;

/**
 * The options of a runner that creates its own sandbox: those of
 * `step.sandbox.create()`, all optional, and those of a command. Anything
 * environment-like belongs to the sandbox.
 */
export type OneShotRunnerOptions = Omit<RunnerOptions, "environment"> &
  Partial<Omit<SandboxCreateFreshOptions, "name" | "snapshotId">>;

/**
 * Create a sandbox, run `code` in it, and destroy it.
 */
export type OneShotRunner = <T = unknown>(
  id: string,
  code: string,
  options?: OneShotRunnerOptions,
) => Promise<T>;

const titles: Record<RunnerLanguage, string> = {
  python: "Python",
  ts: "TypeScript",
};

/**
 * Durable sandboxes can't upload files, so a payload that doesn't fit in the
 * command is refused.
 */
const payloadPath = "/tmp/inngest-runner.json";

const runCode = async (
  commands: DurableSandbox["commands"],
  language: RunnerLanguage,
  idOrOptions: StepOptionsOrId,
  code: string,
  { input, ...commandOptions }: RunnerOptions = {},
): Promise<unknown> => {
  const { command, upload } = buildRunner({
    language,
    code,
    input,
    payloadPath,
  });
  if (upload) {
    throw new SandboxValidationError(
      `${titles[language]} code and input must be under 16 KiB`,
    );
  }

  const { stdout, stderr, exitCode } = await commands.run(
    idOrOptions,
    command,
    commandOptions,
  );
  if (exitCode !== 0) {
    throw new NonRetriableError(
      `${titles[language]} exited with code ${exitCode}:\n${stderr}`,
      { cause: { exitCode, stdout, stderr } },
    );
  }

  return parseRunnerOutput(stdout).result;
};

/**
 * The `language` runner of a sandbox, as a method of its handle. The commands
 * are looked up per call because the handle is built around this method.
 */
export const createSandboxRunner = (
  commands: () => DurableSandbox["commands"],
  language: RunnerLanguage,
): SandboxRunner => {
  return <T>(
    idOrOptions: StepOptionsOrId,
    code: string,
    options?: RunnerOptions,
  ) => {
    return runCode(
      commands(),
      language,
      idOrOptions,
      code,
      options,
    ) as Promise<T>;
  };
};

/**
 * The `language` runner of `step.sandbox`: one group of create, run and
 * destroy steps.
 */
export const createOneShotRunner = (
  tools: DurableSandboxTools,
  language: RunnerLanguage,
): OneShotRunner => {
  return <T>(id: string, code: string, options: OneShotRunnerOptions = {}) => {
    const { input, cwd, timeout, ...create } = options;

    return withSandbox(
      tools,
      { kind: language, title: titles[language] },
      { ...sandboxDefaults(id), ...create },
      (sandbox) => {
        return runCode(
          sandbox.commands,
          language,
          { id: `${id}:run`, name: `Run ${titles[language]}` },
          code,
          { input, cwd, timeout },
        ) as Promise<T>;
      },
    );
  };
};
