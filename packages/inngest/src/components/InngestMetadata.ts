import { type AsyncContext, getAsyncCtx } from "../experimental";
import type { Simplify } from "../helpers/types.ts";
import type { MetadataTarget } from "../types.ts";
import type { Inngest } from "./Inngest.ts";
import { InngestMiddleware } from "./InngestMiddleware.ts";
import type { ExperimentalStepTools } from "./InngestStepTools.ts";
export interface BuilderConfig {
  runId?: string | null;
  stepId?: string | null;
  stepIndex?: number;
  attempt?: number | null;
  spanId?: string;
}

/**
 * The level at which to attach the metadata.
 */
export type MetadataScope = "run" | "step" | "step_attempt" | "extended_trace";

/**
 * Metadata of the same kind attached to the same item at the same scope are combined.
 */
export type MetadataKind = "inngest.warning" | `userland.${string}`;

/**
 * The operation use to combine multiple metadata updates of the same kind.
 */
export type MetadataOpcode = "merge";

/**
 * A metadata update containing `values` to be merged according to `op`
 * at the configured `scope` for the configured `kind`.
 */
export type MetadataUpdate = {
  kind: MetadataKind;
  scope: MetadataScope;
  op: MetadataOpcode;
  values: Record<string, unknown>;
};

export type MetadataBuilder<Extras = {}> = Simplify<
  {
    /**
     * Sets the metadata context to a specific (or current if omitted) run.
     */
    run(id?: string): Simplify<Omit<MetadataBuilder<Extras>, "run">>;

    /**
     * Sets the metadata context to a specific (or current if omitted) step.
     */
    step(
      id?: string,
      index?: number,
    ): Simplify<Omit<MetadataBuilder<Extras>, "run" | "step">>;

    /**
     * Sets the metadata context to a specific (or current if omitted) step attempt.
     */
    attempt(
      index?: number,
    ): Simplify<Omit<MetadataBuilder<Extras>, "run" | "step" | "attempt">>;

    /**
     * Sets the metadata context to a specific span.
     */
    span(
      id: string,
    ): Simplify<
      Omit<MetadataBuilder<Extras>, "run" | "step" | "attempt" | "span">
    >;

    /**
     * Attach metadata to the configured run/step/step attempt/span.
     *
     * By default it will attach metadata to the current run if
     * executed inside the body of `createFunction` or to the
     * current step attempt if executed inside `step.run`.
     */
    update(values: Record<string, unknown>, kind?: string): Promise<void>;
  } & Extras
>;

/**
 * A wrapper around `MetadataBuilder` to attach metadata as a step.
 */
export type MetadataStepTool = MetadataBuilder<{
  /**
   * Allows many `updates` to be sent with the same scope.
   */
  do: (fn: (builder: MetadataBuilder) => Promise<void>) => Promise<void>;
}>;

/**
 * Configures and sends metadata updates.
 *
 * It sends metadata updates via step opcodes if the metadata is
 * configured to be attached to the current run/step/step attempt
 * and `update` is called inside of `step.run`.
 *
 * Otherwise it sends updates via the Inngest API.
 */
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

  span(id: string): UnscopedMetadataBuilder {
    return new UnscopedMetadataBuilder(this.client, {
      ...this.config,
      spanId: id,
    });
  }

  async update(
    values: Record<string, unknown>,
    kind: string = "default",
  ): Promise<void> {
    await performOp(
      this.client,
      this.config,
      values,
      `userland.${kind}`,
      "merge",
    );
  }

  toJSON() {
    return this.config;
  }
}

/**
 * Creates a `MetadataTarget` based on the current execution context and the `BuilderConfig` created using
 * `MetadataBuilder`.
 */
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

  if (config.stepId === null && !stepId) {
    const reason = !ctxExecution
      ? "no function execution context is available"
      : !ctxExecution.executingStep
        ? "you are not inside a step.run() callback"
        : "you are targeting a different run";

    throw new Error(`step() was called without a step ID, but ${reason}`);
  }

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

  if (config.attempt === null && attempt === undefined) {
    const reason = !stepId
      ? "no step context is available"
      : "you are targeting a different step";

    throw new Error(`attempt() was called without a value, but ${reason}`);
  }

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
  op: MetadataOpcode,
  metadata: Record<string, unknown>,
) {
  return [
    {
      kind,
      op,
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
  op: MetadataOpcode,
  metadata: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<void> {
  const metadataArray = createMetadataPayload(kind, op, metadata);

  await client["_updateMetadata"]({
    target,
    metadata: metadataArray,
    headers,
  });
}

function getBatchScope(config: BuilderConfig): MetadataScope {
  if (config.spanId !== undefined) return "extended_trace";
  if (config.attempt !== undefined) return "step_attempt";
  if (config.stepId !== undefined) return "step";
  if (config.runId !== undefined) return "run";

  return "step_attempt";
}

async function performOp(
  client: Inngest,
  config: BuilderConfig,
  values: Record<string, unknown>,
  kind: MetadataKind,
  op: MetadataOpcode,
): Promise<void> {
  const ctx = await getAsyncCtx();
  const target = buildTarget(config, ctx);

  const isInsideRun = !!ctx?.execution;
  const isInsideStep = !!ctx?.execution?.executingStep;
  if (isInsideRun && !isInsideStep) {
    console.warn(
      "inngest: metadata.update() called outside of a step. This metadata may be lost on retries. Wrap the call in step.run() for durable metadata.",
    );
  }

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
    const scope = getBatchScope(config);

    if (
      executingStep?.id &&
      execInstance &&
      execInstance.addMetadata(executingStep.id, kind, scope, op, values)
    ) {
      return;
    }
  }

  const headers =
    (
      ctx?.execution?.instance as
        | { options?: { headers?: Record<string, string> } }
        | undefined
    )?.options?.headers ?? undefined;

  await sendMetadataViaAPI(client, target, kind, op, values, headers);
}

export const metadataSymbol = Symbol.for("inngest.step.metadata");

/**
 * Middleware that enables the experimental step.metadata() feature.
 *
 * @example
 * ```ts
 * import { metadataMiddleware } from "inngest/experimental";
 *
 * const inngest = new Inngest({
 *   id: "my-app",
 *   middleware: [metadataMiddleware()],
 * });
 * ```
 */
export const metadataMiddleware = () => {
  return new InngestMiddleware({
    name: "Inngest: Experimental Metadata",
    init({ client }) {
      (client as Inngest.Any)._experimentalMetadataEnabled = true;
      return {
        onFunctionRun() {
          return {
            transformInput(input) {
              return {
                ctx: {
                  step: {
                    ...input.steps,
                    /**
                     * Create a durable metadata update wrapped in a step
                     *
                     * @param memoizationId - The step ID used for the step itself, ensuring the
                     *   metadata update is only performed once even on function retries.
                     *
                     * @example
                     * ```ts
                     * // Update metadata for the current run
                     * await step.metadata("update-status").update({ status: "processing" });
                     *
                     * // Update metadata for a different run
                     * await step.metadata("notify-parent")
                     *   .run(parentRunId)
                     *   .update({ childCompleted: true });
                     * ```
                     */
                    metadata: (input.steps as unknown as ExperimentalStepTools)[
                      metadataSymbol
                    ],
                  },
                },
              };
            },
          };
        },
      };
    },
  });
};
