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
 * the sha it started with however often the ref moves. A thread's sandbox is
 * restored from the thread's own snapshot, which holds the skills it was saved
 * with: a baked source is not re-resolved on a restore, so a thread keeps its
 * skills until its snapshot expires; `"boot"` sources are fetched again.
 */

import type { Inngest } from "../Inngest.ts";
import type { InngestFunction } from "../InngestFunction.ts";
import { NonRetriableError } from "../NonRetriableError.ts";
import { defaultSandboxSize, type GroupSandbox } from "../sandbox/group.ts";
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
import { eventType, staticSchema } from "../triggers/triggers.ts";

/**
 * The event that asks for a skills snapshot to be baked.
 */
export const skillsBake = eventType("agent/skills.bake", {
  schema: staticSchema<SkillsBakeRequest>(),
});

/**
 * The name of the skills bake event.
 */
export const skillsBakeEvent = skillsBake.name;

/**
 * The scope of every skills snapshot, `skills/<repos>/<config>/<sha>`.
 */
export const skillsScope = "skills";

const defaultGithub = {
  url: "https://github.com",
  apiUrl: "https://api.github.com",
};

/**
 * Options of `skills.git()`: which ref to use, when to fetch it and where it
 * lands in the sandbox.
 */
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
  /**
   * Marks the value as made by `skills.git()`.
   */
  readonly kind: "inngest/skills.git";

  /**
   * `owner/name` on GitHub.
   */
  readonly repo: string;

  /**
   * The branch, tag or commit used.
   */
  readonly ref: string;

  /**
   * When the skills are fetched: baked into a snapshot, or at every boot.
   */
  readonly freshness: "bake" | "boot";

  /**
   * The directory in the sandbox the skills land in.
   */
  readonly into: string;

  /**
   * The GitHub host's web and API URLs.
   */
  readonly github: { url: string; apiUrl: string };
}

const skillsRoot = "/skills";

const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const gitSource = (
  /**
   * `owner/name`.
   */
  repo: string,

  /**
   * Ref, freshness and where the skills land.
   */
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
    event: ReturnType<typeof skillsBake.create>,
  ) => Promise<unknown>;

  /**
   * Resolves refs. Default: global `fetch`.
   */
  fetch?: typeof fetch;

  /**
   * The ref of the agent that runs, `appId/functionId`, sent with bake
   * requests.
   */
  agent: string;
}

/**
 * What the bake function is asked to build.
 */
export type SkillsBakeRequest = {
  /**
   * The snapshot's name, which names the build.
   */
  name: string;

  /**
   * The ref of the agent whose sandbox asks, `appId/functionId`. The request
   * is checked against what that agent's definitions use.
   */
  agent: string;

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
};

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

  /**
   * Called as soon as the sandbox exists, before its skills are fetched, so
   * the caller can arrange its cleanup: a fetch that fails or a run that ends
   * during it would otherwise leave the sandbox running.
   */
  onCreated?: (sandbox: DurableSandbox) => void;
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
        agent: runtime.agent,
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

    options.onCreated?.(sandbox);

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
    await runtime.sendEvent(`${stepId}:bake`, skillsBake.create(request));
  }

  const sandbox = await options.sandboxes.create(name, fresh);

  options.onCreated?.(sandbox);

  await fetchSources(sandbox, stepId, sources, (source) => {
    return shaOf.get(source) ?? source.ref;
  });

  return sandbox;
};

/**
 * Fetches again the `"boot"` sources of a sandbox that was resumed from a
 * pause: it has every other source already.
 */
export const fetchBootSkills = (
  /**
   * The sandbox's name in the agent's `sandboxes`.
   */
  name: string,
  sandbox: DurableSandbox,
  sources: readonly SkillsSource[],
): Promise<void> => {
  return fetchSources(
    sandbox,
    `${name}:skills`,
    sources.filter((source) => {
      return source.freshness === "boot";
    }),
    (source) => {
      return source.ref;
    },
  );
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
 * What one agent's bake requests may ask for, read from its sandbox
 * definitions, so an event can't choose a repository, host, image or size the
 * agent doesn't use.
 */
export interface AgentBakeAllowance {
  /**
   * Whether the agent's `sandboxes` is a function, so its definitions can't be
   * read ahead. Its requests may then name any host and image, up to the size
   * ceiling: a forged event that names this agent gets the same.
   */
  dynamic: boolean;

  /**
   * The `host|owner/name` of every baked source of the agent's definitions.
   */
  repos: Set<string>;

  /**
   * The largest size the agent's definitions use, by image ref (`""` for the
   * default image).
   */
  sizes: Map<string, { vcpu: number; memoryMb: number }>;
}

/**
 * What bake requests may ask for, by the ref of the agent that asks.
 */
export type BakeAllowance = Map<string, AgentBakeAllowance>;

/**
 * The most vCPUs and memory a bake may ask for, whatever the definitions say.
 */
export const maxBakeSize = Object.freeze({ vcpu: 16, memoryMb: 32_768 });

const trimUrl = (url: string): string => {
  return url.replace(/\/+$/, "");
};

const repoKey = (url: string, repo: string): string => {
  return `${trimUrl(url)}|${repo}`;
};

const allowanceOf = (
  allowance: BakeAllowance,
  agent: string,
): AgentBakeAllowance => {
  let found = allowance.get(agent);

  if (!found) {
    found = { dynamic: false, repos: new Set(), sizes: new Map() };
    allowance.set(agent, found);
  }

  return found;
};

/**
 * The allowance of every agent of a client. Agents made on one client by any
 * number of `createAgents()` calls share it, as they share the bake function.
 */
const allowances = new WeakMap<object, BakeAllowance>();

export const bakeAllowanceOf = (client: object): BakeAllowance => {
  let found = allowances.get(client);

  if (!found) {
    found = new Map();
    allowances.set(client, found);
  }

  return found;
};

/**
 * Notes the repositories, image and size of a definition's baked skills as
 * what an agent's requests may use.
 */
export const allowBake = (
  allowance: BakeAllowance,
  /** The agent's ref, `appId/functionId`. */
  agent: string,
  definition: {
    image?: SandboxImage;
    vcpu?: number;
    memoryMb?: number;
    skills?: readonly SkillsSource[];
  },
): void => {
  const baked = (definition.skills ?? []).filter((source) => {
    return source.freshness === "bake";
  });

  if (baked.length === 0) {
    return;
  }

  const allowed = allowanceOf(allowance, agent);
  const image = definition.image?.ref ?? "";
  const size = allowed.sizes.get(image);
  const vcpu = definition.vcpu ?? defaultSandboxSize.vcpu;
  const memoryMb = definition.memoryMb ?? defaultSandboxSize.memoryMb;

  allowed.sizes.set(image, {
    vcpu: Math.max(size?.vcpu ?? 0, vcpu),
    memoryMb: Math.max(size?.memoryMb ?? 0, memoryMb),
  });

  for (const source of baked) {
    allowed.repos.add(repoKey(source.github.url, source.repo));
  }
};

/**
 * Notes that an agent's definitions can't be read ahead.
 */
export const allowDynamicBake = (
  allowance: BakeAllowance,
  /** The agent's ref, `appId/functionId`. */
  agent: string,
): void => {
  allowanceOf(allowance, agent).dynamic = true;
};

/**
 * Checks a bake request as untrusted input and rebuilds from it what the
 * function bakes: sources that pass the same checks as `skills.git()`, pinned
 * to 40-hex shas, and the snapshot entry computed from them. Throws when the
 * request is malformed, asks for a repository, image or size its agent doesn't
 * use, or its name is not the one its sources bake into.
 */
export const validateBakeRequest = async (
  request: SkillsBakeRequest,
  allowance: BakeAllowance,
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

  if (
    request.vcpu > maxBakeSize.vcpu ||
    request.memoryMb > maxBakeSize.memoryMb
  ) {
    throw new SandboxValidationError(
      `Skills bake request asks for more than ${maxBakeSize.vcpu} vCPUs or ${maxBakeSize.memoryMb} MB`,
    );
  }

  const allowed =
    typeof request.agent === "string"
      ? allowance.get(request.agent)
      : undefined;

  if (!allowed) {
    throw new SandboxValidationError(
      `Skills bake request names the agent "${String(request.agent)}", which bakes no skills`,
    );
  }

  if (request.image !== undefined && typeof request.image !== "string") {
    throw new SandboxValidationError(
      "Skills bake request has an invalid image",
    );
  }

  const size = allowed.sizes.get(request.image ?? "");

  if (!allowed.dynamic) {
    if (!size) {
      throw new SandboxValidationError(
        `Skills bake request names image "${request.image ?? "the default image"}", which no sandbox of "${request.agent}" bakes skills into`,
      );
    }

    if (request.vcpu > size.vcpu || request.memoryMb > size.memoryMb) {
      throw new SandboxValidationError(
        `Skills bake request asks for more than "${request.agent}" uses on that image: ${size.vcpu} vCPUs, ${size.memoryMb} MB`,
      );
    }
  }

  const sources = asked.map((item) => {
    if (typeof item?.sha !== "string" || !shaPattern.test(item.sha)) {
      throw new SandboxValidationError(
        `Skills bake request has an invalid sha "${String(item?.sha)}"`,
      );
    }

    if (typeof item.url !== "string") {
      throw new SandboxValidationError(
        `Skills bake request has an invalid url "${String(item.url)}"`,
      );
    }

    if (
      allowed.dynamic
        ? !/^https:\/\//.test(item.url)
        : !allowed.repos.has(repoKey(item.url, String(item.repo)))
    ) {
      throw new SandboxValidationError(
        `Skills bake request has the source "${item.url}/${String(item.repo)}", which no sandbox of "${request.agent}" bakes skills from`,
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
 *
 * The request is validated first thing in the run, not in the trigger: the
 * singleton key is the name the event gives, so a forged event with a real name
 * can hold the slot for the moment it takes to be refused, and the real request
 * is skipped then. The run is refused at once, so the slot frees at once.
 */
export const createSkillsBakeFunction = (
  client: Inngest.Any,
  /** What each agent's requests may use, filled in as agents are made. */
  allowance: BakeAllowance,
): InngestFunction.Any => {
  return client.createFunction(
    {
      id: "agent-skills-bake",
      triggers: [skillsBake],
      singleton: { key: "event.data.name", mode: "skip" },
    },
    async ({ event, step, group, runId }) => {
      const request = event.data as SkillsBakeRequest;
      const { sources, shas, entry } = await validateBakeRequest(
        request,
        allowance,
      ).catch((error: unknown) => {
        throw new NonRetriableError(
          error instanceof Error ? error.message : String(error),
        );
      });
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
