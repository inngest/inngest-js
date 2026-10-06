import type {
  SandboxOperationResultV1,
  SandboxOperationV1,
} from "./protocol.ts";
import type { SandboxError } from "./types.ts";

/**
 * The metadata kind attached to every step behind `step.sandbox`.
 */
export const sandboxMetadataKind = "inngest.sandbox";

/**
 * The facade method a user calls for each action. Methods that share an
 * action, like `snapshot.clone()` and `create()`, are named by the action.
 */
const methodForAction: Record<SandboxOperationV1["action"], string> = {
  create: "create",
  list: "list",
  get: "get",
  waitUntilRunning: "waitUntilRunning",
  exec: "commands.run",
  destroy: "destroy",
  pause: "pause",
  resume: "resume",
  "process.start": "processes.start",
  "process.list": "processes.list",
  "process.get": "processes.get",
  "process.signal": "process.signal",
  "process.wait": "process.wait",
  "process.output": "process.getOutput",
  "snapshot.create": "snapshot",
  "snapshot.list": "snapshots.list",
  "snapshot.get": "snapshots.get",
  "snapshot.waitUntilReady": "snapshot.waitUntilReady",
  "snapshot.delete": "snapshot.delete",
};

/**
 * Values of an `inngest.sandbox` metadata entry. Mirrors `SandboxMetadata` in
 * the Inngest server's `pkg/tracing/metadata/sandbox.go`.
 *
 * Each step attempt sends exactly one entry, and it carries the attempt's full
 * value set. The server folds entries for the same span and kind as merge
 * patches, which never clear a key that a later entry omits, so an entry must
 * never rely on an earlier one.
 *
 * Values stay flat: scalars and short string arrays only, no nested objects,
 * so they survive ClickHouse `JSON` and DuckDB `VARIANT` storage unchanged.
 */
export interface SandboxTraceMetadata {
  version: 1;
  action: SandboxOperationV1["action"];
  /**
   * The facade method the user called, like "commands.run" or "snapshot".
   */
  method: string;
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
 * Describe a sandbox step for the trace: what it did, and to which machine.
 * The result is the attempt's whole entry (see `SandboxTraceMetadata`), never
 * a partial update.
 */
export const sandboxTraceMetadata = (
  operation: SandboxOperationV1,
  outcome:
    | { result: SandboxOperationResultV1 }
    | { error: Pick<SandboxError, "code"> | undefined },
): SandboxTraceMetadata => {
  const metadata: SandboxTraceMetadata = {
    version: 1,
    action: operation.action,
    method: methodForAction[operation.action],
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
