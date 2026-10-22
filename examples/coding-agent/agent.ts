import { Inngest } from "inngest";
import { agent, repo, sandboxMiddleware, tool } from "inngest/experimental";
import { z } from "zod";

import { claude } from "./model.ts";

export const inngest = new Inngest({
  id: "coding-agent",
  middleware: [sandboxMiddleware()],
});

const github = process.env.GITHUB_API_URL ?? "https://api.github.com";

export const coder = inngest.createFunction(
  { id: "coder", triggers: [{ event: "agent/task" }] },
  async ({ event, step, runId }) => {
    const { repo: name, ref = "main", task } = event.data;

    await using sandbox = await step.sandbox.create("coder", {
      name: `coder-${runId}`,
      vcpu: 2,
      memoryMb: 2048,
    });

    const checkout = await repo(sandbox, {
      repo: name,
      ref,
      token: process.env.GITHUB_TOKEN,
    });

    const openPullRequest = tool.step({
      description: "Open a pull request for a branch that has been pushed",
      input: z.object({
        branch: z.string(),
        title: z.string(),
        body: z.string(),
      }),
      run: async ({ branch, title, body }) => {
        const response = await fetch(`${github}/repos/${name}/pulls`, {
          method: "POST",
          headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}` },
          body: JSON.stringify({ title, body, head: branch, base: ref }),
        });
        const pull = (await response.json()) as { html_url: string };

        return { url: pull.html_url };
      },
    });

    const { text, stopped, turns } = await agent.loop({
      model: claude,
      system: `You are a careful engineer. Work on a new branch named agent/${runId}. Run the code to check it works, commit, push the branch, then open a pull request.`,
      prompt: `The repository is in ${checkout.path}. Task: ${task}`,
      tools: { ...checkout.tools, openPullRequest },
    });

    return { text, stopped, turns };
  },
);
