/**
 * What a snapshot knows about itself, kept in a file inside it: the working
 * tree it holds. Written just before a machine is snapshotted, and read back
 * when a machine starts from one.
 *
 * @module
 */

/** Where the file lives on every machine. */
export const snapshotMetaPath = "/.inngest-ci/snapshot.json";

export interface SnapshotMeta {
  /**
   * The git tree ID of the working tree the snapshot holds, so a job that
   * starts from it uploads only what changed since.
   */
  treeId?: string;
}

/**
 * The script that writes the file. Its path and contents are passed as
 * arguments, so nothing in them is ever read by the shell.
 */
export const writeSnapshotMetaScript = `mkdir -p "$(dirname "$1")" && printf '%s' "$2" > "$1"`;

/** Prints the file, for a machine's setup to read back with `parseSnapshotMeta`. */
export const readSnapshotMetaScript = `(cat ${snapshotMetaPath} 2>/dev/null || true)`;

/** Write `meta` into the machine, unless it says nothing. */
export const saveSnapshotMeta = async (
  // biome-ignore lint/suspicious/noExplicitAny: DurableSandbox
  sandbox: any,
  stepId: string,
  meta: SnapshotMeta,
): Promise<void> => {
  const json = JSON.stringify(meta);

  if (json !== "{}") {
    await sandbox.commands.run(stepId, [
      "/bin/sh",
      "-c",
      writeSnapshotMetaScript,
      "sh",
      snapshotMetaPath,
      json,
    ]);
  }
};

/**
 * Read the file's contents, as printed by a machine's setup. Anything that
 * isn't the file, such as nothing at all on a fresh machine, says nothing.
 */
export const parseSnapshotMeta = (stdout: string): SnapshotMeta => {
  try {
    const { treeId } = JSON.parse(stdout) as SnapshotMeta;

    return typeof treeId === "string" ? { treeId } : {};
  } catch {
    return {};
  }
};
