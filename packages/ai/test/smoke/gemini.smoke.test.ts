import { describe, test, expect, beforeAll, beforeEach } from "vitest";
import { config } from "dotenv";
import { gemini } from "../../src/models/gemini.js";
import type { GeminiAiAdapter } from "../../src/adapters/gemini.js";

// Load environment variables
config();

describe("Gemini AI Adapter Smoke Tests", () => {
  let apiKey: string;

  beforeAll(() => {
    apiKey = process.env.GEMINI_API_KEY || "";
    if (!apiKey) {
      throw new Error(
        "GEMINI_API_KEY environment variable is required for smoke tests. " +
          "Copy .env.example to .env and add your API key."
      );
    }
  });

  // Add 2-second delay between tests to avoid rate limiting
  beforeEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 2000));
  });

  test("Adapter configuration and URL construction", () => {
    const model = gemini({
      model: "gemini-2.0-flash-exp",
      apiKey,
    });

    // Test adapter properties
    expect(model.format).toBe("gemini");
    expect(model.url).toContain("gemini-2.0-flash-exp");
    expect(model.url).toContain("generateContent");
    expect(model.url).toContain("key=");
    expect(model.authKey).toBe(apiKey);
    expect(model.options.model).toBe("gemini-2.0-flash-exp");
    expect(model.onCall).toBeDefined();
    expect(typeof model.onCall).toBe("function");
  });

  test("Base URL configuration", () => {
    const model = gemini({
      model: "gemini-1.5-flash",
      apiKey,
      baseUrl: "https://custom-api.example.com/v1/",
    });

    expect(model.url).toContain("https://custom-api.example.com/v1/");
    expect(model.url).toContain("gemini-1.5-flash");
    expect(model.url).toContain("generateContent");
  });

  test("onCall transformation with default parameters", () => {
    const model = gemini({
      model: "gemini-2.0-flash-exp",
      apiKey,
      defaultParameters: {
        generationConfig: {
          temperature: 0.8,
          maxOutputTokens: 500,
        },
      },
    });

    const inputBody: GeminiAiAdapter.GenerateContentRequest = {
      contents: [
        {
          role: "user",
          parts: [{ text: "Hello" }],
        },
      ],
    };

    const bodyToTransform = JSON.parse(JSON.stringify(inputBody));

    // Test onCall applies default parameters
    model.onCall!(model, bodyToTransform);

    expect(bodyToTransform.generationConfig).toBeDefined();
    expect(bodyToTransform.generationConfig.temperature).toBe(0.8);
    expect(bodyToTransform.generationConfig.maxOutputTokens).toBe(500);
  });

  test("onCall transformation preserves existing parameters", () => {
    const model = gemini({
      model: "gemini-2.0-flash-exp",
      apiKey,
      defaultParameters: {
        generationConfig: {
          temperature: 0.8,
          maxOutputTokens: 500,
        },
      },
    });

    const inputBody: GeminiAiAdapter.GenerateContentRequest = {
      contents: [
        {
          role: "user",
          parts: [{ text: "Hello" }],
        },
      ],
      generationConfig: {
        temperature: 0.2, // Should override default
        topP: 0.9, // Should be preserved
      },
    };

    const bodyToTransform = JSON.parse(JSON.stringify(inputBody));

    // Test onCall merges parameters correctly
    model.onCall!(model, bodyToTransform);

    expect(bodyToTransform.generationConfig.temperature).toBe(0.2); // Original preserved
    expect(bodyToTransform.generationConfig.topP).toBe(0.9); // Original preserved
    expect(bodyToTransform.generationConfig.maxOutputTokens).toBe(500); // Default applied
  });

  test("Real API integration - basic text generation", async () => {
    const model = gemini({
      model: "gemini-2.0-flash-exp",
      apiKey,
    });

    const requestBody: GeminiAiAdapter.GenerateContentRequest = {
      contents: [
        {
          role: "user",
          parts: [
            { text: "Say hello and explain what you are in one sentence." },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 100,
      },
    };

    // Apply adapter transformations
    const body = JSON.parse(JSON.stringify(requestBody));
    model.onCall!(model, body);

    // Make actual API call using adapter configuration
    const response = await fetch(model.url!, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...model.headers,
      },
      body: JSON.stringify(body),
    });

    expect(response.ok).toBe(true);

    const result: GeminiAiAdapter.GenerateContentResponse =
      await response.json();

    // Validate response structure matches our types
    expect(result.candidates).toBeDefined();
    expect(result.candidates?.length).toBeGreaterThan(0);
    expect(result.candidates?.[0]?.content.parts).toBeDefined();
    expect(result.candidates?.[0]?.finishReason).toBeDefined();
    expect(result.usageMetadata).toBeDefined();
    expect(result.usageMetadata?.totalTokenCount).toBeGreaterThan(0);
    expect(result.usageMetadata?.promptTokenCount).toBeGreaterThan(0);
    expect(result.usageMetadata?.candidatesTokenCount).toBeGreaterThan(0);
  });

  test("Real API integration - thinking features", async () => {
    const model = gemini({
      model: "gemini-2.0-flash-thinking-exp",
      apiKey,
    });

    const requestBody: GeminiAiAdapter.GenerateContentRequest = {
      contents: [
        {
          role: "user",
          parts: [
            {
              text: "Calculate 15 - 7 + 12. Show your work.",
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 400,
        thinkingConfig: {
          thinkingBudget: 512,
          includeThoughts: true,
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
        ...model.headers,
      },
      body: JSON.stringify(body),
    });

    expect(response.ok).toBe(true);

    const result: GeminiAiAdapter.GenerateContentResponse =
      await response.json();

    // Validate thinking-specific features
    expect(result.candidates).toBeDefined();
    expect(result.usageMetadata).toBeDefined();
    expect(result.usageMetadata?.thoughtsTokenCount).toBeGreaterThan(0);
    expect(result.usageMetadata?.totalTokenCount).toBeGreaterThan(0);
  });

  test("Real API integration - structured JSON output", async () => {
    const model = gemini({
      model: "gemini-2.0-flash-exp",
      apiKey,
    });

    const requestBody: GeminiAiAdapter.GenerateContentRequest = {
      contents: [
        {
          role: "user",
          parts: [
            {
              text: "Generate a person profile with name, age, and hobbies.",
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 200,
        responseMimeType: "application/json",
        responseSchema: {
          type: "object",
          properties: {
            name: { type: "string" },
            age: { type: "number" },
            hobbies: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: ["name", "age", "hobbies"],
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
        ...model.headers,
      },
      body: JSON.stringify(body),
    });

    expect(response.ok).toBe(true);

    const result: GeminiAiAdapter.GenerateContentResponse =
      await response.json();

    expect(result.candidates).toBeDefined();
    expect(result.candidates?.[0]?.finishReason).toBe("STOP");

    const firstPart = result.candidates?.[0]?.content.parts[0];
    expect(firstPart).toBeDefined();
    expect("text" in firstPart!).toBe(true);

    if ("text" in firstPart!) {
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
  });

  test("Error handling - invalid API key", async () => {
    const model = gemini({
      model: "gemini-2.0-flash-exp",
      apiKey: "invalid-key",
    });

    const requestBody: GeminiAiAdapter.GenerateContentRequest = {
      contents: [
        {
          role: "user",
          parts: [{ text: "Hello" }],
        },
      ],
      generationConfig: {
        maxOutputTokens: 10,
      },
    };

    // Apply adapter transformations
    const body = JSON.parse(JSON.stringify(requestBody));
    model.onCall!(model, body);

    // Make API call with invalid key
    const response = await fetch(model.url!, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...model.headers,
      },
      body: JSON.stringify(body),
    });

    expect(response.ok).toBe(false);
    expect(response.status).toBe(400);
  });

  test("Type safety - input and output types", () => {
    const model = gemini({
      model: "gemini-2.0-flash-exp",
      apiKey,
    });

    // Test that types are correctly defined
    expect(model.format).toBe("gemini");

    // These should compile without errors due to proper typing
    const input: (typeof model)["~types"]["input"] = {
      contents: [
        {
          role: "user",
          parts: [{ text: "Hello" }],
        },
      ],
    };

    const mockOutput: (typeof model)["~types"]["output"] = {
      candidates: [
        {
          content: {
            parts: [{ text: "Hello!" }],
          },
        },
      ],
      usageMetadata: {
        totalTokenCount: 10,
        promptTokenCount: 5,
        candidatesTokenCount: 5,
      },
    };

    expect(input.contents).toBeDefined();
    expect(mockOutput.candidates).toBeDefined();
  });
});
