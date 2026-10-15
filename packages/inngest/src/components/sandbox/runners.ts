/**
 * @module
 * `step.sandbox.python()`, `.typescript()` and `.ruby()`: run a snippet in a
 * sandbox of its own and get its `return` value back, checked against
 * `schema.output` when one is given. The snippet's command comes from
 * `runnerScripts.ts`; this file runs it and reads the result back from the file
 * it wrote.
 */

import type { StandardSchemaV1 } from "@standard-schema/spec";
import { NonRetriableError } from "../NonRetriableError.ts";
import { readParsedFile } from "./durable.ts";
import { sandboxDefaults, withSandbox } from "./group.ts";
import {
  buildRunner,
  parseRunnerResult,
  type RunnerLanguage,
  type RunnerPlan,
} from "./runnerScripts.ts";
import type { SandboxToolsOptions } from "./tools.ts";
import { sdkOrigin } from "./trace.ts";
import {
  type DurableSandbox,
  type DurableSandboxTools,
  type SandboxCommandOptions,
  type SandboxCreateFreshOptions,
  SandboxValidationError,
} from "./types.ts";

export interface RunnerOptions
  extends SandboxCommandOptions,
    SandboxToolsOptions {
  /**
   * JSON values, each available to the snippet as a global of the same name.
   * With `tools`, `tools` is taken.
   */
  input?: Record<string, unknown>;

  /**
   * What the result must look like. A result that doesn't match fails the
   * step, and the return type is inferred from `output`.
   */
  schema?: { output?: StandardSchemaV1 };
}

/**
 * The options of a runner that creates its own sandbox: those of
 * `step.sandbox.create()`, all optional, and those of a command. Anything
 * environment-like belongs to the sandbox.
 */
export type OneShotRunnerOptions = Omit<RunnerOptions, "environment"> &
  Partial<Omit<SandboxCreateFreshOptions, "name" | "snapshotId">>;

/**
 * Create a sandbox, run `code` in it, and destroy it. A top-level `return` is
 * the result, typed by `schema.output` when given, or by `T`.
 */
export interface OneShotRunner {
  <TSchema extends StandardSchemaV1>(
    id: string,
    code: string,
    options: Omit<OneShotRunnerOptions, "schema"> & {
      schema: { output: TSchema };
    },
  ): Promise<StandardSchemaV1.InferOutput<TSchema>>;
  <T = unknown>(
    id: string,
    code: string,
    options?: OneShotRunnerOptions,
  ): Promise<T>;
}

const titles: Record<RunnerLanguage, string> = {
  python: "Python",
  typescript: "TypeScript",
  ruby: "Ruby",
};

type LocatedPlan = RunnerPlan & { resultPath: string };

/**
 * The plan to run `code`, refused before any sandbox exists if the input
 * can't be sent. The files are named for the step so that no two runs in a
 * sandbox share them.
 */
const buildPlan = (
  language: RunnerLanguage,
  id: string,
  code: string,
  input: RunnerOptions["input"],
  tools: RunnerOptions["tools"],
): LocatedPlan => {
  if (tools && input && "tools" in input) {
    throw new SandboxValidationError(
      "input can't be named tools when the runner is given tools",
    );
  }

  const base = `/tmp/inngest-${encodeURIComponent(id)}`;

  const resultPath = `${base}.result.json`;

  return {
    ...buildRunner({
      language,
      code,
      input,
      payloadPath: `${base}.json`,
      resultPath,
    }),
    resultPath,
  };
};

const validate = async (
  language: RunnerLanguage,
  output: StandardSchemaV1,
  value: unknown,
): Promise<unknown> => {
  const result = await output["~standard"].validate(value);
  if (result.issues) {
    const issues = result.issues.map(({ message, path }) => {
      const where = path?.map((key) =>
        String(typeof key === "object" ? key.key : key),
      );

      return where?.length ? `${where.join(".")}: ${message}` : message;
    });

    throw new NonRetriableError(
      `${titles[language]} result didn't match schema.output:\n${issues.join("\n")}`,
    );
  }

  return result.value;
};

/**
 * Upload the payload if it has to be a file, run the command, and read the
 * result back from the file the wrapper wrote. Reading it also parses and
 * validates it, so the step's output is the result itself. The user never
 * wrote these steps, so they are named for what they do and marked as the
 * SDK's own.
 */
const runPlan = async (
  sandbox: DurableSandbox,
  language: RunnerLanguage,
  id: string,
  plan: LocatedPlan,
  { schema, ...commandOptions }: Omit<RunnerOptions, "input">,
): Promise<unknown> => {
  const generated = (name: string, suffix?: string) => {
    return {
      id: suffix ? `${id}:${suffix}` : id,
      name,
      "~origin": sdkOrigin,
    };
  };

  if (plan.upload) {
    await sandbox.files.write(generated("Uploading code", "payload"), {
      path: plan.upload.path,
      data: plan.upload.content,
    });
  }

  const { stderr, exitCode, stdout } = await sandbox.commands.run(
    generated("Running code"),
    plan.command,
    commandOptions,
  );
  if (exitCode !== 0) {
    throw new NonRetriableError(
      `${titles[language]} exited with code ${exitCode}:\n${stderr}`,
      { cause: { exitCode, stdout, stderr } },
    );
  }

  return readParsedFile(
    sandbox,
    generated("Gathering result", "result"),
    plan.resultPath,
    (file) => {
      const result = parseRunnerResult(new TextDecoder().decode(file));

      return schema?.output
        ? validate(language, schema.output, result)
        : result;
    },
  );
};

/**
 * The `language` runner of `step.sandbox`: one group of create, run and
 * destroy steps.
 */
export const createOneShotRunner = (
  sandboxTools: DurableSandboxTools,
  language: RunnerLanguage,
): OneShotRunner => {
  return (async (
    id: string,
    code: string,
    options: OneShotRunnerOptions = {},
  ) => {
    const { input, cwd, timeout, schema, tools, toolOptions, ...create } =
      options;
    const plan = buildPlan(language, id, code, input, tools);

    return withSandbox(
      sandboxTools,
      { kind: language },
      { ...sandboxDefaults(id), ...create },
      (sandbox) => {
        return runPlan(sandbox, language, `${id}:run`, plan, {
          cwd,
          timeout,
          schema,
          tools,
          toolOptions,
        });
      },
      {
        create: { name: "Creating sandbox", "~origin": sdkOrigin },
        destroy: { name: "Destroying sandbox", "~origin": sdkOrigin },
      },
    );
  }) as OneShotRunner;
};
