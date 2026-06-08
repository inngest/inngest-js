import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Attributes, AttributeValue } from "@opentelemetry/api";
import { describe, expect, test } from "vitest";
import type { AIMetadata } from "./aiExtractor.ts";
import { aggregate, extractAIMetadataFromAttributes } from "./aiExtractor.ts";

/**
 * These fixtures are real OTLP/JSON spans captured from instrumented OpenAI SDK
 * calls, copied from the Inngest server-side extractor's test suite. Each
 * `<variant>.otlp.json` has a sibling `<variant>.otlp.json.out` golden that
 * records, per span, the metadata the server extracts. We assert only the
 * subset this extractor implements (`model` and `input_tokens`).
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

/** The fields of a golden block this extractor is responsible for. */
interface GoldenMetadata {
  model?: string;
  inputTokens?: number;
}

/**
 * Parse a golden `.out` file into one expected metadata entry per span, in
 * document order. Each block is `SPAN <name>` followed by either a JSON object
 * or the literal `no AI metadata extracted`. We keep only the two fields this
 * extractor produces, treating empty/zero values as absent (the server golden
 * always renders them, this extractor omits them).
 */
const loadGolden = (goldenPath: string): GoldenMetadata[] => {
  const lines = readFileSync(goldenPath, "utf8").split("\n");
  const blocks: GoldenMetadata[] = [];

  let body: string[] = [];
  let inBlock = false;

  const flush = () => {
    if (!inBlock) return;
    const text = body.join("\n").trim();
    if (text === "" || text === "no AI metadata extracted") {
      blocks.push({});
    } else {
      const parsed = JSON.parse(text) as {
        model?: string;
        input_tokens?: number;
      };
      blocks.push({
        model: parsed.model || undefined,
        inputTokens: parsed.input_tokens || undefined,
      });
    }
    body = [];
  };

  for (const line of lines) {
    if (line.startsWith("SPAN ")) {
      flush();
      inBlock = true;
      continue;
    }
    if (inBlock) body.push(line);
  }
  flush();

  return blocks;
};

const discoverFixtures = (): {
  name: string;
  jsonPath: string;
  outPath: string;
}[] => {
  const out: { name: string; jsonPath: string; outPath: string }[] = [];
  for (const dir of readdirSync(testdataDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const dirPath = join(testdataDir, dir.name);
    for (const file of readdirSync(dirPath)) {
      if (!file.endsWith(".otlp.json")) continue;
      out.push({
        name: `${dir.name}/${file}`,
        jsonPath: join(dirPath, file),
        outPath: join(dirPath, `${file}.out`),
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

    for (const { name, jsonPath, outPath } of fixtures) {
      test(name, () => {
        const spans = loadOtlpSpans(jsonPath);
        const golden = loadGolden(outPath);

        expect(spans.length).toBe(golden.length);

        spans.forEach((span, i) => {
          const extracted = extractAIMetadataFromAttributes(span.attributes);
          expect(extracted, `span ${i} (${span.name})`).toEqual(golden[i]);
        });
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
