/**
 * @module
 * EXPERIMENTAL: Skills for agent sandboxes. `skills.git()` names a git source
 * of skills for a sandbox definition (`sandbox({ skills: [...] })`) and says
 * how fresh it must be:
 *
 * - `"boot"`: cloned into the sandbox every time it is created. Always
 *   current, costs the clone on every cold sandbox and needs network access.
 * - `"bake"` (default): part of a snapshot named by the commit sha, found by
 *   name when the sandbox is created. The first sandbox created after the ref
 *   moves has no snapshot yet: it boots from a fetch like `"boot"`, and asks a
 *   function of its own to bake the snapshot for the sandboxes after it. There
 *   is no watcher and no schedule: a snapshot is built because a sandbox
 *   missed it.
 *
 * Limits: sources are public GitHub repositories (a token would have to be in
 * the sandbox, and so in the snapshot). A baked snapshot is a whole sandbox, so
 * its name is `skills/<repos>/<config hash>/<sha>`: the config hash tells apart
 * the image, size, ref and place the skills go to. A baked source can't go with
 * `environment` or `secrets`. Superseded snapshots are replaced when the new
 * one is saved; the rest expire.
 *
 * The ref is resolved to a sha in a memoized step, so a running thread keeps
 * the sha it started with however often the ref moves.
 */

import type { Inngest } from "../Inngest.ts";
import type { InngestFunction } from "../InngestFunction.ts";
import { NonRetriableError } from "../NonRetriableError.ts";
import type { GroupSandbox } from "../sandbox/group.ts";
import type { SandboxImage } from "../sandbox/image.ts";
import { image as sandboxImage } from "../sandbox/image.ts";
import {
  type SnapshotCacheClient,
  type SnapshotEntry,
  snapshotCache,
  snapshotKey,
} from "../sandbox/snapshotCache.ts";
import {
  type DurableSandbox,
  type DurableSandboxTools,
  SandboxValidationError,
} from "../sandbox/types.ts";

/**
 * The event that asks for a skills snapshot to be baked.
 */
export const skillsBakeEvent = "agent/skills.bake";

/**
 * The scope of every skills snapshot, `skills/<repos>/<config>/<sha>`.
 */
export const skillsScope = "skills";

const defaultGithub = {
  url: "https://github.com",
  apiUrl: "https://api.github.com",
};

export interface SkillsGitOptions {
  /**
   * The branch, tag or commit to use. Default: the repository's default
   * branch (`HEAD`).
   */
  ref?: string;

  /**
   * `"bake"` (default) puts the skills in a snapshot named by commit sha, with
   * a boot fetch for the sandboxes created before it is ready. `"boot"`
   * fetches them every time a sandbox is created.
   */
  freshness?: "bake" | "boot";

  /**
   * Where the skills land in the sandbox. Default: `/skills/<owner>/<name>`.
   * Must be a directory under `/skills/`, since it is replaced on every
   * fetch.
   */
  into?: string;

  /**
   * A GitHub host other than github.com, such as GitHub Enterprise.
   */
  github?: { url?: string; apiUrl?: string };
}

/**
 * A git source of skills made with `skills.git()`. Plain data: it needs no
 * client and fetches nothing until a sandbox that has it is created.
 */
export interface SkillsSource {
  readonly kind: "inngest/skills.git";

  /**
   * `owner/name` on GitHub.
   */
  readonly repo: string;
  readonly ref: string;
  readonly freshness: "bake" | "boot";
  readonly into: string;
  readonly github: { url: string; apiUrl: string };
}

const skillsRoot = "/skills";

const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const gitSource = (
  repo: string,
  options: SkillsGitOptions = {},
): SkillsSource => {
  if (!repoPattern.test(repo) || repo.split("/").includes("..")) {
    throw new SandboxValidationError(
      `Invalid skills repository "${repo}": use "owner/name"`,
    );
  }

  const freshness = options.freshness ?? "bake";

  if (freshness !== "bake" && freshness !== "boot") {
    throw new SandboxValidationError(
      `Skills "${repo}" has freshness "${String(freshness)}": use "bake" or "boot"`,
    );
  }

  const ref = options.ref ?? "HEAD";

  if (!ref || /\s/.test(ref) || ref.startsWith("-")) {
    throw new SandboxValidationError(
      `Skills "${repo}" has an invalid ref "${ref}"`,
    );
  }

  const into = options.into ?? `/skills/${repo}`;

  if (
    !into.startsWith(`${skillsRoot}/`) ||
    into
      .split("/")
      .slice(1)
      .some((part) => {
        return part === "" || part === ".." || part === ".";
      })
  ) {
    throw new SandboxValidationError(
      `Skills "${repo}" must go into a directory under ${skillsRoot}/, not "${into}"`,
    );
  }

  return Object.freeze({
    kind: "inngest/skills.git",
    repo,
    ref,
    freshness,
    into,
    github: {
      url: (options.github?.url ?? defaultGithub.url).replace(/\/+$/, ""),
      apiUrl: (options.github?.apiUrl ?? defaultGithub.apiUrl).replace(
        /\/+$/,
        "",
      ),
    },
  });
};

/**
 * EXPERIMENTAL: Sources of skills for a sandbox.
 *
 * @example
 * ```ts
 * const inngestSkills = skills.git("inngest/inngest-skills", { ref: "main" });
 *
 * export const workbench = sandbox({
 *   id: "workbench",
 *   skills: [inngestSkills],
 *   tools: sandbox.tools.code(),
 * });
 * ```
 */
export const skills = {
  /**
   * A public GitHub repository of skills.
   * @param repo `owner/name`.
   * @param options Ref, freshness and where the skills land.
   */
  git: gitSource,
};

/**
 * Whether a value is a {@link SkillsSource}.
 */
export const isSkillsSource = (value: unknown): value is SkillsSource => {
  return (value as SkillsSource | undefined)?.kind === "inngest/skills.git";
};

const quote = (value: string): string => {
  return `'${value.replace(/'/g, `'\\''`)}'`;
};

/**
 * The shell script that puts a source's skills, at `ref`, into the sandbox.
 * `ref` is a sha for a baked source and the source's own ref otherwise.
 */
export const skillsFetchScript = (
  source: SkillsSource,
  ref: string,
): string => {
  return [
    "set -e",
    `rm -rf ${quote(source.into)}`,
    `mkdir -p ${quote(source.into)}`,
    `cd ${quote(source.into)}`,
    "git init -q",
    `git fetch -q --depth 1 ${quote(`${source.github.url}/${source.repo}.git`)} ${quote(ref)}`,
    "git checkout -q FETCH_HEAD",
    "rm -rf .git",
  ].join("\n");
};

const shaPattern = /^[0-9a-f]{40}$/;

/**
 * The commit sha a source's ref points at now, or `undefined` when it can't be
 * worked out (rate limited, offline, no such ref).
 */
const resolveSha = async (
  source: SkillsSource,
  fetchImpl: typeof fetch,
): Promise<string | undefined> => {
  if (shaPattern.test(source.ref)) {
    return source.ref;
  }

  try {
    const res = await fetchImpl(
      `${source.github.apiUrl}/repos/${source.repo}/commits/${encodeURIComponent(source.ref)}`,
      { headers: { accept: "application/vnd.github.sha" } },
    );

    if (!res.ok) {
      return undefined;
    }

    const sha = (await res.text()).trim();

    return shaPattern.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
};

/**
 * What creating a sandbox with skills needs from the running function.
 */
export interface SkillsRuntime {
  /**
   * What the snapshot cache reads: the client's snapshots.
   */
  client: SnapshotCacheClient;

  /**
   * Runs `fn` once per run, such as `(id, fn) => step.run(id, fn)`.
   */
  run: <T>(id: string, fn: () => Promise<T>) => Promise<T>;

  /**
   * Sends an event once per run, such as `step.sendEvent`.
   */
  sendEvent: (
    id: string,
    event: { name: string; data: SkillsBakeRequest },
  ) => Promise<unknown>;

  /**
   * Resolves refs. Default: global `fetch`.
   */
  fetch?: typeof fetch;
}

/**
 * What the bake function is asked to build.
 */
export interface SkillsBakeRequest {
  /**
   * The snapshot's name, which names the build.
   */
  name: string;

  /**
   * The image ref the snapshot starts from, if the definition names one.
   */
  image?: string;
  vcpu: number;
  memoryMb: number;
  sources: {
    repo: string;
    ref: string;
    sha: string;
    into: string;
    url: string;
  }[];
}

type CreateOptions = Parameters<DurableSandboxTools["create"]>[1];

export interface CreateWithSkillsOptions {
  /**
   * The binding's name. Step IDs start with it.
   */
  name: string;
  sources: readonly SkillsSource[];

  /**
   * The create options without skills: a fresh sandbox of the definition.
   */
  fresh: CreateOptions & { vcpu: number; memoryMb: number };
  image?: SandboxImage;
  sandboxes: DurableSandboxTools;
  runtime: SkillsRuntime;

  /**
   * A snapshot of this sandbox to start from, such as the thread's. It holds
   * the skills it was saved with, so no baked snapshot is looked up or asked
   * for; `"boot"` sources are fetched again.
   */
  restoreFrom?: string;
}

/**
 * Creates a sandbox with its skills in place: from the baked snapshot when
 * there is one, else fresh with a boot fetch, asking for the snapshot to be
 * baked when a baked source has none.
 */
export const createWithSkills = async (
  options: CreateWithSkillsOptions,
): Promise<DurableSandbox> => {
  const { name, sources, fresh, runtime } = options;
  const baked = sources.filter((source) => {
    return source.freshness === "bake";
  });
  const stepId = `${name}:skills`;
  let found: { snapshotId: string } | undefined;
  let shas: (string | undefined)[] = [];
  let request: SkillsBakeRequest | undefined;

  if (baked.length > 0 && !options.restoreFrom) {
    shas = await runtime.run(`${stepId}:resolve`, async () => {
      return Promise.all(
        baked.map((source) => {
          return resolveSha(source, runtime.fetch ?? globalThis.fetch);
        }),
      );
    });

    if (shas.every(Boolean)) {
      const entry = await skillsEntry(
        baked,
        shas as string[],
        options.image,
        fresh,
      );
      const cache = snapshotCache(runtime.client, {
        memo: (id, fn) => {
          return runtime.run(id, fn);
        },
      });

      found = await cache.find(entry, { stepId });
      request = {
        name: snapshotName(entry),
        ...(options.image && { image: options.image.ref }),
        vcpu: fresh.vcpu,
        memoryMb: fresh.memoryMb,
        sources: baked.map((source, index) => {
          return {
            repo: source.repo,
            ref: source.ref,
            sha: (shas as string[])[index] as string,
            into: source.into,
            url: source.github.url,
          };
        }),
      };
    }
  }

  const shaOf = new Map(
    baked.map((source, index) => {
      return [source, shas[index]] as const;
    }),
  );

  const snapshotId = options.restoreFrom ?? found?.snapshotId;

  if (snapshotId) {
    const sandbox = await options.sandboxes.create(name, {
      name: fresh.name,
      snapshotId,
    } as CreateOptions);

    await fetchSources(
      sandbox,
      stepId,
      sources.filter((source) => {
        return source.freshness === "boot";
      }),
      (source) => {
        return source.ref;
      },
    );

    return sandbox;
  }

  if (request) {
    // Builds of one snapshot name run one at a time (the function's singleton).
    await runtime.sendEvent(`${stepId}:bake`, {
      name: skillsBakeEvent,
      data: request,
    });
  }

  const sandbox = await options.sandboxes.create(name, fresh);

  await fetchSources(sandbox, stepId, sources, (source) => {
    return shaOf.get(source) ?? source.ref;
  });

  return sandbox;
};

const fetchSources = async (
  sandbox: DurableSandbox,
  stepId: string,
  sources: readonly SkillsSource[],
  refOf: (source: SkillsSource) => string,
): Promise<void> => {
  for (const [index, source] of sources.entries()) {
    await sandbox.commands.run(
      `${stepId}:fetch:${index}`,
      skillsFetchScript(source, refOf(source)),
    );
  }
};

/**
 * The snapshot a set of baked sources, on a base, bakes into. The key tells
 * apart everything but the sha that makes a different sandbox: another image,
 * size, ref or place for the same repository is another snapshot, so one
 * never replaces the other.
 */
const skillsEntry = async (
  baked: readonly SkillsSource[],
  shas: string[],
  image: SandboxImage | undefined,
  size: { vcpu: number; memoryMb: number },
): Promise<SnapshotEntry> => {
  const config = await snapshotKey({
    image: image?.ref ?? "",
    vcpu: String(size.vcpu),
    memoryMb: String(size.memoryMb),
    sources: JSON.stringify(
      baked.map((source) => {
        return [source.repo, source.ref, source.into, source.github.url];
      }),
    ),
  });
  const generation =
    shas.length === 1 ? (shas[0] as string) : (await snapshotKey(shas)).hash;

  return {
    scope: skillsScope,
    key: `${baked.map((source) => source.repo).join("+")}/${config.hash.slice(0, 16)}`,
    generation,
  };
};

const snapshotName = (entry: SnapshotEntry): string => {
  return `${entry.scope}/${entry.key}/${entry.generation}`;
};

/**
 * Checks a bake request as untrusted input and rebuilds from it what the
 * function bakes: sources that pass the same checks as `skills.git()`, pinned
 * to 40-hex shas, and the snapshot entry computed from them. Throws when the
 * request is malformed or its name is not the one its sources bake into.
 */
export const validateBakeRequest = async (
  request: SkillsBakeRequest,
): Promise<{
  sources: SkillsSource[];
  shas: string[];
  entry: SnapshotEntry;
}> => {
  const asked = request.sources;

  if (!Array.isArray(asked) || asked.length === 0) {
    throw new SandboxValidationError("Skills bake request has no sources");
  }

  for (const size of [request.vcpu, request.memoryMb]) {
    if (!Number.isInteger(size) || size <= 0) {
      throw new SandboxValidationError(
        `Skills bake request has an invalid size "${String(size)}"`,
      );
    }
  }

  if (request.image !== undefined && typeof request.image !== "string") {
    throw new SandboxValidationError(
      "Skills bake request has an invalid image",
    );
  }

  const sources = asked.map((item) => {
    if (typeof item?.sha !== "string" || !shaPattern.test(item.sha)) {
      throw new SandboxValidationError(
        `Skills bake request has an invalid sha "${String(item?.sha)}"`,
      );
    }

    if (typeof item.url !== "string" || !/^https?:\/\//.test(item.url)) {
      throw new SandboxValidationError(
        `Skills bake request has an invalid url "${String(item.url)}"`,
      );
    }

    return gitSource(item.repo, {
      ref: item.ref,
      freshness: "bake",
      into: item.into,
      github: { url: item.url },
    });
  });
  const shas = asked.map((item) => {
    return item.sha;
  });
  const entry = await skillsEntry(
    sources,
    shas,
    request.image ? sandboxImage.custom(request.image) : undefined,
    { vcpu: request.vcpu, memoryMb: request.memoryMb },
  );

  if (request.name !== snapshotName(entry)) {
    throw new SandboxValidationError(
      `Skills bake request is named "${String(request.name)}", but its sources bake into "${snapshotName(entry)}"`,
    );
  }

  return { sources, shas, entry };
};

/**
 * Builds a skills snapshot when asked: the function that bakes what a sandbox
 * missed. One build runs per snapshot name; asking again once it exists does
 * nothing.
 */
export const createSkillsBakeFunction = (
  client: Inngest.Any,
): InngestFunction.Any => {
  return client.createFunction(
    {
      id: "agent-skills-bake",
      triggers: [{ event: skillsBakeEvent }],
      singleton: { key: "event.data.name", mode: "skip" },
    },
    async ({ event, step, group, runId }) => {
      const request = event.data as SkillsBakeRequest;
      const { sources, shas, entry } = await validateBakeRequest(request).catch(
        (error: unknown) => {
          throw new NonRetriableError(
            error instanceof Error ? error.message : String(error),
          );
        },
      );
      const cache = snapshotCache(client, {
        memo: (id, fn) => {
          return step.run(id, fn);
        },
      });
      const sandboxGroup = group as unknown as { sandbox: GroupSandbox };

      const snapshot = await cache.ensure(
        entry,
        async (take) => {
          return sandboxGroup.sandbox(
            {
              id: "bake",
              name: `${runId}-bake`,
              vcpu: request.vcpu,
              memoryMb: request.memoryMb,
              ...(request.image && {
                from: sandboxImage.custom(request.image),
              }),
            },
            async (sandbox) => {
              await fetchSources(sandbox, "bake", sources, (source) => {
                return shas[sources.indexOf(source)] as string;
              });

              return take((name, attempt) => {
                return sandbox.snapshot(`save:${attempt}`, { name });
              });
            },
          );
        },
        { stepId: "bake" },
      );

      return { name: snapshot.name, snapshotId: snapshot.snapshotId };
    },
  );
};
