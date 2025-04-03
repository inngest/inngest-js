import { z } from "zod";
import { Stagehand } from "@browserbasehq/stagehand";
import {
  TextMessage,
  ToolCallMessage,
  ToolResultMessage,
} from "@inngest/agent-kit";
import { InferenceResult } from "@inngest/agent-kit";

export async function getStagehand(sessionId: string) {
  const stagehand = new Stagehand({
    env: "BROWSERBASE",
    apiKey: process.env.BROWSERBASE_API_KEY,
    projectId: process.env.BROWSERBASE_PROJECT_ID,
    browserbaseSessionID: sessionId,
    modelName: "gpt-4o",
    modelClientOptions: {
      apiKey: process.env.OPENAI_API_KEY,
    },
  });
  await stagehand.init();
  return stagehand;
}

export const StagehandAvailableModelSchema = z.enum([
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4o-2024-11-20",
  "gpt-4o-2024-08-06",
  "gpt-4o-2024-05-13",
  "claude-3-5-sonnet-latest",
  "claude-3-5-sonnet-20241022",
  "claude-3-5-sonnet-20240620",
  "claude-3-7-sonnet-20250219",
  "o1-mini",
  "o1-preview",
  "o3-mini",
]);

// Transform string such as "{ lastFundraiseDate: string, amount: string, round: string }" into a zod schema
export function stringToZodSchema(schema: string) {
  // Remove whitespace and curly braces
  const trimmed = schema.replace(/\s/g, "").slice(1, -1);

  // Split into individual field definitions
  const fields = trimmed.split(",");

  // Build object shape
  const shape: Record<string, z.ZodType> = {};

  for (const field of fields) {
    const [key, type] = field.split(":");

    // Check if type is an array (ends with [])
    const isArray = type.endsWith("[]");
    const baseType = isArray ? type.slice(0, -2) : type;

    let zodType: z.ZodType;
    switch (baseType) {
      case "string":
        zodType = z.string();
        break;
      case "number":
        zodType = z.number();
        break;
      case "boolean":
        zodType = z.boolean();
        break;
      case "date":
        zodType = z.date();
        break;
      default:
        zodType = z.string(); // Default to string for unknown types
    }

    // Wrap in array if needed
    shape[key] = isArray ? z.array(zodType) : zodType;
  }

  return z.object(shape);
}

export function lastResult(results: InferenceResult[] | undefined) {
  if (!results) {
    return undefined;
  }
  return results[results.length - 1];
}

type MessageType =
  | TextMessage["type"]
  | ToolCallMessage["type"]
  | ToolResultMessage["type"];

export function isLastMessageOfType(
  result: InferenceResult,
  type: MessageType
) {
  return result.output[result.output.length - 1]?.type === type;
}
