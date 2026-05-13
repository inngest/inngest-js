import { isRecord } from "../helpers/types.ts";
import type { Inngest } from "./Inngest.ts";
import { performOp } from "./InngestMetadata.ts";
import type { ExperimentalStepTools } from "./InngestStepTools.ts";
import { Middleware } from "./middleware/middleware.ts";

const scoreNameRegex = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

type ScoreValue = number | boolean;

export type SendScoreOptions = {
  runId: string;
  stepId?: string;
  name: string;
  value: ScoreValue;
};

export type StepScoreOptions = {
  runId?: string;
  stepId?: string;
  name: string;
  value: ScoreValue;
};

export type ScoreStepTool = (
  memoizationId: string,
  options: StepScoreOptions,
) => Promise<void>;

export const scoreSymbol = Symbol.for("inngest.step.score");

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
    const value = options[field];
    const isRequired = requiredTargetIds.includes(field);
    const invalidRequired =
      isRequired && (typeof value !== "string" || value.trim().length === 0);
    const invalidOptional =
      !isRequired &&
      value !== undefined &&
      (typeof value !== "string" || value.trim().length === 0);

    if (invalidRequired || invalidOptional) {
      throw new Error(`${field} must be a non-empty string`);
    }
  }

  if (typeof options.name !== "string" || !scoreNameRegex.test(options.name)) {
    throw new Error(
      `invalid score name "${String(options.name)}"; must match ${scoreNameRegex.source}`,
    );
  }

  if (
    typeof options.value !== "boolean" &&
    (typeof options.value !== "number" || !Number.isFinite(options.value))
  ) {
    throw new Error("score value must be a finite number or boolean");
  }
}

function normalizeScoreValue(value: ScoreValue): number {
  return typeof value === "boolean" ? Number(value) : value;
}

function validateSendScoreOptions(
  options: unknown,
): asserts options is SendScoreOptions {
  validateScoreFields(options, ["runId"]);
}

export function validateStepScoreOptions(
  options: unknown,
): asserts options is StepScoreOptions {
  validateScoreFields(options, []);
}

export async function sendScore(
  client: Inngest,
  options: SendScoreOptions,
): Promise<void> {
  validateSendScoreOptions(options);

  await performOp(
    client,
    {
      runId: options.runId,
      stepId: options.stepId,
    },
    { [options.name]: normalizeScoreValue(options.value) },
    "inngest.score",
    "merge",
  );
}

export async function sendStepScore(
  client: Inngest,
  options: StepScoreOptions,
): Promise<void> {
  validateStepScoreOptions(options);

  await performOp(
    client,
    {
      runId:
        options.stepId === undefined ? (options.runId ?? null) : options.runId,
      stepId: options.stepId,
    },
    { [options.name]: normalizeScoreValue(options.value) },
    "inngest.score",
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
           *
           * @param memoizationId - The score step ID suffix; the durable step is
           *   recorded as `score:${memoizationId}`.
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
