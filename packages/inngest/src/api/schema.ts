import { z } from "zod";
import { ExecutionVersion } from "../components/execution/InngestExecution.js";
import { jsonErrorSchema, type EventPayload } from "../types.js";

export const errorSchema = z.object({
  error: z.string(),
  status: z.number(),
});
export type ErrorResponse = z.infer<typeof errorSchema>;

export const stepsSchemas = {
  [ExecutionVersion.V0]: z
    .record(
      z.any().refine((v) => typeof v !== "undefined", {
        message: "Values in steps must be defined",
      })
    )
    .optional()
    .nullable(),
  [ExecutionVersion.V1]: z
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
            .strict()
        )

        /**
         * If the result isn't a distcint `data` or `error` object, then it's
         * likely that the executor has set this directly to a value, for example
         * in the case of `sleep` or `waitForEvent`.
         *
         * In this case, pull the entire value through as data.
         */
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        .or(z.any().transform((v) => ({ type: "data" as const, data: v })))
    )
    .default({}),
} satisfies Record<ExecutionVersion, z.ZodSchema>;

export type StepsResponse = {
  [V in ExecutionVersion]: z.infer<(typeof stepsSchemas)[V]>;
}[ExecutionVersion];

export const batchSchema = z.array(
  z.record(z.any()).transform((v) => v as EventPayload)
);
export type BatchResponse = z.infer<typeof batchSchema>;
