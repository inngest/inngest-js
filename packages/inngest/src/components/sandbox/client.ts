import { z } from "zod/v3";

import {
  type Sandbox,
  type SandboxAction,
  type SandboxClient,
  type SandboxDestroyResult,
  SandboxError,
  type SandboxErrorCode,
  type SandboxErrorDetail,
  type SandboxFileUploadResult,
  type SandboxOutputChunk,
  type SandboxProcess,
  type SandboxRef,
  type SandboxStatus,
  SandboxValidationError,
} from "./types.ts";
import {
  canonicalUuidSchema,
  decodeBase64,
  decodeOutputChunk,
  normalizeFileDownloadOptions,
  normalizeFileUploadOptions,
  normalizeSandboxCommandOptions,
  normalizeSandboxCreateOptions,
  normalizeSandboxListOptions,
  normalizeSandboxProcessListOptions,
  normalizeSandboxProcessOutputOptions,
  normalizeSandboxProcessSignalOptions,
  normalizeSandboxProcessStartOptions,
  normalizeSandboxProcessWaitOptions,
  normalizeSandboxWaitUntilRunningOptions,
  parseWithSchema,
  restOutputChunkSchema,
  sandboxProcessRefFromResource,
  sandboxProcessRefSchema,
  sandboxRefFromResource,
  sandboxRefSchema,
} from "./validation.ts";

type FetchT = typeof fetch;

export interface SandboxClientConfig {
  baseUrl: () => string;
  apiKey: () => string | undefined;
  headers: () => Record<string, string>;
  fetch: () => FetchT;
}

const metadataSchema = z.object({ fetchedAt: z.string().min(1) }).passthrough();
const errorItemSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
  })
  .passthrough();
const errorEnvelopeSchema = z
  .object({ errors: z.array(errorItemSchema).min(1) })
  .passthrough();
const streamErrorFrameSchema = z
  .object({
    type: z.literal("error"),
    error: errorItemSchema,
  })
  .passthrough();
const responseEnvelopeSchema = z
  .object({
    data: z.unknown(),
    metadata: metadataSchema.optional(),
    page: z.unknown().optional(),
  })
  .passthrough();

const sandboxPageSchema = z
  .object({
    cursor: z.string().min(1).nullish(),
    hasMore: z.boolean(),
    limit: z.number().int().min(1).max(250),
  })
  .strip();

const wireCommandResultSchema = z
  .object({
    stdout: z.string(),
    stderr: z.string(),
    encoding: z.literal("base64"),
    exitCode: z.number().int().min(-0x80000000).max(0x7fffffff),
  })
  .strip();

const outputResponseSchema = z
  .object({ chunks: z.array(restOutputChunkSchema) })
  .passthrough();

const fileUploadResultSchema = z
  .object({
    path: z.string(),
    bytesWritten: z.number().int().nonnegative().safe(),
  })
  .strip();

const waitProcessSchema = z
  .object({
    id: canonicalUuidSchema,
    state: z.enum(["EXITED", "KILLED", "FAILED", "LOST"]),
    exitCode: z.number().int().optional(),
    terminationSignal: z.number().int().min(1).max(64).optional(),
  })
  .strip()
  .superRefine((process, ctx) => {
    if ((process.state === "EXITED") !== (process.exitCode !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "exitCode must be present only for EXITED processes",
      });
    }
    if (
      (process.state === "KILLED") !==
      (process.terminationSignal !== undefined)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "terminationSignal must be present only for KILLED processes",
      });
    }
  });

const safeRepeatActions = new Set<SandboxAction>([
  "create",
  "destroy",
  "file.upload",
  "list",
  "get",
  "waitUntilRunning",
  "process.list",
  "process.get",
  "process.wait",
  "process.output",
  "process.stream",
  "logs.stream",
  "file.download",
]);

const sandboxTransportFailureMessage = (action: SandboxAction): string => {
  switch (action) {
    case "create":
      return "The Sandbox Create response was not confirmed. Repeating the same Create request is safe";
    case "destroy":
      return "Sandbox teardown may have been accepted. Get the sandbox; repeating Destroy is safe";
    case "file.upload":
      return "The sandbox file may have been replaced. Repeating the same upload is safe";
    case "exec":
      return "The sandbox command may have run. Inspect its external effects before running it again";
    case "process.start":
      return "A sandbox process may be running. List processes and reconcile before starting another";
    case "process.signal":
      return "The sandbox process signal may have been delivered. Get or wait for the process before sending another";
    default:
      return "Compute is temporarily unavailable. Retry this operation";
  }
};

const sandboxAmbiguousResponseMessage = (action: SandboxAction): string => {
  if (action === "create") {
    return "A sandbox was created, but its current resource could not be loaded. List sandboxes and reconcile by name before creating another";
  }
  return sandboxTransportFailureMessage(action);
};

class SandboxRestTransport {
  constructor(private readonly config: SandboxClientConfig) {}

  async json(
    action: SandboxAction,
    method: string,
    path: string,
    options: {
      body?: unknown;
      statuses: readonly number[];
      sandboxId?: string;
      processId?: string;
    },
  ): Promise<{
    status: number;
    envelope?: z.infer<typeof responseEnvelopeSchema>;
  }> {
    const response = await this.send(action, method, path, {
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      headers:
        options.body === undefined
          ? undefined
          : { "Content-Type": "application/json" },
      sandboxId: options.sandboxId,
      processId: options.processId,
    });
    if (!options.statuses.includes(response.status)) {
      await this.throwResponseError(
        action,
        response,
        options.sandboxId,
        options.processId,
      );
    }
    if (response.status === 204) {
      return { status: response.status };
    }
    const raw = await this.readResponseJSON(
      action,
      response,
      options.sandboxId,
      options.processId,
    );
    return {
      status: response.status,
      envelope: parseWithSchema(
        responseEnvelopeSchema,
        raw,
        "sandbox API response",
      ),
    };
  }

  async raw(
    action: SandboxAction,
    method: string,
    path: string,
    options: {
      body?: BodyInit;
      headers?: Record<string, string>;
      sandboxId?: string;
      processId?: string;
    },
  ): Promise<Response> {
    const response = await this.send(action, method, path, options);
    if (!response.ok) {
      await this.throwResponseError(
        action,
        response,
        options.sandboxId,
        options.processId,
      );
    }
    return response;
  }

  async readResponseEnvelope(
    action: SandboxAction,
    response: Response,
    sandboxId?: string,
    processId?: string,
  ): Promise<z.infer<typeof responseEnvelopeSchema>> {
    return parseWithSchema(
      responseEnvelopeSchema,
      await this.readResponseJSON(action, response, sandboxId, processId),
      "sandbox API response",
    );
  }

  async stream(
    action: SandboxAction,
    path: string,
    sandboxId: string,
    processId?: string,
  ): Promise<ReadableStream<SandboxOutputChunk>> {
    const abortController = new AbortController();
    const response = await this.send(action, "GET", path, {
      sandboxId,
      processId,
      signal: abortController.signal,
    });
    if (!response.ok) {
      await this.throwResponseError(action, response, sandboxId, processId);
    }
    if (!response.body) {
      throw new SandboxValidationError(
        "Sandbox API returned a stream without a body",
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let ended = false;

    const nextLine = async (): Promise<string | undefined> => {
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) {
            return line;
          }
          continue;
        }
        if (ended) {
          const line = buffer.trim();
          buffer = "";
          return line || undefined;
        }
        const result = await reader.read();
        ended = result.done;
        buffer += decoder.decode(result.value, { stream: !result.done });
      }
    };

    return new ReadableStream<SandboxOutputChunk>({
      pull: async (controller) => {
        try {
          const line = await nextLine();
          if (line === undefined) {
            controller.close();
            return;
          }
          const frame = JSON.parse(line) as unknown;
          if (
            typeof frame === "object" &&
            frame !== null &&
            "type" in frame &&
            frame.type === "error"
          ) {
            const errorFrame = parseWithSchema(
              streamErrorFrameSchema,
              frame,
              "sandbox stream error",
            );
            throw this.errorFromItem(
              action,
              response.status,
              errorFrame.error,
              sandboxId,
              processId,
              response.headers.get("x-request-id") ?? undefined,
            );
          }
          if (
            typeof frame !== "object" ||
            frame === null ||
            !("type" in frame) ||
            frame.type !== "log"
          ) {
            throw new SandboxValidationError(
              "Sandbox API returned an invalid stream frame",
            );
          }
          const { type: _type, ...chunk } = frame as Record<string, unknown>;
          controller.enqueue(decodeOutputChunk(chunk));
        } catch (error) {
          abortController.abort();
          controller.error(error);
        }
      },
      cancel: async () => {
        abortController.abort();
        await reader.cancel().catch(() => undefined);
      },
    });
  }

  private async send(
    action: SandboxAction,
    method: string,
    path: string,
    options: {
      body?: BodyInit;
      headers?: Record<string, string>;
      sandboxId?: string;
      processId?: string;
      signal?: AbortSignal;
    },
  ): Promise<Response> {
    const apiKey = this.config.apiKey()?.trim();
    if (!apiKey) {
      throw new SandboxValidationError(
        "A signing or API key is required to use inngest.sandboxes",
      );
    }
    const requestInit: RequestInit & { duplex?: "half" } = {
      method,
      headers: {
        ...this.config.headers(),
        Authorization: `Bearer ${apiKey}`,
        ...options.headers,
      },
      body: options.body,
      signal: options.signal,
    };
    if (options.body instanceof ReadableStream) {
      requestInit.duplex = "half";
    }
    try {
      return await this.config.fetch()(
        new URL(path, this.config.baseUrl()),
        requestInit,
      );
    } catch (error) {
      throw this.transportFailure(
        action,
        error,
        options.sandboxId,
        options.processId,
      );
    }
  }

  private async readResponseJSON(
    action: SandboxAction,
    response: Response,
    sandboxId?: string,
    processId?: string,
  ): Promise<unknown> {
    try {
      return await response.json();
    } catch (error) {
      throw this.transportFailure(action, error, sandboxId, processId);
    }
  }

  private transportFailure(
    action: SandboxAction,
    cause: unknown,
    sandboxId?: string,
    processId?: string,
  ): SandboxError {
    const safeToRepeat = safeRepeatActions.has(action);
    return new SandboxError({
      action,
      code: safeToRepeat ? "compute_unavailable" : "operation_ambiguous",
      message: sandboxTransportFailureMessage(action),
      sandboxId,
      processId,
      ambiguous: !safeToRepeat,
      retryable: safeToRepeat,
      details: [],
      cause,
    });
  }

  private async throwResponseError(
    action: SandboxAction,
    response: Response,
    sandboxId?: string,
    processId?: string,
  ): Promise<never> {
    const raw = await response.json().catch(() => undefined);
    const parsed = errorEnvelopeSchema.safeParse(raw);
    const item = parsed.success
      ? parsed.data.errors[0]!
      : {
          code: "internal_error",
          message: `Sandbox API returned HTTP ${response.status}`,
        };
    throw this.errorFromItem(
      action,
      response.status,
      item,
      sandboxId,
      processId,
      response.headers.get("x-request-id") ?? undefined,
      parsed.success ? (parsed.data.errors as SandboxErrorDetail[]) : [],
    );
  }

  private errorFromItem(
    action: SandboxAction,
    status: number,
    item: { code: string; message: string },
    sandboxId?: string,
    processId?: string,
    requestId?: string,
    details: readonly SandboxErrorDetail[] = [],
  ): SandboxError {
    const ambiguous =
      item.code === "operation_ambiguous" ||
      item.code === "sandbox_exec_output_too_large" ||
      item.code === "sandbox_exec_timed_out";
    const availability =
      item.code === "compute_unavailable" ||
      item.code === "rate_limited" ||
      status === 429 ||
      status === 503;
    return new SandboxError({
      action,
      code: item.code as SandboxErrorCode,
      message:
        item.code === "operation_ambiguous"
          ? sandboxAmbiguousResponseMessage(action)
          : item.message,
      status,
      sandboxId,
      processId,
      ambiguous,
      retryable: !ambiguous && availability,
      requestId,
      details,
    });
  }
}

const processPath = (sandboxId: string, processId: string): string =>
  `/v2/sandboxes/${encodeURIComponent(sandboxId)}/processes/${encodeURIComponent(processId)}`;

const sandboxStartingStatuses = new Set<SandboxStatus>(["PENDING", "STARTING"]);
const sandboxRunningPollIntervalMs = 1_000;

const delay = async (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const sandboxStartFailedError = (
  action: "create" | "waitUntilRunning",
  sandbox: SandboxRef,
): SandboxError =>
  new SandboxError({
    action,
    code: "sandbox_start_failed",
    message: `Sandbox entered ${sandbox.status} before reaching RUNNING`,
    sandboxId: sandbox.id,
    retryable: false,
    details: [
      {
        status: sandbox.status,
        ...(sandbox.error !== undefined && { error: sandbox.error }),
      },
    ],
  });

const sandboxStartTimedOutError = (
  action: "create" | "waitUntilRunning",
  sandbox: SandboxRef,
  timeoutMs: number,
): SandboxError =>
  new SandboxError({
    action,
    code: "sandbox_start_timed_out",
    message: `Sandbox did not reach RUNNING within ${timeoutMs} milliseconds`,
    sandboxId: sandbox.id,
    retryable: false,
    details: [{ status: sandbox.status, timeoutMs }],
  });

const createDirectProcessFacade = (
  rawRef: unknown,
  transport: SandboxRestTransport,
): SandboxProcess => {
  const ref = parseWithSchema(
    sandboxProcessRefSchema,
    rawRef,
    "sandbox process reference",
  );
  const basePath = processPath(ref.sandboxId, ref.id);
  const facade: SandboxProcess = {
    ...ref,
    command: Object.freeze([...ref.command]),
    signal: async (options) => {
      await transport.json("process.signal", "POST", `${basePath}/signals`, {
        body: normalizeSandboxProcessSignalOptions(options),
        statuses: [204],
        sandboxId: ref.sandboxId,
        processId: ref.id,
      });
    },
    wait: async (options) => {
      const normalized = normalizeSandboxProcessWaitOptions(options);
      const query = new URLSearchParams({
        timeout: `${normalized.timeoutMs}ms`,
      });
      const { envelope } = await transport.json(
        "process.wait",
        "POST",
        `${basePath}/wait?${query}`,
        {
          statuses: [200],
          sandboxId: ref.sandboxId,
          processId: ref.id,
        },
      );
      const terminal = parseWithSchema(
        waitProcessSchema,
        envelope?.data,
        "sandbox process wait result",
      );
      const {
        exitCode: _previousExitCode,
        terminationSignal: _previousTerminationSignal,
        ...baseRef
      } = ref;
      return createDirectProcessFacade(
        parseWithSchema(
          sandboxProcessRefSchema,
          {
            ...baseRef,
            state: terminal.state,
            ...(terminal.exitCode !== undefined && {
              exitCode: terminal.exitCode,
            }),
            ...(terminal.terminationSignal !== undefined && {
              terminationSignal: terminal.terminationSignal,
            }),
          },
          "sandbox process reference",
        ),
        transport,
      );
    },
    getOutput: async (options) => {
      const { tailBytes } = normalizeSandboxProcessOutputOptions(options);
      const query = new URLSearchParams({ tailBytes: `${tailBytes}` });
      const { envelope } = await transport.json(
        "process.output",
        "GET",
        `${basePath}/output?${query}`,
        {
          statuses: [200],
          sandboxId: ref.sandboxId,
          processId: ref.id,
        },
      );
      const output = parseWithSchema(
        outputResponseSchema,
        envelope?.data,
        "sandbox process output",
      );
      return { chunks: output.chunks.map(decodeOutputChunk) };
    },
    streamOutput: async (options) => {
      const { tailBytes } = normalizeSandboxProcessOutputOptions(options);
      const query = new URLSearchParams({ tailBytes: `${tailBytes}` });
      return transport.stream(
        "process.stream",
        `${basePath}/output/stream?${query}`,
        ref.sandboxId,
        ref.id,
      );
    },
  };
  return Object.freeze(facade);
};

const createDirectSandboxFacade = (
  rawRef: unknown,
  transport: SandboxRestTransport,
): Sandbox => {
  const ref = parseWithSchema(sandboxRefSchema, rawRef, "sandbox reference");
  const basePath = `/v2/sandboxes/${encodeURIComponent(ref.id)}`;
  const facade: Sandbox = {
    ...ref,
    resources: Object.freeze({ ...ref.resources }),
    commands: Object.freeze({
      run: async (command, options) => {
        const normalized = normalizeSandboxCommandOptions(command, options);
        const { timeout: _timeout, timeoutMs, ...spec } = normalized;
        const { envelope } = await transport.json(
          "exec",
          "POST",
          `${basePath}/exec`,
          {
            body: {
              ...spec,
              timeout: `${timeoutMs}ms`,
            },
            statuses: [200],
            sandboxId: ref.id,
          },
        );
        const result = parseWithSchema(
          wireCommandResultSchema,
          envelope?.data,
          "sandbox exec result",
        );
        return {
          stdout: decodeBase64(result.stdout, "sandbox exec stdout"),
          stderr: decodeBase64(result.stderr, "sandbox exec stderr"),
          exitCode: result.exitCode,
          output: { truncated: false },
        };
      },
    }),
    logs: Object.freeze({
      stream: async (options = {}) => {
        const parsed = parseWithSchema(
          z.object({ follow: z.boolean().optional() }).strict(),
          options,
          "sandbox log stream options",
        );
        const query = new URLSearchParams({
          follow: `${parsed.follow ?? false}`,
        });
        return transport.stream(
          "logs.stream",
          `${basePath}/logs?${query}`,
          ref.id,
        );
      },
    }),
    files: Object.freeze({
      upload: async (options): Promise<SandboxFileUploadResult> => {
        const normalized = normalizeFileUploadOptions(options);
        const query = new URLSearchParams({ path: normalized.path });
        if (normalized.mode !== undefined) {
          query.set("mode", normalized.mode.toString(8).padStart(4, "0"));
        }
        const response = await transport.raw(
          "file.upload",
          "PUT",
          `${basePath}/files?${query}`,
          {
            body: normalized.data,
            headers: {
              "Content-Type": "application/octet-stream",
            },
            sandboxId: ref.id,
          },
        );
        const envelope = await transport.readResponseEnvelope(
          "file.upload",
          response,
          ref.id,
        );
        return parseWithSchema(
          fileUploadResultSchema,
          envelope.data,
          "sandbox file upload result",
        );
      },
      download: async (options) => {
        const normalized = normalizeFileDownloadOptions(options);
        const query = new URLSearchParams({ path: normalized.path });
        return transport.raw(
          "file.download",
          "GET",
          `${basePath}/files?${query}`,
          { sandboxId: ref.id },
        );
      },
    }),
    processes: Object.freeze({
      start: async (options) => {
        const body = normalizeSandboxProcessStartOptions(options);
        const { envelope } = await transport.json(
          "process.start",
          "POST",
          `${basePath}/processes`,
          {
            body,
            statuses: [201],
            sandboxId: ref.id,
          },
        );
        const process = sandboxProcessRefFromResource(ref.id, envelope?.data);
        if (process.state !== "RUNNING" || process.pid === undefined) {
          throw new SandboxValidationError(
            "Sandbox process Start returned a process that is not RUNNING",
          );
        }
        return createDirectProcessFacade(process, transport);
      },
      list: async (options) => {
        const normalized = normalizeSandboxProcessListOptions(options);
        const query = new URLSearchParams({ limit: `${normalized.limit}` });
        if (normalized.cursor !== undefined) {
          query.set("cursor", normalized.cursor);
        }
        const { envelope } = await transport.json(
          "process.list",
          "GET",
          `${basePath}/processes?${query}`,
          { statuses: [200], sandboxId: ref.id },
        );
        const processes = parseWithSchema(
          z.array(z.unknown()),
          envelope?.data,
          "sandbox process list",
        );
        const metadata = parseWithSchema(
          metadataSchema,
          envelope?.metadata,
          "sandbox process list metadata",
        );
        const page = parseWithSchema(
          sandboxPageSchema,
          envelope?.page,
          "sandbox process list page",
        );
        const items = processes
          .map((process) =>
            createDirectProcessFacade(
              sandboxProcessRefFromResource(ref.id, process),
              transport,
            ),
          )
          .sort((left, right) => left.id.localeCompare(right.id));
        return {
          items,
          page: {
            hasMore: page.hasMore,
            limit: page.limit,
            ...(page.cursor != null && { cursor: page.cursor }),
          },
          fetchedAt: metadata.fetchedAt,
        };
      },
      get: async (processId) => {
        const parsedProcessId = parseWithSchema(
          canonicalUuidSchema,
          processId,
          "sandbox process ID",
        );
        try {
          const { envelope } = await transport.json(
            "process.get",
            "GET",
            processPath(ref.id, parsedProcessId),
            {
              statuses: [200],
              sandboxId: ref.id,
              processId: parsedProcessId,
            },
          );
          return createDirectProcessFacade(
            sandboxProcessRefFromResource(ref.id, envelope?.data),
            transport,
          );
        } catch (error) {
          if (
            error instanceof SandboxError &&
            error.code === "sandbox_process_not_found"
          ) {
            return null;
          }
          throw error;
        }
      },
    }),
    waitUntilRunning: async (options) =>
      waitUntilSandboxRunning(
        ref,
        normalizeSandboxWaitUntilRunningOptions(options).timeoutMs,
        transport,
        "waitUntilRunning",
      ),
    destroy: async (): Promise<SandboxDestroyResult> => {
      const { status, envelope } = await transport.json(
        "destroy",
        "DELETE",
        basePath,
        { statuses: [202, 204], sandboxId: ref.id },
      );
      if (status === 204) {
        return { status: "TERMINATED", sandbox: null };
      }
      const sandbox = sandboxRefFromResource(envelope?.data);
      if (sandbox.status !== "TERMINATING") {
        throw new SandboxValidationError(
          "Sandbox Destroy returned a resource that is not TERMINATING",
        );
      }
      return {
        status: "TERMINATING",
        sandbox,
      };
    },
  };
  return Object.freeze(facade);
};

const waitUntilSandboxRunning = async (
  initialSandbox: SandboxRef,
  timeoutMs: number,
  transport: SandboxRestTransport,
  action: "create" | "waitUntilRunning",
): Promise<Sandbox> => {
  let sandbox = initialSandbox;
  if (sandbox.status === "RUNNING") {
    return createDirectSandboxFacade(sandbox, transport);
  }
  if (!sandboxStartingStatuses.has(sandbox.status)) {
    throw sandboxStartFailedError(action, sandbox);
  }

  const deadline = Date.now() + timeoutMs;
  const path = `/v2/sandboxes/${encodeURIComponent(sandbox.id)}`;
  for (;;) {
    if (deadline - Date.now() <= 0) {
      throw sandboxStartTimedOutError(action, sandbox, timeoutMs);
    }

    try {
      const { envelope } = await transport.json(action, "GET", path, {
        statuses: [200],
        sandboxId: sandbox.id,
      });
      sandbox = sandboxRefFromResource(envelope?.data);
    } catch (error) {
      if (!(error instanceof SandboxError && error.retryable)) {
        throw error;
      }
    }

    if (sandbox.status === "RUNNING") {
      return createDirectSandboxFacade(sandbox, transport);
    }
    if (!sandboxStartingStatuses.has(sandbox.status)) {
      throw sandboxStartFailedError(action, sandbox);
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw sandboxStartTimedOutError(action, sandbox, timeoutMs);
    }
    await delay(Math.min(sandboxRunningPollIntervalMs, remainingMs));
  }
};

const sandboxClientTransports = new WeakMap<
  SandboxClient,
  SandboxRestTransport
>();

const transportForClient = (client: SandboxClient): SandboxRestTransport => {
  const transport = sandboxClientTransports.get(client);
  if (!transport) {
    throw new SandboxValidationError(
      "Sandbox resources can only be reconstructed for an SDK sandbox client",
    );
  }
  return transport;
};

/**
 * Internal reconstruction used by the durable adapter. Public callers reload
 * resources with Get so they receive current state.
 */
export const sandboxForOperation = (
  client: SandboxClient,
  ref: unknown,
): Sandbox => createDirectSandboxFacade(ref, transportForClient(client));

export const sandboxProcessForOperation = (
  client: SandboxClient,
  ref: unknown,
): SandboxProcess => createDirectProcessFacade(ref, transportForClient(client));

export const createSandboxClient = (
  config: SandboxClientConfig,
): SandboxClient => {
  const transport = new SandboxRestTransport(config);
  const client: SandboxClient = {
    create: async (options) => {
      const { runningTimeoutMs, ...body } =
        normalizeSandboxCreateOptions(options);
      const { status, envelope } = await transport.json(
        "create",
        "POST",
        "/v2/sandboxes",
        { body, statuses: [200, 201, 202] },
      );
      const sandbox = sandboxRefFromResource(envelope?.data);
      if (
        (status === 201 && sandbox.status !== "RUNNING") ||
        (status === 202 && sandbox.status !== "STARTING")
      ) {
        throw new SandboxValidationError(
          `Sandbox Create returned HTTP ${status} with status ${sandbox.status}`,
        );
      }
      return runningTimeoutMs === undefined
        ? createDirectSandboxFacade(sandbox, transport)
        : waitUntilSandboxRunning(
            sandbox,
            runningTimeoutMs,
            transport,
            "create",
          );
    },
    list: async (options) => {
      const normalized = normalizeSandboxListOptions(options);
      const query = new URLSearchParams({ limit: `${normalized.limit}` });
      if (normalized.cursor !== undefined) {
        query.set("cursor", normalized.cursor);
      }
      const { envelope } = await transport.json(
        "list",
        "GET",
        `/v2/sandboxes?${query}`,
        { statuses: [200] },
      );
      const resources = parseWithSchema(
        z.array(z.unknown()),
        envelope?.data,
        "sandbox list",
      );
      const page = parseWithSchema(
        sandboxPageSchema,
        envelope?.page,
        "sandbox list page",
      );
      const metadata = parseWithSchema(
        metadataSchema,
        envelope?.metadata,
        "sandbox list metadata",
      );
      return {
        items: resources.map((resource) =>
          createDirectSandboxFacade(
            sandboxRefFromResource(resource),
            transport,
          ),
        ),
        page: {
          hasMore: page.hasMore,
          limit: page.limit,
          ...(page.cursor != null && { cursor: page.cursor }),
        },
        fetchedAt: metadata.fetchedAt,
      };
    },
    get: async (sandboxId) => {
      const parsedSandboxId = parseWithSchema(
        canonicalUuidSchema,
        sandboxId,
        "sandbox ID",
      );
      try {
        const { envelope } = await transport.json(
          "get",
          "GET",
          `/v2/sandboxes/${encodeURIComponent(parsedSandboxId)}`,
          { statuses: [200], sandboxId: parsedSandboxId },
        );
        return createDirectSandboxFacade(
          sandboxRefFromResource(envelope?.data),
          transport,
        );
      } catch (error) {
        if (
          error instanceof SandboxError &&
          error.code === "sandbox_not_found"
        ) {
          return null;
        }
        throw error;
      }
    },
  };
  sandboxClientTransports.set(client, transport);
  return client;
};
