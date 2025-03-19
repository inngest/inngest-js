import { EventSchemas, Inngest } from "inngest";
import { z } from "zod";

// Define the meal generation event schema
export const mealGenerateSchema = z.object({
  name: z.literal("meal.generate"),
  data: z.object({
    participantsCount: z.number().int().positive(),
    preferences: z.array(z.string()),
  }),
});

// Create type from the schema
export type MealGenerateEvent = z.infer<typeof mealGenerateSchema>;

// Define all events type
export type Events = {
  "meal.generate": MealGenerateEvent;
};

// Create a typed client
export const typedInngest = new Inngest({
  id: "my-app",
  schemas: new EventSchemas().fromZod([mealGenerateSchema]),
});
