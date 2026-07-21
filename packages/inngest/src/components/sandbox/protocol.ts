import { z } from "zod/v3";

import type { StepOptionsOrId } from "../../types.ts";
import {
  type SandboxAction,
  type SandboxErrorDetail,
  type SandboxErrorOptions,
  SandboxValidationError,
  sandboxProtocolVersion,
} from "./types.ts";
import {
  canonicalUuidSchema,
  normalizeSandboxProcessStartOptions,
  parseWithSchema,
  sandboxProcessRefSchema,
  sandboxRefSchema,
  wireOutputChunkSchema,
} from "./validation.ts";

const sandboxTargetSchema = z
  .object({ sandboxId: canonicalUuidSchema })
  .strict();
const processTargetSchema = sandboxTargetSchema
  .extend({ processId: canonicalUuidSchema })
  .strict();

const createInputSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9_-]{1,63}$/),
    vcpu: z.number().int().positive().max(0xffffffff),
    memoryMb: z.number().int().positive().max(0xffffffff),
  })
  .strict();
const listInputSchema = z
  .object({
    cursor: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(250),
  })
  .strict();
const getInputSchema = z.object({ sandboxId: canonicalUuidSchema }).strict();
const processSpecShape = {
  command: z.array(z.string()).min(1).max(128),
  environment: z.record(z.string()).optional(),
  cwd: z.string().optional(),
};
const validateProcessSpec = (
  value: {
    command: string[];
    environment?: Record<string, string>;
    cwd?: string;
  },
  ctx: z.RefinementCtx,
): void => {
  try {
    const { command, environment, cwd } = value;
    normalizeSandboxProcessStartOptions({
      command,
      ...(environment !== undefined && { environment }),
      ...(cwd !== undefined && { cwd }),
    });
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : "invalid process spec",
    });
  }
};
const processSpecInputSchema = z
  .object(processSpecShape)
  .strict()
  .superRefine(validateProcessSpec);
const execInputSchema = z
  .object({
    ...processSpecShape,
    timeoutMs: z.number().int().positive().max(300_000),
  })
  .strict()
  .superRefine(validateProcessSpec);
const signalInputSchema = z
  .object({
    signal: z.number().int().min(1).max(64),
    includeChildren: z.boolean(),
  })
  .strict();
const waitInputSchema = z
  .object({ timeoutMs: z.number().int().positive().max(300_000) })
  .strict();
const outputInputSchema = z
  .object({
    tailBytes: z
      .number()
      .int()
      .min(0)
      .max(512 * 1_024),
  })
  .strict();

const operationBase = {
  protocolVersion: z.literal(sandboxProtocolVersion),
};

export const sandboxOperationSchema = z.discriminatedUnion("action", [
  z
    .object({
      ...operationBase,
      action: z.literal("create"),
      input: z.tuple([createInputSchema]),
    })
    .strict(),
  z
    .object({
      ...operationBase,
      action: z.literal("list"),
      input: z.tuple([listInputSchema]),
    })
    .strict(),
  z
    .object({
      ...operationBase,
      action: z.literal("get"),
      input: z.tuple([getInputSchema]),
    })
    .strict(),
  z
    .object({
      ...operationBase,
      action: z.literal("exec"),
      target: sandboxTargetSchema,
      input: z.tuple([execInputSchema]),
    })
    .strict(),
  z
    .object({
      ...operationBase,
      action: z.literal("destroy"),
      target: sandboxTargetSchema,
      input: z.tuple([]),
    })
    .strict(),
  z
    .object({
      ...operationBase,
      action: z.literal("process.start"),
      target: sandboxTargetSchema,
      input: z.tuple([processSpecInputSchema]),
    })
    .strict(),
  z
    .object({
      ...operationBase,
      action: z.literal("process.list"),
      target: sandboxTargetSchema,
      input: z.tuple([]),
    })
    .strict(),
  z
    .object({
      ...operationBase,
      action: z.literal("process.get"),
      target: processTargetSchema,
      input: z.tuple([]),
    })
    .strict(),
  z
    .object({
      ...operationBase,
      action: z.literal("process.signal"),
      target: processTargetSchema,
      input: z.tuple([signalInputSchema]),
    })
    .strict(),
  z
    .object({
      ...operationBase,
      action: z.literal("process.wait"),
      target: processTargetSchema,
      input: z.tuple([waitInputSchema]),
    })
    .strict(),
  z
    .object({
      ...operationBase,
      action: z.literal("process.output"),
      target: processTargetSchema,
      input: z.tuple([outputInputSchema]),
    })
    .strict(),
]);

const pageSchema = z
  .object({
    cursor: z.string().min(1).optional(),
    hasMore: z.boolean(),
    limit: z.number().int().min(1).max(250),
  })
  .strict();

const wireCommandResultSchema = z
  .object({
    stdout: z.string(),
    stderr: z.string(),
    encoding: z.literal("base64"),
    exitCode: z.number().int().min(-0x80000000).max(0x7fffffff),
  })
  .strict();

const wireDestroyResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("TERMINATING"),
      sandbox: sandboxRefSchema.refine(
        (sandbox) => sandbox.status === "TERMINATING",
        "destroyed sandbox must be TERMINATING",
      ),
    })
    .strict(),
  z
    .object({
      status: z.literal("TERMINATED"),
      sandbox: z.null(),
    })
    .strict(),
]);

const wireWaitProcessSchema = z
  .object({
    kind: z.literal("inngest/sandbox.process"),
    version: z.literal(1),
    sandboxId: canonicalUuidSchema,
    id: canonicalUuidSchema,
    state: z.enum(["EXITED", "KILLED", "FAILED", "LOST"]),
    exitCode: z.number().int().optional(),
    terminationSignal: z.number().int().min(1).max(64).optional(),
  })
  .strict()
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

export const sandboxOperationResultSchema = z.discriminatedUnion("action", [
  z
    .object({
      ...operationBase,
      action: z.literal("create"),
      sandbox: sandboxRefSchema,
    })
    .strict(),
  z
    .object({
      ...operationBase,
      action: z.literal("list"),
      sandboxes: z.array(sandboxRefSchema),
      page: pageSchema,
      fetchedAt: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...operationBase,
      action: z.literal("get"),
      sandbox: sandboxRefSchema.nullable(),
    })
    .strict(),
  z
    .object({
      ...operationBase,
      action: z.literal("exec"),
      result: wireCommandResultSchema,
    })
    .strict(),
  z
    .object({
      ...operationBase,
      action: z.literal("destroy"),
      result: wireDestroyResultSchema,
    })
    .strict(),
  z
    .object({
      ...operationBase,
      action: z.literal("process.start"),
      process: sandboxProcessRefSchema,
    })
    .strict(),
  z
    .object({
      ...operationBase,
      action: z.literal("process.list"),
      processes: z.array(sandboxProcessRefSchema),
    })
    .strict(),
  z
    .object({
      ...operationBase,
      action: z.literal("process.get"),
      process: sandboxProcessRefSchema.nullable(),
    })
    .strict(),
  z
    .object({
      ...operationBase,
      action: z.literal("process.signal"),
      result: z.null(),
    })
    .strict(),
  z
    .object({
      ...operationBase,
      action: z.literal("process.wait"),
      process: wireWaitProcessSchema,
    })
    .strict(),
  z
    .object({
      ...operationBase,
      action: z.literal("process.output"),
      result: z.object({ chunks: z.array(wireOutputChunkSchema) }).strict(),
    })
    .strict(),
]);

const sandboxErrorPayloadSchema = z
  .object({
    protocolVersion: z.literal(sandboxProtocolVersion),
    action: z.enum([
      "create",
      "list",
      "get",
      "exec",
      "destroy",
      "process.start",
      "process.list",
      "process.get",
      "process.signal",
      "process.wait",
      "process.output",
    ]),
    code: z.string().min(1),
    message: z.string().min(1),
    status: z.number().int().min(100).max(599).optional(),
    sandboxId: canonicalUuidSchema.optional(),
    processId: canonicalUuidSchema.optional(),
    ambiguous: z.boolean(),
    retryable: z.boolean(),
    requestId: z.string().min(1).optional(),
    details: z.array(z.record(z.unknown())).default([]),
  })
  .strict();

export type SandboxOperationV1 = z.infer<typeof sandboxOperationSchema>;
export type SandboxOperationResultV1 = z.infer<
  typeof sandboxOperationResultSchema
>;
export type DurableSandboxAction = SandboxOperationV1["action"];
export type SandboxStepType = `step.sandbox.${DurableSandboxAction}`;
export type SandboxRawTool = (
  idOrOptions: StepOptionsOrId,
  operation: SandboxOperationV1,
) => Promise<unknown>;
export type SandboxRawToolResolver = () =>
  | SandboxRawTool
  | Promise<SandboxRawTool>;

export type SandboxOperationForAction<A extends SandboxAction> = Extract<
  SandboxOperationV1,
  { action: A }
>;
export type SandboxResultForAction<A extends SandboxAction> = Extract<
  SandboxOperationResultV1,
  { action: A }
>;

export const parseSandboxOperation = (value: unknown): SandboxOperationV1 =>
  parseWithSchema(sandboxOperationSchema, value, "sandbox operation");

export const parseSandboxOperationForAction = <A extends SandboxAction>(
  action: A,
  value: unknown,
): SandboxOperationForAction<A> => {
  const operation = parseSandboxOperation(value);
  if (operation.action !== action) {
    throw new SandboxValidationError(
      `Expected sandbox ${action} operation, received ${operation.action}`,
    );
  }
  return operation as SandboxOperationForAction<A>;
};

const tryParseSandboxOperation = (
  value: unknown,
): SandboxOperationV1 | undefined => {
  try {
    return parseSandboxOperation(value);
  } catch {
    return;
  }
};

export const sandboxStepTypeFromOpts = (
  opts: Record<string, unknown> | undefined,
): SandboxStepType | undefined => {
  const operation = tryParseSandboxOperation(opts?.sandbox);
  if (!operation) {
    return;
  }
  const stepType = `step.sandbox.${operation.action}` as SandboxStepType;
  return opts?.type === stepType ? stepType : undefined;
};

export const sandboxInputFromOpts = (
  opts: Record<string, unknown> | undefined,
): unknown[] | undefined => tryParseSandboxOperation(opts?.sandbox)?.input;

export const sandboxOptsFromInput = (
  stepType: SandboxStepType,
  input: unknown[] | undefined,
  originalOpts: Record<string, unknown> | undefined,
): Record<string, unknown> => {
  const original = parseSandboxOperation(originalOpts?.sandbox);
  const expectedStepType = `step.sandbox.${original.action}` as SandboxStepType;
  if (
    stepType !== expectedStepType ||
    originalOpts?.type !== expectedStepType
  ) {
    throw new SandboxValidationError(
      "Sandbox step type does not match its operation action",
    );
  }
  const sandbox = parseSandboxOperation({ ...original, input });
  return { ...originalOpts, type: expectedStepType, sandbox };
};

export const findSandboxErrorOptions = (
  error: unknown,
): SandboxErrorOptions | undefined => {
  let current = error;
  for (let depth = 0; depth < 6 && current; depth++) {
    const parsed = sandboxErrorPayloadSchema.safeParse(current);
    if (parsed.success) {
      return {
        ...parsed.data,
        code: parsed.data.code,
        details: parsed.data.details as SandboxErrorDetail[],
        cause: error,
      };
    }
    if (typeof current !== "object" || !("cause" in current)) {
      return;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return;
};

const operationSandboxId = (
  operation: SandboxOperationV1,
): string | undefined => {
  if (operation.action === "get") {
    return operation.input[0].sandboxId;
  }
  if ("target" in operation) {
    return operation.target.sandboxId;
  }
  return;
};

const operationProcessId = (
  operation: SandboxOperationV1,
): string | undefined =>
  "target" in operation && "processId" in operation.target
    ? operation.target.processId
    : undefined;

export const validateSandboxResult = <A extends SandboxAction>(
  operation: SandboxOperationForAction<A>,
  rawResult: unknown,
): SandboxResultForAction<A> => {
  const result = parseWithSchema(
    sandboxOperationResultSchema,
    rawResult,
    "sandbox operation result",
  );
  if (result.action !== operation.action) {
    throw new SandboxValidationError(
      `Sandbox operation returned ${result.action} for ${operation.action}`,
    );
  }
  const sandboxId = operationSandboxId(operation);
  const processId = operationProcessId(operation);
  if (
    sandboxId &&
    "sandbox" in result &&
    result.sandbox &&
    result.sandbox.id !== sandboxId
  ) {
    throw new SandboxValidationError(
      "Sandbox operation returned an unrelated sandbox",
    );
  }
  if (
    sandboxId &&
    "process" in result &&
    result.process &&
    "sandboxId" in result.process &&
    result.process.sandboxId !== sandboxId
  ) {
    throw new SandboxValidationError(
      "Sandbox operation returned a process from an unrelated sandbox",
    );
  }
  if (
    processId &&
    "process" in result &&
    result.process &&
    "id" in result.process &&
    result.process.id !== processId
  ) {
    throw new SandboxValidationError(
      "Sandbox operation returned an unrelated process",
    );
  }
  return result as SandboxResultForAction<A>;
};
