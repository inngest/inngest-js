/**
 * @module
 * Proves baked skills on the fake Sandboxes API. A sandbox with
 * `skills.git()` looks for a snapshot named by the ref's sha. The first run
 * misses: it boots fresh, fetches the skills and asks for a bake. The second
 * run boots from the baked snapshot with no fetch. A new sha bakes a new
 * generation and the old snapshot is deleted.
 */
import { Inngest } from "inngest";
import {
  agent,
  createAgents,
  createKv,
  getThread,
  redisKvAdapter,
  sandbox,
  skills,
} from "inngest/experimental/agents";
import { scenario, script } from "../kit/driver.ts";

const agentId = "skills-bake-agent";
const ref = `agents-e2e/${agentId}`;
const repo = "acme/skills-bake";
const sha1 = "1".repeat(40);
const sha2 = "2".repeat(40);

export const skillsBake = scenario({
  id: "skills-bake",
  owner: "piece-skills-bake",
  needs: { oss: "jack/step-subscribe-clean" },
  sandbox: "fake",
  functions: ({ client, fakes }) => {
    const agents = createAgents(client);
    const box = sandbox({
      id: "skills-box",
      skills: [
        skills.git(repo, {
          ref: "main",
          github: { apiUrl: `${fakes.url}/github` },
        }),
      ],
    });

    agents.agent(
      { id: agentId, sandboxes: { work: { sandbox: box, start: "eager" } } },
      async ({ inbox, control }) => {
        const first = await inbox.next();
        const result = await agent.loop({
          model: script([{ say: "ready" }]),
          prompt: first?.content ?? "",
          tools: {},
          ...control,
        });

        return { text: result.text };
      },
    );

    return agents.functions();
  },
  run: async (ctx) => {
    const client = new Inngest({
      id: "agents-e2e",
      baseUrl: ctx.devUrl,
      isDev: true,
    });
    const kv = createKv({ adapter: redisKvAdapter(ctx.redisUrl) });
    const point = async (sha: string) => {
      await fetch(`${ctx.fakes.url}/github/repos/${repo}/commits/main`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sha }),
      });
    };
    const start = async (name: string) => {
      await getThread(client, ref, `${name}-${Date.now()}`, { kv }).send("go");
    };
    const fetches = () => {
      return ctx.fakes
        .posts({ channel: "sandbox", method: "sandbox.exec" })
        .filter((call) => {
          return String(call.body.command).includes("git fetch");
        });
    };
    // The thread's own snapshots, taken when a run ends, are not the bakes.
    const bakes = () => {
      return ctx.fakes
        .posts({ channel: "sandbox", method: "snapshot.create" })
        .filter((call) => {
          return String(call.body.name).startsWith("skills/");
        });
    };
    const baked = (sha: string) => {
      return bakes().some((call) => {
        return String(call.body.name).endsWith(`/${sha}`);
      });
    };

    await point(sha1);
    await start("miss");

    await ctx.eventually(
      "the first sandbox boots with a fetch of the sha and the snapshot is baked",
      async () => {
        return { fetches: fetches().length, baked: baked(sha1) };
      },
      (seen) => {
        return seen.fetches === 2 && seen.baked;
      },
    );
    ctx.check(
      "every fetch is pinned to the sha",
      fetches().every((call) => {
        return String(call.body.command).includes(sha1);
      }),
    );

    await start("hit");
    await ctx.expect
      .posts({ channel: "sandbox", method: "sandbox.create" })
      .toInclude({
        snapshotId: bakes()[0]?.body.id,
      });
    ctx.check("one snapshot is baked", bakes().length === 1);
    ctx.check("the second sandbox fetches nothing", fetches().length === 2);

    await point(sha2);
    await start("moved");
    await ctx.eventually(
      "the new sha bakes a new generation",
      async () => {
        return baked(sha2);
      },
      (found) => {
        return found;
      },
    );
    await ctx.expect
      .posts({ channel: "sandbox", method: "snapshot.delete" })
      .toHaveCount(1);
  },
});
