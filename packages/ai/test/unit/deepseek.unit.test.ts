import { describe, expect, test } from "vitest";
import { deepseek } from "../../src/models/deepseek.js";

describe("DeepSeek model selection", () => {
  test.each(["deepseek-flash", "deepseek-v4-pro"])(
    "uses %s for chat completions",
    (id) => {
      const model = deepseek({ model: id, apiKey: "test-key" });
      const body = { model: "", messages: [] };

      model.onCall?.(model, body);

      expect(model.url).toBe("https://api.deepseek.com/v1/chat/completions");
      expect(body.model).toBe(id);
    },
  );

  test("preserves a custom model ID and compatible base URL", () => {
    const id = "custom-deepseek";
    const model = deepseek({
      model: id,
      apiKey: "test-key",
      baseUrl: "https://example.com/api",
    });
    const body = { model: "", messages: [] };

    model.onCall?.(model, body);

    expect(model.url).toBe("https://example.com/api/chat/completions");
    expect(body.model).toBe(id);
  });
});
