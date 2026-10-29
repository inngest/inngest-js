/**
 * @module
 * Cancelling around `agent.invoke()`. A callee that is cancelled makes the
 * call throw an `AgentCancelledError` instead of handing the caller the
 * executor's finish event. A caller that is cancelled cancels the agent it
 * invoked, and that agent cancels the plain function it invoked in turn.
 */
import {
  AgentCancelledError,
  agent,
  agentInvokeCancelOn,
  createAgents,
} from "inngest/experimental/agents";
import { scenario } from "../kit/driver.ts";

const app = "agents-e2e";

/**
 * The status of the newest run of a function, by its slug.
 */
const statusOf = async (devUrl: string, slug: string) => {
  const res = await fetch(`${devUrl}/v0/gql`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: `query { runs(filter: { from: "2020-01-01T00:00:00Z" }, orderBy: [{ field: QUEUED_AT, direction: DESC }], first: 50) { edges { node { status function { slug } } } } }`,
    }),
  });
  const json = (await res.json()) as {
    data?: {
      runs: {
        edges: { node: { status: string; function: { slug: string } } }[];
      };
    };
  };

  return json.data?.runs.edges.find((edge) => {
    return edge.node.function.slug === slug;
  })?.node.status;
};

export const invokeCancel = scenario({
  id: "invoke-cancel",
  owner: "agents-invoke-cancel",
  functions: ({ client, event }) => {
    const agents = createAgents(client);

    agents.agent(
      { id: "ic-agent-child", cancelOn: [agentInvokeCancelOn] },
      async ({ inbox, thread }) => {
        await inbox.next();
        await agent.invoke(`${app}/ic-grandchild`, {
          key: thread.key,
        });
        await inbox.next();
      },
    );

    // A run that nothing invoked, which another run's cancellation leaves alone.
    agents.agent(
      {
        id: "ic-bystander",
        on: {
          event: event("bystander"),
          thread: "event.data.key",
        },
      },
      async ({ inbox }) => {
        await inbox.next();
        await inbox.next();
      },
    );

    return [
      ...agents.functions(),
      // A caller that survives its callee being cancelled.
      client.createFunction(
        { id: "ic-caller", triggers: [{ event: event("call") }] },
        async ({ step, event: trigger }) => {
          let outcome: Record<string, unknown> = { returned: true };

          try {
            await agent.invoke(`${app}/ic-plain-child`, {
              key: trigger.data.key,
            });
          } catch (error) {
            outcome = {
              returned: false,
              cancelled: error instanceof AgentCancelledError,
              name: (error as Error).name,
              runId: (error as AgentCancelledError).runId,
            };
          }

          await step.run("after", () => {
            return "after";
          });

          return outcome;
        },
      ),
      client.createFunction(
        {
          id: "ic-plain-child",
          triggers: [],
          cancelOn: [{ event: event("cancel-child"), match: "data.key" }],
        },
        async ({ step }) => {
          await step.waitForEvent("wait", {
            event: event("never"),
            timeout: "1h",
          });
        },
      ),
      // A caller that is cancelled while its callee runs.
      client.createFunction(
        {
          id: "ic-parent",
          triggers: [{ event: event("parent") }],
          cancelOn: [{ event: event("cancel-parent"), match: "data.key" }],
        },
        async ({ event: trigger }) => {
          return agent.invoke(`${app}/ic-agent-child`, {
            agent: `${app}/ic-agent-child`,
            thread: trigger.data.key,
            text: "go",
          });
        },
      ),
      client.createFunction(
        {
          id: "ic-grandchild",
          triggers: [],
          cancelOn: [agentInvokeCancelOn],
        },
        async ({ step }) => {
          await step.waitForEvent("wait", {
            event: event("never"),
            timeout: "1h",
          });
        },
      ),
    ];
  },
  run: async (ctx) => {
    const key = `k${Date.now()}`;

    // The callee is cancelled: the caller gets an error it can catch.
    const call = await ctx.send("call", { key }, { startsRun: true });
    await new Promise((resolve) => {
      setTimeout(resolve, 3000);
    });
    await ctx.send("cancel-child", { key });

    // The output can trail the status for a moment.
    const caller = await ctx.until(
      () => {
        return ctx.finished(call);
      },
      (run) => {
        return run.output !== null;
      },
    );

    ctx.expect.run(caller).toComplete();
    ctx.expect.run(caller).toHaveSteps("after");
    ctx.check(
      "a cancelled callee throws AgentCancelledError",
      JSON.stringify(caller.output).includes('"cancelled":true') &&
        JSON.stringify(caller.output).includes('"name":"AgentCancelledError"'),
      JSON.stringify(caller.output),
    );

    // The caller is cancelled: the agent and the function below it follow.
    const parent = await ctx.send("parent", { key }, { startsRun: true });
    await ctx.until(
      () => {
        return statusOf(ctx.devUrl, `${app}-ic-grandchild`);
      },
      (status) => {
        return status === "RUNNING";
      },
    );

    await ctx.send("bystander", { key });
    await ctx.until(
      () => {
        return statusOf(ctx.devUrl, `${app}-ic-bystander`);
      },
      (status) => {
        return status === "RUNNING";
      },
    );

    await ctx.send("cancel-parent", { key });
    await ctx.finished(parent);

    for (const [name, slug] of [
      ["the invoked agent", `${app}-ic-agent-child`],
      ["the function it invoked", `${app}-ic-grandchild`],
    ] as const) {
      const status = await ctx.until(
        () => {
          return statusOf(ctx.devUrl, slug);
        },
        (found) => {
          return found === "CANCELLED";
        },
      );

      ctx.check(
        `${name} was cancelled with the caller`,
        status === "CANCELLED",
        status,
      );
    }

    const bystander = await statusOf(ctx.devUrl, `${app}-ic-bystander`);

    ctx.check(
      "a run nothing invoked is not cancelled with it",
      bystander === "RUNNING",
      bystander,
    );
  },
});
