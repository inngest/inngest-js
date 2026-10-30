/**
 * @module
 * Per-user OAuth for `tool.mcp()` against a fake OAuth MCP server on
 * localhost, with the real Redis behind the encrypted token store:
 * a user with no token gets a link, the "app's callback" completes the
 * exchange and sends `agent/mcp.authorized`, the waiting run continues and the
 * call succeeds, and a later call after the access token expired refreshes on
 * the host. No access token, refresh token or code appears in any output.
 */
import {
  completeMcpAuthorization,
  kvOAuthStore,
  secret,
  tool,
  waitForMcpAuthorization,
} from "inngest/experimental";
import { agent } from "inngest/experimental/agents";
import { fakeMcpServer } from "inngest/experimental/agents/testing";
import { scenario, script } from "../kit/driver.ts";

process.env.E2E_MCP_OAUTH_KEY = "e2e-mcp-oauth-encryption-key";

const redirectUri = "https://app.example.test/oauth/hex/callback";

let started: ReturnType<typeof fakeMcpServer> | undefined;

const server = () => {
  started ??= fakeMcpServer({
    oauth: { accessTokenTtl: 2 },
    tools: {
      create_thread: {
        description: "Starts a thread",
        inputSchema: {
          type: "object",
          properties: { prompt: { type: "string" } },
        },
        run: (args) => {
          return { id: "t-1", prompt: args.prompt };
        },
      },
      get_thread: {
        annotations: { readOnlyHint: true },
        run: () => {
          return { id: "t-1", status: "DONE" };
        },
      },
    },
  });

  return started;
};

export const toolMcpOauth = scenario({
  id: "tool-mcp-oauth",
  owner: "agents-mcp-oauth",
  needs: { oss: "jack/step-subscribe-clean" },
  functions: ({ client, event }) => {
    const store = kvOAuthStore({ encryptionKey: secret("E2E_MCP_OAUTH_KEY") });

    return [
      client.createFunction(
        { id: "mcp-oauth-asker", triggers: [{ event: event("ask") }] },
        async ({ event: trigger, step }) => {
          const fake = await server();
          const hex = tool.mcp({
            url: fake.url,
            auth: {
              oauth: {
                user: trigger.data.user,
                redirectUri,
                store,
                onNeedsAuthorization: async (info) => {
                  await client.send({
                    name: event("link"),
                    data: { url: info.authorizeUrl },
                  });
                },
              },
            },
          });
          const call = (name: string, input: Record<string, unknown>) => {
            return agent.loop({
              model: script([{ call: { name, input } }, { say: "done" }]),
              prompt: "go",
              tools: { hex },
            });
          };

          const first = await call("hex_connect", {});
          const link = first.toolCalls[0]?.isError === true;
          const authorized = await waitForMcpAuthorization({
            user: trigger.data.user,
            server: "hex",
            timeout: "1m",
          });
          const second = await call("hex_create_thread", { prompt: "hi" });

          // Past the 2s lifetime, so this one refreshes.
          await step.sleep("let-token-expire", "3s");

          const third = await call("hex_get_thread", {});
          const text = JSON.stringify([first, second, third]);
          const grants = fake.oauthCalls
            .filter((item) => {
              return item.path === "/oauth/token";
            })
            .map((item) => {
              return new URLSearchParams(item.body).get("grant_type");
            });

          return {
            link,
            authorized: authorized?.data.user ?? null,
            secondOk: second.toolCalls[0]?.isError === false,
            thirdOk: third.toolCalls[0]?.isError === false,
            grants: grants[0],
            refreshed: grants.includes("refresh_token"),
            leaked: /access-\d|refresh-\d|code-\d/.test(text),
          };
        },
      ),
      // The user opens the link and the app's callback route runs.
      client.createFunction(
        { id: "mcp-oauth-user", triggers: [{ event: event("link") }] },
        async ({ event: trigger, step }) => {
          const fake = await server();

          // Let the asker reach its wait first.
          await step.sleep("let-asker-wait", "8s");

          await step.run("callback", async () => {
            const callback = new URL(await fake.approve(trigger.data.url));

            await completeMcpAuthorization({
              store,
              code: callback.searchParams.get("code") ?? "",
              state: callback.searchParams.get("state") ?? "",
              send: (authorized) => {
                return client.send(authorized);
              },
            });
          });
        },
      ),
    ];
  },
  run: async (ctx) => {
    const run = await ctx.finished(
      await ctx.send("ask", { user: "U-e2e" }, { startsRun: true }),
    );

    ctx.expect.run(run).toComplete();
    ctx.expect.run(run).toOutput({
      link: true,
      authorized: "U-e2e",
      secondOk: true,
      thirdOk: true,
      grants: "authorization_code",
      refreshed: true,
      leaked: false,
    });
  },
});
