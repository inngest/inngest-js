import { describe, test, expect } from "vitest";
import { gemini } from "../../src/models/gemini.js";
import type { Gemini } from "../../src/models/gemini.js";
import { GeminiAiAdapter } from "../../src/adapters/gemini.js";

describe("Gemini Adapter Unit Tests", () => {
  describe("Model Creation", () => {
    test("creates adapter with required options", () => {
      const model = gemini({
        model: "gemini-2.0-flash-exp",
        apiKey: "test-api-key",
      });

      expect(model).toBeDefined();
      expect(model.format).toBe("gemini");
      expect(model.authKey).toBe("test-api-key");
      expect(model.options.model).toBe("gemini-2.0-flash-exp");
      expect(model.onCall).toBeDefined();
      expect(typeof model.onCall).toBe("function");
    });

    test("uses environment variable when no API key provided", () => {
      // Mock the environment variable
      const originalEnv = process.env.GEMINI_API_KEY;
      process.env.GEMINI_API_KEY = "env-api-key";

      const model = gemini({
        model: "gemini-1.5-flash",
      });

      expect(model.authKey).toBe("env-api-key");

      // Restore original environment
      if (originalEnv !== undefined) {
        process.env.GEMINI_API_KEY = originalEnv;
      } else {
        delete process.env.GEMINI_API_KEY;
      }
    });

    test("explicit API key takes precedence over environment", () => {
      const originalEnv = process.env.GEMINI_API_KEY;
      process.env.GEMINI_API_KEY = "env-api-key";

      const model = gemini({
        model: "gemini-1.5-flash",
        apiKey: "explicit-api-key",
      });

      expect(model.authKey).toBe("explicit-api-key");

      // Restore original environment
      if (originalEnv !== undefined) {
        process.env.GEMINI_API_KEY = originalEnv;
      } else {
        delete process.env.GEMINI_API_KEY;
      }
    });
  });

  describe("URL Construction", () => {
    test("constructs correct URL with default base URL", () => {
      const model = gemini({
        model: "gemini-2.0-flash-exp",
        apiKey: "test-key",
      });

      expect(model.url).toContain(
        "https://generativelanguage.googleapis.com/v1beta/",
      );
      expect(model.url).toContain(
        "models/gemini-2.0-flash-exp:generateContent",
      );
      expect(model.url).toContain("key=test-key");
    });

    test("constructs correct URL with custom base URL", () => {
      const model = gemini({
        model: "gemini-1.5-flash",
        apiKey: "test-key",
        baseUrl: "https://custom-api.example.com/v1/",
      });

      expect(model.url).toContain("https://custom-api.example.com/v1/");
      expect(model.url).toContain("models/gemini-1.5-flash:generateContent");
      expect(model.url).toContain("key=test-key");
    });

    test("handles base URL without trailing slash", () => {
      const model = gemini({
        model: "gemini-1.5-flash",
        apiKey: "test-key",
        baseUrl: "https://custom-api.example.com/v1",
      });

      expect(model.url).toContain("https://custom-api.example.com/v1/");
      expect(model.url).toContain("models/gemini-1.5-flash:generateContent");
    });

    test("supports different model names", () => {
      const models = [
        "gemini-1.5-flash",
        "gemini-1.5-flash-8b",
        "gemini-1.5-pro",
        "gemini-2.0-flash",
        "gemini-2.0-flash-thinking-exp",
        "text-embedding-004",
      ];

      models.forEach((modelName) => {
        const model = gemini({
          model: modelName as Gemini.Model,
          apiKey: "test-key",
        });

        expect(model.url).toContain(`models/${modelName}:generateContent`);
        expect(model.options.model).toBe(modelName);
      });
    });
  });

  describe("Parameter Transformation (onCall)", () => {
    test("applies default parameters when body is empty", () => {
      const model = gemini({
        model: "gemini-2.0-flash-exp",
        apiKey: "test-key",
        defaultParameters: {
          generationConfig: {
            temperature: 0.8,
            maxOutputTokens: 500,
            topP: 0.9,
          },
        },
      });

      const body: GeminiAiAdapter.GenerateContentRequest = {
        contents: [
          {
            role: "user",
            parts: [{ text: "Hello" }],
          },
        ],
      };

      model.onCall!(model, body);

      expect(body.generationConfig).toBeDefined();
      expect(body.generationConfig!.temperature).toBe(0.8);
      expect(body.generationConfig!.maxOutputTokens).toBe(500);
      expect(body.generationConfig!.topP).toBe(0.9);
    });

    test("preserves existing parameters over defaults", () => {
      const model = gemini({
        model: "gemini-2.0-flash-exp",
        apiKey: "test-key",
        defaultParameters: {
          generationConfig: {
            temperature: 0.8,
            maxOutputTokens: 500,
            topP: 0.9,
          },
        },
      });

      const body: GeminiAiAdapter.GenerateContentRequest = {
        contents: [
          {
            role: "user",
            parts: [{ text: "Hello" }],
          },
        ],
        generationConfig: {
          temperature: 0.2, // Should override default
          topK: 40, // Should be preserved
        },
      };

      model.onCall!(model, body);

      expect(body.generationConfig!.temperature).toBe(0.2); // User value preserved
      expect(body.generationConfig!.topK).toBe(40); // User value preserved
      expect(body.generationConfig!.maxOutputTokens).toBe(500); // Default applied
      expect(body.generationConfig!.topP).toBe(0.9); // Default applied
    });

    test("handles nested parameter merging correctly", () => {
      const model = gemini({
        model: "gemini-2.0-flash-exp",
        apiKey: "test-key",
        defaultParameters: {
          generationConfig: {
            temperature: 0.8,
            maxOutputTokens: 500,
            thinkingConfig: {
              thinkingBudget: 1024,
              includeThoughts: false,
            },
          },
        },
      });

      const body: GeminiAiAdapter.GenerateContentRequest = {
        contents: [
          {
            role: "user",
            parts: [{ text: "Hello" }],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          thinkingConfig: {
            includeThoughts: true, // Should override default
          },
        },
      };

      model.onCall!(model, body);

      expect(body.generationConfig!.temperature).toBe(0.2);
      expect(body.generationConfig!.maxOutputTokens).toBe(500);
      expect(body.generationConfig!.thinkingConfig!.includeThoughts).toBe(true); // User value
      expect(body.generationConfig!.thinkingConfig!.thinkingBudget).toBe(1024); // Default value
    });

    test("applies top-level default parameters", () => {
      const model = gemini({
        model: "gemini-2.0-flash-exp",
        apiKey: "test-key",
        defaultParameters: {
          systemInstruction: {
            parts: [{ text: "You are a helpful assistant." }],
          },
          safetySettings: [
            {
              category: GeminiAiAdapter.HarmCategory.HARM_CATEGORY_HARASSMENT,
              threshold:
                GeminiAiAdapter.HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
            },
          ],
        },
      });

      const body: GeminiAiAdapter.GenerateContentRequest = {
        contents: [
          {
            role: "user",
            parts: [{ text: "Hello" }],
          },
        ],
      };

      model.onCall!(model, body);

      expect(body.systemInstruction).toBeDefined();
      expect(body.systemInstruction!.parts[0]).toEqual({
        text: "You are a helpful assistant.",
      });
      expect(body.safetySettings).toBeDefined();
      expect(body.safetySettings![0].category).toBe(
        GeminiAiAdapter.HarmCategory.HARM_CATEGORY_HARASSMENT,
      );
    });

    test("does not override existing top-level parameters", () => {
      const model = gemini({
        model: "gemini-2.0-flash-exp",
        apiKey: "test-key",
        defaultParameters: {
          systemInstruction: {
            parts: [{ text: "Default instruction" }],
          },
        },
      });

      const body: GeminiAiAdapter.GenerateContentRequest = {
        contents: [
          {
            role: "user",
            parts: [{ text: "Hello" }],
          },
        ],
        systemInstruction: {
          parts: [{ text: "User instruction" }],
        },
      };

      model.onCall!(model, body);

      expect(body.systemInstruction!.parts[0]).toEqual({
        text: "User instruction",
      });
    });

    test("handles no default parameters gracefully", () => {
      const model = gemini({
        model: "gemini-2.0-flash-exp",
        apiKey: "test-key",
      });

      const body: GeminiAiAdapter.GenerateContentRequest = {
        contents: [
          {
            role: "user",
            parts: [{ text: "Hello" }],
          },
        ],
        generationConfig: {
          temperature: 0.7,
        },
      };

      const originalBody = JSON.parse(JSON.stringify(body));

      model.onCall!(model, body);

      // Body should remain unchanged when no defaults
      expect(body).toEqual(originalBody);
    });
  });

  describe("Type Safety", () => {
    test("has correct input and output types", () => {
      type GeminiModel = ReturnType<typeof gemini>;

      // Test input type
      const input: GeminiModel["~types"]["input"] = {
        contents: [
          {
            role: "user",
            parts: [{ text: "Hello" }],
          },
        ],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 100,
          thinkingConfig: {
            thinkingBudget: 512,
            includeThoughts: true,
          },
        },
      };

      expect(input.contents).toBeDefined();
      expect(input.generationConfig?.temperature).toBe(0.7);
      expect(input.generationConfig?.thinkingConfig?.thinkingBudget).toBe(512);

      // Test output type
      const output: GeminiModel["~types"]["output"] = {
        candidates: [
          {
            content: {
              parts: [
                { text: "Hello!", thought: false },
                { text: "Thinking...", thought: true },
              ],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          totalTokenCount: 50,
          promptTokenCount: 20,
          candidatesTokenCount: 25,
          thoughtsTokenCount: 5,
        },
      };

      expect(output.candidates).toBeDefined();
      expect(output.usageMetadata?.thoughtsTokenCount).toBe(5);
    });

    test("format is correctly typed", () => {
      const model = gemini({
        model: "gemini-2.0-flash-exp",
        apiKey: "test-key",
      });

      expect(model.format).toBe("gemini");

      // TypeScript should enforce this at compile time
      const format: "gemini" = model.format;
      expect(format).toBe("gemini");
    });

    test("supports all documented model types", () => {
      const modelTypes: Gemini.Model[] = [
        "gemini-1.5-flash",
        "gemini-1.5-flash-8b",
        "gemini-1.5-pro",
        "gemini-1.0-pro",
        "gemini-2.0-flash",
        "gemini-2.0-flash-lite",
        "gemini-2.5-pro",
        "gemini-2.5-flash",
        "gemini-2.5-flash-lite-preview-06-17",
        "text-embedding-004",
        "aqa",
      ];

      modelTypes.forEach((modelType) => {
        expect(() => {
          gemini({
            model: modelType,
            apiKey: "test-key",
          });
        }).not.toThrow();
      });
    });
  });

  describe("Configuration Validation", () => {
    test("adapter properties are correctly set", () => {
      const model = gemini({
        model: "gemini-2.0-flash-exp",
        apiKey: "test-key",
        baseUrl: "https://custom.example.com/",
        defaultParameters: {
          generationConfig: {
            temperature: 0.5,
          },
        },
      });

      expect(model.format).toBe("gemini");
      expect(model.authKey).toBe("test-key");
      expect(model.url).toContain("https://custom.example.com/");
      expect(model.headers).toBeDefined();
      expect(typeof model.headers).toBe("object");
      expect(model.options).toBeDefined();
      expect(model.options.model).toBe("gemini-2.0-flash-exp");
      expect(model.options.apiKey).toBe("test-key");
      expect(model.options.baseUrl).toBe("https://custom.example.com/");
      expect(model.options.defaultParameters).toBeDefined();
    });

    test("empty headers object is created", () => {
      const model = gemini({
        model: "gemini-2.0-flash-exp",
        apiKey: "test-key",
      });

      expect(model.headers).toEqual({});
      expect(typeof model.headers).toBe("object");
    });

    test("options object contains all provided configuration", () => {
      const options = {
        model: "gemini-1.5-pro" as const,
        apiKey: "test-key",
        baseUrl: "https://custom.example.com/",
        defaultParameters: {
          generationConfig: {
            temperature: 0.9,
            maxOutputTokens: 1000,
          },
        },
      };

      const model = gemini(options);

      expect(model.options).toEqual(options);
    });
  });

  describe("Edge Cases", () => {
    test("handles empty API key gracefully", () => {
      const model = gemini({
        model: "gemini-2.0-flash-exp",
        apiKey: "",
      });

      expect(model.authKey).toBe("");
      expect(model.url).toContain("key=");
    });

    test("handles undefined default parameters", () => {
      const model = gemini({
        model: "gemini-2.0-flash-exp",
        apiKey: "test-key",
        defaultParameters: undefined,
      });

      const body: GeminiAiAdapter.GenerateContentRequest = {
        contents: [
          {
            role: "user",
            parts: [{ text: "Hello" }],
          },
        ],
      };

      const originalBody = JSON.parse(JSON.stringify(body));

      expect(() => model.onCall!(model, body)).not.toThrow();
      expect(body).toEqual(originalBody);
    });

    test("handles empty generationConfig in defaults", () => {
      const model = gemini({
        model: "gemini-2.0-flash-exp",
        apiKey: "test-key",
        defaultParameters: {
          generationConfig: {},
        },
      });

      const body: GeminiAiAdapter.GenerateContentRequest = {
        contents: [
          {
            role: "user",
            parts: [{ text: "Hello" }],
          },
        ],
        generationConfig: {
          temperature: 0.7,
        },
      };

      model.onCall!(model, body);

      expect(body.generationConfig!.temperature).toBe(0.7);
    });
  });
});
