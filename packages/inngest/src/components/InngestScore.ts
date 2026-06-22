import { isFiniteNumber, isRecord } from "../helpers/types.ts";
import type { ExperimentRef } from "../types.ts";
import type { Inngest } from "./Inngest.ts";
import { performOp } from "./InngestMetadata.ts";
import type { ExperimentalStepTools } from "./InngestStepTools.ts";
import { Middleware } from "./middleware/middleware.ts";

const scoreKind = "inngest.score" as const;
const experimentKind = "inngest.experiment" as const;
const maxKindByteLength = 128;
const maxScoreNameByteLength = maxKindByteLength;

type ScoreValue = number | boolean;

export type ScoreOptions = {
  runId?: string;
  stepId?: string;
  name: string;
  value: ScoreValue;
};

export type ScoreExperimentOptions = ScoreOptions & {
  experiment: ExperimentRef;
};

/**
 * The client `score` API. Call it directly to write a live score for a run or
 * step; use `.experiment(...)` to attach a score to a `group.experiment()`
 * variant.
 */
export interface ClientScore {
  /**
   * Write a live score for a run or a specific run step. Explicit targets win;
   * otherwise the current run or step is inferred from the execution context.
   * For standalone durable score writes, prefer `step.score()`.
   */
  (options: ScoreOptions): Promise<void>;

  /**
   * Attach a score to a previously-selected experiment variant, using the
   * `experiment` ref returned by `group.experiment()`. Writes the score and the
   * experiment attribution together so they co-locate on one row.
   *
   * **Call at the function-body level** (outside any `step.run()` callback), or
   * pass an explicit `runId`, so the write is run-scoped and attaches to the
   * experiment. Calling inside `step.run()` without `runId` produces a
   * step-scoped write the experiment detail backend never surfaces.
   */
  experiment(options: ScoreExperimentOptions): Promise<void>;
}

export type ScoreStepTool = (
  memoizationId: string,
  options: ScoreOptions,
) => Promise<void>;

export const scoreSymbol = Symbol.for("inngest.step.score");

function validateIdField({
  value,
  field,
  required,
}: {
  value: unknown;
  field: string;
  required: boolean;
}): void {
  if (!required && value === undefined) {
    return;
  }

  const isValidString = typeof value === "string" && value.trim().length > 0;
  if (!isValidString) {
    throw new Error(`${field} must be a non-empty string`);
  }
}

function validateScoreFields(
  options: unknown,
  requiredTargetIds: readonly ("runId" | "stepId")[],
): asserts options is {
  runId?: unknown;
  stepId?: unknown;
  name: unknown;
  value: unknown;
} {
  if (!isRecord(options)) {
    throw new Error("score options must be an object");
  }

  for (const field of ["runId", "stepId"] as const) {
    validateIdField({
      value: options[field],
      field,
      required: requiredTargetIds.includes(field),
    });
  }

  if (typeof options.name !== "string" || options.name.trim().length === 0) {
    throw new Error("score name must be a non-empty string");
  }

  // Single quote rejection mirrors the cloud MetricKeyRegex; without it,
  // valid-looking score names like "it's-broken" would silently drop in
  // variant aggregation.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — rejecting control chars and single quotes in user-supplied names
  if (/[\x00-\x1f\x7f']/.test(options.name)) {
    throw new Error(
      "score name must not contain control characters or single quotes",
    );
  }

  const nameByteLength = new TextEncoder().encode(options.name).length;
  if (nameByteLength > maxScoreNameByteLength) {
    throw new Error(
      `score name must be ${maxScoreNameByteLength} bytes or fewer in UTF-8 (got ${nameByteLength})`,
    );
  }

  if (typeof options.value !== "boolean" && !isFiniteNumber(options.value)) {
    throw new Error("score value must be a finite number or boolean");
  }
}

function validateSendScoreOptions(
  options: unknown,
): asserts options is ScoreOptions {
  validateScoreFields(options, []);
}

export function validateStepScoreOptions(
  options: unknown,
): asserts options is ScoreOptions {
  validateScoreFields(options, []);
}

export async function sendScore(
  client: Inngest,
  options: ScoreOptions,
): Promise<void> {
  validateSendScoreOptions(options);

  await performOp(
    client,
    {
      runId: options.runId,
      stepId: options.stepId,
    },
    { [options.name]: { value: options.value } },
    `${scoreKind}`,
    "merge",
  );
}

export async function sendStepScore(
  client: Inngest,
  options: ScoreOptions,
): Promise<void> {
  validateStepScoreOptions(options);

  await performOp(
    client,
    {
      // Omitted stepId means run scope and null keeps current-run lookup intact.
      runId:
        options.stepId === undefined ? (options.runId ?? null) : options.runId,
      stepId: options.stepId,
    },
    { [options.name]: { value: options.value } },
    `${scoreKind}`,
    "merge",
  );
}

function validateExperimentRef(
  experiment: unknown,
): asserts experiment is ExperimentRef {
  if (!isRecord(experiment)) {
    throw new Error("experiment must be an object");
  }
  for (const field of ["experimentName", "variant"] as const) {
    if (
      typeof experiment[field] !== "string" ||
      (experiment[field] as string).trim().length === 0
    ) {
      throw new Error(`experiment.${field} must be a non-empty string`);
    }
  }
}

export async function sendScoreExperiment(
  client: Inngest,
  options: ScoreExperimentOptions,
): Promise<void> {
  validateSendScoreOptions(options);
  validateExperimentRef(options.experiment);

  const target = { runId: options.runId, stepId: options.stepId };

  // Write the experiment attribution first, then the score. These are two
  // non-atomic metadata writes; if the second fails, attribution-without-score
  // is the benign state the system already produces (it's exactly what
  // `group.experiment()` leaves after selecting a variant but before scoring).
  // Writing the score first would instead risk a bare, unattributed score that
  // never surfaces in the experiment view.
  await performOp(
    client,
    target,
    {
      experiment_name: options.experiment.experimentName,
      variant: options.experiment.variant,
    },
    experimentKind,
    "merge",
  );
  await performOp(
    client,
    target,
    { [options.name]: { value: options.value } },
    scoreKind,
    "merge",
  );
}

export const scoreMiddleware = () => {
  class ScoreMiddleware extends Middleware.BaseMiddleware {
    readonly id = "inngest:score";

    static override onRegister({ client }: Middleware.OnRegisterArgs) {
      client["experimentalScoreEnabled"] = true;
    }

    override transformFunctionInput(
      arg: Middleware.TransformFunctionInputArgs,
    ): Middleware.TransformFunctionInputArgs & {
      ctx: {
        step: {
          /**
           * Create a durable score update wrapped in a step.
           * Omit `stepId` to attach the score to the run.
           * Use `inngest.score()` for live score writes inside `step.run()`.
           *
           * @param memoizationId - The durable step ID used to memoize this score write.
           */
          score: ExperimentalStepTools[typeof scoreSymbol];
        };
      };
    } {
      return {
        ...arg,
        ctx: {
          ...arg.ctx,
          step: {
            ...arg.ctx.step,
            score: (arg.ctx.step as unknown as ExperimentalStepTools)[
              scoreSymbol
            ],
          },
        },
      };
    }
  }

  return ScoreMiddleware;
};
