import { z } from "zod/v3";
import { ExecutionVersion } from "../helpers/consts.ts";
import { type EventPayload, jsonErrorSchema } from "../types.ts";

export const errorSchema = z.object({
  error: z.string(),
  status: z.number(),
});
export type ErrorResponse = z.infer<typeof errorSchema>;

const v0StepSchema = z
  .record(
    z.any().refine((v) => typeof v !== "undefined", {
      message: "Values in steps must be defined",
    }),
  )
  .optional()
  .nullable();

const v1StepSchema = z
  .record(
    z
      .object({
        type: z.literal("data").optional().default("data"),
        data: z.any().refine((v) => typeof v !== "undefined", {
          message: "Data in steps must be defined",
        }),
      })
      .strict()
      .or(
        z
          .object({
            type: z.literal("error").optional().default("error"),
            error: jsonErrorSchema,
          })
          .strict(),
      )
      .or(
        z
          .object({
            type: z.literal("input").optional().default("input"),
            input: z.any().refine((v) => typeof v !== "undefined", {
              message: "If input is present it must not be `undefined`",
            }),
          })
          .strict(),
      )

      /**
       * If the result isn't a distcint `data` or `error` object, then it's
       * likely that the executor has set this directly to a value, for example
       * in the case of `sleep` or `waitForEvent`.
       *
       * In this case, pull the entire value through as data.
       */

      .or(z.any().transform((v) => ({ type: "data" as const, data: v }))),
  )
  .default({});

const v2StepSchema = v1StepSchema;

export const stepsSchemas = {
  [ExecutionVersion.V0]: v0StepSchema,
  [ExecutionVersion.V1]: v1StepSchema,
  [ExecutionVersion.V2]: v2StepSchema,
} satisfies Record<ExecutionVersion, z.ZodSchema>;

export type StepsResponse = {
  [V in ExecutionVersion]: z.infer<(typeof stepsSchemas)[V]>;
}[ExecutionVersion];

export const batchSchema = z.array(
  z.record(z.any()).transform((v) => v as EventPayload),
);
export type BatchResponse = z.infer<typeof batchSchema>;
