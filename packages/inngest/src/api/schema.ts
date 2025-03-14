import * as v from "valibot";
import { ExecutionVersion } from "../helpers/consts.ts";
import { type EventPayload, jsonErrorSchema } from "../types.ts";

export const errorSchema = v.object({
  error: v.string(),
  status: v.number(),
});
export type ErrorResponse = v.InferOutput<typeof errorSchema>;

const v0StepSchema = v.nullish(
  v.record(
    v.string(),
    v.pipe(
      v.any(),
      v.check(
        (v) => typeof v !== "undefined",
        "Values in steps must be defined",
      ),
    ),
  ),
);

const v1StepSchema = v.optional(
  v.record(
    v.string(),
    v.union([
      v.strictObject({
        type: v.optional(v.literal("data"), "data"),
        data: v.pipe(
          v.any(),
          v.check(
            (v) => typeof v !== "undefined",
            "Data in steps must be defined",
          ),
        ),
      }),
      v.strictObject({
        type: v.optional(v.literal("error"), "error"),
        error: jsonErrorSchema,
      }),
      v.strictObject({
        type: v.optional(v.literal("input"), "input"),
        input: v.pipe(
          v.any(),
          v.check(
            (v) => typeof v !== "undefined",
            "If input is present it must not be `undefined`",
          ),
        ),
      }),

      /**
       * If the result isn't a distcint `data` or `error` object, then it's
       * likely that the executor has set this directly to a value, for example
       * in the case of `sleep` or `waitForEvent`.
       *
       * In this case, pull the entire value through as data.
       */
      v.pipe(
        v.any(),
        v.transform((v) => ({
          type: "data" as const,
          data: v,
        })),
      ),
    ]),
  ),
  {},
);

const v2StepSchema = v1StepSchema;

export const stepsSchemas = {
  [ExecutionVersion.V0]: v0StepSchema,
  [ExecutionVersion.V1]: v1StepSchema,
  [ExecutionVersion.V2]: v2StepSchema,
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
} satisfies Record<ExecutionVersion, v.BaseSchema<any, any, any>>;

export type StepsResponse = {
  [V in ExecutionVersion]: v.InferOutput<(typeof stepsSchemas)[V]>;
}[ExecutionVersion];

export const batchSchema = v.array(
  v.record(
    v.string(),
    v.pipe(
      v.any(),
      v.transform((v) => v as EventPayload),
    ),
  ),
);
export type BatchResponse = v.InferOutput<typeof batchSchema>;
