/**
 * @module
 * The static `inngest-tool` binary (source in `packages/inngest/sandbox-tool`),
 * which handler shims need. It is built by `pnpm build:sandbox-tool`, read
 * from disk by the SDK, and put into the sandbox on first use: a small command
 * checks for it, and only a sandbox without it receives an upload. A base image
 * that already has it at the same path pays nothing.
 */
import hashjs from "hash.js";

import type { Sandbox } from "./types.ts";

const { sha256 } = hashjs;

export const toolBinaryDir = "/inngest/tools/bin";

export interface ToolBinary {
  /**
   * Where it lives in the sandbox. The name carries a hash of its content, so
   * a different build never meets an older one.
   */
  path: string;

  /**
   * Its gzipped bytes.
   */
  load: () => Promise<Uint8Array>;
}

/**
 * The binary built next to the SDK, or the one `INNGEST_SANDBOX_TOOL` names.
 * Sandboxes are x86_64 linux. `undefined` when it has not been built, or where
 * there is no file system.
 */
export const bundledToolBinary = async (): Promise<ToolBinary | undefined> => {
  try {
    const { readFile } = await import("node:fs/promises");
    const { gzipSync } = await import("node:zlib");
    const file =
      process.env.INNGEST_SANDBOX_TOOL ??
      new URL(
        "../../../sandbox-tool/dist/inngest-tool-linux-amd64",
        import.meta.url,
      ).pathname;
    const raw = await readFile(file);
    const hash = sha256().update(Array.from(raw)).digest("hex").slice(0, 12);

    return {
      path: `${toolBinaryDir}/inngest-tool-${hash}`,
      load: async () => {
        return gzipSync(raw, { level: 9 });
      },
    };
  } catch {
    return undefined;
  }
};

/**
 * Makes sure the binary is in the sandbox. Safe to repeat.
 */
export const installToolBinary = async (
  sandbox: Sandbox,
  binary: ToolBinary,
): Promise<void> => {
  const have = await sandbox.commands.run([
    "/bin/sh",
    "-c",
    'test -x "$1"',
    "sh",
    binary.path,
  ]);
  if (have.exitCode === 0) {
    return;
  }

  const gz = `${binary.path}.gz`;
  await sandbox.commands.run(["/bin/mkdir", "-p", toolBinaryDir]);
  const bytes = await binary.load();
  await sandbox.files.upload({ path: gz, data: new Blob([bytes as BlobPart]) });
  await sandbox.commands.run([
    "/bin/sh",
    "-c",
    'gunzip -c "$1.gz" > "$1.tmp" && chmod +x "$1.tmp" && mv "$1.tmp" "$1" && rm "$1.gz"',
    "sh",
    binary.path,
  ]);
};
