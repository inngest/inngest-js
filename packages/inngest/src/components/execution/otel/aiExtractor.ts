import type { Attributes } from "@opentelemetry/api";

/**
 * Canonical AI metadata extracted from a span's OpenInference attributes.
 *
 * The fields below are an explicit **allowlist**: only these are ever read from
 * a span (see {@link FIELD_SPECS}). Anything not mapped — prompt/response
 * content, messages, tool calls, embeddings, and other potentially-sensitive or
 * bulky payloads — is not captured.
 *
 * For each category, we describe how we handle aggregation of multiple
 * AIMetadata.
 */
export interface AIMetadata {
  // Identity & classification (last-write-wins).
  spanKind?: string;
  model?: string;
  provider?: string;
  system?: string;
  finishReason?: string;

  // Correlation / identity (last-write-wins).
  sessionId?: string;
  userId?: string;
  agentName?: string;
  graphNodeId?: string;
  graphNodeName?: string;
  graphNodeParentId?: string;

  // Prompt provenance (last-write-wins).
  promptVendor?: string;
  promptId?: string;
  promptUrl?: string;
  promptTemplateVersion?: string;

  // Token usage (summed).
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  cacheInputTokens?: number;
  inputAudioTokens?: number;
  reasoningTokens?: number;
  outputAudioTokens?: number;

  // Cost (summed).
  inputCost?: number;
  outputCost?: number;
  totalCost?: number;
  inputTokenCost?: number;
  outputTokenCost?: number;
  cachedInputCost?: number;
  cacheWriteCost?: number;
  cacheInputCost?: number;
  inputAudioCost?: number;
  reasoningCost?: number;
  outputAudioCost?: number;

  // Embedding (last-write-wins).
  embeddingModel?: string;

  // Reranker (last-write-wins).
  rerankerModel?: string;
  rerankerTopK?: number;
}

type ValueType = "text" | "number";
type MergeStrategy = "replace" | "sum";

/**
 * Derives the subset of AIMetadata keys whose assigned value matches TValue.
 *
 * AIMetadata fields are optional (`model?: string`), so each field's type is
 * effectively `string | undefined` or `number | undefined`. `Exclude` removes
 * `undefined` before checking the value type, and `-?` prevents optional fields
 * from adding `undefined` back into the final key union.
 */
type FieldsWithValue<TValue> = {
  [TField in keyof AIMetadata]-?: Exclude<
    AIMetadata[TField],
    undefined
  > extends TValue
    ? TField
    : never;
}[keyof AIMetadata];

type TextField = FieldsWithValue<string>;
type NumberField = FieldsWithValue<number>;

interface BaseFieldSpec {
  /** The source OpenInference attribute key. */
  source: string;
  valueType: ValueType;
  merge: MergeStrategy;
}

interface TextFieldSpec extends BaseFieldSpec {
  /** The canonical {@link AIMetadata} field this populates. */
  field: TextField;
  valueType: "text";
  merge: "replace";
}

interface NumberFieldSpec extends BaseFieldSpec {
  /** The canonical {@link AIMetadata} field this populates. */
  field: NumberField;
  valueType: "number";
}

type NumberFieldOptions = {
  merge?: MergeStrategy;
};

/**
 * The attribute every OpenInference span carries to declare its kind (`LLM`,
 * `CHAIN`, `TOOL`, …). We use its presence as the discriminator for "is this an
 * OpenInference span?".
 */
const OPENINFERENCE_SPAN_KIND = "openinference.span.kind";

function textField(field: TextField, source: string): TextFieldSpec {
  return {
    field,
    source,
    valueType: "text",
    merge: "replace",
  };
}

function numberField(
  field: NumberField,
  source: string,
  { merge = "sum" }: NumberFieldOptions = {},
): NumberFieldSpec {
  return {
    field,
    source,
    valueType: "number",
    merge,
  };
}

/**
 * Every OpenInference attribute we capture, mapped to its
 * canonical field.
 *
 * Anything not listed here (content, sensitive payloads,
 * unknown keys) is ignored.
 */
export const FIELD_SPECS = [
  // Identity & classification.
  textField("spanKind", OPENINFERENCE_SPAN_KIND),
  textField("model", "llm.model_name"),
  textField("provider", "llm.provider"),
  textField("system", "llm.system"),
  textField("finishReason", "llm.finish_reason"),

  // Correlation / identity.
  textField("sessionId", "session.id"),
  textField("userId", "user.id"),
  textField("agentName", "agent.name"),
  textField("graphNodeId", "graph.node.id"),
  textField("graphNodeName", "graph.node.name"),
  textField("graphNodeParentId", "graph.node.parent_id"),

  // Prompt provenance.
  textField("promptVendor", "prompt.vendor"),
  textField("promptId", "prompt.id"),
  textField("promptUrl", "prompt.url"),
  textField("promptTemplateVersion", "llm.prompt_template.version"),

  // Token usage.
  numberField("inputTokens", "llm.token_count.prompt"),
  numberField("outputTokens", "llm.token_count.completion"),
  numberField("totalTokens", "llm.token_count.total"),
  numberField("cachedInputTokens", "llm.token_count.prompt_details.cache_read"),
  numberField("cacheWriteTokens", "llm.token_count.prompt_details.cache_write"),
  numberField("cacheInputTokens", "llm.token_count.prompt_details.cache_input"),
  numberField("inputAudioTokens", "llm.token_count.prompt_details.audio"),
  numberField(
    "reasoningTokens",
    "llm.token_count.completion_details.reasoning",
  ),
  numberField("outputAudioTokens", "llm.token_count.completion_details.audio"),

  // Cost.
  numberField("inputCost", "llm.cost.prompt"),
  numberField("outputCost", "llm.cost.completion"),
  numberField("totalCost", "llm.cost.total"),
  numberField("inputTokenCost", "llm.cost.prompt_details.input"),
  numberField("outputTokenCost", "llm.cost.completion_details.output"),
  numberField("cachedInputCost", "llm.cost.prompt_details.cache_read"),
  numberField("cacheWriteCost", "llm.cost.prompt_details.cache_write"),
  numberField("cacheInputCost", "llm.cost.prompt_details.cache_input"),
  numberField("inputAudioCost", "llm.cost.prompt_details.audio"),
  numberField("reasoningCost", "llm.cost.completion_details.reasoning"),
  numberField("outputAudioCost", "llm.cost.completion_details.audio"),

  // Embedding / reranker.
  textField("embeddingModel", "embedding.model_name"),
  textField("rerankerModel", "reranker.model_name"),
  numberField("rerankerTopK", "reranker.top_k", { merge: "replace" }),
];

function parseNumericAttribute(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }

  if (typeof value !== "string" || value === "") {
    return undefined;
  }

  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

/**
 * Extracts {@link AIMetadata} from a span's attributes.
 *
 * Returns an empty object unless the span is an OpenInference span.
 *
 * Only the allowlisted {@link FIELD_SPECS} are read; every other attribute is
 * ignored. Numeric fields accept numbers and quoted numeric strings (OTLP/JSON
 * may encode int64 as a quoted string) and are otherwise dropped; text fields
 * are dropped when empty.
 *
 * @param attributes - The span attributes, as exposed by
 * `ReadableSpan.attributes`.
 */
export const extractAIMetadataFromAttributes = (
  attributes: Attributes,
): AIMetadata => {
  const metadata: AIMetadata = {};

  // Gate on the OpenInference marker: without it, this isn't an OpenInference
  // span and its attributes must not be mined for AI metadata.
  const spanKind = attributes[OPENINFERENCE_SPAN_KIND];
  if (typeof spanKind !== "string" || spanKind === "") {
    return metadata;
  }

  for (const spec of FIELD_SPECS) {
    const value = attributes[spec.source];
    if (value === undefined) {
      continue;
    }

    if (spec.valueType === "text") {
      const text = typeof value === "string" ? value : String(value);
      if (text !== "") {
        metadata[spec.field] = text;
      }
    } else {
      const num = parseNumericAttribute(value);
      if (num !== undefined) {
        metadata[spec.field] = num;
      }
    }
  }

  return metadata;
};

/**
 * Aggregates two {@link AIMetadata} values, folding a later call's metadata into
 * an earlier accumulator for a single step.
 *
 * - Token-count and cost fields (`merge: "sum"`) are **summed**, so a step
 *   that makes several LLM calls reports their combined usage.
 * - Every other field uses `merge: "replace"` (`b` overwrites `a`).
 *
 * A field is present in the result only when at least one input supplies it.
 *
 * @param a - The accumulator (earlier calls).
 * @param b - The later metadata, whose values win on conflict (and add for sums).
 */
export const aggregate = (a: AIMetadata, b: AIMetadata): AIMetadata => {
  const out: AIMetadata = { ...a };

  for (const spec of FIELD_SPECS) {
    if (spec.merge === "sum") {
      const bValue = b[spec.field];
      if (bValue === undefined) {
        continue;
      }

      const aValue = out[spec.field];
      out[spec.field] = (aValue ?? 0) + bValue;
    } else {
      if (spec.valueType === "number") {
        const bValue = b[spec.field];
        if (bValue !== undefined) {
          out[spec.field] = bValue;
        }
      } else {
        const bValue = b[spec.field];
        if (bValue !== undefined) {
          out[spec.field] = bValue;
        }
      }
    }
  }

  return out;
};

/** Converts a canonical camelCase field name to the server's snake_case key. */
const toSnakeCase = (field: string): string =>
  field.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);

/**
 * Maps an {@link AIMetadata} value onto the server's `inngest.ai` metadata
 * values, converting each canonical camelCase field to snake_case (e.g.
 * `inputTokens` → `input_tokens`). Returns `undefined` when there is nothing to
 * emit so callers can skip stamping metadata entirely.
 */
export const toInngestAIMetadataValues = (
  metadata: AIMetadata,
): Record<string, unknown> | undefined => {
  const entries = Object.entries(metadata);
  if (entries.length === 0) {
    return undefined;
  }

  const values: Record<string, unknown> = {};
  for (const [field, value] of entries) {
    values[toSnakeCase(field)] = value;
  }

  return values;
};
