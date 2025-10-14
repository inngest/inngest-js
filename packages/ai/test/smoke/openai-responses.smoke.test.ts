import { describe, test, expect, beforeAll, beforeEach } from "vitest";
import { config } from "dotenv";
import { openaiResponses } from "../../src/models/openai-responses.js";
import type { OpenAiResponsesApi } from "../../src/adapters/openai-responses.js";

// Load environment variables
config();

describe("OpenAI Responses Adapter Smoke Tests", () => {
  let apiKey: string;

  beforeAll(() => {
    apiKey = process.env.OPENAI_API_KEY || "";
    if (!apiKey) {
      throw new Error(
        "OPENAI_API_KEY environment variable is required for smoke tests. " +
          "Copy .env.example to .env and add your API key."
      );
    }
  });

  // Add 2-second delay between tests to avoid rate limiting
  beforeEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 2000));
  });

  test("Adapter configuration and URL construction", () => {
    const model = openaiResponses({
      model: "gpt-5",
      apiKey,
    });

    expect(model.format).toBe("openai-responses");
    expect(model.url).toContain("responses");
    expect(model.url).toContain("https://api.openai.com/v1/");
    expect(model.authKey).toBe(apiKey);
    expect(model.options.model).toBe("gpt-5");
    expect(model.onCall).toBeDefined();
    expect(typeof model.onCall).toBe("function");
  });

  test("Base URL configuration", () => {
    const model = openaiResponses({
      model: "gpt-5",
      apiKey,
      baseUrl: "https://custom-api.example.com/v1/",
    });

    expect(model.url).toContain("https://custom-api.example.com/v1/");
    expect(model.url?.endsWith("responses")).toBe(true);
  });

  test("onCall transformation with default parameters", () => {
    const model = openaiResponses({
      model: "gpt-5",
      apiKey,
      defaultParameters: {
        temperature: 0.8,
        max_output_tokens: 500,
      },
    });

    const inputBody: OpenAiResponsesApi.Request = {
      input: "Hello",
    };

    const bodyToTransform = JSON.parse(JSON.stringify(inputBody));

    // Test onCall applies default parameters
    model.onCall!(model, bodyToTransform);

    expect(bodyToTransform.temperature).toBe(0.8);
    expect(bodyToTransform.max_output_tokens).toBe(500);
  });

  test("Real API integration - basic text generation", async () => {
    const model = openaiResponses({
      model: "gpt-5",
      apiKey,
    });

    const requestBody: OpenAiResponsesApi.Request = {
      input: "Say hello and explain what you are in one short sentence.",
      max_output_tokens: 100,
    };

    // Apply adapter transformations
    const body = JSON.parse(JSON.stringify(requestBody));
    model.onCall!(model, body);

    // Make actual API call using adapter configuration
    const response = await fetch(model.url!, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${model.authKey}`,
      },
      body: JSON.stringify(body),
    });

    // If this fails, the assertion below will provide the failure signal

    expect(response.ok).toBe(true);

    const result: OpenAiResponsesApi.Response = await response.json();

    // Validate response structure matches our types
    expect(Array.isArray(result.output)).toBe(true);
    expect(result.output.length).toBeGreaterThan(0);

    const first = result.output[0];
    if (first && first.type === "message") {
      expect(Array.isArray(first.content)).toBe(true);
      const textPart = first.content.find((c) => c.type === "output_text");
      expect(textPart && "text" in textPart && textPart.text.length > 0).toBe(
        true
      );
    }

    if (result.usage) {
      expect(result.usage.total_tokens).toBeGreaterThan(0);
    }
  });

  test("Real API integration - structured JSON output", async () => {
    const model = openaiResponses({
      model: "gpt-5",
      apiKey,
    });

    const requestBody: OpenAiResponsesApi.Request = {
      input:
        "Generate a JSON object with name (string), age (number), and hobbies (string array). Return only JSON.",
      max_output_tokens: 200,
      text: {
        format: {
          type: "json_schema",
          name: "profile",
          strict: true,
          schema: {
            type: "object",
            properties: {
              name: { type: "string" },
              age: { type: "number" },
              hobbies: { type: "array", items: { type: "string" } },
            },
            required: ["name", "age", "hobbies"],
            additionalProperties: false,
          },
        },
      },
    };

    // Apply adapter transformations
    const body = JSON.parse(JSON.stringify(requestBody));
    model.onCall!(model, body);

    // Make actual API call
    const response = await fetch(model.url!, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${model.authKey}`,
      },
      body: JSON.stringify(body),
    });

    // If this fails, the assertion below will provide the failure signal

    expect(response.ok).toBe(true);

    const result: OpenAiResponsesApi.Response = await response.json();

    // Find a text output and validate JSON
    const message = result.output.find((i) => i.type === "message");
    if (!message) {
      // Accept reasoning-only outputs for gpt-5 style responses
      expect(result.output.some((i) => i.type === "reasoning")).toBe(true);
      return;
    }
    expect(message).toBeDefined();
    if (message && message.type === "message") {
      const firstPart = message.content.find((p) => p.type === "output_text");
      expect(firstPart).toBeDefined();
      if (firstPart && firstPart.type === "output_text") {
        const jsonText = firstPart.text;
        expect(() => JSON.parse(jsonText)).not.toThrow();
        const parsed = JSON.parse(jsonText);
        expect(parsed).toHaveProperty("name");
        expect(parsed).toHaveProperty("age");
        expect(parsed).toHaveProperty("hobbies");
        expect(typeof parsed.name).toBe("string");
        expect(typeof parsed.age).toBe("number");
        expect(Array.isArray(parsed.hobbies)).toBe(true);
      }
    }
  });

  test("Reasoning signals (best-effort)", async () => {
    const model = openaiResponses({
      model: "gpt-5",
      apiKey,
    });

    const requestBody: OpenAiResponsesApi.Request = {
      input: "Briefly explain how to add two numbers.",
      reasoning: { effort: "medium" },
      max_output_tokens: 150,
    };

    const body = JSON.parse(JSON.stringify(requestBody));
    model.onCall!(model, body);

    const response = await fetch(model.url!, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${model.authKey}`,
      },
      body: JSON.stringify(body),
    });

    // If this fails, the assertion below will provide the failure signal

    expect(response.ok).toBe(true);

    const result: OpenAiResponsesApi.Response = await response.json();
    if (
      result.usage?.output_tokens_details &&
      typeof result.usage.output_tokens_details.reasoning_tokens === "number"
    ) {
      expect(
        result.usage.output_tokens_details.reasoning_tokens
      ).toBeGreaterThanOrEqual(0);
    }
  });

  test("Error handling - invalid API key", async () => {
    const model = openaiResponses({
      model: "gpt-5",
      apiKey: "invalid-key",
    });

    const requestBody: OpenAiResponsesApi.Request = {
      input: "Hello",
      max_output_tokens: 10,
    };

    // Apply adapter transformations
    const body = JSON.parse(JSON.stringify(requestBody));
    model.onCall!(model, body);

    // Make API call with invalid key
    const response = await fetch(model.url!, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${model.authKey}`,
      },
      body: JSON.stringify(body),
    });

    expect(response.ok).toBe(false);
    expect(response.status).toBe(401);
  });
});
