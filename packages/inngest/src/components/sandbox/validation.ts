import ms, { type StringValue } from "ms";
import { z } from "zod/v3";

import { isTemporalDuration } from "../../helpers/temporal.ts";
import {
  type SandboxCommand,
  type SandboxCommandOptions,
  type SandboxCreateOptions,
  type SandboxFileDownloadOptions,
  type SandboxFileUploadOptions,
  type SandboxListOptions,
  type SandboxOutputChunk,
  type SandboxProcessOutputOptions,
  type SandboxProcessRef,
  type SandboxProcessSignalOptions,
  type SandboxProcessStartOptions,
  type SandboxProcessWaitOptions,
  type SandboxRef,
  SandboxValidationError,
  type SandboxWaitUntilRunningOptions,
} from "./types.ts";

export const maxSandboxProcessTimeoutMs = 5 * 60 * 1_000;
export const defaultSandboxProcessTimeoutMs = 30 * 1_000;
export const maxSandboxRunningTimeoutMs = 5 * 60 * 1_000;
export const defaultSandboxRunningTimeoutMs = 120 * 1_000;
export const maxSandboxProcessTailBytes = 512 * 1_024;

const maxProcessArgvCount = 128;
const maxProcessArgvBytes = 32 * 1_024;
const maxProcessEnvCount = 256;
const maxProcessEnvBytes = 64 * 1_024;
const maxProcessCwdBytes = 4_096;
const maxProcessWireBytes = 96 * 1_024;
const maxSandboxNameCharacters = 255;
const sandboxNameControlCharacterPattern = /\p{Cc}/u;
const sandboxNameEdgeWhitespacePattern = /^\p{White_Space}|\p{White_Space}$/u;
const textEncoder = new TextEncoder();

export const sandboxNameSchema = z.string().superRefine((name, ctx) => {
  if (name.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "must not be empty",
    });
  } else if ([...name].length > maxSandboxNameCharacters) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `must not exceed ${maxSandboxNameCharacters} characters`,
    });
  }
  if (sandboxNameEdgeWhitespacePattern.test(name)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "must not contain leading or trailing whitespace",
    });
  }
  if (sandboxNameControlCharacterPattern.test(name)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "must not contain control characters",
    });
  }
});

const goJSONBytes = (value: unknown): number => {
  // encoding/json escapes these runes by default. Simcity measures the
  // marshalled ProcessSpec, so mirror Go rather than JSON.stringify exactly.
  const encoded = JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return textEncoder.encode(encoded).byteLength;
};

const assertNoNul = (value: string, context: string): void => {
  if (value.includes("\0")) {
    throw new SandboxValidationError(`${context} must not contain NUL`);
  }
};

const assertValidUnicode = (value: string, context: string): void => {
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        throw new SandboxValidationError(
          `${context} must not contain an unpaired surrogate`,
        );
      }
      index++;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new SandboxValidationError(
        `${context} must not contain an unpaired surrogate`,
      );
    }
  }
};

const validateSandboxEnvironment = (
  environment: Record<string, string> | undefined,
): Array<[string, string]> => {
  const entries = Object.entries(environment ?? {});
  if (entries.length > maxProcessEnvCount) {
    throw new SandboxValidationError(
      `environment must not contain more than ${maxProcessEnvCount} entries`,
    );
  }
  let environmentBytes = 0;
  for (const [key, value] of entries) {
    if (!key || key.includes("=")) {
      throw new SandboxValidationError(
        "environment keys must be nonempty and must not contain '='",
      );
    }
    assertNoNul(key, `environment key ${key}`);
    assertNoNul(value, `environment.${key}`);
    assertValidUnicode(key, `environment key ${key}`);
    assertValidUnicode(value, `environment.${key}`);
    environmentBytes +=
      textEncoder.encode(key).byteLength +
      1 +
      textEncoder.encode(value).byteLength;
  }
  if (environmentBytes > maxProcessEnvBytes) {
    throw new SandboxValidationError(
      `environment must not exceed ${maxProcessEnvBytes} bytes`,
    );
  }
  return entries;
};

export const canonicalUuidSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/,
    "must be a canonical lowercase UUID",
  )
  .refine((value) => value !== "00000000-0000-0000-0000-000000000000", {
    message: "must not be the nil UUID",
  });

const timestampSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/,
    "must be an RFC3339 timestamp",
  )
  .refine((value) => Number.isFinite(Date.parse(value)), {
    message: "must be an RFC3339 timestamp",
  });

export const sandboxStatusSchema = z.enum([
  "PENDING",
  "STARTING",
  "RUNNING",
  "PAUSED",
  "TERMINATING",
  "TERMINATED",
  "FAILED",
]);

const sandboxResourcesSchema = z
  .object({
    vcpu: z.number().int().positive().max(0xffffffff),
    memoryMb: z.number().int().positive().max(0xffffffff),
  })
  .strict();

export const sandboxResourceSchema = z
  .object({
    id: canonicalUuidSchema,
    name: sandboxNameSchema,
    status: sandboxStatusSchema,
    vpcId: canonicalUuidSchema,
    imageRef: z.string().min(1),
    resources: sandboxResourcesSchema,
    createdAt: timestampSchema,
    startedAt: timestampSchema.optional(),
    endedAt: timestampSchema.optional(),
    error: z.string().min(1).optional(),
  })
  .strict();

const wireSandboxResourceSchema = sandboxResourceSchema
  .omit({ resources: true, startedAt: true, endedAt: true, error: true })
  .extend({
    resources: sandboxResourcesSchema.strip(),
    startedAt: timestampSchema.nullish(),
    endedAt: timestampSchema.nullish(),
    error: z.string().min(1).nullish(),
  })
  .strip();

export const sandboxRefSchema = sandboxResourceSchema
  .extend({
    kind: z.literal("inngest/sandbox"),
    version: z.literal(1),
  })
  .strict();

export const sandboxProcessStateSchema = z.enum([
  "STARTING",
  "RUNNING",
  "EXITED",
  "KILLED",
  "FAILED",
  "LOST",
]);

const sandboxProcessResourceShape = {
  id: canonicalUuidSchema,
  command: z.array(z.string()).min(1).max(maxProcessArgvCount),
  pid: z.number().int().positive().max(0x7fffffff).optional(),
  state: sandboxProcessStateSchema,
  exitCode: z.number().int().min(-0x80000000).max(0x7fffffff).optional(),
  terminationSignal: z.number().int().min(1).max(64).optional(),
  startedAt: timestampSchema.optional(),
  endedAt: timestampSchema.optional(),
};

const validateSandboxProcessResource = (
  process: z.infer<z.ZodObject<typeof sandboxProcessResourceShape>>,
  ctx: z.RefinementCtx,
): void => {
  if ((process.state === "EXITED") !== (process.exitCode !== undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "exitCode must be present only for EXITED processes",
      path: ["exitCode"],
    });
  }
  if (
    (process.state === "KILLED") !==
    (process.terminationSignal !== undefined)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "terminationSignal must be present only for KILLED processes",
      path: ["terminationSignal"],
    });
  }
};

export const sandboxProcessResourceSchema = z
  .object(sandboxProcessResourceShape)
  .strict()
  .superRefine(validateSandboxProcessResource);

const wireSandboxProcessResourceSchema = z
  .object(sandboxProcessResourceShape)
  .strip()
  .superRefine(validateSandboxProcessResource);

export const sandboxProcessRefSchema = z
  .object({
    kind: z.literal("inngest/sandbox.process"),
    version: z.literal(1),
    sandboxId: canonicalUuidSchema,
    id: canonicalUuidSchema,
    command: z.array(z.string()).min(1).max(maxProcessArgvCount),
    pid: z.number().int().positive().max(0x7fffffff).optional(),
    state: sandboxProcessStateSchema,
    exitCode: z.number().int().min(-0x80000000).max(0x7fffffff).optional(),
    terminationSignal: z.number().int().min(1).max(64).optional(),
    startedAt: timestampSchema.optional(),
    endedAt: timestampSchema.optional(),
  })
  .strict()
  .superRefine((process, ctx) => {
    if ((process.state === "EXITED") !== (process.exitCode !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "exitCode must be present only for EXITED processes",
        path: ["exitCode"],
      });
    }
    if (
      (process.state === "KILLED") !==
      (process.terminationSignal !== undefined)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "terminationSignal must be present only for KILLED processes",
        path: ["terminationSignal"],
      });
    }
  });

const outputChunkShape = {
  stream: z.enum(["STDOUT", "STDERR"]),
  data: z.string(),
  encoding: z.literal("base64"),
  at: timestampSchema.optional(),
};

export const wireOutputChunkSchema = z.object(outputChunkShape).strict();
export const restOutputChunkSchema = z.object(outputChunkShape).strip();

const formatValidationError = (context: string, error: z.ZodError): string => {
  const issue = error.issues[0];
  const path = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
  return `Invalid ${context}${path}: ${issue?.message ?? "validation failed"}`;
};

export const parseWithSchema = <T>(
  schema: z.ZodType<T>,
  value: unknown,
  context: string,
): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new SandboxValidationError(
      formatValidationError(context, parsed.error),
      { cause: parsed.error },
    );
  }
  return parsed.data;
};

export const sandboxRefFromResource = (value: unknown): SandboxRef => {
  const resource = parseWithSchema(
    wireSandboxResourceSchema,
    value,
    "sandbox resource",
  );
  return {
    kind: "inngest/sandbox",
    version: 1,
    id: resource.id,
    name: resource.name,
    status: resource.status,
    vpcId: resource.vpcId,
    imageRef: resource.imageRef,
    resources: resource.resources,
    createdAt: resource.createdAt,
    ...(resource.startedAt != null && { startedAt: resource.startedAt }),
    ...(resource.endedAt != null && { endedAt: resource.endedAt }),
    ...(resource.error != null && { error: resource.error }),
  };
};

export const sandboxProcessRefFromResource = (
  sandboxId: string,
  value: unknown,
): SandboxProcessRef =>
  parseWithSchema(
    sandboxProcessRefSchema,
    {
      kind: "inngest/sandbox.process",
      version: 1,
      sandboxId,
      ...parseWithSchema(
        wireSandboxProcessResourceSchema,
        value,
        "sandbox process resource",
      ),
    },
    "sandbox process reference",
  );

export const normalizeSandboxCreateOptions = (
  options: SandboxCreateOptions,
): Omit<SandboxCreateOptions, "runningTimeout"> & {
  runningTimeoutMs: number | false;
} => {
  const parsed = parseWithSchema(
    z
      .object({
        name: sandboxNameSchema,
        vcpu: z.number().int().positive().max(0xffffffff),
        memoryMb: z.number().int().positive().max(0xffffffff),
        environment: z.record(z.string()).optional(),
        runningTimeout: z.unknown().optional(),
      })
      .strict(),
    options,
    "sandbox create options",
  );
  validateSandboxEnvironment(parsed.environment);
  const { runningTimeout, ...create } = parsed;
  return {
    ...create,
    runningTimeoutMs:
      runningTimeout === false
        ? false
        : normalizeDurationMs(
            runningTimeout ?? defaultSandboxRunningTimeoutMs,
            maxSandboxRunningTimeoutMs,
            "runningTimeout",
          ),
  };
};

export const normalizeSandboxWaitUntilRunningOptions = (
  options: SandboxWaitUntilRunningOptions,
): { timeoutMs: number } => {
  const parsed = parseWithSchema(
    z.object({ timeout: z.unknown() }).strict(),
    options,
    "sandbox waitUntilRunning options",
  );
  return {
    timeoutMs: normalizeDurationMs(
      parsed.timeout,
      maxSandboxRunningTimeoutMs,
      "timeout",
    ),
  };
};

export const normalizeSandboxListOptions = (
  options: SandboxListOptions = {},
): Required<Pick<SandboxListOptions, "limit">> &
  Pick<SandboxListOptions, "cursor"> => {
  const parsed = parseWithSchema(
    z
      .object({
        cursor: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(250).optional(),
      })
      .strict(),
    options,
    "sandbox list options",
  );
  return { ...parsed, limit: parsed.limit ?? 50 };
};

export const normalizeSandboxProcessListOptions = normalizeSandboxListOptions;

type SandboxProcessSpecOptions = SandboxCommandOptions & {
  command: SandboxCommand;
};

const normalizeProcessSpec = <
  T extends SandboxProcessSpecOptions | SandboxProcessStartOptions,
>(
  options: T,
  includeTimeout: boolean,
): Omit<T, "command"> & { command: string[] } => {
  const parsed = parseWithSchema(
    z
      .object({
        command: z.union([
          z.string().min(1, "command must not be empty"),
          z.array(z.string()).min(1).max(maxProcessArgvCount),
        ]),
        environment: z.record(z.string()).optional(),
        cwd: z.string().optional(),
        ...(includeTimeout && { timeout: z.unknown().optional() }),
      })
      .strict(),
    options,
    "sandbox command options",
  ) as unknown as T;

  if (Array.isArray(parsed.command) && !parsed.command[0]?.startsWith("/")) {
    throw new SandboxValidationError(
      "command must begin with an absolute executable path",
    );
  }
  const argv =
    typeof parsed.command === "string"
      ? ["/bin/sh", "-c", parsed.command]
      : parsed.command;
  let argvBytes = 0;
  argv.forEach((argument, index) => {
    const context =
      typeof parsed.command === "string" ? "command" : `command[${index}]`;
    assertNoNul(argument, context);
    assertValidUnicode(argument, context);
    argvBytes += textEncoder.encode(argument).byteLength;
  });
  if (argvBytes > maxProcessArgvBytes) {
    throw new SandboxValidationError(
      `command must not exceed ${maxProcessArgvBytes} bytes`,
    );
  }

  const entries = validateSandboxEnvironment(parsed.environment);

  if (parsed.cwd !== undefined) {
    assertNoNul(parsed.cwd, "cwd");
    assertValidUnicode(parsed.cwd, "cwd");
    if (textEncoder.encode(parsed.cwd).byteLength > maxProcessCwdBytes) {
      throw new SandboxValidationError(
        `cwd must not exceed ${maxProcessCwdBytes} bytes`,
      );
    }
  }

  const wireBytes = goJSONBytes({
    argv,
    ...(entries.length > 0 && { env: parsed.environment }),
    ...(parsed.cwd !== undefined && parsed.cwd !== "" && { cwd: parsed.cwd }),
  });
  if (wireBytes > maxProcessWireBytes) {
    throw new SandboxValidationError(
      `command, environment, and cwd must not exceed ${maxProcessWireBytes} encoded bytes`,
    );
  }
  return {
    ...parsed,
    command: [...argv],
  } as Omit<T, "command"> & { command: string[] };
};

export const normalizeSandboxCommandOptions = (
  command: SandboxCommand,
  options: SandboxCommandOptions = {},
): SandboxCommandOptions & { command: string[]; timeoutMs: number } => {
  const parsed = normalizeProcessSpec({ ...options, command }, true);
  return {
    ...parsed,
    timeoutMs:
      parsed.timeout === undefined
        ? defaultSandboxProcessTimeoutMs
        : normalizeDurationMs(
            parsed.timeout,
            maxSandboxProcessTimeoutMs,
            "timeout",
          ),
  };
};

export const normalizeSandboxProcessStartOptions = (
  options: SandboxProcessStartOptions,
): Omit<SandboxProcessStartOptions, "command"> & { command: string[] } =>
  normalizeProcessSpec(options, false);

export const normalizeSandboxProcessSignalOptions = (
  options: SandboxProcessSignalOptions,
): Required<SandboxProcessSignalOptions> => {
  const parsed = parseWithSchema(
    z
      .object({
        signal: z.number().int().min(1).max(64),
        includeChildren: z.boolean().optional(),
      })
      .strict(),
    options,
    "sandbox process signal options",
  );
  return {
    signal: parsed.signal,
    includeChildren: parsed.includeChildren ?? true,
  };
};

export const normalizeSandboxProcessWaitOptions = (
  options: SandboxProcessWaitOptions = {},
): { timeoutMs: number } => {
  const parsed = parseWithSchema(
    z.object({ timeout: z.unknown().optional() }).strict(),
    options,
    "sandbox process wait options",
  );
  return {
    timeoutMs:
      parsed.timeout === undefined
        ? defaultSandboxProcessTimeoutMs
        : normalizeDurationMs(
            parsed.timeout,
            maxSandboxProcessTimeoutMs,
            "timeout",
          ),
  };
};

export const normalizeSandboxProcessOutputOptions = (
  options: SandboxProcessOutputOptions = {},
): { tailBytes: number } => {
  const parsed = parseWithSchema(
    z
      .object({
        tailBytes: z
          .number()
          .int()
          .min(0)
          .max(maxSandboxProcessTailBytes)
          .optional(),
      })
      .strict(),
    options,
    "sandbox process output options",
  );
  return { tailBytes: parsed.tailBytes ?? 0 };
};

export const normalizeDurationMs = (
  duration: unknown,
  maximumMs: number,
  context: string,
): number => {
  let milliseconds: number | undefined;
  if (typeof duration === "number") {
    milliseconds = duration;
  } else if (typeof duration === "string") {
    milliseconds = ms(duration as StringValue);
  } else if (isTemporalDuration(duration)) {
    if (duration.years || duration.months || duration.weeks) {
      throw new SandboxValidationError(
        `${context} cannot contain calendar years, months, or weeks`,
      );
    }
    milliseconds = duration.total({ unit: "milliseconds" });
  }
  if (
    typeof milliseconds !== "number" ||
    !Number.isFinite(milliseconds) ||
    !Number.isSafeInteger(milliseconds) ||
    milliseconds <= 0
  ) {
    throw new SandboxValidationError(
      `${context} must be a positive, whole number of milliseconds`,
    );
  }
  if (milliseconds > maximumMs) {
    throw new SandboxValidationError(
      `${context} must not exceed ${maximumMs} milliseconds`,
    );
  }
  return milliseconds;
};

export const normalizeFileUploadOptions = (
  options: SandboxFileUploadOptions,
): SandboxFileUploadOptions => {
  const parsed = parseWithSchema(
    z
      .object({
        path: z.string().min(1),
        data: z.unknown(),
        mode: z.number().int().min(1).max(0o777).optional(),
      })
      .strict(),
    options,
    "sandbox file upload options",
  );
  validateFilePath(parsed.path);
  return parsed as SandboxFileUploadOptions;
};

export const normalizeFileDownloadOptions = (
  options: SandboxFileDownloadOptions,
): SandboxFileDownloadOptions => {
  const parsed = parseWithSchema(
    z.object({ path: z.string().min(1) }).strict(),
    options,
    "sandbox file download options",
  );
  validateFilePath(parsed.path);
  return parsed;
};

const validateFilePath = (path: string): void => {
  assertNoNul(path, "path");
  if (!path.startsWith("/")) {
    throw new SandboxValidationError("path must be absolute");
  }
  if (textEncoder.encode(path).byteLength > maxProcessCwdBytes) {
    throw new SandboxValidationError(
      `path must not exceed ${maxProcessCwdBytes} bytes`,
    );
  }
};

export const decodeBase64 = (value: string, context: string): Uint8Array => {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    throw new SandboxValidationError(`${context} is not valid base64`);
  }
  try {
    const binary = globalThis.atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch (error) {
    throw new SandboxValidationError(`${context} is not valid base64`, {
      cause: error,
    });
  }
};

export const decodeUtf8 = (value: Uint8Array): string =>
  new TextDecoder("utf-8", { fatal: false }).decode(value);

export const encodeBase64 = (value: Uint8Array): string => {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < value.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...value.subarray(offset, offset + chunkSize),
    );
  }
  return globalThis.btoa(binary);
};

export const decodeOutputChunk = (value: unknown): SandboxOutputChunk => {
  const chunk = parseWithSchema(
    restOutputChunkSchema,
    value,
    "sandbox output chunk",
  );
  return {
    stream: chunk.stream,
    data: decodeBase64(chunk.data, "sandbox output data"),
    ...(chunk.at !== undefined && { at: chunk.at }),
  };
};
