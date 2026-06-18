import type { Attributes, AttributeValue } from "@opentelemetry/api";

/**
 * A loosely-typed bag of OpenInference span attributes.
 *
 * This captures *every* attribute a span
 * carries under an OpenInference namespace, keys verbatim, values in their
 * native OTel {@link AttributeValue} shape. The set of keys is open-ended
 * (OpenInference uses indexed/nested keys like
 * `llm.input_messages.0.message.role`), so there is no per-key schema — new and
 * indexed keys flow through untouched.
 *
 * A key is only present when the span carried it; absent attributes are
 * omitted.
 */
export type OpenInferenceAttributes = Record<string, AttributeValue>;

/**
 * The convention-agnostic name the metadata pipeline (span processor, engine)
 * uses for the bag it carries. Those layers don't care that the payload happens
 * to be OpenInference attributes, so they refer to it as `AIMetadata`.
 */
export type AIMetadata = OpenInferenceAttributes;

/**
 * Top-level OpenInference attribute namespace roots.
 *
 * An attribute belongs to OpenInference when its key equals one of these roots
 * or sits beneath it (`<root>.…`). Roots — rather than the full constant list —
 * are matched so the entire indexed/nested tree under a namespace (e.g.
 * `llm.input_messages.0.message.contents.0.message_content.text`) is captured
 * without enumerating every key, and so attributes added by future
 * OpenInference versions are picked up automatically.
 *
 * This list is the authoritative spec surface as of
 * `@arizeai/openinference-semantic-conventions`; `aiExtractor.test.ts` asserts
 * it stays in sync with that package (a devDependency), so a new namespace in
 * the spec fails the suite rather than silently dropping attributes.
 */
export const OPENINFERENCE_ROOTS = [
  "openinference",
  "llm",
  "message",
  "message_content",
  "tool",
  "tool_call",
  "document",
  "retrieval",
  "reranker",
  "embedding",
  "prompt",
  "input",
  "output",
  "image",
  "audio",
  "tag",
  "metadata",
  "graph",
  "agent",
  "user",
  "session",
] as const;

const openInferenceRootSet = new Set<string>(OPENINFERENCE_ROOTS);

/**
 * Whether an attribute key belongs to an OpenInference namespace: it is either
 * a bare root (e.g. `metadata`) or sits beneath one (e.g. `llm.token_count.…`).
 */
const isOpenInferenceKey = (key: string): boolean => {
  const dot = key.indexOf(".");
  const root = dot === -1 ? key : key.slice(0, dot);
  return openInferenceRootSet.has(root);
};

/**
 * Extracts every OpenInference attribute from a span's attributes into a loose
 * bag, preserving keys and native values verbatim.
 *
 * Capture is namespace-based: any attribute under a known OpenInference root
 * (see {@link OPENINFERENCE_ROOTS}) is included, which covers the indexed
 * message/tool/document trees and any keys newer OpenInference versions add.
 *
 * Note that payload-bearing keys such as `input.value` / `output.value` carry
 * full prompt and completion content; callers that forward this bag should be
 * mindful of size and sensitive data.
 *
 * @param attributes - The span attributes, as exposed by
 * `ReadableSpan.attributes`.
 */
export const extractOpenInferenceAttributes = (
  attributes: Attributes,
): OpenInferenceAttributes => {
  const out: OpenInferenceAttributes = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined) {
      continue;
    }
    if (isOpenInferenceKey(key)) {
      out[key] = value;
    }
  }

  return out;
};

/**
 * Aggregates two {@link OpenInferenceAttributes} bags into one, last-write-wins:
 * `b`'s keys overwrite `a`'s, and keys present in only one input survive.
 *
 * Unlike the previous curated aggregator, no value is summed or otherwise
 * combined — within a single step the most recently ended span's attributes are
 * authoritative for any key they both carry.
 *
 * @param a - The earlier bag.
 * @param b - The later bag, whose keys win on conflict.
 */
export const aggregate = (
  a: OpenInferenceAttributes,
  b: OpenInferenceAttributes,
): OpenInferenceAttributes => ({ ...a, ...b });

/**
 * The bag the server stamps as `inngest.ai` step metadata. Keys are already
 * canonical OpenInference attribute names, so the bag is returned as-is — except
 * an empty bag becomes `undefined`, so callers can skip stamping entirely. This
 * is the seam at which any future server-bound filtering (e.g. dropping the
 * large `input.value` / `output.value` payloads) would live.
 */
export const toInngestAIMetadataValues = (
  metadata: OpenInferenceAttributes,
): OpenInferenceAttributes | undefined =>
  Object.keys(metadata).length === 0 ? undefined : metadata;
