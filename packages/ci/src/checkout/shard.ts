/**
 * Splitting a list of files across shards: `shard()`.
 *
 * @module
 */

import { requireJobScope } from "../pipeline/scope.ts";

export interface ShardOptions {
  total: number;
}

/**
 * EXPERIMENTAL: This API is not yet stable and may change in the future without
 * a major version bump.
 *
 * Split a list of files evenly across shards and run one of them.
 */
export const shard = async <T>(
  opts: ShardOptions & { index: number; files: string[] },
  run: (files: string[]) => Promise<T>,
): Promise<T> => {
  requireJobScope("shard");

  return run(
    opts.files.filter((_file, index) => {
      return index % opts.total === opts.index;
    }),
  );
};
