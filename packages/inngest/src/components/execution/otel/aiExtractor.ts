import type { Attributes, AttributeValue } from "@opentelemetry/api";
import { isRecord } from "../../../helpers/types.ts";

/**
 * AI metadata extracted from a span's attributes.
 *
 * A field is only present when a matching attribute was found on the span;
 * absent fields are omitted rather than zero-valued.
 */
export interface AIMetadata {
  /** The requested model, e.g. `gpt-4.1-nano`. */
  model?: string;
  /**
   * The model that actually served the request. This is often a dated snapshot
   * of the requested {@link AIMetadata.model} (e.g. `gpt-4.1-nano-2025-04-14`).
   */
  responseModel?: string;
  /**
   * The AI provider/system that served the request, stored raw per emitter
   * (e.g. `openai`, or the provider + API surface like `openai.chat`). Emitted
   * as `system` on the server schema.
   */
  system?: string;
  /** The provider's identifier for the response, e.g. `chatcmpl-...`. */
  responseId?: string;
  /** The number of input (prompt) tokens consumed by the request. */
  inputTokens?: number;
  /** The number of output (completion) tokens produced by the response. */
  outputTokens?: number;
  /**
   * The total tokens consumed. Taken from the provider's count when supplied,
   * otherwise derived as input + output when either is present.
   */
  totalTokens?: number;
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
   * Tiebreak used to order keys within the same convention; lower wins
   * (default 0). Used e.g. to rank the deprecated `gen_ai.system` behind its
   * replacement `gen_ai.provider.name`, which are both semconv.
   */
  keyRank?: number;
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
 * The usage counts we lift out of the `langfuse.observation.usage_details` JSON
 * blob (e.g. `{"input":17,"output":36,"total":53}`). Langfuse emits more counts
 * (cached, reasoning, …), but this extractor only reads the ones it tracks.
 */
const langfuseUsageKeys = ["input", "output", "total"] as const;

/**
 * Parses the `langfuse.observation.usage_details` JSON blob and emits a synthetic
 * scalar attribute for each count we track. Only `input`, `output`, and `total`
 * are emitted; the other counts are intentionally dropped since this extractor
 * tracks input, output, and total tokens alone.
 */
const expandLangfuseUsageDetails = (
  value: AttributeValue,
): Record<string, AttributeValue> => {
  if (typeof value !== "string" || value === "") {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return {};
  }

  if (!isRecord(parsed)) {
    return {};
  }

  const out: Record<string, AttributeValue> = {};
  for (const key of langfuseUsageKeys) {
    const count = parsed[key];
    if (typeof count === "number") {
      out[`${langfuseUsagePrefix}${key}`] = count;
    }
  }

  return out;
};

/**
 * Maps a source attribute key to the canonical {@link AIMetadata} field it
 * populates and the convention it belongs to.
 */
const keyFieldMap: Record<string, Mapping> = {
  // Langfuse (`langfuse.*` telemetry). Langfuse reports token usage as a single
  // JSON blob under `usage_details`; it is expanded into synthetic per-count
  // attributes that are matched back through this map. Langfuse only emits a
  // response model (not the requested model), so no `model` mapping is
  // registered here. Langfuse outranks the other conventions when several are
  // present on one span.
  "langfuse.observation.usage_details": {
    convention: Convention.Langfuse,
    expand: expandLangfuseUsageDetails,
  },
  [`${langfuseUsagePrefix}input`]: {
    field: "inputTokens",
    convention: Convention.Langfuse,
  },
  [`${langfuseUsagePrefix}output`]: {
    field: "outputTokens",
    convention: Convention.Langfuse,
  },
  [`${langfuseUsagePrefix}total`]: {
    field: "totalTokens",
    convention: Convention.Langfuse,
  },
  "langfuse.observation.model.name": {
    field: "responseModel",
    convention: Convention.Langfuse,
  },

  // OpenTelemetry Semantic Conventions
  "gen_ai.request.model": { field: "model", convention: Convention.Semconv },
  "gen_ai.response.model": {
    field: "responseModel",
    convention: Convention.Semconv,
  },
  "gen_ai.provider.name": {
    field: "system",
    convention: Convention.Semconv,
  },
  // Deprecated in semconv in favor of `gen_ai.provider.name`; both are semconv,
  // so this keyRank places it behind its replacement.
  "gen_ai.system": {
    field: "system",
    convention: Convention.Semconv,
    keyRank: 1,
  },
  "gen_ai.response.id": {
    field: "responseId",
    convention: Convention.Semconv,
  },
  "gen_ai.usage.input_tokens": {
    field: "inputTokens",
    convention: Convention.Semconv,
  },
  "gen_ai.usage.output_tokens": {
    field: "outputTokens",
    convention: Convention.Semconv,
  },
  "gen_ai.usage.total_tokens": {
    field: "totalTokens",
    convention: Convention.Semconv,
  },

  // OpenInference. `llm.model_name` is the model that served the request (a
  // response model), not the requested model — hence it maps to `responseModel`.
  "llm.model_name": {
    field: "responseModel",
    convention: Convention.OpenInference,
  },
  "llm.token_count.prompt": {
    field: "inputTokens",
    convention: Convention.OpenInference,
  },
  "llm.token_count.completion": {
    field: "outputTokens",
    convention: Convention.OpenInference,
  },
  "llm.token_count.total": {
    field: "totalTokens",
    convention: Convention.OpenInference,
  },
  // `llm.system` identifies the AI product/vendor (openai, anthropic, …),
  // matching the semantics of the deprecated semconv `gen_ai.system`.
  "llm.system": { field: "system", convention: Convention.OpenInference },

  // Vercel AI SDK (native `ai.*` telemetry)
  "ai.model.id": { field: "model", convention: Convention.Vercel },
  "ai.response.model": {
    field: "responseModel",
    convention: Convention.Vercel,
  },
  // `ai.model.provider` is the provider + API surface, e.g. `openai.responses`
  // (not bare `openai`); stored faithfully, no normalization.
  "ai.model.provider": {
    field: "system",
    convention: Convention.Vercel,
  },
  "ai.response.id": {
    field: "responseId",
    convention: Convention.Vercel,
  },
  "ai.usage.inputTokens": {
    field: "inputTokens",
    convention: Convention.Vercel,
  },
  "ai.usage.outputTokens": {
    field: "outputTokens",
    convention: Convention.Vercel,
  },
  "ai.usage.totalTokens": {
    field: "totalTokens",
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
  keyRank: number;
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
    const keyRank = mapping.keyRank ?? 0;
    const existing = candidates[mapping.field];
    // Order by convention first, breaking ties within a convention by keyRank;
    // lower wins for both.
    if (
      !existing ||
      mapping.convention < existing.convention ||
      (mapping.convention === existing.convention && keyRank < existing.keyRank)
    ) {
      candidates[mapping.field] = {
        value,
        convention: mapping.convention,
        keyRank,
      };
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
  if (typeof model === "string" && model) {
    metadata.model = model;
  }

  const responseModel = candidates.responseModel?.value;
  if (typeof responseModel === "string" && responseModel) {
    metadata.responseModel = responseModel;
  }

  const system = candidates.system?.value;
  if (typeof system === "string" && system) {
    metadata.system = system;
  }

  const responseId = candidates.responseId?.value;
  if (typeof responseId === "string" && responseId) {
    metadata.responseId = responseId;
  }

  // Token counts arrive as numbers from the SDK, but OTLP/JSON encodes int64 as
  // either a number or a quoted string, so coerce defensively.
  const count = (field: Field): number | undefined => {
    const raw = candidates[field]?.value;
    if (raw === undefined) {
      return undefined;
    }
    const n = Number(raw);
    return Number.isNaN(n) ? undefined : n;
  };

  const inputTokens = count("inputTokens");
  if (inputTokens !== undefined) {
    metadata.inputTokens = inputTokens;
  }

  const outputTokens = count("outputTokens");
  if (outputTokens !== undefined) {
    metadata.outputTokens = outputTokens;
  }

  // Use the provider's total when supplied, otherwise derive it from input +
  // output when either is present, mirroring the server-side extractor.
  let totalTokens = count("totalTokens");
  if (totalTokens === undefined) {
    const sum = (inputTokens ?? 0) + (outputTokens ?? 0);
    if (sum > 0) {
      totalTokens = sum;
    }
  }
  if (totalTokens !== undefined) {
    metadata.totalTokens = totalTokens;
  }

  return metadata;
};

/**
 * Aggregates two {@link AIMetadata} values into one.
 *
 * Input, output, and total token counts are summed, while `a`'s models take
 * precedence over `b`'s. Each field is only present in the result when at least
 * one input supplies it.
 *
 * @param a - The primary metadata; its models win when both are present.
 * @param b - The secondary metadata.
 */
export const aggregate = (a: AIMetadata, b: AIMetadata): AIMetadata => {
  const metadata: AIMetadata = {};

  const model = a.model ?? b.model;
  if (model !== undefined) {
    metadata.model = model;
  }

  const responseModel = a.responseModel ?? b.responseModel;
  if (responseModel !== undefined) {
    metadata.responseModel = responseModel;
  }

  const system = a.system ?? b.system;
  if (system !== undefined) {
    metadata.system = system;
  }

  const responseId = a.responseId ?? b.responseId;
  if (responseId !== undefined) {
    metadata.responseId = responseId;
  }

  if (a.inputTokens !== undefined || b.inputTokens !== undefined) {
    metadata.inputTokens = (a.inputTokens ?? 0) + (b.inputTokens ?? 0);
  }

  if (a.outputTokens !== undefined || b.outputTokens !== undefined) {
    metadata.outputTokens = (a.outputTokens ?? 0) + (b.outputTokens ?? 0);
  }

  if (a.totalTokens !== undefined || b.totalTokens !== undefined) {
    metadata.totalTokens = (a.totalTokens ?? 0) + (b.totalTokens ?? 0);
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

  if (metadata.responseModel !== undefined) {
    values.response_model = metadata.responseModel;
  }

  if (metadata.system !== undefined) {
    values.system = metadata.system;
  }

  if (metadata.responseId !== undefined) {
    values.response_id = metadata.responseId;
  }

  if (metadata.inputTokens !== undefined) {
    values.input_tokens = metadata.inputTokens;
  }

  if (metadata.outputTokens !== undefined) {
    values.output_tokens = metadata.outputTokens;
  }

  if (metadata.totalTokens !== undefined) {
    values.total_tokens = metadata.totalTokens;
  }

  if (Object.keys(values).length === 0) {
    return undefined;
  }

  return values;
};
