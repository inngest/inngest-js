import type { RunMetadata, TraceMetadataNode } from "@inngest/test-harness";

function scoreEntries(metadata: RunMetadata[]) {
  return metadata.filter((md) => md.kind === "inngest.score");
}

function scoreValues(metadata: RunMetadata[]) {
  return Object.assign({}, ...scoreEntries(metadata).map((md) => md.values));
}

export function expectScoreValue(
  metadata: RunMetadata[],
  name: string,
  value: number,
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
