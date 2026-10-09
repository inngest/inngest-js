import {
  operationProcessId,
  operationSandboxId,
  operationSnapshotId,
  type SandboxOperationResultV1,
  type SandboxOperationV1,
} from "./protocol.ts";
import type { SandboxError } from "./types.ts";

/**
 * The metadata kind attached to every step behind `step.sandbox`.
 */
export const sandboxMetadataKind = "inngest.sandbox";

/**
 * The facade method a user calls for each action, where it isn't the action's
 * own name. Methods that share an action, like `snapshot.clone()` and
 * `create()`, are named by the action.
 */
const methodForAction: Partial<Record<SandboxOperationV1["action"], string>> = {
  exec: "commands.run",
  "process.start": "processes.start",
  "process.list": "processes.list",
  "process.get": "processes.get",
  "process.output": "process.getOutput",
  "snapshot.list": "snapshots.list",
  "snapshot.get": "snapshots.get",
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
export type SandboxTraceMetadata = {
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
};

/**
 * Commands can be up to 32 KiB of argv, and a run's metadata is capped at
 * 1 MiB, so a trace only keeps enough of a command to recognise it.
 */
const maxCommandMetadataChars = 1_024;

const commandMetadata = (
  argv: readonly string[],
): Partial<SandboxTraceMetadata> => {
  let remaining = maxCommandMetadataChars;
  const command: string[] = [];
  for (const argument of argv) {
    if (remaining <= 0) {
      break;
    }
    command.push(argument.slice(0, remaining));
    remaining -= argument.length;
  }

  const isShellScript =
    command.length === 3 && command[0] === "/bin/sh" && command[1] === "-c";

  return {
    command,
    // `commands.run("npm test")` runs as `/bin/sh -c "npm test"`; show what
    // the user wrote.
    command_display: isShellScript ? command[2] : undefined,
    command_truncated:
      remaining < 0 || command.length < argv.length || undefined,
  };
};

/**
 * What the operation targets. This comes from the operation, not its result,
 * so a failed step still names its machine.
 */
const targetMetadata = (
  operation: SandboxOperationV1,
): Partial<SandboxTraceMetadata> => {
  const [input] = operation.input;
  const command =
    input && "command" in input
      ? input.command
      : "target" in operation && "process" in operation.target
        ? operation.target.process.command
        : undefined;

  return {
    sandbox_id: operationSandboxId(operation),
    sandbox_name:
      "target" in operation && "sandbox" in operation.target
        ? operation.target.sandbox.name
        : input && "name" in input
          ? input.name
          : undefined,
    source_snapshot_id:
      input && "snapshotId" in input ? input.snapshotId : undefined,
    process_id: operationProcessId(operation),
    snapshot_id: operationSnapshotId(operation),
    cwd: input && "cwd" in input ? input.cwd : undefined,
    ...(command && commandMetadata(command)),
  };
};

const resultMetadata = (
  result: SandboxOperationResultV1,
): Partial<SandboxTraceMetadata> => {
  switch (result.action) {
    case "create":
    case "get":
    case "waitUntilRunning":
    case "pause":
    case "resume":
      return result.sandbox
        ? { sandbox_id: result.sandbox.id, sandbox_name: result.sandbox.name }
        : {};
    case "exec":
      return {
        exit_code: result.result.exitCode,
        output_truncated: result.result.output.truncated || undefined,
      };
    case "process.start":
    case "process.wait":
      return {
        process_id: result.process.id,
        process_state: result.process.state,
        exit_code: result.process.exitCode,
        termination_signal: result.process.terminationSignal,
      };
    case "process.get":
      return {
        process_state: result.process?.state,
        exit_code: result.process?.exitCode,
        termination_signal: result.process?.terminationSignal,
      };
    case "snapshot.create":
    case "snapshot.waitUntilReady":
      return {
        snapshot_id: result.snapshot.id,
        snapshot_status: result.snapshot.status,
      };
    case "snapshot.get":
      return { snapshot_status: result.snapshot?.status };
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
    method: methodForAction[operation.action] ?? operation.action,
    ...targetMetadata(operation),
    ...("result" in outcome
      ? resultMetadata(outcome.result)
      : { error_code: outcome.error?.code }),
  };

  // `undefined` doesn't survive the wire, so don't send keys for it.
  for (const key of Object.keys(metadata) as (keyof SandboxTraceMetadata)[]) {
    if (metadata[key] === undefined) {
      delete metadata[key];
    }
  }

  return metadata;
};
