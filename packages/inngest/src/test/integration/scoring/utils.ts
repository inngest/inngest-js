import type { RunMetadata, TraceMetadataNode } from "@inngest/test-harness";

const scoreKind = "inngest.score";

function scoreValues(metadata: RunMetadata[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const md of metadata) {
    if (md.kind === scoreKind) {
      for (const [name, entry] of Object.entries(md.values)) {
        out[name] = (entry as { value: unknown }).value;
      }
    }
  }
  return out;
}

export function expectScoreValue(
  metadata: RunMetadata[],
  name: string,
  value: number | boolean,
) {
  expect(scoreValues(metadata)).toEqual(
    expect.objectContaining({ [name]: value }),
  );
}

export function expectNoScoreValue(metadata: RunMetadata[], name: string) {
  expect(scoreValues(metadata)).not.toHaveProperty(name);
}

function flattenTrace(node: TraceMetadataNode): TraceMetadataNode[] {
  return [node, ...node.childrenSpans.flatMap(flattenTrace)];
}

export function findSpanByName(trace: TraceMetadataNode, name: string) {
  const spans = flattenTrace(trace);
  const span = spans.find((node) => node.name === name);
  if (!span) {
    throw new Error(
      `Unable to find span "${name}". Found spans: ${spans
        .map((node) => node.name)
        .join(", ")}`,
    );
  }
  return span;
}

export function expectNoSpanByName(trace: TraceMetadataNode, name: string) {
  expect(flattenTrace(trace).map((node) => node.name)).not.toContain(name);
}
