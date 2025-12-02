import { type AsyncContext, getAsyncCtx } from "../experimental";
import type { MetadataTarget } from "../types.ts";
import type { IInngestExecution } from "./execution/InngestExecution.ts";
import type { Inngest } from "./Inngest.ts";

export interface BuilderConfig {
  runId?: string | null;
  stepId?: string | null;
  stepIndex?: number;
  attempt?: number | null;
  spanId?: string;
}

export type MetadataScope = "run" | "step" | "step_attempt" | "extended_trace";

export type MetadataKind = "inngest.warning" | `userland.${string}`;

export interface MetadataBuilder {
  run(id?: string): Omit<MetadataBuilder, "run">;
  step(id?: string, index?: number): Omit<MetadataBuilder, "run" | "step">;
  attempt(index?: number): Omit<MetadataBuilder, "run" | "step" | "attempt">;
  span(id?: string): Omit<MetadataBuilder, "run" | "step" | "attempt" | "span">;
  update(values: Record<string, unknown>, kind?: string): Promise<void>;
}

export class UnscopedMetadataBuilder implements MetadataBuilder {
  constructor(
    private client: Inngest,
    private config: BuilderConfig = {},
  ) {}

  run(id?: string): UnscopedMetadataBuilder {
    return new UnscopedMetadataBuilder(this.client, {
      ...this.config,
      runId: id ?? null,
    });
  }

  step(id?: string, index?: number): UnscopedMetadataBuilder {
    return new UnscopedMetadataBuilder(this.client, {
      ...this.config,
      stepId: id ?? null,
      stepIndex: index ?? 0,
    });
  }

  attempt(attempt?: number): UnscopedMetadataBuilder {
    return new UnscopedMetadataBuilder(this.client, {
      ...this.config,
      attempt: attempt ?? null,
    });
  }

  span(id?: string): UnscopedMetadataBuilder {
    return new UnscopedMetadataBuilder(this.client, {
      ...this.config,
      spanId: id,
    });
  }

  async update(
    values: Record<string, unknown>,
    kind = "default",
  ): Promise<void> {
    await performUpdate(this.client, this.config, values, `userland.${kind}`);
  }

  toJSON() {
    return this.config;
  }
}

export function buildTarget(
  config: BuilderConfig,
  ctx?: AsyncContext,
): MetadataTarget {
  const ctxExecution = ctx?.execution;
  const ctxRunId = ctxExecution?.ctx?.runId;
  const targetRunId = config.runId ?? ctxRunId;
  if (!targetRunId) throw new Error("No run context available");

  const isSameRunAsCtx = ctxRunId !== undefined && targetRunId === ctxRunId;

  const ctxStepId = ctxExecution?.executingStep?.id;
  const stepId = config.stepId ?? (isSameRunAsCtx ? ctxStepId : undefined);

  let target: MetadataTarget = {
    run_id: targetRunId,
  };

  if (stepId) {
    target = { ...target, step_id: stepId };

    if (config.stepIndex !== undefined) {
      target = { ...target, step_index: config.stepIndex };
    }
  }

  const ctxAttempt = ctxExecution?.ctx?.attempt;
  const attempt =
    config.attempt ??
    (isSameRunAsCtx && stepId && stepId === ctxStepId ? ctxAttempt : undefined);

  if (attempt !== undefined) {
    if (!stepId) throw new Error("attempt() requires step()");
    target = { ...target, step_attempt: attempt };
  }

  if (config.spanId) {
    if (attempt === undefined) throw new Error("span() requires attempt()");
    target = { ...target, span_id: config.spanId };
  }

  return target as MetadataTarget;
}

/**
 * Creates a metadata array payload for API calls.
 */
export function createMetadataPayload(
  kind: string,
  metadata: Record<string, unknown>,
) {
  return [
    {
      kind,
      op: "merge",
      values: metadata,
    },
  ];
}

/**
 * Sends metadata update via REST API to a specific target.
 */
export async function sendMetadataViaAPI(
  client: Inngest,
  target: MetadataTarget,
  kind: string,
  metadata: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<void> {
  const metadataArray = createMetadataPayload(kind, metadata);

  await client["_updateMetadata"]({
    target,
    metadata: metadataArray,
    headers,
  });
}

/**
 * Adds metadata to the current execution instance for batched opcode delivery.
 */
export function addMetadataToBatch(
  execInstance: IInngestExecution,
  stepID: string,
  kind: MetadataKind,
  scope: MetadataScope,
  metadata: Record<string, unknown>,
): void {
  if (execInstance.addMetadata(stepID, kind, scope, metadata)) {
    return;
  }

  throw new Error(
    "Unable to add metadata: execution instance does not support metadata. " +
      "This may be due to using an older execution version that doesn't support metadata updates.",
  );
}

function getBatchScope(config: BuilderConfig): MetadataScope {
  if (config.spanId != undefined) return "extended_trace";
  if (config.attempt != undefined) return "step_attempt";
  if (config.stepId != undefined) return "step";
  if (config.runId != undefined) return "run";

  return "step_attempt";
}

async function performUpdate(
  client: Inngest,
  config: BuilderConfig,
  values: Record<string, unknown>,
  kind: MetadataKind,
): Promise<void> {
  const ctx = await getAsyncCtx();
  const target = buildTarget(config, ctx);

  const runId = config.runId ?? ctx?.execution?.ctx?.runId;
  const stepId = config.stepId ?? ctx?.execution?.executingStep?.id;
  // TODO: get step index from ctx?
  const attempt = config.attempt ?? ctx?.execution?.ctx?.attempt;

  // We can batch metadata if we're updating the current run
  const canBatch =
    runId === ctx?.execution?.ctx?.runId &&
    stepId === ctx?.execution?.executingStep?.id &&
    attempt === ctx?.execution?.ctx?.attempt &&
    !config.spanId;

  if (canBatch) {
    const executingStep = ctx?.execution?.executingStep;
    const execInstance = ctx?.execution?.instance;

    if (executingStep?.id && execInstance) {
      const scope = getBatchScope(config);
      // TODO: handle case where too much metadata is added to batch
      addMetadataToBatch(execInstance, executingStep.id, kind, scope, values);
      return;
    }
  }

  const headers =
    (
      ctx?.execution?.instance as
        | { options?: { headers?: Record<string, string> } }
        | undefined
    )?.options?.headers ?? undefined;

  await sendMetadataViaAPI(client, target, kind, values, headers);
}
