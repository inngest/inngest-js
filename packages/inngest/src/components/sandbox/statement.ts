import hashjs from "hash.js";
import {
  type AsyncContext,
  getAsyncCtxSync,
  getAsyncLocalStorage,
  isALSFallback,
} from "../execution/als.ts";

const { sha1 } = hashjs;

/**
 * A sandbox statement scope, as `withSandboxStatement()` stores it.
 */
export type SandboxStatementScope = NonNullable<
  NonNullable<AsyncContext["execution"]>["sandboxStatement"]
>;

/**
 * Options for `withSandboxStatement()`.
 */
export interface SandboxStatementOptions {
  /**
   * The step ID the statement is known by, like a CI command's step ID. It's
   * hashed the way step IDs are, so every step in the scope is grouped under a
   * stable ID that looks like any other. It needn't name a real step; if it
   * does, that step is the statement's own row.
   */
  id: string;

  /**
   * The label a trace titles the statement with. Defaults to `id`.
   */
  name?: string;

  /**
   * The SDK method the statement stands for, like "commands.run" or
   * "processes.start".
   */
  statement: string;

  /**
   * The machine the statement runs on.
   */
  sandbox?: { id: string; name: string };
}

/**
 * The fields a `step.sleep()` inside a sandbox statement carries on its
 * opcode's `opts.sandboxStatement`, for the executor to turn into an
 * `inngest.sandbox` entry with `action: "sleep"` and `role: "internal"`.
 */
export interface SandboxStatementOpts {
  statement: string;
  statement_id: string;
  statement_name: string;
  sandbox_id?: string;
  sandbox_name?: string;
}

/**
 * Hash a statement's step ID the way the engine hashes step IDs.
 */
const hashStatementId = (id: string): string => {
  return sha1().update(id).digest("hex");
};

/**
 * The sandbox statement scope that steps created here belong to, if any.
 */
export const getSandboxStatement = (): SandboxStatementScope | undefined => {
  return getAsyncCtxSync()?.execution?.sandboxStatement;
};

/**
 * The opcode opts a step carries to say which sandbox statement it serves.
 */
export const sandboxStatementOpts = (
  scope: SandboxStatementScope,
): SandboxStatementOpts => {
  return {
    statement: scope.statement,
    statement_id: scope.statementId,
    statement_name: scope.statementName,
    ...(scope.sandbox && {
      sandbox_id: scope.sandbox.id,
      sandbox_name: scope.sandbox.name,
    }),
  };
};

/**
 * EXPERIMENTAL: This API is not yet stable and may change in the future without
 * a major version bump.
 *
 * Run `fn` as one sandbox statement, so a trace shows every step it takes as a
 * single row. Use it when one user-level action is built from several steps,
 * like a long command that starts a process, sleeps, polls and reads output.
 *
 * Inside it, every `step.sandbox` step's `inngest.sandbox` metadata is marked
 * internal to the statement, and every `step.sleep()` carries the statement so
 * the executor describes it too. Outside a function run, or where async
 * context isn't available, `fn` just runs.
 *
 * @example
 * ```ts
 * import { withSandboxStatement } from "inngest/experimental";
 *
 * await withSandboxStatement(
 *   { id: "test", statement: "commands.run", sandbox: box },
 *   async () => {
 *     const proc = await box.processes.start("test › start", { command });
 *     await step.sleep("test › wait #1", "1s");
 *     // ...
 *   },
 * );
 * ```
 */
export const withSandboxStatement = async <T>(
  options: SandboxStatementOptions,
  fn: () => T | Promise<T>,
): Promise<T> => {
  const currentCtx = getAsyncCtxSync();

  if (!currentCtx?.execution || isALSFallback()) {
    return fn();
  }

  const als = await getAsyncLocalStorage();

  const sandboxStatement: SandboxStatementScope = {
    statementId: hashStatementId(options.id),
    statementName: options.name ?? options.id,
    statement: options.statement,
    ...(options.sandbox && {
      sandbox: { id: options.sandbox.id, name: options.sandbox.name },
    }),
  };

  return als.run(
    {
      ...currentCtx,
      execution: { ...currentCtx.execution, sandboxStatement },
    },
    fn,
  );
};
