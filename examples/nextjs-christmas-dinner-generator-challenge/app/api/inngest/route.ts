import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { generateMeal } from "@/inngest/functions";

// Create an API route handler with all functions
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [generateMeal],
});
