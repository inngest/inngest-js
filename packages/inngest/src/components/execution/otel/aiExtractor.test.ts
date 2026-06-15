import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Attributes, AttributeValue } from "@opentelemetry/api";
import { describe, expect, test } from "vitest";
import type { AIMetadata } from "./aiExtractor.ts";
import {
  aggregate,
  extractAIMetadataFromAttributes,
  toInngestAIMetadataValues,
} from "./aiExtractor.ts";

/**
 * These fixtures are real OTLP/JSON spans captured from instrumented OpenAI SDK
 * calls, copied from the Inngest server-side extractor's test suite. Each
 * `<variant>.otlp.json` has a sibling `<variant>.otlp.json.snap` Vitest file
 * snapshot recording, per span, the metadata this extractor produces. Run
 * `pnpm test -- -u` to regenerate the snapshots after intentional changes.
 */
const testdataDir = join(dirname(fileURLToPath(import.meta.url)), "testdata");

/** A single OTLP attribute value as encoded in OTLP/JSON. */
interface OtlpAnyValue {
  stringValue?: string;
  intValue?: number | string;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values?: OtlpAnyValue[] };
}

const unwrapOtlpValue = (v: OtlpAnyValue): AttributeValue | undefined => {
  if (v.stringValue !== undefined) return v.stringValue;
  // OTLP/JSON encodes int64 as a number or a quoted string; keep it numeric.
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.arrayValue?.values) {
    return v.arrayValue.values
      .map(unwrapOtlpValue)
      .filter((x): x is string => typeof x === "string");
  }
  return undefined;
};

interface OtlpSpan {
  name: string;
  attributes: Attributes;
}

/**
 * Parse an OTLP/JSON `ExportTraceServiceRequest` fixture into a flat list of
 * spans (in document order), each with its attributes converted to the
 * `Attributes` record shape the SDK exposes via `ReadableSpan.attributes`.
 */
const loadOtlpSpans = (fixturePath: string): OtlpSpan[] => {
  const req = JSON.parse(readFileSync(fixturePath, "utf8")) as {
    resourceSpans?: {
      scopeSpans?: {
        spans?: {
          name: string;
          attributes?: { key: string; value: OtlpAnyValue }[];
        }[];
      }[];
    }[];
  };

  const spans: OtlpSpan[] = [];
  for (const rs of req.resourceSpans ?? []) {
    for (const ss of rs.scopeSpans ?? []) {
      for (const span of ss.spans ?? []) {
        const attributes: Attributes = {};
        for (const attr of span.attributes ?? []) {
          const value = unwrapOtlpValue(attr.value);
          if (value !== undefined) {
            attributes[attr.key] = value;
          }
        }
        spans.push({ name: span.name, attributes });
      }
    }
  }
  return spans;
};

const discoverFixtures = (): {
  name: string;
  jsonPath: string;
  snapPath: string;
}[] => {
  const out: { name: string; jsonPath: string; snapPath: string }[] = [];
  for (const dir of readdirSync(testdataDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const dirPath = join(testdataDir, dir.name);
    for (const file of readdirSync(dirPath)) {
      if (!file.endsWith(".otlp.json")) continue;
      out.push({
        name: `${dir.name}/${file}`,
        jsonPath: join(dirPath, file),
        snapPath: join(dirPath, `${file}.snap`),
      });
    }
  }
  return out;
};

describe("extractAIMetadataFromAttributes", () => {
  describe("captured OTLP fixtures", () => {
    const fixtures = discoverFixtures();

    test("discovers fixtures", () => {
      expect(fixtures.length).toBeGreaterThan(0);
    });

    for (const { name, jsonPath, snapPath } of fixtures) {
      test(name, async () => {
        const spans = loadOtlpSpans(jsonPath);

        // One entry per span, in document order: the span name alongside the
        // metadata this extractor produces for it.
        const extracted = spans.map((span) => ({
          span: span.name,
          metadata: extractAIMetadataFromAttributes(span.attributes),
        }));

        await expect(
          `${JSON.stringify(extracted, null, 2)}\n`,
        ).toMatchFileSnapshot(snapPath);
      });
    }
  });

  test("returns empty object when no AI attributes are present", () => {
    expect(extractAIMetadataFromAttributes({ "http.method": "GET" })).toEqual(
      {},
    );
  });

  test("prefers semconv over vercel when both are present", () => {
    const extracted = extractAIMetadataFromAttributes({
      "ai.model.id": "vercel-model",
      "gen_ai.request.model": "semconv-model",
      "ai.response.model": "vercel-response-model",
      "gen_ai.response.model": "semconv-response-model",
      "ai.model.provider": "vercel-system",
      "gen_ai.provider.name": "semconv-system",
      "ai.response.id": "vercel-response-id",
      "gen_ai.response.id": "semconv-response-id",
      "ai.usage.inputTokens": 10,
      "gen_ai.usage.input_tokens": 22,
      "ai.usage.outputTokens": 5,
      "gen_ai.usage.output_tokens": 6,
    });
    expect(extracted).toEqual({
      model: "semconv-model",
      responseModel: "semconv-response-model",
      system: "semconv-system",
      responseId: "semconv-response-id",
      inputTokens: 22,
      outputTokens: 6,
      // No total attribute present, so it's derived from input + output.
      totalTokens: 28,
    });
  });

  test("prefers gen_ai.provider.name over the deprecated gen_ai.system", () => {
    // Both are semconv; the keyRank tiebreak ranks the deprecated key behind
    // its replacement regardless of attribute order.
    const attributes = {
      "gen_ai.system": "deprecated-system",
      "gen_ai.provider.name": "current-system",
    };
    const expected = { system: "current-system" };
    expect(extractAIMetadataFromAttributes(attributes)).toEqual(expected);
    expect(
      extractAIMetadataFromAttributes(
        Object.fromEntries(Object.entries(attributes).reverse()),
      ),
    ).toEqual(expected);
  });

  test("langfuse input tokens and response model win over co-present gen_ai", () => {
    const attributes = {
      "gen_ai.response.model": "gpt-4.1-nano-another",
      "gen_ai.usage.input_tokens": 100,
      "langfuse.observation.model.name": "gpt-4.1-nano-2025-04-14",
      "langfuse.observation.usage_details":
        '{"input":22,"output":6,"total":28,"input_cached_tokens":5}',
    };
    // Order-independent: langfuse outranks semconv regardless of key order.
    const expected = {
      responseModel: "gpt-4.1-nano-2025-04-14",
      inputTokens: 22,
      outputTokens: 6,
      totalTokens: 28,
    };
    expect(extractAIMetadataFromAttributes(attributes)).toEqual(expected);
    expect(
      extractAIMetadataFromAttributes(
        Object.fromEntries(Object.entries(attributes).reverse()),
      ),
    ).toEqual(expected);
  });

  test("ignores a malformed langfuse usage_details blob", () => {
    expect(
      extractAIMetadataFromAttributes({
        "langfuse.observation.usage_details": "not json",
      }),
    ).toEqual({});
  });

  test("prefers a provider-supplied total over deriving it from input + output", () => {
    // The provider's total need not equal input + output (e.g. it may include
    // reasoning tokens), so the supplied value must win over the derived one.
    expect(
      extractAIMetadataFromAttributes({
        "gen_ai.usage.input_tokens": 22,
        "gen_ai.usage.output_tokens": 6,
        "gen_ai.usage.total_tokens": 99,
      }),
    ).toEqual({ inputTokens: 22, outputTokens: 6, totalTokens: 99 });
  });

  test("does not derive a total when no token counts are present", () => {
    expect(
      extractAIMetadataFromAttributes({ "gen_ai.request.model": "gpt-4o" }),
    ).toEqual({ model: "gpt-4o" });
  });
});

describe("aggregate", () => {
  test("sums input and output tokens and keeps the first models", () => {
    const a: AIMetadata = {
      model: "gpt-4.1-nano",
      responseModel: "gpt-4.1-nano-2025-04-14",
      system: "openai.chat",
      responseId: "chatcmpl-a",
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
    };
    const b: AIMetadata = {
      model: "gpt-4o",
      responseModel: "gpt-4o-2024-08-06",
      system: "openai.responses",
      responseId: "chatcmpl-b",
      inputTokens: 22,
      outputTokens: 8,
      totalTokens: 30,
    };
    expect(aggregate(a, b)).toEqual({
      model: "gpt-4.1-nano",
      responseModel: "gpt-4.1-nano-2025-04-14",
      system: "openai.chat",
      responseId: "chatcmpl-a",
      inputTokens: 32,
      outputTokens: 12,
      totalTokens: 44,
    });
  });

  test("falls back to the second response model when the first is absent", () => {
    expect(
      aggregate({ inputTokens: 5 }, { responseModel: "gpt-4o-2024-08-06" }),
    ).toEqual({ responseModel: "gpt-4o-2024-08-06", inputTokens: 5 });
  });

  test("treats a missing output token count as zero", () => {
    expect(aggregate({ outputTokens: 7 }, { model: "b" })).toEqual({
      model: "b",
      outputTokens: 7,
    });
  });

  test("falls back to the second model when the first is absent", () => {
    expect(
      aggregate({ inputTokens: 5 }, { model: "gpt-4o", inputTokens: 3 }),
    ).toEqual({ model: "gpt-4o", inputTokens: 8 });
  });

  test("treats a missing input token count as zero", () => {
    expect(aggregate({ model: "a", inputTokens: 7 }, { model: "b" })).toEqual({
      model: "a",
      inputTokens: 7,
    });
    expect(aggregate({ model: "a" }, { model: "b", inputTokens: 4 })).toEqual({
      model: "a",
      inputTokens: 4,
    });
  });

  test("omits fields absent from both inputs", () => {
    expect(aggregate({}, {})).toEqual({});
    expect(aggregate({ model: "a" }, {})).toEqual({ model: "a" });
  });
});

describe("toInngestAIMetadataValues", () => {
  test("maps all fields onto the server's snake_case schema", () => {
    expect(
      toInngestAIMetadataValues({
        model: "gpt-4o",
        responseModel: "gpt-4o-2024-08-06",
        system: "openai.chat",
        responseId: "chatcmpl-abc",
        inputTokens: 42,
        outputTokens: 8,
        totalTokens: 50,
      }),
    ).toEqual({
      model: "gpt-4o",
      response_model: "gpt-4o-2024-08-06",
      system: "openai.chat",
      response_id: "chatcmpl-abc",
      input_tokens: 42,
      output_tokens: 8,
      total_tokens: 50,
    });
  });

  test("omits absent fields rather than zero-valuing them", () => {
    expect(toInngestAIMetadataValues({ model: "gpt-4o" })).toEqual({
      model: "gpt-4o",
    });
    expect(
      toInngestAIMetadataValues({ responseModel: "gpt-4o-2024-08-06" }),
    ).toEqual({ response_model: "gpt-4o-2024-08-06" });
    expect(toInngestAIMetadataValues({ system: "openai.chat" })).toEqual({
      system: "openai.chat",
    });
    expect(toInngestAIMetadataValues({ responseId: "chatcmpl-abc" })).toEqual({
      response_id: "chatcmpl-abc",
    });
    expect(toInngestAIMetadataValues({ totalTokens: 50 })).toEqual({
      total_tokens: 50,
    });
    expect(toInngestAIMetadataValues({ inputTokens: 7 })).toEqual({
      input_tokens: 7,
    });
    expect(toInngestAIMetadataValues({ outputTokens: 9 })).toEqual({
      output_tokens: 9,
    });
  });

  test("returns undefined when there is nothing to emit", () => {
    expect(toInngestAIMetadataValues({})).toBeUndefined();
  });
});
