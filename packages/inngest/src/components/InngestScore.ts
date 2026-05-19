import { isFiniteNumber, isRecord } from "../helpers/types.ts";
import type { Inngest } from "./Inngest.ts";
import { performOp } from "./InngestMetadata.ts";
import type { ExperimentalStepTools } from "./InngestStepTools.ts";
import { Middleware } from "./middleware/middleware.ts";

// Server caps the full kind at 128 bytes; "inngest.score." is 14 bytes, so the
// user-supplied suffix can be up to 114 UTF-8 bytes.
const scoreKindPrefix = "inngest.score." as const;
const maxKindByteLength = 128;
const maxScoreNameByteLength = maxKindByteLength - scoreKindPrefix.length;

type ScoreValue = number | boolean;

export type ScoreOptions = {
  runId?: string;
  stepId?: string;
  name: string;
  value: ScoreValue;
};

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
    { value: options.value },
    `${scoreKindPrefix}${options.name}`,
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
    { value: options.value },
    `${scoreKindPrefix}${options.name}`,
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
