import type { Attributes } from "@opentelemetry/api";

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
}

type ValueType = "text" | "number" | "stringList";
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

interface BaseFieldSpec {
  /** The canonical (preferred) source `gen_ai.*` attribute key. */
  source: string;
  /**
   * Deprecated source keys to read when {@link BaseFieldSpec.source} is absent
   * or carries no usable value, in descending precedence. The preferred
   * {@link BaseFieldSpec.source} always wins when it supplies a value; these are
   * only consulted as fallbacks.
   */
  fallbackSources?: readonly string[];
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

interface StringListFieldSpec extends BaseFieldSpec {
  /** The canonical {@link AIMetadata} field this populates. */
  field: StringListField;
  valueType: "stringList";
  merge: "replace";
}

type FieldSpec = TextFieldSpec | NumberFieldSpec | StringListFieldSpec;

function textField(
  field: TextField,
  source: string,
  fallbackSources?: readonly string[],
): TextFieldSpec {
  return {
    field,
    source,
    fallbackSources,
    valueType: "text",
    merge: "replace",
  };
}

function numberField(
  field: NumberField,
  source: string,
  merge: MergeStrategy,
): NumberFieldSpec {
  return {
    field,
    source,
    valueType: "number",
    merge,
  };
}

function stringListField(
  field: StringListField,
  source: string,
): StringListFieldSpec {
  return {
    field,
    source,
    valueType: "stringList",
    merge: "replace",
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
 * Extracts {@link AIMetadata} from a span's attributes.
 *
 * Only the allowlisted {@link FIELD_SPECS} are read. Every other attribute is
 * ignored. Numeric fields accept numbers and quoted numeric strings and are
 * otherwise dropped, as OTLP/JSON may encode int64 as a quoted string. Text
 * fields are dropped when empty. String-list fields keep only non-empty string
 * entries and are dropped when none remain.
 *
 * Returns an empty object for spans carrying no recognised `gen_ai.*`
 * attributes.
 *
 * @param attributes - The span attributes, as exposed by
 * `ReadableSpan.attributes`.
 */
export const extractAIMetadataFromAttributes = (
  attributes: Attributes,
): AIMetadata => {
  const metadata: AIMetadata = {};

  for (const spec of FIELD_SPECS) {
    // Read the canonical key first, then any deprecated fallbacks in order,
    // taking the first that yields a usable value.
    const sources = [spec.source, ...(spec.fallbackSources ?? [])];

    for (const source of sources) {
      const value = attributes[source];
      if (value === undefined) {
        continue;
      }

      if (spec.valueType === "text") {
        const text = typeof value === "string" ? value : String(value);
        if (text !== "") {
          metadata[spec.field] = text;
          break;
        }
      } else if (spec.valueType === "stringList") {
        const list = parseStringListAttribute(value);
        if (list !== undefined) {
          metadata[spec.field] = list;
          break;
        }
      } else {
        const num = parseNumericAttribute(value);
        if (num !== undefined) {
          metadata[spec.field] = num;
          break;
        }
      }
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
