import type { DurationLike } from "../../helpers/temporal.ts";
import type { StepOptionsOrId } from "../../types.ts";

export const sandboxProtocolVersion = 1 as const;

export type SandboxDuration = number | string | DurationLike;

export type SandboxStatus =
  | "PENDING"
  | "STARTING"
  | "RUNNING"
  | "PAUSED"
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

export interface SandboxCreateOptions {
  /**
   * Stable identity for an active sandbox. Creating the same name again with
   * the same resources returns the existing sandbox.
   */
  name: string;
  vcpu: number;
  memoryMb: number;
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
   * Replaces the sandbox environment for this command. It is not merged.
   * Omitted or empty uses the guest's default environment.
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
   * Replaces the sandbox environment for this process. It is not merged.
   * Omitted or empty uses the guest's default environment.
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

export type SandboxAction =
  | "create"
  | "list"
  | "get"
  | "exec"
  | "destroy"
  | "process.start"
  | "process.list"
  | "process.get"
  | "process.signal"
  | "process.wait"
  | "process.output"
  | "process.stream"
  | "logs.stream"
  | "file.upload"
  | "file.download";

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
  | "sandbox_process_not_found"
  | "sandbox_process_output_not_retained"
  | "sandbox_process_wait_timed_out"
  | (string & {});

export type SandboxErrorDetail = Record<string, unknown>;

export interface SandboxErrorOptions {
  action: SandboxAction;
  code: SandboxErrorCode;
  message: string;
  status?: number;
  sandboxId?: string;
  processId?: string;
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
  create(options: SandboxCreateOptions): Promise<Sandbox>;
  list(options?: SandboxListOptions): Promise<SandboxListResult<Sandbox>>;
  get(sandboxId: string): Promise<Sandbox | null>;
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
  destroy(idOrOptions: StepOptionsOrId): Promise<SandboxDestroyResult>;
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
}
