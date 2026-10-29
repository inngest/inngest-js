/**
 * @module
 * The static `inngest-tool` binary (source in `packages/inngest/sandbox-tool`),
 * which handler shims need. It is built by `pnpm build:sandbox-tool`, read
 * from disk by the SDK, and put into the sandbox on first use: a small command
 * checks for it, and only a sandbox without it receives an upload. A base image
 * that already has it at the same path pays nothing.
 */
import { NonRetriableError } from "../NonRetriableError.ts";
import type { Sandbox } from "./types.ts";

export const toolBinaryDir = "/inngest/tools/bin";

export interface ToolBinary {
  /**
   * Where it lives in the sandbox. The name carries a hash of its content, so
   * a different build never meets an older one.
   */
  path: string;

  /**
   * The SHA-256 of the binary, which an installed file must match.
   */
  sha256: string;

  /**
   * Its gzipped bytes.
   */
  load: () => Promise<Uint8Array>;
}

const binaryFile = "sandbox-tool/dist/inngest-tool-linux-amd64";

let bundled: Promise<ToolBinary | undefined> | undefined;

/**
 * Looks for `sandbox-tool/dist` in this folder and each one above it, so it is
 * found from `src` and from a built chunk alike. Written so that bundlers do
 * not mistake the file for an import.
 */
const findBinary = async (): Promise<string | undefined> => {
  const { existsSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  if (process.env.INNGEST_SANDBOX_TOOL) {
    return process.env.INNGEST_SANDBOX_TOOL;
  }

  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const file = join(dir, binaryFile);
    if (existsSync(file)) {
      return file;
    }

    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }

    dir = parent;
  }
};

const loadBundled = async (): Promise<ToolBinary | undefined> => {
  try {
    const { readFile } = await import("node:fs/promises");
    const { createHash } = await import("node:crypto");
    const { gzipSync } = await import("node:zlib");
    const file = await findBinary();
    if (!file) {
      return undefined;
    }

    const raw = await readFile(file);
    const sha256 = createHash("sha256").update(raw).digest("hex");
    let gz: Uint8Array | undefined;

    return {
      path: `${toolBinaryDir}/inngest-tool-${sha256.slice(0, 12)}`,
      sha256,
      load: async () => {
        gz ??= gzipSync(raw, { level: 9 });

        return gz;
      },
    };
  } catch {
    return undefined;
  }
};

/**
 * The binary built next to the SDK, or the one `INNGEST_SANDBOX_TOOL` names.
 * Sandboxes are x86_64 linux. `undefined` when it has not been built, or where
 * there is no file system.
 */
export const bundledToolBinary = (): Promise<ToolBinary | undefined> => {
  bundled ??= loadBundled();

  return bundled;
};

/**
 * Makes sure the binary is in the sandbox. Safe to repeat, and to run next to
 * itself: each run stages its own files and moves the result into place.
 */
export const installToolBinary = async (
  sandbox: Sandbox,
  binary: ToolBinary,
): Promise<void> => {
  const have = await sandbox.commands.run([
    "/bin/sh",
    "-c",
    '[ "$(uname -m)" = x86_64 ] || exit 3; test -x "$1" && sha256sum "$1" | grep -q "^$2 "',
    "sh",
    binary.path,
    binary.sha256,
  ]);
  if (have.exitCode === 0) {
    return;
  }

  if (have.exitCode === 3) {
    throw new NonRetriableError(
      "Handler shims need the inngest-tool binary, which is built for x86_64 sandboxes only",
    );
  }

  const staged = `${binary.path}.${crypto.randomUUID()}`;
  const bytes = await binary.load();
  await sandbox.commands.run(["/bin/mkdir", "-p", toolBinaryDir]);
  await sandbox.files.upload({
    path: `${staged}.gz`,
    data: new Blob([bytes as BlobPart]),
  });
  await sandbox.commands.run([
    "/bin/sh",
    "-c",
    'gunzip -c "$1.gz" > "$1" && chmod +x "$1" && mv "$1" "$2" && rm "$1.gz"',
    "sh",
    staged,
    binary.path,
  ]);
};
