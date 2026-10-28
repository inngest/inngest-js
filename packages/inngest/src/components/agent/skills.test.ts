/**
 * @module
 * Tests for skills sources and how a sandbox with skills is created: from a
 * baked snapshot when there is one, else with a boot fetch and a request to
 * bake.
 */
import { describe, expect, test, vi } from "vitest";
import type { DurableSandbox, DurableSandboxTools } from "../sandbox/types.ts";
import { sandbox } from "./defs.ts";
import {
  createWithSkills,
  type SkillsBakeRequest,
  type SkillsRuntime,
  skills,
  skillsBakeEvent,
  skillsFetchScript,
  validateBakeRequest,
} from "./skills.ts";

const sha1 = "a".repeat(40);
const sha2 = "b".repeat(40);

const setup = (options: { sha?: string | null; snapshots?: string[] } = {}) => {
  const commands: string[] = [];
  const created: unknown[] = [];
  const events: { name: string; data: SkillsBakeRequest }[] = [];
  const snapshots = (options.snapshots ?? []).map((name, index) => {
    return {
      id: `snap-${index}`,
      name,
      status: "READY",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    };
  });
  const sandboxes = {
    create: async (_id: unknown, createOptions: unknown) => {
      created.push(createOptions);

      return {
        commands: {
          run: async (_stepId: unknown, command: unknown) => {
            commands.push(String(command));

            return { stdout: "", stderr: "", exitCode: 0 };
          },
        },
      } as unknown as DurableSandbox;
    },
  } as unknown as DurableSandboxTools;
  const fetchImpl = vi.fn(async () => {
    return options.sha === null
      ? new Response("nope", { status: 403 })
      : new Response(options.sha ?? sha1);
  });
  const runtime: SkillsRuntime = {
    client: {
      sandboxes: {
        snapshots: {
          list: async () => {
            return { items: snapshots, page: { hasMore: false } };
          },
          get: async (id: string) => {
            return snapshots.find((row) => row.id === id) ?? null;
          },
        },
      },
    } as unknown as SkillsRuntime["client"],
    run: (_id, fn) => fn(),
    sendEvent: async (_id, event) => {
      events.push(event);
    },
    fetch: fetchImpl as unknown as typeof fetch,
  };
  const create = (
    sources: Parameters<typeof createWithSkills>[0]["sources"],
  ) => {
    return createWithSkills({
      name: "work",
      sources,
      fresh: { name: "run-work", vcpu: 2, memoryMb: 2048 },
      sandboxes,
      runtime,
    });
  };

  return { commands, created, events, create, fetchImpl };
};

describe("skills.git()", () => {
  test("defaults to bake, HEAD and /skills/<name>", () => {
    expect(skills.git("inngest/inngest-skills")).toMatchObject({
      kind: "inngest/skills.git",
      freshness: "bake",
      ref: "HEAD",
      into: "/skills/inngest/inngest-skills",
    });
  });

  test("rejects bad input", () => {
    expect(() => skills.git("nope")).toThrow("owner/name");
    expect(() => skills.git("a/b", { freshness: "x" as "bake" })).toThrow(
      "freshness",
    );
    expect(() => skills.git("a/b", { into: "rel" })).toThrow("under /skills/");
    expect(() => skills.git("a/b", { into: "/etc/ssh" })).toThrow(
      "under /skills/",
    );
    expect(() => skills.git("a/b", { into: "/skills" })).toThrow(
      "under /skills/",
    );
    expect(() => skills.git("a/b", { into: "/skills/../etc" })).toThrow(
      "under /skills/",
    );
    expect(() => skills.git("a/b", { into: "/skills//x" })).toThrow(
      "under /skills/",
    );
  });

  test("two sources can't share a place", () => {
    expect(() => {
      return sandbox({
        id: "x",
        skills: [
          skills.git("a/b", { into: "/skills/x" }),
          skills.git("c/d", { into: "/skills/x/y" }),
        ],
      });
    }).toThrow("overlap");
  });

  test("a baked source can't go with environment or secrets", () => {
    const source = skills.git("a/b");

    expect(() => {
      return sandbox({ id: "x", skills: [source], secrets: ["K"] });
    }).toThrow("bakes skills");
    expect(
      sandbox({
        id: "x",
        skills: [skills.git("a/b", { freshness: "boot" })],
        secrets: ["K"],
      }).id,
    ).toBe("x");
  });

  test("the fetch script quotes and pins the ref", () => {
    const script = skillsFetchScript(
      skills.git("a/b", { into: "/skills/it's" }),
      sha1,
    );

    expect(script).toContain(`'/skills/it'\\''s'`);
    expect(script).toContain(`'https://github.com/a/b.git' '${sha1}'`);
  });
});

describe("createWithSkills()", () => {
  test("a miss boots fresh, fetches the sha and asks for a bake once", async () => {
    const { create, created, commands, events } = setup();

    await create([skills.git("a/b", { ref: "main" })]);

    expect(created).toEqual([{ name: "run-work", vcpu: 2, memoryMb: 2048 }]);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain(sha1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      name: skillsBakeEvent,
      data: { sources: [{ repo: "a/b", ref: "main", sha: sha1 }] },
    });
  });

  test("a hit boots from the snapshot and fetches nothing", async () => {
    const miss = setup();
    await miss.create([skills.git("a/b", { ref: "main" })]);
    const name = miss.events[0]?.data.name as string;

    const { create, created, commands, events } = setup({ snapshots: [name] });
    await create([skills.git("a/b", { ref: "main" })]);

    expect(created).toEqual([{ name: "run-work", snapshotId: "snap-0" }]);
    expect(commands).toEqual([]);
    expect(events).toEqual([]);
  });

  test("a new sha is another generation", async () => {
    const first = setup();
    await first.create([skills.git("a/b")]);
    const second = setup({
      sha: sha2,
      snapshots: [first.events[0]?.data.name as string],
    });
    await second.create([skills.git("a/b")]);

    expect(second.created[0]).toMatchObject({ vcpu: 2 });
    expect(second.events[0]?.data.sources[0]?.sha).toBe(sha2);
  });

  test("boot freshness always fetches the ref and never bakes", async () => {
    const { create, commands, events, fetchImpl } = setup();

    await create([skills.git("a/b", { ref: "main", freshness: "boot" })]);

    expect(commands[0]).toContain("'main'");
    expect(events).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("an unresolvable ref falls back to a boot fetch with no bake", async () => {
    const { create, commands, events } = setup({ sha: null });

    await create([skills.git("a/b", { ref: "main" })]);

    expect(commands[0]).toContain("'main'");
    expect(events).toEqual([]);
  });

  test("a hit still fetches boot sources", async () => {
    const miss = setup();
    const baked = skills.git("a/b", { into: "/skills/a" });
    await miss.create([baked]);

    const { create, commands } = setup({
      snapshots: [miss.events[0]?.data.name as string],
    });
    await create([baked, skills.git("c/d", { freshness: "boot", ref: "dev" })]);

    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("c/d");
  });
});

describe("validateBakeRequest()", () => {
  const honest = async () => {
    const { events, create } = setup();
    await create([skills.git("a/b", { ref: "main" })]);

    return events[0]?.data as SkillsBakeRequest;
  };

  test("accepts the request createWithSkills sends", async () => {
    const request = await honest();
    const checked = await validateBakeRequest(request);

    expect(checked.shas).toEqual([sha1]);
    expect(checked.sources[0]).toMatchObject({ repo: "a/b", ref: "main" });
  });

  test("rejects forged payloads", async () => {
    const request = await honest();
    const source = request.sources[0] as SkillsBakeRequest["sources"][number];
    const forge = (patch: Partial<typeof source>, top = {}) => {
      return validateBakeRequest({
        ...request,
        ...top,
        sources: [{ ...source, ...patch }],
      });
    };

    await expect(forge({ sha: "main" })).rejects.toThrow("invalid sha");
    await expect(forge({ sha: "--upload-pack=x" })).rejects.toThrow(
      "invalid sha",
    );
    await expect(forge({ repo: "../etc" })).rejects.toThrow("owner/name");
    await expect(forge({ into: "/etc/ssh" })).rejects.toThrow("under /skills/");
    await expect(forge({ url: "file:///etc" })).rejects.toThrow("invalid url");
    await expect(forge({ ref: "-x" })).rejects.toThrow("invalid ref");
    await expect(
      validateBakeRequest({ ...request, sources: [] }),
    ).rejects.toThrow("no sources");
  });

  test("rejects a name that is not the one the sources bake into", async () => {
    const request = await honest();

    await expect(
      validateBakeRequest({ ...request, name: "skills/other/x/y" }),
    ).rejects.toThrow("bake into");
    await expect(
      validateBakeRequest({
        ...request,
        sources: [
          {
            ...(request.sources[0] as SkillsBakeRequest["sources"][number]),
            sha: sha2,
          },
        ],
      }),
    ).rejects.toThrow("bake into");
  });
});
