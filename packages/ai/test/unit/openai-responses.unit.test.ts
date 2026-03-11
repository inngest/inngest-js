import { describe, test, expect } from "vitest";
import { openaiResponses } from "../../src/models/openai-responses.js";
import type { OpenAiResponsesApi } from "../../src/adapters/openai-responses.js";

describe("OpenAI Responses Adapter Unit Tests", () => {
  describe("Model Creation", () => {
    test("creates adapter with required options", () => {
      const model = openaiResponses({
        model: "gpt-5",
        apiKey: "test-api-key",
      });

      expect(model).toBeDefined();
      expect(model.format).toBe("openai-responses");
      expect(model.authKey).toBe("test-api-key");
      expect(model.options.model).toBe("gpt-5");
      expect(model.onCall).toBeDefined();
      expect(typeof model.onCall).toBe("function");
    });

    test("uses environment variable when no API key provided", () => {
      const originalEnv = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = "env-api-key";

      const model = openaiResponses({
        model: "gpt-5",
      });

      expect(model.authKey).toBe("env-api-key");

      if (originalEnv !== undefined) {
        process.env.OPENAI_API_KEY = originalEnv;
      } else {
        delete process.env.OPENAI_API_KEY;
      }
    });

    test("explicit API key takes precedence over environment", () => {
      const originalEnv = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = "env-api-key";

      const model = openaiResponses({
        model: "gpt-5",
        apiKey: "explicit-api-key",
      });

      expect(model.authKey).toBe("explicit-api-key");

      if (originalEnv !== undefined) {
        process.env.OPENAI_API_KEY = originalEnv;
      } else {
        delete process.env.OPENAI_API_KEY;
      }
    });
  });

  describe("URL Construction", () => {
    test("constructs correct URL with default base URL", () => {
      const model = openaiResponses({
        model: "gpt-5",
        apiKey: "test-key",
      });

      expect(model.url).toContain("https://api.openai.com/v1/");
      expect(model.url).toContain("responses");
      expect(model.url?.endsWith("responses")).toBe(true);
    });

    test("constructs correct URL with custom base URL", () => {
      const model = openaiResponses({
        model: "gpt-5",
        apiKey: "test-key",
        baseUrl: "https://custom-api.example.com/v1/",
      });

      expect(model.url).toContain("https://custom-api.example.com/v1/");
      expect(model.url).toContain("responses");
      expect(model.url?.endsWith("responses")).toBe(true);
    });

    test("handles base URL without trailing slash", () => {
      const model = openaiResponses({
        model: "gpt-5",
        apiKey: "test-key",
        baseUrl: "https://custom-api.example.com/v1",
      });

      expect(model.url).toContain("https://custom-api.example.com/v1/");
      expect(model.url?.endsWith("responses")).toBe(true);
    });

    test("supports different model names", () => {
      const models = [
        "gpt-5",
        "gpt-5-mini",
        "gpt-5-nano",
        "gpt-4.1-mini",
        "gpt-4.1",
        "gpt-4.5-preview",
        "gpt-4o",
        "chatgpt-4o-latest",
        "gpt-4o-mini",
        "gpt-4",
        "o1",
        "o1-preview",
        "o1-mini",
        "o3-mini",
        "gpt-4-turbo",
        "gpt-3.5-turbo",
      ] as const;

      models.forEach((modelName) => {
        const model = openaiResponses({
          model: modelName as unknown as string,
          apiKey: "test-key",
        });

        expect(model.url).toContain("responses");
        expect(model.options.model).toBe(modelName);
      });
    });
  });

  describe("Parameter Transformation (onCall)", () => {
    test("applies default parameters when body is empty", () => {
      const model = openaiResponses({
        model: "gpt-5",
        apiKey: "test-key",
        defaultParameters: {
          temperature: 0.8,
          max_output_tokens: 500,
          text: {
            format: { type: "text" },
          },
        },
      });

      const body: OpenAiResponsesApi.Request = {
        input: "Hello",
      };

      model.onCall!(model, body);

      expect(body.temperature).toBe(0.8);
      expect(body.max_output_tokens).toBe(500);
      expect(body.text?.format).toEqual({ type: "text" });
      expect(body.model).toBe("gpt-5");
    });

    test("default parameters override existing body fields (shallow)", () => {
      const model = openaiResponses({
        model: "gpt-5",
        apiKey: "test-key",
        defaultParameters: {
          temperature: 0.8, // should override
          top_p: 0.9, // should add
          text: {
            // should override whole nested object (shallow assign)
            format: {
              type: "json_schema",
              strict: true,
              schema: { a: { type: "string" } },
            },
          },
        },
      });

      const body: OpenAiResponsesApi.Request = {
        model: "gpt-4o",
        input: "Hello",
        temperature: 0.2,
        text: { format: { type: "text" } },
      };

      model.onCall!(model, body);

      // defaultParameters override body (Object.assign semantics)
      expect(body.temperature).toBe(0.8);
      expect(body.top_p).toBe(0.9);
      expect(body.text?.format).toEqual({
        type: "json_schema",
        strict: true,
        schema: { a: { type: "string" } },
      });

      // body.model is preserved if present (||= semantics)
      expect(body.model).toBe("gpt-4o");
    });

    test("applies model when missing but preserves existing model", () => {
      const model = openaiResponses({
        model: "gpt-5",
        apiKey: "test-key",
      });

      const missingModelBody: OpenAiResponsesApi.Request = { input: "Hi" };
      model.onCall!(model, missingModelBody);
      expect(missingModelBody.model).toBe("gpt-5");

      const presentModelBody: OpenAiResponsesApi.Request = {
        input: "Hi",
        model: "o1-mini",
      };
      model.onCall!(model, presentModelBody);
      expect(presentModelBody.model).toBe("o1-mini");
    });
  });

  describe("Type Safety", () => {
    test("has correct input and output types", () => {
      type OpenAiModel = ReturnType<typeof openaiResponses>;

      const input: OpenAiModel["~types"]["input"] = {
        input: "Hello",
        temperature: 0.7,
        max_output_tokens: 100,
        reasoning: { effort: "medium" },
        text: {
          format: {
            type: "json_schema",
            name: "sample",
            strict: true,
            schema: { value: { type: "string" } },
          },
        },
      };

      expect(input.input).toBeDefined();
      expect(input.temperature).toBe(0.7);

      const output: OpenAiModel["~types"]["output"] = {
        id: "res_123",
        object: "response",
        created_at: Date.now() / 1000,
        status: "completed",
        model: "gpt-5",
        output: [
          {
            id: "msg_1",
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: "Hello!" }],
          },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 15,
          total_tokens: 25,
        },
      };

      expect(output.output).toBeDefined();
      expect(output.usage?.total_tokens).toBe(25);
    });

    test("format is correctly typed", () => {
      const model = openaiResponses({ model: "gpt-5", apiKey: "test-key" });
      expect(model.format).toBe("openai-responses");

      const format: "openai-responses" = model.format;
      expect(format).toBe("openai-responses");
    });
  });

  describe("Configuration Validation", () => {
    test("adapter properties are correctly set", () => {
      const model = openaiResponses({
        model: "gpt-5",
        apiKey: "test-key",
        baseUrl: "https://custom.example.com/",
        defaultParameters: {
          temperature: 0.5,
        },
      });

      expect(model.format).toBe("openai-responses");
      expect(model.authKey).toBe("test-key");
      expect(model.url).toContain("https://custom.example.com/");
      expect(model.headers).toBeUndefined();
      expect(model.options).toBeDefined();
      expect(model.options.model).toBe("gpt-5");
      expect(model.options.apiKey).toBe("test-key");
      expect(model.options.baseUrl).toBe("https://custom.example.com/");
      expect(model.options.defaultParameters).toBeDefined();
    });

    test("options object contains all provided configuration", () => {
      const options = {
        model: "gpt-4o" as const,
        apiKey: "test-key",
        baseUrl: "https://custom.example.com/",
        defaultParameters: {
          temperature: 0.9,
          max_output_tokens: 1000,
        },
      };

      const model = openaiResponses(options);
      expect(model.options).toEqual(options);
    });
  });

  describe("Edge Cases", () => {
    test("handles empty API key gracefully", () => {
      const model = openaiResponses({
        model: "gpt-5",
        apiKey: "",
      });
      expect(model.authKey).toBe("");
    });

    test("handles undefined default parameters", () => {
      const model = openaiResponses({
        model: "gpt-5",
        apiKey: "test-key",
        defaultParameters: undefined,
      });

      const body: OpenAiResponsesApi.Request = { input: "Hello" };
      const originalBody = JSON.parse(JSON.stringify(body));

      expect(() => model.onCall!(model, body)).not.toThrow();
      expect(body).toEqual({ ...originalBody, model: "gpt-5" });
    });

    test("handles empty default parameters object without changing body except model", () => {
      const model = openaiResponses({
        model: "gpt-5",
        apiKey: "test-key",
        defaultParameters: {},
      });

      const body: OpenAiResponsesApi.Request = {
        input: "Hello",
        temperature: 0.7,
      };

      model.onCall!(model, body);
      expect(body.temperature).toBe(0.7);
      expect(body.model).toBe("gpt-5");
    });
  });

  describe("Tools and tool_choice", () => {
    test("merges tools and tool_choice via defaultParameters", () => {
      const model = openaiResponses({
        model: "gpt-5",
        apiKey: "test-key",
        defaultParameters: {
          tool_choice: "auto",
          parallel_tool_calls: true,
          tools: [
            {
              type: "function",
              name: "add",
              description: "Add two numbers",
              parameters: {
                type: "object",
                properties: {
                  a: { type: "number" },
                  b: { type: "number" },
                },
                required: ["a", "b"],
                additionalProperties: false,
              },
              strict: true,
            },
          ],
        },
      });

      const body: OpenAiResponsesApi.Request = {
        input: "Add 1 and 2 using the provided tool.",
      };

      model.onCall!(model, body);

      expect(body.model).toBe("gpt-5");
      expect(body.tool_choice).toBe("auto");
      expect(body.parallel_tool_calls).toBe(true);
      expect(Array.isArray(body.tools)).toBe(true);
      expect(body.tools && body.tools.length).toBe(1);
    });
  });

  describe("Function call item types", () => {
    test("supports function_call and function_call_output items in typing", () => {
      const response: OpenAiResponsesApi.Response = {
        id: "res_func_1",
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        status: "in_progress",
        model: "gpt-5",
        output: [
          {
            id: "fc_1",
            type: "function_call",
            name: "add",
            arguments: '{"a":1,"b":2}',
            call_id: "call_1",
          },
          {
            id: "msg_1",
            type: "message",
            status: "in_progress",
            role: "assistant",
            content: [{ type: "output_text", text: "Working..." }],
          },
          // Allow unknown future/built-in tool items via open union
          { type: "web_search_call", any: true },
        ],
      };

      expect(Array.isArray(response.output)).toBe(true);
      const call = response.output.find(
        (i) => (i as any).type === "function_call",
      ) as OpenAiResponsesApi.FunctionCallItem | undefined;
      expect(call?.name).toBe("add");
      expect(call?.call_id).toBeDefined();
    });
  });
});
