import type { MetadataTarget } from "../types.ts";
import { getAsyncCtx } from "../experimental";
import type { Inngest } from "./Inngest.ts";

export interface BuilderConfig {
  runId?: string | null;
  stepId?: string | null;
  stepIndex?: number | null;
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
    return new UnscopedMetadataBuilder(this.client, { ...this.config, runId: id ?? null });
  }

  step(id?: string, index?: number): UnscopedMetadataBuilder {
    return new UnscopedMetadataBuilder(this.client, {
      ...this.config,
      stepId: id ?? null,
      stepIndex: index ?? null,
    });
  }

  attempt(attempt?: number): UnscopedMetadataBuilder {
    return new UnscopedMetadataBuilder(this.client, { ...this.config, attempt: attempt ?? null});
  }

  span(id?: string): UnscopedMetadataBuilder {
    return new UnscopedMetadataBuilder(this.client, { ...this.config, spanId: id });
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

export function buildTarget(config: BuilderConfig, ctx: any): MetadataTarget {
  const ctxExecution = ctx?.execution;
  const ctxRunId = ctxExecution?.ctx?.runId;
  const targetRunId = config.runId ?? ctxRunId;
  if (!targetRunId) throw new Error("No run context available");

  const isSameRunAsCtx =
    ctxRunId !== undefined && targetRunId === ctxRunId;

  const ctxStepId = ctxExecution?.executingStep?.id;
  const stepId =
    config.stepId ?? (isSameRunAsCtx ? ctxStepId : undefined);

  const target: MetadataTarget & Record<string, unknown> = {
    run_id: targetRunId,
  };

  if (stepId) {
    target.step_id = stepId;
    if (config.stepIndex !== undefined) target.index = config.stepIndex;
  }

  const ctxAttempt = ctxExecution?.ctx?.attempt;
  const attempt =
    config.attempt ??
    (isSameRunAsCtx && stepId && stepId === ctxStepId ? ctxAttempt : undefined);

  if (attempt !== undefined) {
    if (!stepId) throw new Error("attempt() requires step()");
    target.attempt = attempt;
  }

  if (config.spanId) {
    if (attempt === undefined) throw new Error("span() requires attempt()");
    target.span_id = config.spanId;
  }

  return target as MetadataTarget;
}

// function createUpdate(client: Inngest, config: BuilderConfig, values: Record<string, unknown>): MetadataUpdateFuture {
//   return new MetadataUpdateFuture(async (forceNow: boolean) => {
//     const ctx = await getAsyncCtx();
//     const target = buildTarget(config, ctx);
//     // validateTarget(target); // TODO: I think we'll need this to be really sure that the target is valid?

//     const canBatch = (
//       config.runId === undefined &&
//       config.stepId === undefined &&
//       config.attempt === undefined &&
//       config.spanId === undefined
//     )

//     if (canBatch && !forceNow) {
//       // addMetadataToBatch();
//       console.log("Adding metadata to batch");
//     } else {
//       // sendMetadataViaAPI()
//       console.log("Sending metadata via API");
//     }
//   });
// }

/**
 * Creates a metadata array payload for API calls.
 */
export function createMetadataPayload(
  kind: string,
  metadata: Record<string, any>,
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
  metadata: Record<string, any>,
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
  execInstance: any,
  stepId: string,
  kind: string,
  scope: MetadataScope,
  metadata: Record<string, any>,
): void {
  if (execInstance && "addMetadata" in execInstance) {
    execInstance.addMetadata(stepId, kind, scope, metadata);
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

  // We can batch metadata if we're updating the current run
  const canBatch = !config.runId && !config.stepId && !config.attempt && !config.spanId;

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
