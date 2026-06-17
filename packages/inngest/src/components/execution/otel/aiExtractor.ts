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
  Langfuse = 1,
  Semconv = 2,
  OpenInference = 3,
  Vercel = 4,
}

type Field = keyof AIMetadata;

interface Mapping {
  /**
   * The canonical {@link AIMetadata} field this attribute populates. Omitted
   * for composite attributes that only carry an {@link Mapping.expand}.
   */
  field?: Field;
  convention: Convention;
  /**
   * Composite attributes (e.g. a JSON blob of token counts) provide an
   * `expand` that explodes the raw value into synthetic scalar attributes,
   * each re-matched against {@link keyFieldMap}.
   */
  expand?: (value: AttributeValue) => Record<string, AttributeValue>;
}

/**
 * Prefix for the synthetic attributes produced by
 * {@link expandLangfuseUsageDetails}, kept distinct from any real attribute
 * namespace.
 */
const langfuseUsagePrefix = "__langfuse.usage_details.";

/**
 * Parses the `langfuse.observation.usage_details` JSON blob (e.g.
 * `{"input":17,"output":36,"total":53}`) and emits a synthetic scalar
 * attribute for each count we track. Only `input` is emitted; the other counts
 * (output, total, cached, reasoning, …) are intentionally dropped since this
 * extractor tracks input tokens alone.
 */
const expandLangfuseUsageDetails = (
  value: AttributeValue,
): Record<string, AttributeValue> => {
  if (typeof value !== "string" || value === "") {
    return {};
  }

  let counts: unknown;
  try {
    counts = JSON.parse(value);
  } catch {
    return {};
  }

  if (typeof counts !== "object" || counts === null) {
    return {};
  }

  const input = (counts as Record<string, unknown>).input;
  if (typeof input !== "number") {
    return {};
  }

  return { [`${langfuseUsagePrefix}input`]: input };
};

/**
 * Maps a source attribute key to the canonical {@link AIMetadata} field it
 * populates and the convention it belongs to.
 */
const keyFieldMap: Record<string, Mapping> = {
  // Langfuse (`langfuse.*` telemetry). Langfuse reports token usage as a single
  // JSON blob under `usage_details`; it is expanded into synthetic per-count
  // attributes that are matched back through this map. Langfuse only emits a
  // response model (not the requested model), which this extractor doesn't
  // track, so no `model` mapping is registered here. Langfuse outranks the
  // other conventions when several are present on one span.
  "langfuse.observation.usage_details": {
    convention: Convention.Langfuse,
    expand: expandLangfuseUsageDetails,
  },
  [`${langfuseUsagePrefix}input`]: {
    field: "inputTokens",
    convention: Convention.Langfuse,
  },

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

  const record = (mapping: Mapping, value: AttributeValue) => {
    if (!mapping.field) {
      return;
    }
    const existing = candidates[mapping.field];
    if (!existing || mapping.convention < existing.convention) {
      candidates[mapping.field] = { value, convention: mapping.convention };
    }
  };

  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined) {
      continue;
    }

    const mapping = keyFieldMap[key];
    if (!mapping) {
      continue;
    }

    // Composite attribute: explode into synthetic children and match each back
    // through the map.
    if (mapping.expand) {
      for (const [childKey, childValue] of Object.entries(
        mapping.expand(value),
      )) {
        const childMapping = keyFieldMap[childKey];
        if (childMapping) {
          record(childMapping, childValue);
        }
      }
      continue;
    }

    record(mapping, value);
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

/**
 * Maps an {@link AIMetadata} value onto the server's `inngest.ai` metadata
 * schema (snake_case keys). Only the fields we extract are emitted; absent
 * fields are omitted rather than zero-valued. Returns `undefined` when there
 * is nothing to emit, so callers can skip stamping metadata entirely.
 */
export const toInngestAIMetadataValues = (
  metadata: AIMetadata,
): Record<string, unknown> | undefined => {
  const values: Record<string, unknown> = {};

  if (metadata.model !== undefined) {
    values.model = metadata.model;
  }

  if (metadata.inputTokens !== undefined) {
    values.input_tokens = metadata.inputTokens;
  }

  if (Object.keys(values).length === 0) {
    return undefined;
  }

  return values;
};
