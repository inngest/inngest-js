import type { Attributes } from "@opentelemetry/api";

/**
 * Canonical AI metadata extracted from a span's OpenInference attributes.
 *
 * The fields below are an explicit **allowlist**: only these are ever read from
 * a span (see {@link FIELD_SPECS}). Anything not mapped — prompt/response
 * content, messages, tool calls, embeddings, and other potentially-sensitive or
 * bulky payloads — is never captured in the first place, so there is no
 * separate redaction step. A field is present only when the span carried its
 * source attribute.
 *
 * Token-count and cost fields are summed across the LLM calls in a step; every
 * other field is last-write-wins (see {@link aggregate}).
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

/**
 * How a field's raw attribute value is coerced and how repeated occurrences
 * across the LLM calls in one step combine:
 * - `text`   — string, last-write-wins
 * - `number` — numeric, last-write-wins
 * - `sum`    — numeric, summed
 */
type Combine = "text" | "number" | "sum";

interface FieldSpec {
  /** The canonical {@link AIMetadata} field this populates. */
  field: keyof AIMetadata;
  /** The source OpenInference attribute key. */
  source: string;
  combine: Combine;
}

/**
 * The allowlist: every OpenInference attribute we capture, mapped to its
 * canonical field. Anything not listed here (content, sensitive payloads,
 * unknown keys) is ignored. `aiExtractor.test.ts` asserts each `source` is a
 * published `@arizeai/openinference-semantic-conventions` key, so a spec rename
 * fails the suite rather than silently dropping a field.
 */
export const FIELD_SPECS: readonly FieldSpec[] = [
  // Identity & classification.
  { field: "spanKind", source: "openinference.span.kind", combine: "text" },
  { field: "model", source: "llm.model_name", combine: "text" },
  { field: "provider", source: "llm.provider", combine: "text" },
  { field: "system", source: "llm.system", combine: "text" },
  { field: "finishReason", source: "llm.finish_reason", combine: "text" },

  // Correlation / identity.
  { field: "sessionId", source: "session.id", combine: "text" },
  { field: "userId", source: "user.id", combine: "text" },
  { field: "agentName", source: "agent.name", combine: "text" },
  { field: "graphNodeId", source: "graph.node.id", combine: "text" },
  { field: "graphNodeName", source: "graph.node.name", combine: "text" },
  {
    field: "graphNodeParentId",
    source: "graph.node.parent_id",
    combine: "text",
  },

  // Prompt provenance.
  { field: "promptVendor", source: "prompt.vendor", combine: "text" },
  { field: "promptId", source: "prompt.id", combine: "text" },
  { field: "promptUrl", source: "prompt.url", combine: "text" },
  {
    field: "promptTemplateVersion",
    source: "llm.prompt_template.version",
    combine: "text",
  },

  // Token usage.
  { field: "inputTokens", source: "llm.token_count.prompt", combine: "sum" },
  {
    field: "outputTokens",
    source: "llm.token_count.completion",
    combine: "sum",
  },
  { field: "totalTokens", source: "llm.token_count.total", combine: "sum" },
  {
    field: "cachedInputTokens",
    source: "llm.token_count.prompt_details.cache_read",
    combine: "sum",
  },
  {
    field: "cacheWriteTokens",
    source: "llm.token_count.prompt_details.cache_write",
    combine: "sum",
  },
  {
    field: "cacheInputTokens",
    source: "llm.token_count.prompt_details.cache_input",
    combine: "sum",
  },
  {
    field: "inputAudioTokens",
    source: "llm.token_count.prompt_details.audio",
    combine: "sum",
  },
  {
    field: "reasoningTokens",
    source: "llm.token_count.completion_details.reasoning",
    combine: "sum",
  },
  {
    field: "outputAudioTokens",
    source: "llm.token_count.completion_details.audio",
    combine: "sum",
  },

  // Cost.
  { field: "inputCost", source: "llm.cost.prompt", combine: "sum" },
  { field: "outputCost", source: "llm.cost.completion", combine: "sum" },
  { field: "totalCost", source: "llm.cost.total", combine: "sum" },
  {
    field: "inputTokenCost",
    source: "llm.cost.prompt_details.input",
    combine: "sum",
  },
  {
    field: "outputTokenCost",
    source: "llm.cost.completion_details.output",
    combine: "sum",
  },
  {
    field: "cachedInputCost",
    source: "llm.cost.prompt_details.cache_read",
    combine: "sum",
  },
  {
    field: "cacheWriteCost",
    source: "llm.cost.prompt_details.cache_write",
    combine: "sum",
  },
  {
    field: "cacheInputCost",
    source: "llm.cost.prompt_details.cache_input",
    combine: "sum",
  },
  {
    field: "inputAudioCost",
    source: "llm.cost.prompt_details.audio",
    combine: "sum",
  },
  {
    field: "reasoningCost",
    source: "llm.cost.completion_details.reasoning",
    combine: "sum",
  },
  {
    field: "outputAudioCost",
    source: "llm.cost.completion_details.audio",
    combine: "sum",
  },

  // Embedding / reranker.
  { field: "embeddingModel", source: "embedding.model_name", combine: "text" },
  { field: "rerankerModel", source: "reranker.model_name", combine: "text" },
  { field: "rerankerTopK", source: "reranker.top_k", combine: "number" },
] as const;

/** Assigns onto an {@link AIMetadata}, narrowing the mixed string/number value. */
const setField = (
  metadata: AIMetadata,
  field: keyof AIMetadata,
  value: string | number,
): void => {
  (metadata as Record<string, string | number>)[field] = value;
};

/**
 * Extracts canonical {@link AIMetadata} from a span's attributes.
 *
 * Only the allowlisted {@link FIELD_SPECS} are read; every other attribute is
 * ignored. Numeric fields are coerced with `Number` (OTLP/JSON may encode int64
 * as a quoted string) and dropped if not a number; text fields are dropped when
 * empty.
 *
 * @param attributes - The span attributes, as exposed by
 * `ReadableSpan.attributes`.
 */
export const extractAIMetadataFromAttributes = (
  attributes: Attributes,
): AIMetadata => {
  const metadata: AIMetadata = {};

  for (const spec of FIELD_SPECS) {
    const value = attributes[spec.source];
    if (value === undefined) {
      continue;
    }

    if (spec.combine === "text") {
      const text = typeof value === "string" ? value : String(value);
      if (text !== "") {
        setField(metadata, spec.field, text);
      }
    } else {
      const num = Number(value);
      if (!Number.isNaN(num)) {
        setField(metadata, spec.field, num);
      }
    }
  }

  return metadata;
};

/**
 * Aggregates two {@link AIMetadata} values, folding a later call's metadata into
 * an earlier accumulator for a single step.
 *
 * - Token-count and cost fields (`combine: "sum"`) are **summed**, so a step
 *   that makes several LLM calls reports their combined usage.
 * - Every other field is **last-write-wins** (`b` overwrites `a`).
 *
 * A field is present in the result only when at least one input supplies it.
 *
 * @param a - The accumulator (earlier calls).
 * @param b - The later metadata, whose values win on conflict (and add for sums).
 */
export const aggregate = (a: AIMetadata, b: AIMetadata): AIMetadata => {
  const out: AIMetadata = { ...a };

  for (const spec of FIELD_SPECS) {
    const bValue = b[spec.field];
    if (bValue === undefined) {
      continue;
    }

    if (spec.combine === "sum") {
      const aValue = out[spec.field];
      setField(
        out,
        spec.field,
        (typeof aValue === "number" ? aValue : 0) + (bValue as number),
      );
    } else {
      setField(out, spec.field, bValue);
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
