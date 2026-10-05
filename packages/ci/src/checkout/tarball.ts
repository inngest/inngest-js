/**
 * A tar of the local working tree, for uploading to a machine. Only
 * `checkout()` needs it.
 *
 * @module
 */

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { git } from "../util.ts";

const blockSize = 512;

const octal = (value: number, length: number): string => {
  return `${value.toString(8).padStart(length - 1, "0")}\0`;
};

/**
 * The files git would consider part of the working tree: tracked files plus
 * untracked ones that aren't ignored.
 */
const workingTreeFiles = async (cwd: string): Promise<string[]> => {
  const stdout = await git(cwd, [
    "ls-files",
    "-co",
    "--exclude-standard",
    "-z",
  ]);
  return stdout.split("\0").filter(Boolean);
};

/**
 * Build an uncompressed tar of the working tree.
 *
 * This is a small ustar writer rather than a dependency: the machine has
 * `tar`, the format is a few fixed-width fields, and CI only ever writes
 * regular files.
 */
export const buildWorkingTreeTarball = async (
  cwd: string,
): Promise<Uint8Array> => {
  const files = await workingTreeFiles(cwd);
  const blocks: Uint8Array[] = [];
  const encoder = new TextEncoder();

  for (const relative of files) {
    const absolute = join(cwd, relative);

    let contents: Uint8Array;
    let mode = 0o644;

    try {
      const info = await stat(absolute);
      if (!info.isFile()) {
        continue;
      }
      mode = info.mode & 0o777;
      contents = new Uint8Array(await readFile(absolute));
    } catch {
      // Deleted between listing and reading.
      continue;
    }

    const header = new Uint8Array(blockSize);
    const write = (text: string, offset: number, length: number) => {
      header.set(encoder.encode(text).slice(0, length), offset);
    };

    // Names over 100 bytes aren't split across ustar's `prefix` field, so the
    // tail is kept.
    const name = relative.length > 100 ? relative.slice(-100) : relative;

    write(name, 0, 100);
    write(octal(mode, 8), 100, 8);
    write(octal(0, 8), 108, 8);
    write(octal(0, 8), 116, 8);
    write(octal(contents.byteLength, 12), 124, 12);
    write(octal(Math.floor(Date.now() / 1000), 12), 136, 12);
    write("        ", 148, 8); // checksum placeholder
    write("0", 156, 1);
    write("ustar\0", 257, 6);
    write("00", 263, 2);

    let checksum = 0;
    for (const byte of header) {
      checksum += byte;
    }
    write(octal(checksum, 7), 148, 7);
    header[155] = 0x20;

    blocks.push(header, contents);

    const padding = (blockSize - (contents.byteLength % blockSize)) % blockSize;
    if (padding > 0) {
      blocks.push(new Uint8Array(padding));
    }
  }

  // Two empty blocks end the archive.
  blocks.push(new Uint8Array(blockSize * 2));

  const total = blocks.reduce((sum, block) => {
    return sum + block.byteLength;
  }, 0);
  const tarball = new Uint8Array(total);
  let offset = 0;

  for (const block of blocks) {
    tarball.set(block, offset);
    offset += block.byteLength;
  }

  return tarball;
};
