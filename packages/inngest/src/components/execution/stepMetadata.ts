import type { MetadataUpdate } from "../InngestMetadata.ts";
import { aggregateAIMetadataUpdates } from "./otel/metadataProcessor/metadata.ts";

/**
 * Execution-owned buffer for metadata updates that will ship with step ops.
 */
export class StepMetadataBuffer {
  private buffer = new Map<string, MetadataUpdate[]>();

  add(stepId: string, update: MetadataUpdate): void {
    const updates = this.buffer.get(stepId) ?? [];
    updates.push(update);
    this.buffer.set(stepId, updates);
  }

  getForStep(stepId: string): MetadataUpdate[] | undefined {
    const updates = this.buffer.get(stepId);
    if (!updates || updates.length === 0) {
      return;
    }

    return aggregateAIMetadataUpdates(updates);
  }
}
