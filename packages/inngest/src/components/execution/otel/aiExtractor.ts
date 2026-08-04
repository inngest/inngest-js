import type { Attributes } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

/**
 * Canonical AI metadata extracted from a span's OpenTelemetry GenAI semantic
 * convention (`gen_ai.*`) attributes.
 *
 * The fields below are an explicit **allowlist**: only these are ever read from
 * a span (see {@link FIELD_SPECS}). Anything not mapped — prompt/response
 * content, messages, tool calls, embeddings payloads, and other
 * potentially-sensitive or bulky attributes — is not captured.
 *
 * For each category we describe how multiple AIMetadata values are aggregated
 * (see {@link aggregate}).
 */
export interface AIMetadata {
  // Identity & classification (last-write-wins).

  /** The requested model, e.g. `gpt-4.1-nano`. */
  requestModel?: string;
  /**
   * The model that actually served the request. This is often a dated snapshot
   * of the requested {@link AIMetadata.requestModel} (e.g.
   * `gpt-4.1-nano-2025-04-14`).
   */
  responseModel?: string;
  /** The AI provider that served the request (e.g. `openai`) */
  provider?: string;
  /**
   * The kind of operation performed, e.g. `chat`, `text_completion`,
   * `embeddings`. Last-write-wins across calls.
   */
  operationName?: string;
  /** The provider's identifier for the response, e.g. `chatcmpl-...`. */
  responseId?: string;
  /**
   * Why generation stopped, as reported by the provider, e.g. `["stop"]`,
   * `["length"]`, or `["tool_calls"]`. Last-write-wins across calls.
   */
  finishReasons?: string[];

  // Token usage (summed).

  /** The number of input tokens consumed by the request. */
  inputTokens?: number;
  /** The number of output tokens produced by the response. */
  outputTokens?: number;
  /** The total tokens consumed, as reported by the provider. */
  totalTokens?: number;
  /**
   * Cached input tokens read from the prompt cache. Providers differ on
   * accounting. OpenAI's cached tokens are a subset of
   * {@link AIMetadata.inputTokens}, Anthropic's are additive. Callers must
   * not assume a single relationship.
   */
  cacheReadTokens?: number;
  /** Tokens written to the prompt cache. */
  cacheCreationTokens?: number;
  /** Reasoning/thinking tokens, when the emitter reports them separately. */
  reasoningTokens?: number;

  // Request / inference parameters (last-write-wins). These describe the
  // request the caller made, not the response, and are stored raw as the
  // emitter reports them.

  /** Sampling temperature requested, e.g. `0.7`. */
  temperature?: number;
  /** Nucleus sampling probability mass requested (`top_p`), e.g. `0.9`. */
  topP?: number;
  /** Upper bound on tokens to generate (`max_tokens`). */
  maxTokens?: number;
  /** Frequency penalty requested. */
  frequencyPenalty?: number;
  /** Presence penalty requested. */
  presencePenalty?: number;
  /** Sampling seed requested, when the emitter reports it. */
  seed?: number;

  // Span-derived metadata (summed). These are not reported by the provider, but are derived from the span itself.
  // They are stored raw as the emitter reports them.
  latencyMs?: number; // The latency of the request in milliseconds.
}

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
type StringListField = FieldsWithValue<string[]>;

interface FieldSpecBase {
  /**
   * When true, this field's `compute` only runs once at least one
   * non-optional field has already produced a value for the same span (see
   * {@link extractAIMetadataFromSpan}). Marks fields whose value is defined
   * for virtually any span regardless of whether it's AI-related (e.g.
   * `latencyMs`, derived from span timing that every span has), so a lone
   * optional field can't make an unrelated span look like it carries AI
   * metadata.
   */
  optional?: boolean;
  merge: MergeStrategy;
}

interface TextFieldSpec extends FieldSpecBase {
  /** The canonical {@link AIMetadata} field this populates. */
  field: TextField;
  valueType: "text";
  merge: "replace";
  /** Derives this field's value from the span. */
  compute: (span: ReadableSpan) => string | undefined;
}

interface NumberFieldSpec extends FieldSpecBase {
  /** The canonical {@link AIMetadata} field this populates. */
  field: NumberField;
  valueType: "number";
  /** Derives this field's value from the span. */
  compute: (span: ReadableSpan) => number | undefined;
}

interface StringListFieldSpec extends FieldSpecBase {
  /** The canonical {@link AIMetadata} field this populates. */
  field: StringListField;
  valueType: "stringList";
  merge: "replace";
  /** Derives this field's value from the span. */
  compute: (span: ReadableSpan) => string[] | undefined;
}

type FieldSpec = TextFieldSpec | NumberFieldSpec | StringListFieldSpec;

/**
 * Reads the first source (the canonical key, then any fallbacks in order)
 * that yields a non-empty value, coercing non-string attribute values to
 * text.
 */
function readTextAttribute(
  attributes: Attributes,
  sources: readonly string[],
): string | undefined {
  for (const source of sources) {
    const value = attributes[source];
    if (value === undefined) {
      continue;
    }

    const text = typeof value === "string" ? value : String(value);
    if (text !== "") {
      return text;
    }
  }

  return undefined;
}

/** A field read out of one of the span's `gen_ai.*` attributes, as text. */
function textField(
  field: TextField,
  source: string,
  fallbackSources?: readonly string[],
): TextFieldSpec {
  const sources = [source, ...(fallbackSources ?? [])];
  return {
    field,
    valueType: "text",
    merge: "replace",
    compute: (span) => readTextAttribute(span.attributes, sources),
  };
}

/** A field read out of one of the span's `gen_ai.*` attributes, as a number. */
function numberField(
  field: NumberField,
  source: string,
  merge: MergeStrategy,
): NumberFieldSpec {
  return {
    field,
    valueType: "number",
    merge,
    compute: (span) => parseNumericAttribute(span.attributes[source]),
  };
}

/**
 * A field read out of one of the span's `gen_ai.*` attributes, as a list of
 * strings.
 */
function stringListField(
  field: StringListField,
  source: string,
): StringListFieldSpec {
  return {
    field,
    valueType: "stringList",
    merge: "replace",
    compute: (span) => parseStringListAttribute(span.attributes[source]),
  };
}

/**
 * A field derived from the span itself via custom logic (e.g. timing, kind,
 * status), rather than a direct attribute read.
 */
function computedNumberField(
  field: NumberField,
  merge: MergeStrategy,
  compute: (span: ReadableSpan) => number | undefined,
  optional?: boolean,
): NumberFieldSpec {
  return {
    field,
    valueType: "number",
    merge,
    compute,
    optional,
  };
}

/**
 * Every `gen_ai.*` attribute we capture, mapped to its canonical field.
 *
 * Anything not listed here (prompt/response content, messages, tool calls,
 * unknown keys) is ignored.
 */
export const FIELD_SPECS = [
  // Identity & classification.
  textField("requestModel", "gen_ai.request.model"),
  textField("responseModel", "gen_ai.response.model"),
  // `gen_ai.system` is the deprecated predecessor of `gen_ai.provider.name`;
  // the canonical key wins when both are present on a span.
  textField("provider", "gen_ai.provider.name", ["gen_ai.system"]),
  textField("operationName", "gen_ai.operation.name"),
  textField("responseId", "gen_ai.response.id"),
  stringListField("finishReasons", "gen_ai.response.finish_reasons"),

  // Token usage.
  numberField("inputTokens", "gen_ai.usage.input_tokens", "sum"),
  numberField("outputTokens", "gen_ai.usage.output_tokens", "sum"),
  numberField("totalTokens", "gen_ai.usage.total_tokens", "sum"),
  numberField("cacheReadTokens", "gen_ai.usage.cache_read.input_tokens", "sum"),
  numberField(
    "cacheCreationTokens",
    "gen_ai.usage.cache_creation.input_tokens",
    "sum",
  ),
  numberField("reasoningTokens", "gen_ai.usage.reasoning.output_tokens", "sum"),

  // Request / inference parameters. These describe the request, not a quantity,
  // so they replace rather than sum when a step makes several calls.
  numberField("temperature", "gen_ai.request.temperature", "replace"),
  numberField("topP", "gen_ai.request.top_p", "replace"),
  numberField("maxTokens", "gen_ai.request.max_tokens", "replace"),
  numberField(
    "frequencyPenalty",
    "gen_ai.request.frequency_penalty",
    "replace",
  ),
  numberField("presencePenalty", "gen_ai.request.presence_penalty", "replace"),
  numberField("seed", "gen_ai.request.seed", "replace"),

  // Span-derived metadata. Not reported by the provider, but computed from the
  // span's own start/end time. Marked optional: it resolves for virtually any
  // span, so it must not by itself make an unrelated span look AI-related.
  computedNumberField(
    "latencyMs",
    "sum",
    (span) => {
      const startMs = span.startTime[0] * 1000 + span.startTime[1] / 1e6;
      const endMs = span.endTime[0] * 1000 + span.endTime[1] / 1e6;
      return endMs - startMs;
    },
    true,
  ),
] as const satisfies readonly FieldSpec[];

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
 * Coerces an attribute to a list of non-empty strings, or `undefined` when it
 * yields none. OTLP arrays may carry non-string or empty entries; those are
 * dropped, and an array that reduces to nothing is treated as absent.
 */
function parseStringListAttribute(value: unknown): string[] | undefined {
  const items = Array.isArray(value) ? value : [value];
  const strings = items.filter(
    (item): item is string => typeof item === "string" && item !== "",
  );
  return strings.length > 0 ? strings : undefined;
}

/**
 * Extracts {@link AIMetadata} from a span.
 *
 * Only the allowlisted {@link FIELD_SPECS} are read; every other attribute or
 * span field is ignored. Each spec derives its value from the span via its
 * `compute` function — most read a `gen_ai.*` attribute (numeric fields
 * accept numbers and quoted numeric strings, as OTLP/JSON may encode int64 as
 * a quoted string; text and string-list fields are dropped when empty), but a
 * field can define arbitrary custom logic instead (e.g. `latencyMs`, derived
 * from the span's start/end time).
 *
 * Fields marked {@link FieldSpecBase.optional} only run once at least one
 * non-optional field has already produced a value, so a span carrying no
 * recognised `gen_ai.*` attributes still yields an empty object rather than
 * picking up e.g. `latencyMs` on its own.
 *
 * @param span - The span, as exposed by the OTel SDK's `ReadableSpan`.
 */
export const extractAIMetadataFromSpan = (span: ReadableSpan): AIMetadata => {
  const metadata: AIMetadata = {};

  const applySpec = (spec: FieldSpec): void => {
    if (spec.valueType === "text") {
      const text = spec.compute(span);
      if (text !== undefined && text !== "") {
        metadata[spec.field] = text;
      }
    } else if (spec.valueType === "stringList") {
      const list = spec.compute(span);
      if (list !== undefined && list.length > 0) {
        metadata[spec.field] = list;
      }
    } else {
      const num = spec.compute(span);
      if (num !== undefined && Number.isFinite(num)) {
        metadata[spec.field] = num;
      }
    }
  };

  for (const spec of FIELD_SPECS) {
    if (!spec.optional) {
      applySpec(spec);
    }
  }

  // No non-optional field matched, so this isn't a span we recognise as
  // AI-related. Skip optional fields entirely rather than let one (e.g.
  // latencyMs, which resolves for virtually every span) make an unrelated
  // span look like it carries AI metadata.
  if (Object.keys(metadata).length === 0) {
    return metadata;
  }

  for (const spec of FIELD_SPECS) {
    if (spec.optional) {
      applySpec(spec);
    }
  }

  return metadata;
};

/**
 * Aggregates two {@link AIMetadata} values, folding a later call's metadata into
 * an earlier accumulator for a single step.
 *
 * - Token-count fields (`merge: "sum"`) are **summed**, so a step that makes
 *   several LLM calls reports their combined usage.
 * - Every other field uses `merge: "replace"` (`b` overwrites `a`)
 *
 * A field is present in the result only when at least one input supplies it.
 *
 * @param a - The accumulator (earlier calls).
 * @param b - The later metadata, whose values win on conflict (and add for sums).
 */
export const aggregate = (a: AIMetadata, b: AIMetadata): AIMetadata => {
  const out: AIMetadata = { ...a };

  for (const spec of FIELD_SPECS) {
    if (spec.valueType === "number") {
      const bValue = b[spec.field];
      if (bValue === undefined) {
        continue;
      }

      if (spec.merge === "sum") {
        out[spec.field] = (out[spec.field] ?? 0) + bValue;
      } else {
        out[spec.field] = bValue;
      }
    } else if (spec.valueType === "text") {
      // Text fields are always replace.
      const bValue = b[spec.field];
      if (bValue === undefined) {
        continue;
      }
      out[spec.field] = bValue;
    } else {
      // String-list fields are always replace.
      const bValue = b[spec.field];
      if (bValue === undefined) {
        continue;
      }
      out[spec.field] = bValue;
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
