/**
 * Reading a project's source as text, never running it: where `createCi()` is
 * called, which file serves its functions and at what path, and the command
 * that starts that file. Pure, so each rule is tested on strings.
 *
 * @module
 */

/** A `const ci = createCi(inngest)`. */
export interface CiInstance {
  file: string;
  /** The variable the instance is bound to. */
  name: string;
  /** The variable passed to `createCi()`, which the server also needs. */
  client: string;
}

/** A file that serves an instance's functions. */
export interface Served {
  file: string;
  /** The name of the instance whose `.functions()` it serves. */
  instance: string;
  /** `serve()` is what `inngest-ci` can run; `connect()` isn't yet. */
  kind: "serve" | "connect";
  /** The `inngest/<adapter>` it serves with, like `next` or `node`. */
  adapter?: string;
  /** Where it serves, when the file or its position in the project says. */
  path?: string;
  readsPort: boolean;
}

export type PackageManager = "npm" | "pnpm" | "yarn";

/** Subpaths of `inngest` that aren't adapters for `serve()`. */
const nonAdapters = new Set(["connect", "experimental", "types"]);

/** The scripts that run a framework's own server, by adapter. */
const frameworkDev: Record<string, RegExp> = {
  next: /\bnext\s+dev\b/,
  sveltekit: /\bvite\s+dev\b/,
  remix: /\bremix\s+(?:vite:)?dev\b/,
};

const isTypeScript = (file: string): boolean => {
  return /\.[cm]?tsx?$/.test(file);
};

/** Every `const <name> = createCi(<client>` in a file. */
export const findInstances = (file: string, source: string): CiInstance[] => {
  return [
    ...source.matchAll(
      /(?:const|let|var)\s+([\w$]+)\s*=\s*createCi\(\s*([\w$]+)?/g,
    ),
  ].map((match) => {
    return {
      file,
      name: match[1] as string,
      client: match[2] ?? "inngest",
    };
  });
};

/**
 * Where a route file is mounted, in the conventions of Next.js, SvelteKit and
 * Remix, where a route is served where its file lives. Another adapter, or a
 * file that isn't a route, has no path.
 */
export const routePath = (
  file: string,
  adapter: string,
): string | undefined => {
  const segments = file.replace(/\.[cm]?[jt]sx?$/, "").split("/");
  const name = segments.pop() as string;

  const after = (folder: string): string[] | undefined => {
    const index = segments.lastIndexOf(folder);

    return index === -1 ? undefined : segments.slice(index + 1);
  };

  const route = (parts: string[]): string => {
    return `/${parts
      .filter((part) => {
        return part !== "" && !/^\(.*\)$/.test(part);
      })
      .join("/")}`;
  };

  switch (adapter) {
    case "next": {
      const app = after("app");
      const pages = after("pages");

      if (app && name === "route") {
        return route(app);
      }

      if (pages) {
        return route([...pages, name === "index" ? "" : name]);
      }

      return undefined;
    }

    case "sveltekit": {
      const routes = after("routes");

      return routes && name === "+server" ? route(routes) : undefined;
    }

    case "remix": {
      const routes = after("routes");

      if (!routes) {
        return undefined;
      }

      const own = ["route", "index", "_index"].includes(name) ? [] : [name];

      return route(
        [...routes, ...own].flatMap((part) => {
          return part.split(".");
        }),
      );
    }

    default: {
      return undefined;
    }
  }
};

/**
 * Whether a file serves one of `instances`' functions, and how. It must
 * call `<instance>.functions()` and either `serve()` with an `inngest/*`
 * adapter, `createServer()` from `inngest/node`, or `connect()`.
 */
export const findServed = (
  file: string,
  source: string,
  instances: string[],
): Served | undefined => {
  const instance = [...source.matchAll(/([\w$]+)\.functions\(\)/g)]
    .map((match) => {
      return match[1] as string;
    })
    .find((name) => {
      return instances.includes(name);
    });

  if (!instance) {
    return undefined;
  }

  const adapter = [...source.matchAll(/from\s+["']inngest\/([\w-]+)["']/g)]
    .map((match) => {
      return match[1] as string;
    })
    .find((name) => {
      return !nonAdapters.has(name);
    });

  const serves =
    /(?<![\w$.])serve\(/.test(source) ||
    /import\s*\{[^}]*\bcreateServer\b[^}]*\}\s*from\s*["']inngest\/node["']/.test(
      source,
    );

  const connects = /(?<![\w$.])connect\(/.test(source);

  if (!(adapter && serves) && !connects) {
    return undefined;
  }

  const servePath = /servePath\s*:\s*(["'`])(\/[^"'`]*)\1/.exec(source)?.[2];

  return {
    file,
    instance,
    kind: adapter && serves ? "serve" : "connect",
    adapter,
    path: servePath ?? (adapter ? routePath(file, adapter) : undefined),
    readsPort: /\bPORT\b/.test(source) || adapter === "next",
  };
};

/** The package manager whose lockfile is among `lockfiles`; npm without one. */
export const packageManagerOf = (lockfiles: string[]): PackageManager => {
  if (lockfiles.includes("pnpm-lock.yaml")) {
    return "pnpm";
  }

  return lockfiles.includes("yarn.lock") ? "yarn" : "npm";
};

/** The command that runs a `package.json` script. */
const runScript = (manager: PackageManager, script: string): string => {
  return manager === "yarn" ? `yarn ${script}` : `${manager} run ${script}`;
};

/** The command that adds `tsx` as a dev dependency. */
export const installTsx = (manager: PackageManager): string => {
  switch (manager) {
    case "pnpm": {
      return "pnpm add --save-dev tsx";
    }

    case "yarn": {
      return "yarn add --dev tsx";
    }

    case "npm": {
      return "npm install --save-dev tsx";
    }
  }
};

/**
 * The command that starts `served`. A `package.json` script that runs its
 * file, or the framework's dev server, is best, because it carries the flags
 * the project runs with; one that doesn't `watch` is preferred. Otherwise
 * `tsx` or `node`.
 */
export const startCommand = (opts: {
  served: Pick<Served, "file" | "adapter">;
  scripts: Record<string, string>;
  manager: PackageManager;
}): string => {
  const { served, scripts, manager } = opts;
  const dev = served.adapter ? frameworkDev[served.adapter] : undefined;

  const runs = Object.entries(scripts)
    .filter(([, command]) => {
      return (
        dev?.test(command) ||
        command.split(/\s+/).some((word) => {
          return word.replace(/^\.\//, "") === served.file;
        })
      );
    })
    .sort(([, left], [, right]) => {
      return Number(/\bwatch\b/.test(left)) - Number(/\bwatch\b/.test(right));
    });

  const script = runs[0]?.[0];

  if (script) {
    return runScript(manager, script);
  }

  return `${isTypeScript(served.file) ? "tsx" : "node"} ${served.file}`;
};
