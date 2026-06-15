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
      "ai.usage.inputTokens": 10,
      "gen_ai.usage.input_tokens": 22,
    });
    expect(extracted).toEqual({ model: "semconv-model", inputTokens: 22 });
  });

  test("langfuse input tokens win over a co-present gen_ai count", () => {
    const attributes = {
      "gen_ai.response.model": "gpt-4.1-nano-another",
      "gen_ai.usage.input_tokens": 100,
      "langfuse.observation.model.name": "gpt-4.1-nano-2025-04-14",
      "langfuse.observation.usage_details":
        '{"input":22,"output":6,"total":28,"input_cached_tokens":5}',
    };
    // Order-independent: langfuse outranks semconv regardless of key order.
    const expected = { inputTokens: 22 };
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
});

describe("aggregate", () => {
  test("sums input tokens and keeps the first model", () => {
    const a: AIMetadata = { model: "gpt-4.1-nano", inputTokens: 10 };
    const b: AIMetadata = { model: "gpt-4o", inputTokens: 22 };
    expect(aggregate(a, b)).toEqual({ model: "gpt-4.1-nano", inputTokens: 32 });
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
  test("maps both fields onto the server's snake_case schema", () => {
    expect(
      toInngestAIMetadataValues({ model: "gpt-4o", inputTokens: 42 }),
    ).toEqual({ model: "gpt-4o", input_tokens: 42 });
  });

  test("omits absent fields rather than zero-valuing them", () => {
    expect(toInngestAIMetadataValues({ model: "gpt-4o" })).toEqual({
      model: "gpt-4o",
    });
    expect(toInngestAIMetadataValues({ inputTokens: 7 })).toEqual({
      input_tokens: 7,
    });
  });

  test("returns undefined when there is nothing to emit", () => {
    expect(toInngestAIMetadataValues({})).toBeUndefined();
  });
});
