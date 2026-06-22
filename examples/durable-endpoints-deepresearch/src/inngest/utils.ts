/**
 * Utility functions for the DeepResearch API
 */

import { createHash } from "crypto";

/**
 * Generate a short hash for step IDs
 * Used to create unique, deterministic step names for Inngest
 */
export function hashQuery(query: string): string {
  return createHash("md5").update(query).digest("hex").substring(0, 8);
}

/**
 * Calculate progress percentage based on depth and breadth
 */
export function calculateProgress(
  currentDepth: number,
  maxDepth: number,
  currentQuery: number,
  totalQueries: number
): number {
  const depthProgress = ((maxDepth - currentDepth) / maxDepth) * 100;
  const queryProgress = (currentQuery / totalQueries) * (100 / maxDepth);
  return Math.min(Math.round(depthProgress + queryProgress), 95);
}

/**
 * Check if a failure should be simulated for this step.
 * Throws an error if failure should be injected - Inngest will handle retries.
 *
 * Used for durability demos to show Inngest's automatic retry behavior.
 *
 * @param stepType - The type of step ("search" | "learn" | "report")
 * @param injectFailure - Which step type to inject failures into (null to disable)
 * @param failureRate - Probability of failure (0.0 to 1.0)
 */
export function maybeInjectFailure(
  stepType: string,
  injectFailure: string | null,
  failureRate: number
): void {
  if (!injectFailure || injectFailure !== stepType) return;
  if (Math.random() < failureRate) {
    throw new Error(`Simulated ${stepType} failure (demo)`);
  }
}
