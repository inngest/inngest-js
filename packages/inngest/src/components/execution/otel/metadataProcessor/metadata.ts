import type { MetadataUpdate } from "../../../InngestMetadata.ts";

export const aiMetadataKind = "inngest.ai";

export const aiMetadataKeys = {
  inputTokens: "input-tokens",
  model: "model",
  outputTokens: "output-tokens",
} as const;

export type AIMetadataValues = Record<string, unknown>;

export function aggregateAIMetadataUpdates(
  updates: MetadataUpdate[],
): MetadataUpdate[] {
  const aggregated: MetadataUpdate[] = [];

  for (const update of updates) {
    if (!isAIMetadataUpdate(update)) {
      aggregated.push(update);
      continue;
    }

    const existingUpdate = findAIMetadataUpdate(aggregated);
    if (!existingUpdate) {
      aggregated.push({
        kind: update.kind,
        scope: update.scope,
        op: update.op,
        values: { ...update.values },
      });
      continue;
    }

    mergeAIMetadataValues(existingUpdate.values, update.values);
  }

  return aggregated;
}

function isAIMetadataUpdate(update: MetadataUpdate): boolean {
  return (
    update.kind === aiMetadataKind &&
    update.scope === "step" &&
    update.op === "merge"
  );
}

function findAIMetadataUpdate(
  updates: MetadataUpdate[],
): MetadataUpdate | undefined {
  for (const update of updates) {
    if (isAIMetadataUpdate(update)) {
      return update;
    }
  }

  return undefined;
}

function mergeAIMetadataValues(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): void {
  for (const [key, sourceValue] of Object.entries(source)) {
    const targetValue = target[key];
    if (typeof targetValue === "number" && typeof sourceValue === "number") {
      target[key] = targetValue + sourceValue;
      continue;
    }

    target[key] = sourceValue;
  }
}
