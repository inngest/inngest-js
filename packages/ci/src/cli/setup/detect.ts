/**
 * Detecting how a project serves its `createCi()` instance, from its source
 * as text: nothing in it is imported or run. This reads the files; `analyze.ts`
 * decides what they mean.
 *
 * @module
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { git } from "../../util.ts";
import { binDirs } from "../app.ts";
import { ancestors } from "../config.ts";
import {
  type CiInstance,
  findInstances,
  findServed,
  installTsx,
  packageManagerOf,
  type Served,
  startCommand,
} from "./analyze.ts";

/** One way the project serves its functions, with what `ci` would say for it. */
export interface Candidate {
  /** The file that serves, relative to the project root. */
  file: string;
  ci: CiInstance;
  start: string;
  path: string;
  /** Things that will probably go wrong, in a sentence each. */
  warnings: string[];
}

export interface Detection {
  /** Every `createCi()` call. Empty means `@inngest/ci` isn't set up. */
  instances: CiInstance[];
  /** The files that `serve()` an instance's functions, best first. */
  candidates: Candidate[];
  /** The files that only `connect()` them, which `inngest-ci` can't run yet. */
  connects: string[];
}

/** What `serve()` mounts at when nothing else says. */
const defaultPath = "/api/inngest";

const sourceFile = /\.(?:[cm]?[jt]s|tsx)$/;
const skippedFolder =
  /(?:^|\/)(?:node_modules|dist|build|\.next|\.svelte-kit|\.output)\//;

/** `ci/` folders hold what is dedicated to CI, so their servers come first. */
const rank = (left: Candidate, right: Candidate): number => {
  const dedicated = (candidate: Candidate): number => {
    return Number(!/(?:^|\/)ci\//.test(candidate.file));
  };
  const depth = (candidate: Candidate): number => {
    return candidate.file.split("/").length;
  };

  return (
    dedicated(left) - dedicated(right) ||
    depth(left) - depth(right) ||
    left.file.localeCompare(right.file)
  );
};

const readScripts = async (root: string): Promise<Record<string, string>> => {
  try {
    const json = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

    return json.scripts ?? {};
  } catch {
    return {};
  }
};

/**
 * Find the `createCi()` instances under `root` and the files that serve them.
 * `gitRoot` is where the search for lockfiles and `node_modules/.bin` stops.
 * Files come from git, so ignored ones are skipped, and new ones count before
 * they are added.
 */
export const detectProject = async (
  root: string,
  gitRoot: string,
): Promise<Detection> => {
  const listed = await git(root, [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
  const sources: [file: string, source: string][] = [];

  for (const file of listed.split("\0")) {
    if (!sourceFile.test(file) || skippedFolder.test(file)) {
      continue;
    }

    const source = await readFile(join(root, file), "utf8").catch(() => {
      return "";
    });

    if (/createCi\(|\.functions\(\)/.test(source)) {
      sources.push([file, source]);
    }
  }

  const instances = sources.flatMap(([file, source]) => {
    return findInstances(file, source);
  });
  const names = instances.map((instance) => {
    return instance.name;
  });
  const served = sources.flatMap(([file, source]) => {
    return findServed(file, source, names) ?? [];
  });

  const manager = packageManagerOf(
    ancestors(root, gitRoot).flatMap((dir) => {
      return ["pnpm-lock.yaml", "yarn.lock"].filter((lockfile) => {
        return existsSync(join(dir, lockfile));
      });
    }),
  );
  const scripts = await readScripts(root);
  const hasTsx = binDirs(root, gitRoot).some((dir) => {
    return existsSync(join(dir, "tsx"));
  });

  const candidates = served
    .filter((item): item is Served & { kind: "serve" } => {
      return item.kind === "serve";
    })
    .map((item): Candidate => {
      const start = startCommand({ served: item, scripts, manager });

      return {
        file: item.file,
        ci: instances.find((instance) => {
          return instance.name === item.instance;
        }) as CiInstance,
        start,
        path: item.path ?? defaultPath,
        warnings: [
          ...(item.readsPort
            ? []
            : [`${item.file} doesn't read PORT, which inngest-ci sets.`]),
          ...(start.startsWith("tsx ") && !hasTsx
            ? [`tsx isn't installed. Add it with ${installTsx(manager)}.`]
            : []),
        ],
      };
    })
    .sort(rank);

  return {
    instances,
    candidates,
    connects: served
      .filter((item) => {
        return item.kind === "connect";
      })
      .map((item) => {
        return item.file;
      }),
  };
};
