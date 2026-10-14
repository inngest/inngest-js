/**
 * @module
 * `sandbox.python()`, `sandbox.typescript()` and their `step.sandbox` forms: run a
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
  resultSentinel,
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
  typescript: "TypeScript",
};

/**
 * Durable sandboxes can't upload files, so a payload that doesn't fit in the
 * command is refused.
 */
const payloadPath = "/tmp/inngest-runner.json";

/**
 * The command that runs `code`, refused before any sandbox exists if it
 * can't be sent.
 */
const buildCommand = (
  language: RunnerLanguage,
  code: string,
  input: RunnerOptions["input"],
): string[] => {
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

  return command;
};

const runCommand = async (
  commands: DurableSandbox["commands"],
  language: RunnerLanguage,
  idOrOptions: StepOptionsOrId,
  command: string[],
  commandOptions: SandboxCommandOptions,
): Promise<unknown> => {
  const { stdout, stderr, exitCode, output } = await commands.run(
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

  // The result is printed last and truncation keeps the tail, so a result
  // that is missing from truncated output was too big to keep.
  if (output.truncated && !stdout.includes(resultSentinel)) {
    throw new NonRetriableError(
      `${titles[language]} result was too large to capture`,
    );
  }

  return parseRunnerOutput(stdout, exitCode).result;
};

/**
 * The `language` runner of a sandbox, as a method of its handle. The commands
 * are looked up per call because the handle is built around this method.
 */
export const createSandboxRunner = (
  commands: () => DurableSandbox["commands"],
  language: RunnerLanguage,
): SandboxRunner => {
  return async <T>(
    idOrOptions: StepOptionsOrId,
    code: string,
    { input, ...commandOptions }: RunnerOptions = {},
  ) => {
    return (await runCommand(
      commands(),
      language,
      idOrOptions,
      buildCommand(language, code, input),
      commandOptions,
    )) as T;
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
  return async <T>(
    id: string,
    code: string,
    options: OneShotRunnerOptions = {},
  ) => {
    const { input, cwd, timeout, ...create } = options;
    const command = buildCommand(language, code, input);

    return withSandbox(
      tools,
      { kind: language, title: titles[language] },
      { ...sandboxDefaults(id), ...create },
      (sandbox) => {
        return runCommand(
          sandbox.commands,
          language,
          { id: `${id}:run`, name: `Run ${titles[language]}` },
          command,
          { cwd, timeout },
        ) as Promise<T>;
      },
    );
  };
};
