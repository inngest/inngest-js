/**
 * What a snapshot knows about itself, kept in a file inside it: the working
 * tree it holds and the cached snapshots it was built from. Written just before
 * a machine is snapshotted, and read back when a machine starts from one.
 *
 * @module
 */

/** Where the file lives on every machine. */
export const snapshotMetaPath = "/.inngest-ci/snapshot.json";

/** A cached snapshot that another was built from, by job ID. */
export interface SnapshotParent {
  /** The name the parent's snapshot had. */
  name: string;
  /** The parent's snapshot. Empty when it isn't known, which never matches. */
  snapshotId: string;
  /** The input the parent was called with, which is part of its key. */
  input?: unknown;
}

export interface SnapshotMeta {
  /**
   * The git tree ID of the working tree the snapshot holds, so a job that
   * starts from it uploads only what changed since.
   */
  treeId?: string;
  /**
   * Every cached snapshot up the chain this one was built from, by job ID. A
   * restore checks each is still what its job would use now.
   */
  parents: Record<string, SnapshotParent>;
}

/**
 * The script that writes the file. Its path and contents are passed as
 * arguments, so nothing in them is ever read by the shell.
 */
export const writeSnapshotMetaScript = `mkdir -p "$(dirname "$1")" && printf '%s' "$2" > "$1"`;

/** The command that writes `meta` into the machine. */
export const writeSnapshotMetaCommand = (meta: SnapshotMeta): string[] => {
  return [
    "/bin/sh",
    "-c",
    writeSnapshotMetaScript,
    "sh",
    snapshotMetaPath,
    JSON.stringify(meta),
  ];
};

/**
 * Read the file's contents, as printed by a machine's setup. Anything that
 * isn't the file, such as nothing at all on a fresh machine, is `undefined`.
 */
export const parseSnapshotMeta = (stdout: string): SnapshotMeta | undefined => {
  const text = stdout.trim();

  if (!text) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(text) as Partial<SnapshotMeta>;

    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }

    return {
      ...(typeof parsed.treeId === "string" ? { treeId: parsed.treeId } : {}),
      parents:
        parsed.parents && typeof parsed.parents === "object"
          ? parsed.parents
          : {},
    };
  } catch {
    return undefined;
  }
};
