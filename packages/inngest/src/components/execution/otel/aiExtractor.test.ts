import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SemanticConventions } from "@arizeai/openinference-semantic-conventions";
import type { Attributes, AttributeValue } from "@opentelemetry/api";
import { describe, expect, test } from "vitest";
import type { OpenInferenceAttributes } from "./aiExtractor.ts";
import {
  aggregate,
  extractOpenInferenceAttributes,
  OPENINFERENCE_ROOTS,
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

describe("extractOpenInferenceAttributes", () => {
  describe("captured OTLP fixtures", () => {
    const fixtures = discoverFixtures();

    test("discovers fixtures", () => {
      expect(fixtures.length).toBeGreaterThan(0);
    });

    for (const { name, jsonPath, snapPath } of fixtures) {
      test(name, async () => {
        const spans = loadOtlpSpans(jsonPath);

        // One entry per span, in document order: the span name alongside the
        // OpenInference attributes this extractor captures for it.
        const extracted = spans.map((span) => ({
          span: span.name,
          metadata: extractOpenInferenceAttributes(span.attributes),
        }));

        await expect(
          `${JSON.stringify(extracted, null, 2)}\n`,
        ).toMatchFileSnapshot(snapPath);
      });
    }
  });

  test("returns empty object when no OpenInference attributes are present", () => {
    expect(
      extractOpenInferenceAttributes({
        "http.method": "GET",
        "service.name": "worker",
      }),
    ).toEqual({});
  });

  test("captures bare roots and nested/indexed keys verbatim", () => {
    expect(
      extractOpenInferenceAttributes({
        "openinference.span.kind": "LLM",
        "llm.model_name": "gpt-4.1-nano",
        "llm.token_count.prompt": 22,
        "llm.input_messages.0.message.role": "user",
        "input.value": "hello",
        metadata: '{"k":"v"}',
        "http.method": "GET",
      }),
    ).toEqual({
      "openinference.span.kind": "LLM",
      "llm.model_name": "gpt-4.1-nano",
      "llm.token_count.prompt": 22,
      "llm.input_messages.0.message.role": "user",
      "input.value": "hello",
      metadata: '{"k":"v"}',
    });
  });

  test("does not match keys that merely share a root prefix string", () => {
    // `inputs` / `llms` share leading characters with roots but are distinct
    // namespaces; only an exact root or a `<root>.` child should match.
    expect(
      extractOpenInferenceAttributes({
        inputs: "x",
        "llms.foo": "y",
        "userspace.id": "z",
      }),
    ).toEqual({});
  });

  test("drops undefined values", () => {
    expect(
      extractOpenInferenceAttributes({
        "llm.model_name": undefined as unknown as AttributeValue,
      }),
    ).toEqual({});
  });
});

describe("aggregate", () => {
  test("last write wins on conflicting non-summed keys", () => {
    const a: OpenInferenceAttributes = {
      "llm.model_name": "gpt-4.1-nano",
      "openinference.span.kind": "LLM",
    };
    const b: OpenInferenceAttributes = {
      "llm.model_name": "gpt-4o",
      "input.value": "second call",
    };
    expect(aggregate(a, b)).toEqual({
      "llm.model_name": "gpt-4o",
      "openinference.span.kind": "LLM",
      "input.value": "second call",
    });
  });

  test("sums token-count and cost keys across calls", () => {
    const a: OpenInferenceAttributes = {
      "llm.token_count.prompt": 10,
      "llm.token_count.total": 15,
      "llm.cost.total": 0.001,
    };
    const b: OpenInferenceAttributes = {
      "llm.token_count.prompt": 7,
      "llm.token_count.total": 12,
      "llm.cost.total": 0.002,
    };
    expect(aggregate(a, b)).toEqual({
      "llm.token_count.prompt": 17,
      "llm.token_count.total": 27,
      "llm.cost.total": 0.003,
    });
  });

  test("sums prompt/completion detail subtrees", () => {
    expect(
      aggregate(
        { "llm.token_count.completion_details.reasoning": 3 },
        { "llm.token_count.completion_details.reasoning": 4 },
      ),
    ).toEqual({ "llm.token_count.completion_details.reasoning": 7 });
  });

  test("coerces quoted-string int64 counts before summing", () => {
    expect(
      aggregate(
        { "llm.token_count.prompt": "10" },
        { "llm.token_count.prompt": "7" },
      ),
    ).toEqual({ "llm.token_count.prompt": 17 });
  });

  test("falls back to last-write-wins when a summed value is non-numeric", () => {
    expect(
      aggregate(
        { "llm.token_count.prompt": 10 },
        { "llm.token_count.prompt": "not-a-number" },
      ),
    ).toEqual({ "llm.token_count.prompt": "not-a-number" });
  });

  test("keeps a summed key present in only one input", () => {
    expect(
      aggregate(
        { "llm.token_count.prompt": 10 },
        { "llm.model_name": "gpt-4o" },
      ),
    ).toEqual({ "llm.token_count.prompt": 10, "llm.model_name": "gpt-4o" });
  });

  test("does not sum non-additive numeric fields", () => {
    expect(aggregate({ "reranker.top_k": 5 }, { "reranker.top_k": 3 })).toEqual(
      { "reranker.top_k": 3 },
    );
  });

  test("keeps keys present in only one input", () => {
    expect(aggregate({ "input.value": "a" }, { "output.value": "b" })).toEqual({
      "input.value": "a",
      "output.value": "b",
    });
  });

  test("returns an empty object when both inputs are empty", () => {
    expect(aggregate({}, {})).toEqual({});
  });
});

describe("toInngestAIMetadataValues", () => {
  test("passes the bag through verbatim", () => {
    const bag: OpenInferenceAttributes = {
      "llm.model_name": "gpt-4o",
      "llm.token_count.prompt": 42,
    };
    expect(toInngestAIMetadataValues(bag)).toEqual(bag);
  });

  test("returns undefined when there is nothing to emit", () => {
    expect(toInngestAIMetadataValues({})).toBeUndefined();
  });
});

describe("OPENINFERENCE_ROOTS", () => {
  test("covers every namespace root in the OpenInference spec", () => {
    // Derive the top-level root of every attribute-key constant the published
    // semantic-conventions package exposes, and assert our hand-maintained
    // root list covers them all. A new namespace in the spec fails here rather
    // than silently dropping attributes.
    const roots = new Set<string>(OPENINFERENCE_ROOTS);
    const missing = new Set<string>();

    for (const value of Object.values(SemanticConventions)) {
      if (typeof value !== "string") continue;
      const dot = value.indexOf(".");
      const root = dot === -1 ? value : value.slice(0, dot);
      if (!roots.has(root)) {
        missing.add(root);
      }
    }

    expect([...missing]).toEqual([]);
  });
});
