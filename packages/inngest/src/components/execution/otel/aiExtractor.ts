import type { Attributes, AttributeValue } from "@opentelemetry/api";

/**
 * AI metadata extracted from a span's attributes.
 *
 * A field is only present when a matching attribute was found on the span;
 * absent fields are omitted rather than zero-valued.
 */
export interface AIMetadata {
  /** The requested model, e.g. `gpt-4.1-nano`. */
  model?: string;
  /** The number of input (prompt) tokens consumed by the request. */
  inputTokens?: number;
}

/**
 * A `convention` identifies a namespace of AI span attributes and orders which
 * should win when multiple namespaces are present on the same span. Lower
 * numbers override higher numbers.
 */
enum Convention {
  Semconv = 1,
  OpenInference = 2,
  Vercel = 3,
}

type Field = keyof AIMetadata;

interface Mapping {
  field: Field;
  convention: Convention;
}

/**
 * Maps a source attribute key to the canonical {@link AIMetadata} field it
 * populates and the convention it belongs to.
 */
const keyFieldMap: Record<string, Mapping> = {
  // OpenTelemetry Semantic Conventions
  "gen_ai.request.model": { field: "model", convention: Convention.Semconv },
  "gen_ai.usage.input_tokens": {
    field: "inputTokens",
    convention: Convention.Semconv,
  },

  // OpenInference
  "llm.model_name": { field: "model", convention: Convention.OpenInference },
  "llm.token_count.prompt": {
    field: "inputTokens",
    convention: Convention.OpenInference,
  },

  // Vercel AI SDK (native `ai.*` telemetry)
  "ai.model.id": { field: "model", convention: Convention.Vercel },
  "ai.usage.inputTokens": {
    field: "inputTokens",
    convention: Convention.Vercel,
  },
  // Embeddings spans emit only a single `ai.usage.tokens` count (no
  // input/output split); map it to inputTokens to match the semconv embeddings
  // case.
  "ai.usage.tokens": { field: "inputTokens", convention: Convention.Vercel },
};

interface Candidate {
  value: AttributeValue;
  convention: Convention;
}

/**
 * Extracts AI model metadata from a span's attributes.
 *
 * Attributes are matched across multiple instrumentation conventions
 * (OpenTelemetry semconv, OpenInference, Vercel AI SDK). When more than one
 * convention supplies the same field, the highest-precedence value wins.
 *
 * @param attributes - The span attributes, as exposed by
 * `ReadableSpan.attributes`.
 */
export const extractAIMetadataFromAttributes = (
  attributes: Attributes,
): AIMetadata => {
  // Track the highest-precedence (lowest convention) candidate seen per field.
  const candidates: Partial<Record<Field, Candidate>> = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined) {
      continue;
    }

    const mapping = keyFieldMap[key];
    if (!mapping) {
      continue;
    }

    const existing = candidates[mapping.field];
    if (!existing || mapping.convention < existing.convention) {
      candidates[mapping.field] = { value, convention: mapping.convention };
    }
  }

  const metadata: AIMetadata = {};

  const model = candidates.model?.value;
  if (typeof model === "string" && model !== "") {
    metadata.model = model;
  }

  const inputTokens = candidates.inputTokens?.value;
  if (inputTokens !== undefined) {
    // Token counts arrive as numbers from the SDK, but OTLP/JSON encodes int64
    // as either a number or a quoted string, so coerce defensively.
    const n = Number(inputTokens);
    if (!Number.isNaN(n)) {
      metadata.inputTokens = n;
    }
  }

  return metadata;
};

/**
 * Aggregates two {@link AIMetadata} values into one.
 *
 * Input token counts are summed, while `a`'s model takes precedence over `b`'s.
 * Each field is only present in the result when at least one input supplies it.
 *
 * @param a - The primary metadata; its `model` wins when both are present.
 * @param b - The secondary metadata.
 */
export const aggregate = (a: AIMetadata, b: AIMetadata): AIMetadata => {
  const metadata: AIMetadata = {};

  const model = a.model ?? b.model;
  if (model !== undefined) {
    metadata.model = model;
  }

  if (a.inputTokens !== undefined || b.inputTokens !== undefined) {
    metadata.inputTokens = (a.inputTokens ?? 0) + (b.inputTokens ?? 0);
  }

  return metadata;
};
