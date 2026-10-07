/**
 * A tar of the local working tree, for uploading to a machine. Only
 * `checkout()` needs it.
 *
 * @module
 */

import { lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { git } from "../util.ts";

const blockSize = 512;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const octal = (value: number, length: number): string => {
  return `${value.toString(8).padStart(length - 1, "0")}\0`;
};

/** Zero-pad to a whole number of tar blocks. */
const padded = (data: Uint8Array): Uint8Array => {
  const out = new Uint8Array(
    Math.ceil(data.byteLength / blockSize) * blockSize,
  );

  out.set(data);

  return out;
};

/**
 * Split a path at a `/` into ustar's `prefix` (up to 155 bytes) and `name` (up
 * to 100 bytes) fields. Returns undefined when it can't be split to fit.
 */
const splitName = (
  path: Uint8Array,
): { prefix: string; name: string } | undefined => {
  if (path.byteLength <= 100) {
    return { prefix: "", name: decoder.decode(path) };
  }

  for (let i = path.byteLength - 1; i > 0; i--) {
    if (path[i] === 0x2f && path.byteLength - i - 1 <= 100 && i <= 155) {
      return {
        prefix: decoder.decode(path.slice(0, i)),
        name: decoder.decode(path.slice(i + 1)),
      };
    }
  }

  return undefined;
};

/** A PAX record is `<length> <key>=<value>\n`, where length counts itself. */
const paxRecord = (key: string, value: string): Uint8Array => {
  const body = ` ${key}=${value}\n`;
  let length = encoder.encode(body).byteLength;

  while (encoder.encode(`${length}${body}`).byteLength !== length) {
    length = encoder.encode(`${length}${body}`).byteLength;
  }

  return encoder.encode(`${length}${body}`);
};

const header = (fields: {
  name: string;
  prefix: string;
  size: number;
  mode: number;
  typeflag: string;
  linkname?: string;
}): Uint8Array => {
  const block = new Uint8Array(blockSize);

  const write = (text: string, offset: number, length: number) => {
    block.set(encoder.encode(text).slice(0, length), offset);
  };

  write(fields.name, 0, 100);
  write(octal(fields.mode, 8), 100, 8);
  write(octal(0, 8), 108, 8);
  write(octal(0, 8), 116, 8);
  write(octal(fields.size, 12), 124, 12);
  write(octal(Math.floor(Date.now() / 1000), 12), 136, 12);
  write("        ", 148, 8); // checksum placeholder
  write(fields.typeflag, 156, 1);
  write(fields.linkname ?? "", 157, 100);
  write("ustar\0", 257, 6);
  write("00", 263, 2);
  write(fields.prefix, 345, 155);

  let checksum = 0;

  for (const byte of block) {
    checksum += byte;
  }

  write(octal(checksum, 7), 148, 7);

  block[155] = 0x20;

  return block;
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
 * regular files and symlinks. A symlink is written as a link entry and its
 * target is never read, so a link out of the tree can't pull in other files. Long paths use ustar's `prefix` field, or a PAX extended
 * header when no `/` split fits.
 */
export const buildWorkingTreeTarball = async (
  cwd: string,
): Promise<Uint8Array> => {
  const files = await workingTreeFiles(cwd);
  const blocks: Uint8Array[] = [];

  for (const relative of files) {
    const absolute = join(cwd, relative);

    let contents = new Uint8Array(0);
    let linkname: string | undefined;
    let mode = 0o644;

    try {
      const info = await lstat(absolute);

      if (info.isSymbolicLink()) {
        linkname = await readlink(absolute);
        mode = 0o777;
      } else if (info.isFile()) {
        mode = info.mode & 0o777;

        contents = new Uint8Array(await readFile(absolute));
      } else {
        continue;
      }
    } catch {
      // Deleted between listing and reading.
      continue;
    }

    const split = splitName(encoder.encode(relative));

    // A link target past the header's 100 bytes needs a PAX record too.
    const longLink =
      linkname !== undefined && encoder.encode(linkname).byteLength > 100;

    if (!split || longLink) {
      const record = new Uint8Array([
        ...(split ? [] : paxRecord("path", relative)),
        ...(longLink ? paxRecord("linkpath", linkname as string) : []),
      ]);

      blocks.push(
        header({
          name: "PaxHeader",
          prefix: "",
          size: record.byteLength,
          mode: 0o644,
          typeflag: "x",
        }),
        padded(record),
      );
    }

    // Without a split, PAX supplies the real path and this name is a stub.
    const { prefix, name } = split ?? { prefix: "", name: relative };

    blocks.push(
      header({
        name,
        prefix,
        size: contents.byteLength,
        mode,
        typeflag: linkname === undefined ? "0" : "2",
        ...(linkname === undefined ? {} : { linkname }),
      }),
      padded(contents),
    );
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
