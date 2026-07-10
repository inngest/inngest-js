import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Attributes, AttributeValue } from "@opentelemetry/api";
import { describe, expect, test } from "vitest";
import type { AIMetadata } from "./aiExtractor.ts";
import {
  aggregate,
  extractAIMetadataFromAttributes,
  FIELD_SPECS,
  toInngestAIMetadataValues,
} from "./aiExtractor.ts";

/**
 * These fixtures are real OTLP/JSON spans captured from instrumented OpenAI SDK
 * calls. Each `<variant>.otlp.json` has a sibling `<variant>.otlp.json.snap`
 * Vitest file snapshot recording, per span, the canonical metadata this
 * extractor produces. Run `pnpm test -- -u` to regenerate the snapshots after
 * intentional changes.
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

interface OtlpTraceRequest {
  resourceSpans?: {
    scopeSpans?: {
      spans?: {
        name: string;
        attributes?: { key: string; value: OtlpAnyValue }[];
      }[];
    }[];
  }[];
}

/**
 * Parse an OTLP/JSON `ExportTraceServiceRequest` fixture into a flat list of
 * spans (in document order), each with its attributes converted to the
 * `Attributes` record shape the SDK exposes via `ReadableSpan.attributes`.
 */
const loadOtlpSpans = (fixturePath: string): OtlpSpan[] => {
  const req: OtlpTraceRequest = JSON.parse(readFileSync(fixturePath, "utf8"));

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
        // canonical metadata this extractor produces for it.
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

  test("maps allowlisted gen_ai keys to canonical fields", () => {
    expect(
      extractAIMetadataFromAttributes({
        "gen_ai.request.model": "gpt-4.1-nano",
        "gen_ai.response.model": "gpt-4.1-nano-2025-04-14",
        "gen_ai.provider.name": "openai",
        "gen_ai.operation.name": "chat",
        "gen_ai.response.id": "chatcmpl-abc",
        "gen_ai.usage.input_tokens": 17,
        "gen_ai.usage.output_tokens": 41,
        "gen_ai.usage.total_tokens": 58,
      }),
    ).toEqual({
      requestModel: "gpt-4.1-nano",
      responseModel: "gpt-4.1-nano-2025-04-14",
      provider: "openai",
      operationName: "chat",
      responseId: "chatcmpl-abc",
      inputTokens: 17,
      outputTokens: 41,
      totalTokens: 58,
    });
  });

  describe("operationName", () => {
    test("reads gen_ai.operation.name", () => {
      expect(
        extractAIMetadataFromAttributes({ "gen_ai.operation.name": "chat" }),
      ).toEqual({ operationName: "chat" });
    });

    test("drops an empty gen_ai.operation.name", () => {
      expect(
        extractAIMetadataFromAttributes({ "gen_ai.operation.name": "" }),
      ).toEqual({});
    });
  });

  describe("provider", () => {
    test("reads the deprecated gen_ai.system when the canonical key is absent", () => {
      expect(
        extractAIMetadataFromAttributes({ "gen_ai.system": "anthropic" }),
      ).toEqual({ provider: "anthropic" });
    });

    test("prefers gen_ai.provider.name over the deprecated gen_ai.system", () => {
      expect(
        extractAIMetadataFromAttributes({
          "gen_ai.provider.name": "openai",
          "gen_ai.system": "anthropic",
        }),
      ).toEqual({ provider: "openai" });
    });

    test("falls back to gen_ai.system when the canonical key is empty", () => {
      expect(
        extractAIMetadataFromAttributes({
          "gen_ai.provider.name": "",
          "gen_ai.system": "anthropic",
        }),
      ).toEqual({ provider: "anthropic" });
    });
  });

  test("reports only the provider-supplied total; never derives one", () => {
    // With input + output but no total, the total field is simply absent.
    expect(
      extractAIMetadataFromAttributes({
        "gen_ai.usage.input_tokens": 17,
        "gen_ai.usage.output_tokens": 41,
      }),
    ).toEqual({ inputTokens: 17, outputTokens: 41 });
  });

  test("extracts request parameters", () => {
    expect(
      extractAIMetadataFromAttributes({
        "gen_ai.request.temperature": 0.7,
        "gen_ai.request.top_p": 0.9,
        "gen_ai.request.max_tokens": 64,
        "gen_ai.request.frequency_penalty": 0.2,
        "gen_ai.request.presence_penalty": 0.1,
        "gen_ai.request.seed": 42,
      }),
    ).toEqual({
      temperature: 0.7,
      topP: 0.9,
      maxTokens: 64,
      frequencyPenalty: 0.2,
      presencePenalty: 0.1,
      seed: 42,
    });
  });

  test("keeps a zero-valued temperature rather than dropping it", () => {
    expect(
      extractAIMetadataFromAttributes({ "gen_ai.request.temperature": 0 }),
    ).toEqual({ temperature: 0 });
  });

  test("extracts finish reasons as a list of strings", () => {
    expect(
      extractAIMetadataFromAttributes({
        "gen_ai.response.finish_reasons": ["stop", "tool_calls"],
      }),
    ).toEqual({ finishReasons: ["stop", "tool_calls"] });
  });

  test("drops empty and non-string finish-reason entries", () => {
    expect(
      extractAIMetadataFromAttributes({
        "gen_ai.response.finish_reasons": ["", "stop"],
      }),
    ).toEqual({ finishReasons: ["stop"] });
  });

  test("drops finish reasons when the list reduces to nothing", () => {
    expect(
      extractAIMetadataFromAttributes({
        "gen_ai.response.finish_reasons": [],
      }),
    ).toEqual({});
  });

  test("ignores unmapped, content, and sensitive keys", () => {
    expect(
      extractAIMetadataFromAttributes({
        "gen_ai.tool.name": "search",
        "gen_ai.prompt": "secret prompt",
        "gen_ai.completion": "secret completion",
        "gen_ai.input.messages": "secret",
        "http.method": "GET",
        "gen_ai.usage.input_tokens": 17,
      }),
    ).toEqual({ inputTokens: 17 });
  });

  test("coerces quoted-string int64 counts to numbers", () => {
    expect(
      extractAIMetadataFromAttributes({
        "gen_ai.usage.input_tokens": "17",
      }),
    ).toEqual({ inputTokens: 17 });
  });

  test("drops empty-string text fields", () => {
    expect(
      extractAIMetadataFromAttributes({
        "gen_ai.request.model": "",
      }),
    ).toEqual({});
  });

  test("drops non-numeric values for numeric fields", () => {
    expect(
      extractAIMetadataFromAttributes({
        "gen_ai.usage.input_tokens": "not-a-number",
        "gen_ai.usage.output_tokens": true,
        "gen_ai.usage.total_tokens": "",
      }),
    ).toEqual({});
  });

  test("drops undefined values", () => {
    expect(
      extractAIMetadataFromAttributes({
        "gen_ai.request.model": undefined,
      }),
    ).toEqual({});
  });
});

describe("aggregate", () => {
  test("sums token-count fields across calls", () => {
    const a: AIMetadata = {
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
    };
    const b: AIMetadata = {
      inputTokens: 7,
      outputTokens: 5,
      totalTokens: 12,
    };
    expect(aggregate(a, b)).toEqual({
      inputTokens: 17,
      outputTokens: 9,
      totalTokens: 26,
    });
  });

  test("last-write-wins for non-summed fields", () => {
    expect(
      aggregate(
        { requestModel: "gpt-4.1-nano", provider: "openai", responseId: "a" },
        { requestModel: "gpt-4o", responseId: "b" },
      ),
    ).toEqual({ requestModel: "gpt-4o", provider: "openai", responseId: "b" });
  });

  test("replaces request parameters rather than summing them", () => {
    expect(
      aggregate(
        { temperature: 0.7, maxTokens: 64, topP: 0.9 },
        { temperature: 0.1, maxTokens: 32, seed: 42 },
      ),
    ).toEqual({
      temperature: 0.1,
      maxTokens: 32,
      topP: 0.9,
      seed: 42,
    });
  });

  test("keeps fields present in only one input", () => {
    expect(aggregate({ inputTokens: 10 }, { requestModel: "gpt-4o" })).toEqual({
      inputTokens: 10,
      requestModel: "gpt-4o",
    });
  });

  test("replaces finish reasons rather than concatenating them", () => {
    expect(
      aggregate({ finishReasons: ["stop"] }, { finishReasons: ["tool_calls"] }),
    ).toEqual({ finishReasons: ["tool_calls"] });
  });

  test("returns an empty object when both inputs are empty", () => {
    expect(aggregate({}, {})).toEqual({});
  });
});

describe("toInngestAIMetadataValues", () => {
  test("maps canonical fields onto the server's snake_case schema", () => {
    expect(
      toInngestAIMetadataValues({
        requestModel: "gpt-4o",
        responseModel: "gpt-4o-2024-08-06",
        provider: "openai",
        operationName: "chat",
        responseId: "chatcmpl-abc",
        finishReasons: ["stop"],
        inputTokens: 42,
        outputTokens: 8,
        totalTokens: 50,
        cacheReadTokens: 30,
        cacheCreationTokens: 12,
        reasoningTokens: 4,
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 64,
        frequencyPenalty: 0.2,
        presencePenalty: 0.1,
        seed: 42,
      }),
    ).toEqual({
      request_model: "gpt-4o",
      response_model: "gpt-4o-2024-08-06",
      provider: "openai",
      operation_name: "chat",
      response_id: "chatcmpl-abc",
      finish_reasons: ["stop"],
      input_tokens: 42,
      output_tokens: 8,
      total_tokens: 50,
      cache_read_tokens: 30,
      cache_creation_tokens: 12,
      reasoning_tokens: 4,
      temperature: 0.7,
      top_p: 0.9,
      max_tokens: 64,
      frequency_penalty: 0.2,
      presence_penalty: 0.1,
      seed: 42,
    });
  });

  test("returns undefined when there is nothing to emit", () => {
    expect(toInngestAIMetadataValues({})).toBeUndefined();
  });
});

describe("FIELD_SPECS", () => {
  test("every source key is a gen_ai.* semantic convention attribute", () => {
    // Guards the allowlist against typos: every source must live in the
    // OpenTelemetry GenAI (`gen_ai.*`) namespace.
    const nonGenAi = FIELD_SPECS.flatMap((spec) => [
      spec.source,
      ...(spec.fallbackSources ?? []),
    ]).filter((source) => !source.startsWith("gen_ai."));

    expect(nonGenAi).toEqual([]);
  });

  test("each canonical field is mapped at most once", () => {
    const fields = FIELD_SPECS.map((spec) => spec.field);
    expect(new Set(fields).size).toBe(fields.length);
  });
});
