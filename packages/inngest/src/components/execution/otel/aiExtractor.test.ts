import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SemanticConventions } from "@arizeai/openinference-semantic-conventions";
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

  test("maps allowlisted OpenInference keys to canonical fields", () => {
    expect(
      extractAIMetadataFromAttributes({
        "openinference.span.kind": "LLM",
        "llm.model_name": "gpt-4.1-nano",
        "llm.provider": "openai",
        "llm.token_count.prompt": 17,
        "llm.token_count.completion": 41,
        "llm.token_count.total": 58,
        "reranker.top_k": 5,
      }),
    ).toEqual({
      spanKind: "LLM",
      model: "gpt-4.1-nano",
      provider: "openai",
      inputTokens: 17,
      outputTokens: 41,
      totalTokens: 58,
      rerankerTopK: 5,
    });
  });

  test("ignores unmapped, content, and sensitive keys", () => {
    expect(
      extractAIMetadataFromAttributes({
        "openinference.span.kind": "LLM",
        "input.value": "secret prompt",
        "output.value": "secret completion",
        "llm.input_messages.0.message.content": "secret",
        "llm.tools.0.tool.json_schema": "{}",
        "llm.invocation_parameters": "{}",
        "http.method": "GET",
      }),
    ).toEqual({ spanKind: "LLM" });
  });

  test("returns nothing for non-OpenInference spans", () => {
    // Allowlisted but generic keys must not be captured when the
    // openinference.span.kind marker is absent.
    expect(
      extractAIMetadataFromAttributes({
        "user.id": "user-123",
        "session.id": "session-456",
        "tool.name": "search",
        "llm.token_count.prompt": 17,
      }),
    ).toEqual({});
  });

  test("returns nothing when the span kind marker is empty", () => {
    expect(
      extractAIMetadataFromAttributes({
        "openinference.span.kind": "",
        "llm.model_name": "gpt-4o",
      }),
    ).toEqual({});
  });

  test("coerces quoted-string int64 counts to numbers", () => {
    expect(
      extractAIMetadataFromAttributes({
        "openinference.span.kind": "LLM",
        "llm.token_count.prompt": "17",
      }),
    ).toEqual({ spanKind: "LLM", inputTokens: 17 });
  });

  test("drops empty-string text fields", () => {
    expect(
      extractAIMetadataFromAttributes({
        "openinference.span.kind": "LLM",
        "llm.model_name": "",
      }),
    ).toEqual({ spanKind: "LLM" });
  });

  test("drops non-numeric values for numeric fields", () => {
    expect(
      extractAIMetadataFromAttributes({
        "openinference.span.kind": "LLM",
        "llm.token_count.prompt": "not-a-number",
      }),
    ).toEqual({ spanKind: "LLM" });
  });

  test("drops undefined values", () => {
    expect(
      extractAIMetadataFromAttributes({
        "openinference.span.kind": "LLM",
        "llm.model_name": undefined as unknown as AttributeValue,
      }),
    ).toEqual({ spanKind: "LLM" });
  });
});

describe("aggregate", () => {
  test("sums token-count and cost fields across calls", () => {
    const a: AIMetadata = {
      inputTokens: 10,
      totalTokens: 15,
      totalCost: 0.001,
    };
    const b: AIMetadata = {
      inputTokens: 7,
      totalTokens: 12,
      totalCost: 0.002,
    };
    expect(aggregate(a, b)).toEqual({
      inputTokens: 17,
      totalTokens: 27,
      totalCost: 0.003,
    });
  });

  test("last-write-wins for non-summed fields", () => {
    expect(
      aggregate(
        { model: "gpt-4.1-nano", spanKind: "LLM", rerankerTopK: 5 },
        { model: "gpt-4o", rerankerTopK: 3 },
      ),
    ).toEqual({ model: "gpt-4o", spanKind: "LLM", rerankerTopK: 3 });
  });

  test("keeps fields present in only one input", () => {
    expect(aggregate({ inputTokens: 10 }, { model: "gpt-4o" })).toEqual({
      inputTokens: 10,
      model: "gpt-4o",
    });
  });

  test("returns an empty object when both inputs are empty", () => {
    expect(aggregate({}, {})).toEqual({});
  });
});

describe("toInngestAIMetadataValues", () => {
  test("maps canonical fields onto the server's snake_case schema", () => {
    expect(
      toInngestAIMetadataValues({
        model: "gpt-4o",
        inputTokens: 42,
        rerankerTopK: 5,
      }),
    ).toEqual({ model: "gpt-4o", input_tokens: 42, reranker_top_k: 5 });
  });

  test("returns undefined when there is nothing to emit", () => {
    expect(toInngestAIMetadataValues({})).toBeUndefined();
  });
});

describe("FIELD_SPECS", () => {
  test("every source key is a published OpenInference semantic convention", () => {
    // Guards the allowlist against typos / spec renames: each source must be a
    // real attribute-key value exported by the semantic-conventions package.
    const known = new Set<string>(
      Object.values(SemanticConventions).filter(
        (value) => typeof value === "string",
      ) as string[],
    );

    const unknownSources = FIELD_SPECS.map((spec) => spec.source).filter(
      (source) => !known.has(source),
    );

    expect(unknownSources).toEqual([]);
  });

  test("each canonical field is mapped at most once", () => {
    const fields = FIELD_SPECS.map((spec) => spec.field);
    expect(new Set(fields).size).toBe(fields.length);
  });
});
