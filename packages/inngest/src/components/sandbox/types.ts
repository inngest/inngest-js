import type { DurationLike } from "../../helpers/temporal.ts";
import type { StepOptionsOrId } from "../../types.ts";

export const sandboxProtocolVersion = 1 as const;

export type SandboxDuration = number | string | DurationLike;

export type SandboxStatus =
  | "PENDING"
  | "STARTING"
  | "PAUSING"
  | "RUNNING"
  | "PAUSED"
  | "RESUMING"
  | "TERMINATING"
  | "TERMINATED"
  | "FAILED";

export interface SandboxResources {
  readonly vcpu: number;
  readonly memoryMb: number;
}

export interface SandboxResource {
  id: string;
  name: string;
  status: SandboxStatus;
  vpcId: string;
  imageRef: string;
  resources: SandboxResources;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  error?: string;
}

export interface SandboxRef extends SandboxResource {
  kind: "inngest/sandbox";
  version: 1;
}

interface SandboxCreateBaseOptions {
  /**
   * Stable identity for an active sandbox. Creating the same name again with
   * the same configuration returns the existing sandbox. Names are
   * case-sensitive and may contain up to 255 characters.
   */
  name: string;

  /** Wait up to this duration for the sandbox to reach RUNNING. */
  runningTimeout?: SandboxDuration;
}

export interface SandboxCreateFreshOptions extends SandboxCreateBaseOptions {
  vcpu: number;
  memoryMb: number;

  /**
   * Environment inherited by commands and managed processes. Values are
   * persisted as literal sandbox configuration; this is not a secrets
   * mechanism, so do not use this field for secrets. Guest defaults are
   * retained, and operation-specific values override matching keys.
   */
  environment?: Record<string, string>;

  snapshotId?: never;
}

export interface SandboxCreateFromSnapshotOptions
  extends SandboxCreateBaseOptions {
  snapshotId: string;
  vcpu?: never;
  memoryMb?: never;
  environment?: never;
}

export type SandboxCreateOptions =
  | SandboxCreateFreshOptions
  | SandboxCreateFromSnapshotOptions;

export interface SandboxWaitUntilRunningOptions {
  timeout: SandboxDuration;
}

export interface SandboxListOptions {
  cursor?: string;
  limit?: number;
}

export interface SandboxPageInfo {
  cursor?: string;
  hasMore: boolean;
  limit: number;
}

export interface SandboxListResult<TSandbox = SandboxRef> {
  items: TSandbox[];
  page: SandboxPageInfo;
  fetchedAt: string;
}

export interface SandboxCommandOptions {
  command: readonly string[];

  /**
   * Overrides matching sandbox environment values for this command.
   * Omitted or empty inherits the sandbox environment unchanged.
   */
  environment?: Record<string, string>;
  cwd?: string;
  timeout?: SandboxDuration;
}

export type SandboxCommandOutputMetadata =
  | {
      truncated: false;
    }
  | {
      truncated: true;
      strategy: "tail";
      originalBytes: {
        stdout: number;
        stderr: number;
      };
      retainedBytes: {
        stdout: number;
        stderr: number;
      };
    };

export interface SandboxCommandResult {
  stdout: Uint8Array;
  stderr: Uint8Array;
  exitCode: number;
  output: SandboxCommandOutputMetadata;
}

export type SandboxDestroyResult =
  | {
      status: "TERMINATING";
      sandbox: SandboxRef;
    }
  | {
      status: "TERMINATED";
      sandbox: null;
    };

export type SandboxProcessState =
  | "STARTING"
  | "RUNNING"
  | "EXITED"
  | "KILLED"
  | "FAILED"
  | "LOST";

export interface SandboxProcessResource {
  id: string;
  command: readonly string[];
  pid?: number;
  state: SandboxProcessState;
  exitCode?: number;
  terminationSignal?: number;
  startedAt?: string;
  endedAt?: string;
}

export interface SandboxProcessRef extends SandboxProcessResource {
  kind: "inngest/sandbox.process";
  version: 1;
  sandboxId: string;
}

export interface SandboxProcessStartOptions {
  command: readonly string[];

  /**
   * Overrides matching sandbox environment values for this process.
   * Omitted or empty inherits the sandbox environment unchanged.
   */
  environment?: Record<string, string>;
  cwd?: string;
}

export interface SandboxProcessSignalOptions {
  signal: number;
  includeChildren?: boolean;
}

export interface SandboxProcessWaitOptions {
  timeout?: SandboxDuration;
}

export interface SandboxProcessOutputOptions {
  tailBytes?: number;
}

export type SandboxProcessListOptions = SandboxListOptions;
export type SandboxProcessListResult<TProcess = SandboxProcessRef> =
  SandboxListResult<TProcess>;

export interface SandboxOutputChunk {
  stream: "STDOUT" | "STDERR";
  data: Uint8Array;
  at?: string;
}

export interface SandboxProcessOutput {
  chunks: SandboxOutputChunk[];
}

export interface SandboxLogStreamOptions {
  follow?: boolean;
}

export interface SandboxFileUploadOptions {
  path: string;
  data: BodyInit;
  mode?: number;
}

export interface SandboxFileUploadResult {
  path: string;
  bytesWritten: number;
}

export interface SandboxFileDownloadOptions {
  path: string;
}

export type SandboxSnapshotStatus =
  | "CREATING"
  | "READY"
  | "DELETING"
  | "DELETED"
  | "FAILED"
  | "LOST";

export interface SandboxSnapshotResource {
  id: string;
  sourceImageId: string;
  status: SandboxSnapshotStatus;
  compatibilityId?: string;
  resources: SandboxResources;
  memoryPackCount: number;
  diskPackCount: number;
  storedBytes: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  error?: string;
}

export interface SandboxSnapshotRef extends SandboxSnapshotResource {
  kind: "inngest/sandbox.snapshot";
  version: 1;
}

export interface SandboxSnapshotWaitOptions {
  timeout: SandboxDuration;
  signal?: AbortSignal;
}

export interface SandboxLifecycleOptions {
  timeout?: SandboxDuration;
  signal?: AbortSignal;
}

export type SandboxSnapshotCreateOptions = Record<string, never>;
export interface SandboxRestoreOptions {
  snapshotId: string;
}
export interface SandboxSnapshotCloneOptions {
  name: string;
  runningTimeout?: SandboxDuration;
}

export type SandboxSnapshotListOptions = SandboxListOptions;
export type SandboxSnapshotListResult<TSnapshot = SandboxSnapshotRef> =
  SandboxListResult<TSnapshot>;

export type SandboxAction =
  | "create"
  | "list"
  | "get"
  | "waitUntilRunning"
  | "exec"
  | "destroy"
  | "pause"
  | "resume"
  | "restore"
  | "process.start"
  | "process.list"
  | "process.get"
  | "process.signal"
  | "process.wait"
  | "process.output"
  | "process.stream"
  | "logs.stream"
  | "file.upload"
  | "file.download"
  | "snapshot.create"
  | "snapshot.list"
  | "snapshot.get"
  | "snapshot.waitUntilReady"
  | "snapshot.delete";

export type SandboxErrorCode =
  | "access_denied"
  | "compute_unavailable"
  | "internal_error"
  | "invalid_field_format"
  | "invalid_request"
  | "missing_field"
  | "operation_ambiguous"
  | "rate_limited"
  | "sandbox_exec_output_too_large"
  | "sandbox_exec_timed_out"
  | "sandbox_name_taken"
  | "sandbox_not_found"
  | "sandbox_start_failed"
  | "sandbox_start_timed_out"
  | "sandbox_process_not_found"
  | "sandbox_process_output_not_retained"
  | "sandbox_process_wait_timed_out"
  | "sandbox_snapshot_limit_exceeded"
  | "sandbox_snapshot_not_found"
  | "sandbox_snapshot_not_ready"
  | "sandbox_snapshot_wait_timed_out"
  | (string & {});

export type SandboxErrorDetail = Record<string, unknown>;

export interface SandboxErrorOptions {
  action: SandboxAction;
  code: SandboxErrorCode;
  message: string;
  status?: number;
  sandboxId?: string;
  processId?: string;
  snapshotId?: string;
  ambiguous?: boolean;
  retryable?: boolean;
  requestId?: string;
  details?: readonly SandboxErrorDetail[];
  cause?: unknown;
}

export class SandboxValidationError extends Error {
  public override readonly cause?: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "SandboxValidationError";
    this.cause = options?.cause;
  }
}

export class SandboxError extends Error {
  public readonly protocolVersion = sandboxProtocolVersion;
  public readonly action: SandboxAction;
  public readonly code: SandboxErrorCode;
  public readonly status?: number;
  public readonly sandboxId?: string;
  public readonly processId?: string;
  public readonly snapshotId?: string;
  public readonly ambiguous: boolean;
  public readonly retryable: boolean;
  public readonly requestId?: string;
  public readonly details: readonly SandboxErrorDetail[];
  public override readonly cause?: unknown;

  constructor(options: SandboxErrorOptions) {
    super(options.message);
    this.name = "SandboxError";
    this.action = options.action;
    this.code = options.code;
    this.status = options.status;
    this.sandboxId = options.sandboxId;
    this.processId = options.processId;
    this.snapshotId = options.snapshotId;
    this.ambiguous =
      options.ambiguous ?? options.code === "operation_ambiguous";
    this.retryable = options.retryable ?? false;
    this.requestId = options.requestId;
    this.details = options.details ?? [];
    this.cause = options.cause;
  }
}

export interface Sandbox {
  readonly kind: "inngest/sandbox";
  readonly version: 1;
  readonly id: string;
  readonly name: string;
  readonly status: SandboxStatus;
  readonly vpcId: string;
  readonly imageRef: string;
  readonly resources: SandboxResources;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly error?: string;
  readonly commands: {
    run(options: SandboxCommandOptions): Promise<SandboxCommandResult>;
  };
  readonly logs: {
    stream(
      options?: SandboxLogStreamOptions,
    ): Promise<ReadableStream<SandboxOutputChunk>>;
  };
  readonly files: {
    upload(options: SandboxFileUploadOptions): Promise<SandboxFileUploadResult>;
    download(options: SandboxFileDownloadOptions): Promise<Response>;
  };
  readonly processes: {
    start(options: SandboxProcessStartOptions): Promise<SandboxProcess>;
    list(
      options?: SandboxProcessListOptions,
    ): Promise<SandboxProcessListResult<SandboxProcess>>;
    get(processId: string): Promise<SandboxProcess | null>;
  };
  waitUntilRunning(options: SandboxWaitUntilRunningOptions): Promise<Sandbox>;
  pause(options?: SandboxLifecycleOptions): Promise<Sandbox>;
  resume(options?: SandboxLifecycleOptions): Promise<Sandbox>;
  snapshot(
    options?: SandboxSnapshotCreateOptions,
    waitOptions?: SandboxLifecycleOptions,
  ): Promise<SandboxSnapshot>;
  restore(
    options: SandboxRestoreOptions,
    waitOptions?: SandboxLifecycleOptions,
  ): Promise<Sandbox>;
  destroy(): Promise<SandboxDestroyResult>;
}

export interface SandboxProcess {
  readonly kind: "inngest/sandbox.process";
  readonly version: 1;
  readonly sandboxId: string;
  readonly id: string;
  readonly command: readonly string[];
  readonly pid?: number;
  readonly state: SandboxProcessState;
  readonly exitCode?: number;
  readonly terminationSignal?: number;
  readonly startedAt?: string;
  readonly endedAt?: string;
  signal(options: SandboxProcessSignalOptions): Promise<void>;
  wait(options?: SandboxProcessWaitOptions): Promise<SandboxProcess>;
  getOutput(
    options?: SandboxProcessOutputOptions,
  ): Promise<SandboxProcessOutput>;
  streamOutput(
    options?: SandboxProcessOutputOptions,
  ): Promise<ReadableStream<SandboxOutputChunk>>;
}

export interface SandboxClient {
  create(options: SandboxCreateFreshOptions): Promise<Sandbox>;
  list(options?: SandboxListOptions): Promise<SandboxListResult<Sandbox>>;
  get(sandboxId: string): Promise<Sandbox | null>;
  readonly snapshots: {
    list(
      options?: SandboxSnapshotListOptions,
    ): Promise<SandboxSnapshotListResult<SandboxSnapshot>>;
    get(snapshotId: string): Promise<SandboxSnapshot | null>;
  };
}

export interface SandboxSnapshot extends Readonly<SandboxSnapshotRef> {
  clone(
    options: SandboxSnapshotCloneOptions,
    waitOptions?: SandboxLifecycleOptions,
  ): Promise<Sandbox>;
  delete(): Promise<void>;
}

export interface DurableSandbox {
  readonly kind: "inngest/sandbox";
  readonly version: 1;
  readonly id: string;
  readonly name: string;
  readonly status: SandboxStatus;
  readonly vpcId: string;
  readonly imageRef: string;
  readonly resources: SandboxResources;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly error?: string;
  readonly commands: {
    run(
      idOrOptions: StepOptionsOrId,
      options: SandboxCommandOptions,
    ): Promise<SandboxCommandResult>;
  };
  readonly processes: {
    start(
      idOrOptions: StepOptionsOrId,
      options: SandboxProcessStartOptions,
    ): Promise<DurableSandboxProcess>;
    list(
      idOrOptions: StepOptionsOrId,
      options?: SandboxProcessListOptions,
    ): Promise<SandboxProcessListResult<DurableSandboxProcess>>;
    get(
      idOrOptions: StepOptionsOrId,
      processId: string,
    ): Promise<DurableSandboxProcess | null>;
  };
  readonly snapshots: {
    create(
      idOrOptions: StepOptionsOrId,
      options?: SandboxSnapshotCreateOptions,
      waitOptions?: SandboxLifecycleOptions,
    ): Promise<DurableSandboxSnapshot>;
  };
  snapshot(
    idOrOptions: StepOptionsOrId,
    options?: SandboxSnapshotCreateOptions,
    waitOptions?: SandboxLifecycleOptions,
  ): Promise<DurableSandboxSnapshot>;
  pause(
    idOrOptions: StepOptionsOrId,
    options?: SandboxLifecycleOptions,
  ): Promise<DurableSandbox>;
  resume(
    idOrOptions: StepOptionsOrId,
    options?: SandboxLifecycleOptions,
  ): Promise<DurableSandbox>;
  restore(
    idOrOptions: StepOptionsOrId,
    options: SandboxRestoreOptions,
    waitOptions?: SandboxLifecycleOptions,
  ): Promise<DurableSandbox>;
  waitUntilRunning(
    idOrOptions: StepOptionsOrId,
    options: SandboxWaitUntilRunningOptions,
  ): Promise<DurableSandbox>;
  destroy(idOrOptions: StepOptionsOrId): Promise<SandboxDestroyResult>;
}

export interface DurableSandboxSnapshot {
  readonly kind: "inngest/sandbox.snapshot";
  readonly version: 1;
  readonly id: string;
  readonly sourceImageId: string;
  readonly status: SandboxSnapshotStatus;
  readonly compatibilityId?: string;
  readonly resources: SandboxResources;
  readonly memoryPackCount: number;
  readonly diskPackCount: number;
  readonly storedBytes: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string;
  readonly error?: string;
  waitUntilReady(
    idOrOptions: StepOptionsOrId,
    options: SandboxSnapshotWaitOptions,
  ): Promise<DurableSandboxSnapshot>;
  delete(idOrOptions: StepOptionsOrId): Promise<void>;
  clone(
    idOrOptions: StepOptionsOrId,
    options: SandboxSnapshotCloneOptions,
    waitOptions?: SandboxLifecycleOptions,
  ): Promise<DurableSandbox>;
}

export interface DurableSandboxProcess {
  readonly kind: "inngest/sandbox.process";
  readonly version: 1;
  readonly sandboxId: string;
  readonly id: string;
  readonly command: readonly string[];
  readonly pid?: number;
  readonly state: SandboxProcessState;
  readonly exitCode?: number;
  readonly terminationSignal?: number;
  readonly startedAt?: string;
  readonly endedAt?: string;
  signal(
    idOrOptions: StepOptionsOrId,
    options: SandboxProcessSignalOptions,
  ): Promise<void>;
  wait(
    idOrOptions: StepOptionsOrId,
    options?: SandboxProcessWaitOptions,
  ): Promise<DurableSandboxProcess>;
  getOutput(
    idOrOptions: StepOptionsOrId,
    options?: SandboxProcessOutputOptions,
  ): Promise<SandboxProcessOutput>;
}

export interface DurableSandboxTools {
  create(
    idOrOptions: StepOptionsOrId,
    options: SandboxCreateOptions,
  ): Promise<DurableSandbox>;
  list(
    idOrOptions: StepOptionsOrId,
    options?: SandboxListOptions,
  ): Promise<SandboxListResult<DurableSandbox>>;
  get(
    idOrOptions: StepOptionsOrId,
    sandboxId: string,
  ): Promise<DurableSandbox | null>;
  readonly snapshots: {
    list(
      idOrOptions: StepOptionsOrId,
      options?: SandboxSnapshotListOptions,
    ): Promise<SandboxSnapshotListResult<DurableSandboxSnapshot>>;
    get(
      idOrOptions: StepOptionsOrId,
      snapshotId: string,
    ): Promise<DurableSandboxSnapshot | null>;
  };
}
