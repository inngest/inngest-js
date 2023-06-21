import { z } from "zod";
import { type EventPayload } from "../types";

export const ErrorSchema = z.object({
  error: z.string(),
  status: z.number(),
});
export type ErrorResponse = z.infer<typeof ErrorSchema>;

export const StepsSchema = z.object({
  step: z.object({}).passthrough(),
});
export type StepsResponse = z.infer<typeof StepsSchema>;

export const BatchSchema = z.array(
  z
    .object({})
    .passthrough()
    .transform((v) => v as EventPayload)
);
export type BatchResponse = z.infer<typeof BatchSchema>;
