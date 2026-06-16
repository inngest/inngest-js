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
  /**
   * Detailed token counts, present only when the emitter reports them.
   * Providers differ on accounting: OpenAI's cached tokens are a subset of
   * {@link AIMetadata.inputTokens}, while Anthropic's cache counts are additive
   * to it — callers must not assume a single relationship.
   */
  cacheReadTokens?: number;
  /** Tokens written to the prompt cache. */
  cacheCreationTokens?: number;
  /** Reasoning/thinking tokens, when the emitter reports them separately. */
  reasoningTokens?: number;

  // Request / inference parameters. These describe the request the caller made,
  // not the response, and are stored raw as the emitter reports them.

  /** Sampling temperature requested, e.g. `0.7`. */
  temperature?: number;
  /** Nucleus sampling probability mass requested (`top_p`), e.g. `0.9`. */
  topP?: number;
  /** Upper bound on tokens to generate (`max_tokens` / `maxOutputTokens`). */
  maxTokens?: number;
  /** Frequency penalty requested. */
  frequencyPenalty?: number;
  /** Presence penalty requested. */
  presencePenalty?: number;
  /** Stop sequences requested; always normalised to a list of strings. */
  stopSequences?: string[];
  /** Sampling seed requested, when the emitter reports it. */
  seed?: number;
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
 * Prefix for the synthetic attributes exploded from the
 * `langfuse.observation.usage_details` JSON blob (e.g.
 * `{"input":17,"output":36,"total":53}`), kept distinct from any real attribute
 * namespace. The double underscore marks them derived.
 */
const langfuseUsagePrefix = "__langfuse.usage_details.";

/**
 * Prefix for the synthetic attributes exploded from the langsmith
 * `gen_ai.usage.input_token_details` JSON blob (e.g.
 * `{"audio":0,"cache_read":2048}`). The double underscore marks them derived.
 */
const genAIInputTokenDetailsPrefix = "__gen_ai.input_token_details.";

/**
 * Prefix for the synthetic attributes exploded from the langsmith
 * `gen_ai.usage.output_token_details` JSON blob (e.g. `{"reasoning":51}`).
 */
const genAIOutputTokenDetailsPrefix = "__gen_ai.output_token_details.";

/**
 * Parses a stringified JSON object of integer counts and emits one synthetic
 * scalar attribute per integer entry, keyed as `${prefix}${key}`. Several
 * emitters pack token detail into a single JSON-string attribute rather than
 * scalar attributes; this explodes them so each entry flows back through
 * {@link keyFieldMap} like any other attribute. Non-integer entries are skipped.
 */
const expandIntBlob = (
  prefix: string,
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
  for (const [key, count] of Object.entries(parsed)) {
    if (typeof count === "number" && Number.isInteger(count)) {
      out[`${prefix}${key}`] = count;
    }
  }

  return out;
};

/** Explodes the `langfuse.observation.usage_details` blob under {@link langfuseUsagePrefix}. */
const expandLangfuseUsageDetails = (
  value: AttributeValue,
): Record<string, AttributeValue> => expandIntBlob(langfuseUsagePrefix, value);

/** Explodes the langsmith `gen_ai.usage.input_token_details` blob. */
const expandGenAIInputTokenDetails = (
  value: AttributeValue,
): Record<string, AttributeValue> =>
  expandIntBlob(genAIInputTokenDetailsPrefix, value);

/** Explodes the langsmith `gen_ai.usage.output_token_details` blob. */
const expandGenAIOutputTokenDetails = (
  value: AttributeValue,
): Record<string, AttributeValue> =>
  expandIntBlob(genAIOutputTokenDetailsPrefix, value);

/**
 * Prefixes for the synthetic attributes exploded from each convention's request
 * parameter blob. Langfuse (`model.parameters`), OpenInference
 * (`llm.invocation_parameters`), and langsmith (`ls_invocation_params`) all pack
 * the same OpenAI-style parameter vocabulary into one JSON string; each gets its
 * own prefix so the children re-match under the right convention.
 */
const langfuseParamsPrefix = "__langfuse.model_parameters.";
const openInferenceParamsPrefix = "__openinference.invocation_parameters.";
const langsmithParamsPrefix = "__langsmith.invocation_params.";

/**
 * Like {@link expandIntBlob} but for request parameters: emits a synthetic
 * attribute for every entry whose value is a number (temperature, top_p, …,
 * including non-integers) or a string array (`stop`). Other entry types are
 * skipped, so unmapped keys (e.g. `model`, `response_format`) fall away.
 */
const expandParamsBlob = (
  prefix: string,
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

  if (typeof parsed !== "object" || parsed === null) {
    return {};
  }

  const out: Record<string, AttributeValue> = {};
  for (const [key, param] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    if (typeof param === "number") {
      out[`${prefix}${key}`] = param;
    } else if (
      Array.isArray(param) &&
      param.every((x): x is string => typeof x === "string")
    ) {
      out[`${prefix}${key}`] = param;
    }
  }

  return out;
};

/** Explodes the `langfuse.observation.model.parameters` blob. */
const expandLangfuseParams = (
  value: AttributeValue,
): Record<string, AttributeValue> =>
  expandParamsBlob(langfuseParamsPrefix, value);

/** Explodes the OpenInference `llm.invocation_parameters` blob. */
const expandOpenInferenceParams = (
  value: AttributeValue,
): Record<string, AttributeValue> =>
  expandParamsBlob(openInferenceParamsPrefix, value);

/** Explodes the langsmith `langsmith.metadata.ls_invocation_params` blob. */
const expandLangsmithParams = (
  value: AttributeValue,
): Record<string, AttributeValue> =>
  expandParamsBlob(langsmithParamsPrefix, value);

/**
 * The OpenAI-style parameter keys that appear inside every convention's request
 * parameter blob, mapped to the canonical {@link AIMetadata} field each fills.
 * Shared by the per-blob child mappings built via {@link paramBlobChildMappings}.
 */
const paramBlobKeyToField: Record<string, Field> = {
  temperature: "temperature",
  top_p: "topP",
  max_tokens: "maxTokens",
  frequency_penalty: "frequencyPenalty",
  presence_penalty: "presencePenalty",
  stop: "stopSequences",
  seed: "seed",
};

/**
 * Builds the child mappings for one request parameter blob: each
 * `${prefix}${rawKey}` synthetic attribute mapped to its field under the given
 * convention. Blob-derived values rank behind scalar attributes of the same
 * convention (keyRank 1) so an explicit scalar wins if an emitter reports both.
 */
const paramBlobChildMappings = (
  prefix: string,
  convention: Convention,
): Record<string, Mapping> =>
  Object.fromEntries(
    Object.entries(paramBlobKeyToField).map(([rawKey, field]) => [
      `${prefix}${rawKey}`,
      { field, convention, keyRank: 1 },
    ]),
  );

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
  [`${langfuseUsagePrefix}input_cached_tokens`]: {
    field: "cacheReadTokens",
    convention: Convention.Langfuse,
  },
  [`${langfuseUsagePrefix}output_reasoning_tokens`]: {
    field: "reasoningTokens",
    convention: Convention.Langfuse,
  },
  "langfuse.observation.model.name": {
    field: "responseModel",
    convention: Convention.Langfuse,
  },
  // Langfuse packs request parameters into a single JSON blob; expand it into
  // synthetic children matched back below.
  "langfuse.observation.model.parameters": {
    convention: Convention.Langfuse,
    expand: expandLangfuseParams,
  },
  ...paramBlobChildMappings(langfuseParamsPrefix, Convention.Langfuse),

  // OpenTelemetry Semantic Conventions
  "gen_ai.request.model": { field: "model", convention: Convention.Semconv },
  // Request / inference parameters as semconv scalars (official, Traceloop, and
  // Vercel all emit these alongside their own shapes).
  "gen_ai.request.temperature": {
    field: "temperature",
    convention: Convention.Semconv,
  },
  "gen_ai.request.top_p": { field: "topP", convention: Convention.Semconv },
  "gen_ai.request.max_tokens": {
    field: "maxTokens",
    convention: Convention.Semconv,
  },
  "gen_ai.request.frequency_penalty": {
    field: "frequencyPenalty",
    convention: Convention.Semconv,
  },
  "gen_ai.request.presence_penalty": {
    field: "presencePenalty",
    convention: Convention.Semconv,
  },
  "gen_ai.request.stop_sequences": {
    field: "stopSequences",
    convention: Convention.Semconv,
  },
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
  // NOT an official OTel GenAI semconv attribute: the spec defines only
  // input/output token counts, no total. Emitted in practice by Traceloop and
  // others, so we still accept it.
  "gen_ai.usage.total_tokens": {
    field: "totalTokens",
    convention: Convention.Semconv,
  },
  "gen_ai.usage.cache_read.input_tokens": {
    field: "cacheReadTokens",
    convention: Convention.Semconv,
  },
  "gen_ai.usage.cache_creation.input_tokens": {
    field: "cacheCreationTokens",
    convention: Convention.Semconv,
  },
  // NOT an official OTel GenAI semconv attribute: the spec uses flat scalar
  // attributes (e.g. gen_ai.usage.cache_read.input_tokens), not a nested
  // *_token_details object. This is langsmith's convention, which packs
  // cache/audio detail into a single JSON blob; expand it into synthetic
  // children matched back below.
  "gen_ai.usage.input_token_details": {
    convention: Convention.Semconv,
    expand: expandGenAIInputTokenDetails,
  },
  [`${genAIInputTokenDetailsPrefix}cache_read`]: {
    field: "cacheReadTokens",
    convention: Convention.Semconv,
  },
  // NOT an official OTel GenAI semconv attribute (see input_token_details
  // above): langsmith's nested blob, vs. the spec's flat
  // gen_ai.usage.reasoning.output_tokens.
  "gen_ai.usage.output_token_details": {
    convention: Convention.Semconv,
    expand: expandGenAIOutputTokenDetails,
  },
  [`${genAIOutputTokenDetailsPrefix}reasoning`]: {
    field: "reasoningTokens",
    convention: Convention.Semconv,
  },
  // langsmith request parameters. It splits them between `ls_*` scalars (string
  // encoded) and an `ls_invocation_params` JSON blob; the two are complementary.
  // langsmith rides the semconv namespace here, as its token-detail blobs do.
  "langsmith.metadata.ls_temperature": {
    field: "temperature",
    convention: Convention.Semconv,
  },
  "langsmith.metadata.ls_max_tokens": {
    field: "maxTokens",
    convention: Convention.Semconv,
  },
  "langsmith.metadata.ls_stop": {
    field: "stopSequences",
    convention: Convention.Semconv,
  },
  "langsmith.metadata.ls_invocation_params": {
    convention: Convention.Semconv,
    expand: expandLangsmithParams,
  },
  ...paramBlobChildMappings(langsmithParamsPrefix, Convention.Semconv),

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
  "llm.token_count.prompt_details.cache_read": {
    field: "cacheReadTokens",
    convention: Convention.OpenInference,
  },
  "llm.token_count.completion_details.reasoning": {
    field: "reasoningTokens",
    convention: Convention.OpenInference,
  },
  // `llm.system` identifies the AI product/vendor (openai, anthropic, …),
  // matching the semantics of the deprecated semconv `gen_ai.system`.
  "llm.system": { field: "system", convention: Convention.OpenInference },
  // OpenInference reports request parameters only as a JSON blob; expand it into
  // synthetic children matched back below.
  "llm.invocation_parameters": {
    convention: Convention.OpenInference,
    expand: expandOpenInferenceParams,
  },
  ...paramBlobChildMappings(
    openInferenceParamsPrefix,
    Convention.OpenInference,
  ),

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
  // Cached-input count. The AI SDK emits both a flat top-level attribute and a
  // nested `inputTokenDetails` breakdown carrying the same value; neither is
  // documented in the telemetry spec and Vercel marks neither deprecated. The
  // flat form is the canonical normalized `LanguageModelUsage` field, so it
  // wins (keyRank 0); the nested form is a fallback (keyRank 1) for emitters
  // that report only the breakdown.
  "ai.usage.cachedInputTokens": {
    field: "cacheReadTokens",
    convention: Convention.Vercel,
  },
  "ai.usage.inputTokenDetails.cacheReadTokens": {
    field: "cacheReadTokens",
    convention: Convention.Vercel,
    keyRank: 1,
  },
  // Reasoning count; same flat-vs-nested duplication as cachedInputTokens above.
  "ai.usage.reasoningTokens": {
    field: "reasoningTokens",
    convention: Convention.Vercel,
  },
  "ai.usage.outputTokenDetails.reasoningTokens": {
    field: "reasoningTokens",
    convention: Convention.Vercel,
    keyRank: 1,
  },
  // Embeddings spans emit only a single `ai.usage.tokens` count (no
  // input/output split); map it to inputTokens to match the semconv embeddings
  // case.
  "ai.usage.tokens": { field: "inputTokens", convention: Convention.Vercel },
  // Request / inference parameters as Vercel scalars. Vercel also emits the
  // semconv `gen_ai.request.*` shape, which outranks these (Semconv < Vercel);
  // `seed` is the one parameter only the Vercel shape carries. `maxRetries` is
  // an SDK transport setting, not an inference parameter, so it is left unmapped.
  "ai.settings.temperature": {
    field: "temperature",
    convention: Convention.Vercel,
  },
  "ai.settings.topP": { field: "topP", convention: Convention.Vercel },
  "ai.settings.maxOutputTokens": {
    field: "maxTokens",
    convention: Convention.Vercel,
  },
  "ai.settings.frequencyPenalty": {
    field: "frequencyPenalty",
    convention: Convention.Vercel,
  },
  "ai.settings.presencePenalty": {
    field: "presencePenalty",
    convention: Convention.Vercel,
  },
  "ai.settings.stopSequences": {
    field: "stopSequences",
    convention: Convention.Vercel,
  },
  "ai.settings.seed": { field: "seed", convention: Convention.Vercel },
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

  // Detailed token counts, stored raw as each emitter reports them; no
  // cross-field derivation since providers account for them differently.
  const cacheReadTokens = count("cacheReadTokens");
  if (cacheReadTokens !== undefined) {
    metadata.cacheReadTokens = cacheReadTokens;
  }

  const cacheCreationTokens = count("cacheCreationTokens");
  if (cacheCreationTokens !== undefined) {
    metadata.cacheCreationTokens = cacheCreationTokens;
  }

  const reasoningTokens = count("reasoningTokens");
  if (reasoningTokens !== undefined) {
    metadata.reasoningTokens = reasoningTokens;
  }

  // Request / inference parameters. The numeric ones reuse the same defensive
  // coercion as token counts (`count` accepts non-integers too); 0 is a valid
  // value, so the `!== undefined` guards must not collapse it to absent.
  const temperature = count("temperature");
  if (temperature !== undefined) {
    metadata.temperature = temperature;
  }

  const topP = count("topP");
  if (topP !== undefined) {
    metadata.topP = topP;
  }

  const maxTokens = count("maxTokens");
  if (maxTokens !== undefined) {
    metadata.maxTokens = maxTokens;
  }

  const frequencyPenalty = count("frequencyPenalty");
  if (frequencyPenalty !== undefined) {
    metadata.frequencyPenalty = frequencyPenalty;
  }

  const presencePenalty = count("presencePenalty");
  if (presencePenalty !== undefined) {
    metadata.presencePenalty = presencePenalty;
  }

  const seed = count("seed");
  if (seed !== undefined) {
    metadata.seed = seed;
  }

  // Stop sequences arrive as a native string array (semconv, Vercel, blobs) or
  // as a JSON-encoded array string (langsmith `ls_stop`); normalise both to a
  // non-empty list of strings.
  const stopSequences = toStopSequences(candidates.stopSequences?.value);
  if (stopSequences !== undefined) {
    metadata.stopSequences = stopSequences;
  }

  return metadata;
};

/**
 * Normalises a stop-sequences candidate into a non-empty `string[]`, or
 * `undefined` when there is nothing usable. Accepts a native string array, a
 * JSON-encoded array string, or a bare single stop string.
 */
const toStopSequences = (
  raw: AttributeValue | undefined,
): string[] | undefined => {
  if (Array.isArray(raw)) {
    const strings = raw.filter((x): x is string => typeof x === "string");
    return strings.length > 0 ? strings : undefined;
  }

  if (typeof raw === "string" && raw !== "") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const strings = parsed.filter(
          (x): x is string => typeof x === "string",
        );
        return strings.length > 0 ? strings : undefined;
      }
    } catch {
      // Not JSON: treat the raw value as a single stop sequence below.
    }
    return [raw];
  }

  return undefined;
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

  if (a.cacheReadTokens !== undefined || b.cacheReadTokens !== undefined) {
    metadata.cacheReadTokens =
      (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0);
  }

  if (
    a.cacheCreationTokens !== undefined ||
    b.cacheCreationTokens !== undefined
  ) {
    metadata.cacheCreationTokens =
      (a.cacheCreationTokens ?? 0) + (b.cacheCreationTokens ?? 0);
  }

  if (a.reasoningTokens !== undefined || b.reasoningTokens !== undefined) {
    metadata.reasoningTokens =
      (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0);
  }

  // Request parameters describe the request, not a quantity, so they are not
  // summed: `a`'s value wins, falling back to `b`.
  const temperature = a.temperature ?? b.temperature;
  if (temperature !== undefined) {
    metadata.temperature = temperature;
  }

  const topP = a.topP ?? b.topP;
  if (topP !== undefined) {
    metadata.topP = topP;
  }

  const maxTokens = a.maxTokens ?? b.maxTokens;
  if (maxTokens !== undefined) {
    metadata.maxTokens = maxTokens;
  }

  const frequencyPenalty = a.frequencyPenalty ?? b.frequencyPenalty;
  if (frequencyPenalty !== undefined) {
    metadata.frequencyPenalty = frequencyPenalty;
  }

  const presencePenalty = a.presencePenalty ?? b.presencePenalty;
  if (presencePenalty !== undefined) {
    metadata.presencePenalty = presencePenalty;
  }

  const stopSequences = a.stopSequences ?? b.stopSequences;
  if (stopSequences !== undefined) {
    metadata.stopSequences = stopSequences;
  }

  const seed = a.seed ?? b.seed;
  if (seed !== undefined) {
    metadata.seed = seed;
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

  if (metadata.cacheReadTokens !== undefined) {
    values.cache_read_tokens = metadata.cacheReadTokens;
  }

  if (metadata.cacheCreationTokens !== undefined) {
    values.cache_creation_tokens = metadata.cacheCreationTokens;
  }

  if (metadata.reasoningTokens !== undefined) {
    values.reasoning_tokens = metadata.reasoningTokens;
  }

  if (metadata.temperature !== undefined) {
    values.temperature = metadata.temperature;
  }

  if (metadata.topP !== undefined) {
    values.top_p = metadata.topP;
  }

  if (metadata.maxTokens !== undefined) {
    values.max_tokens = metadata.maxTokens;
  }

  if (metadata.frequencyPenalty !== undefined) {
    values.frequency_penalty = metadata.frequencyPenalty;
  }

  if (metadata.presencePenalty !== undefined) {
    values.presence_penalty = metadata.presencePenalty;
  }

  if (metadata.stopSequences !== undefined) {
    values.stop_sequences = metadata.stopSequences;
  }

  if (metadata.seed !== undefined) {
    values.seed = metadata.seed;
  }

  if (Object.keys(values).length === 0) {
    return undefined;
  }

  return values;
};
