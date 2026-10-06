import type {
  SandboxOperationResultV1,
  SandboxOperationV1,
} from "./protocol.ts";
import type { SandboxStatementScope } from "./statement.ts";
import type { SandboxError } from "./types.ts";

/**
 * The metadata kind attached to every step behind `step.sandbox`.
 */
export const sandboxMetadataKind = "inngest.sandbox";

/**
 * How a step relates to the code the user wrote.
 *
 * A "statement" step is the one the user called, like `box.snapshot("snap")`,
 * and is the row a trace shows. An "internal" step is extra work done to serve
 * that statement, like waiting for the snapshot to be ready.
 */
export type SandboxTraceRole = "statement" | "internal";

/**
 * Trace context the durable facade passes along with each operation, so the
 * step can describe the statement it belongs to.
 */
export interface SandboxStepTrace {
  /**
   * The facade method the user called, like "commands.run" or "snapshot".
   */
  statement: string;

  /**
   * For an internal step, the operation of the statement step it serves. The
   * middleware resolves it to that step's ID.
   */
  statementOperation?: SandboxOperationV1;

  /**
   * The machine the statement acts on, for internal steps whose own operation
   * doesn't name it (a snapshot readiness wait only names the snapshot).
   */
  sandbox?: { id: string; name: string };
}

/**
 * Values of an `inngest.sandbox` metadata entry. Mirrors `SandboxMetadata` in
 * the Inngest server's `pkg/tracing/metadata/sandbox.go`.
 */
export interface SandboxTraceMetadata {
  version: 1;
  action: SandboxOperationV1["action"];
  statement: string;
  statement_id: string;
  role: SandboxTraceRole;
  statement_name?: string;
  sandbox_id?: string;
  sandbox_name?: string;
  source_snapshot_id?: string;
  command?: string[];
  command_display?: string;
  command_truncated?: boolean;
  cwd?: string;
  process_id?: string;
  process_state?: string;
  exit_code?: number;
  termination_signal?: number;
  output_truncated?: boolean;
  snapshot_id?: string;
  snapshot_status?: string;
  error_code?: string;
}

/**
 * Commands can be up to 32 KiB of argv, and a run's metadata is capped at
 * 1 MiB, so a trace only keeps enough of a command to recognise it.
 */
const maxCommandMetadataChars = 1_024;

const commandMetadata = (
  argv: readonly string[],
): Pick<
  SandboxTraceMetadata,
  "command" | "command_display" | "command_truncated"
> => {
  let remaining = maxCommandMetadataChars;
  let truncated = false;
  const command: string[] = [];
  for (const argument of argv) {
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    if (argument.length > remaining) {
      command.push(argument.slice(0, remaining));
      truncated = true;
      break;
    }
    command.push(argument);
    remaining -= argument.length;
  }

  // `commands.run("npm test")` runs as `/bin/sh -c "npm test"`; show what the
  // user wrote.
  const shellScript =
    command.length === 3 && command[0] === "/bin/sh" && command[1] === "-c"
      ? command[2]
      : undefined;

  return {
    command,
    ...(shellScript !== undefined && { command_display: shellScript }),
    ...(truncated && { command_truncated: true }),
  };
};

const targetMetadata = (
  operation: SandboxOperationV1,
): Partial<SandboxTraceMetadata> => {
  switch (operation.action) {
    case "create": {
      const [options] = operation.input;
      return {
        sandbox_name: options.name,
        ...("snapshotId" in options &&
          options.snapshotId !== undefined && {
            source_snapshot_id: options.snapshotId,
          }),
      };
    }
    case "get":
      return { sandbox_id: operation.input[0].sandboxId };
    case "exec": {
      const [options] = operation.input;
      return {
        sandbox_id: operation.target.sandbox.id,
        sandbox_name: operation.target.sandbox.name,
        ...commandMetadata(options.command),
        ...(options.cwd !== undefined && { cwd: options.cwd }),
      };
    }
    case "process.start": {
      const [options] = operation.input;
      return {
        sandbox_id: operation.target.sandbox.id,
        sandbox_name: operation.target.sandbox.name,
        ...commandMetadata(options.command),
        ...(options.cwd !== undefined && { cwd: options.cwd }),
      };
    }
    case "process.get":
      return {
        sandbox_id: operation.target.sandbox.id,
        sandbox_name: operation.target.sandbox.name,
        process_id: operation.target.processId,
      };
    case "process.signal":
    case "process.wait":
    case "process.output":
      return {
        sandbox_id: operation.target.sandbox.id,
        sandbox_name: operation.target.sandbox.name,
        process_id: operation.target.process.id,
        ...commandMetadata(operation.target.process.command),
      };
    case "snapshot.get":
      return { snapshot_id: operation.target.snapshotId };
    case "snapshot.waitUntilReady":
    case "snapshot.delete":
      return { snapshot_id: operation.target.snapshot.id };
    case "list":
    case "snapshot.list":
      return {};
    default:
      return {
        sandbox_id: operation.target.sandbox.id,
        sandbox_name: operation.target.sandbox.name,
      };
  }
};

const resultMetadata = (
  result: SandboxOperationResultV1,
): Partial<SandboxTraceMetadata> => {
  switch (result.action) {
    case "create":
    case "waitUntilRunning":
    case "pause":
    case "resume":
      return {
        sandbox_id: result.sandbox.id,
        sandbox_name: result.sandbox.name,
      };
    case "get":
      return result.sandbox
        ? { sandbox_id: result.sandbox.id, sandbox_name: result.sandbox.name }
        : {};
    case "exec":
      return {
        exit_code: result.result.exitCode,
        ...(result.result.output.truncated && { output_truncated: true }),
      };
    case "process.start":
    case "process.wait":
      return {
        process_id: result.process.id,
        process_state: result.process.state,
        ...(result.process.exitCode !== undefined && {
          exit_code: result.process.exitCode,
        }),
        ...(result.process.terminationSignal !== undefined && {
          termination_signal: result.process.terminationSignal,
        }),
      };
    case "process.get":
      return result.process
        ? {
            process_state: result.process.state,
            ...(result.process.exitCode !== undefined && {
              exit_code: result.process.exitCode,
            }),
          }
        : {};
    case "snapshot.create":
    case "snapshot.waitUntilReady":
      return {
        snapshot_id: result.snapshot.id,
        snapshot_status: result.snapshot.status,
      };
    case "snapshot.get":
      return result.snapshot ? { snapshot_status: result.snapshot.status } : {};
    default:
      return {};
  }
};

/**
 * Describe a sandbox step for the trace: what it did, to which machine, and
 * which user-level statement it belongs to.
 */
export const sandboxTraceMetadata = ({
  operation,
  trace,
  stepId,
  statementId,
  statementScope,
  outcome,
}: {
  operation: SandboxOperationV1;
  trace: SandboxStepTrace;
  /** This step's ID. */
  stepId: string;
  /** The statement step's ID, for an internal step. */
  statementId?: string;
  /**
   * The sandbox statement the step was called in, from
   * `withSandboxStatement()`. It takes over from the facade call, so every
   * step in the scope shares one row.
   */
  statementScope?: SandboxStatementScope;
  outcome:
    | { result: SandboxOperationResultV1 }
    | { error: Pick<SandboxError, "code"> | undefined };
}): SandboxTraceMetadata => {
  const internal = trace.statementOperation !== undefined;
  const metadata: SandboxTraceMetadata = statementScope
    ? {
        version: 1,
        action: operation.action,
        statement: statementScope.statement,
        statement_id: statementScope.statementId,
        // The statement's ID can name a real step, like a short CI command
        // that runs as one `commands.run`. That step is the row itself.
        role: stepId === statementScope.statementId ? "statement" : "internal",
        statement_name: statementScope.statementName,
        ...(statementScope.sandbox && {
          sandbox_id: statementScope.sandbox.id,
          sandbox_name: statementScope.sandbox.name,
        }),
        ...targetMetadata(operation),
      }
    : {
        version: 1,
        action: operation.action,
        statement: trace.statement,
        statement_id: (internal && statementId) || stepId,
        role: internal ? "internal" : "statement",
        ...(trace.sandbox && {
          sandbox_id: trace.sandbox.id,
          sandbox_name: trace.sandbox.name,
        }),
        ...targetMetadata(operation),
      };

  if ("result" in outcome) {
    Object.assign(metadata, resultMetadata(outcome.result));
  } else if (outcome.error) {
    metadata.error_code = outcome.error.code;
  }

  // `undefined` doesn't survive the wire, so don't send keys for it.
  for (const key of Object.keys(metadata) as (keyof SandboxTraceMetadata)[]) {
    if (metadata[key] === undefined) {
      delete metadata[key];
    }
  }

  return metadata;
};
