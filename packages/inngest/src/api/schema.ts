import { z } from "zod";
import { failureEventErrorSchema, type EventPayload } from "../types";

export const errorSchema = z.object({
  error: z.string(),
  status: z.number(),
});
export type ErrorResponse = z.infer<typeof errorSchema>;

export const stepsSchema = z
  .record(
    z
      .object({
        type: z.literal("data").optional().default("data"),
        data: z.any().refine((v) => typeof v !== "undefined", {
          message: "Data in steps must be defined",
        }),
      })
      .or(
        z.object({
          type: z.literal("error").optional().default("error"),
          error: failureEventErrorSchema,
        })
      )
  )
  .default({});

export type StepsResponse = z.infer<typeof stepsSchema>;

export const batchSchema = z.array(
  z.record(z.any()).transform((v) => v as EventPayload)
);
export type BatchResponse = z.infer<typeof batchSchema>;
