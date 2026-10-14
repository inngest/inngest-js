/**
 * @module
 * `sandbox.python()`, `sandbox.typescript()` and their `step.sandbox` forms:
 * run a snippet in a sandbox and get its `return` value back, checked against
 * `schema.output` when one is given. The snippet's command comes from
 * `runnerScripts.ts`; this file runs it and reads the result back from the
 * file it wrote.
 */

import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { StepOptionsOrId } from "../../types.ts";
import { getStepOptions, withSpan } from "../InngestStepTools.ts";
import { NonRetriableError } from "../NonRetriableError.ts";
import { sandboxDefaults, withSandbox } from "./group.ts";
import {
  buildRunner,
  parseRunnerResult,
  type RunnerLanguage,
  type RunnerPlan,
} from "./runnerScripts.ts";
import type {
  DurableSandbox,
  DurableSandboxTools,
  SandboxCommandOptions,
  SandboxCreateFreshOptions,
} from "./types.ts";

export interface RunnerOptions extends SandboxCommandOptions {
  /**
   * JSON values, each available to the snippet as a global of the same name.
   */
  input?: Record<string, unknown>;

  /**
   * What the result must look like. A result that doesn't match fails the
   * step, and the return type is inferred from `output`.
   */
  schema?: { output?: StandardSchemaV1 };
}

type OutputOf<TOptions, TSchema extends StandardSchemaV1> = Omit<
  TOptions,
  "schema"
> & {
  schema: { output: TSchema };
};

/**
 * A runner: its result is typed by `schema.output` when given, or by `T`.
 */
interface Runner<TId, TOptions> {
  <TSchema extends StandardSchemaV1>(
    id: TId,
    code: string,
    options: OutputOf<TOptions, TSchema>,
  ): Promise<StandardSchemaV1.InferOutput<TSchema>>;
  <T = unknown>(id: TId, code: string, options?: TOptions): Promise<T>;
}

/**
 * Run `code` in this sandbox. A top-level `return` is the result.
 */
export type SandboxRunner = Runner<StepOptionsOrId, RunnerOptions>;

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
export type OneShotRunner = Runner<string, OneShotRunnerOptions>;

const titles: Record<RunnerLanguage, string> = {
  python: "Python",
  typescript: "TypeScript",
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
): LocatedPlan => {
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
 * result back from the file the wrapper wrote.
 */
const runPlan = async (
  sandbox: DurableSandbox,
  language: RunnerLanguage,
  idOrOptions: StepOptionsOrId,
  plan: LocatedPlan,
  { schema, ...commandOptions }: Omit<RunnerOptions, "input">,
): Promise<unknown> => {
  const options = getStepOptions(idOrOptions);
  const sibling = (name: string) => {
    return {
      ...options,
      id: `${options.id}:${name}`,
      name: `${titles[language]} ${name}`,
    };
  };

  if (plan.upload) {
    await sandbox.files.write(sibling("payload"), {
      path: plan.upload.path,
      data: plan.upload.content,
    });
  }

  const { stderr, exitCode, stdout } = await sandbox.commands.run(
    idOrOptions,
    plan.command,
    commandOptions,
  );
  if (exitCode !== 0) {
    throw new NonRetriableError(
      `${titles[language]} exited with code ${exitCode}:\n${stderr}`,
      { cause: { exitCode, stdout, stderr } },
    );
  }

  const file = await sandbox.files.read(sibling("result"), plan.resultPath);
  const result = parseRunnerResult(new TextDecoder().decode(file));

  return schema?.output ? validate(language, schema.output, result) : result;
};

/**
 * The `language` runner of a sandbox, as a method of its handle. The sandbox
 * is looked up per call because the handle is built around this method.
 */
export const createSandboxRunner = (
  sandbox: () => DurableSandbox,
  language: RunnerLanguage,
): SandboxRunner => {
  return (async (
    idOrOptions: StepOptionsOrId,
    code: string,
    { input, ...options }: RunnerOptions = {},
  ) => {
    const { id, name } = getStepOptions(idOrOptions);
    const plan = buildPlan(language, id, code, input);

    return withSpan(
      { id, name: name ?? `${titles[language]} ${id}`, kind: language },
      () => {
        return runPlan(sandbox(), language, idOrOptions, plan, options);
      },
    );
  }) as SandboxRunner;
};

/**
 * The `language` runner of `step.sandbox`: one group of create, run and
 * destroy steps.
 */
export const createOneShotRunner = (
  tools: DurableSandboxTools,
  language: RunnerLanguage,
): OneShotRunner => {
  return (async (
    id: string,
    code: string,
    options: OneShotRunnerOptions = {},
  ) => {
    const { input, cwd, timeout, schema, ...create } = options;
    const plan = buildPlan(language, id, code, input);

    return withSandbox(
      tools,
      { kind: language, title: titles[language] },
      { ...sandboxDefaults(id), ...create },
      (sandbox) => {
        return runPlan(
          sandbox,
          language,
          { id: `${id}:run`, name: `Run ${titles[language]}` },
          plan,
          { cwd, timeout, schema },
        );
      },
    );
  }) as OneShotRunner;
};
