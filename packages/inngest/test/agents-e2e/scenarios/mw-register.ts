/**
 * @module
 * Serving through the client's middleware `functions` hook: the app lists
 * only the two agent functions, and the cleanup function of each agent and the
 * function both agents share reach the Dev Server because the agents
 * registered them on the client. Registering the shared function twice leaves
 * one.
 */

import { createDefer, registerFunctions } from "inngest/experimental";
import { scenario } from "../kit/driver.ts";

const registeredIds = [
  "mw-register-a",
  "mw-register-a-cleanup",
  "mw-register-shared",
  "mw-register-b",
  "mw-register-b-cleanup",
];

export const mwRegister = scenario({
  id: "mw-register",
  owner: "agents-mw-register",
  functions: ({ client, event }) => {
    const shared = createDefer(
      client,
      { id: "mw-register-shared" },
      async () => {
        return;
      },
    );
    const agent = (name: string) => {
      const cleanup = createDefer(
        client,
        { id: `mw-register-${name}-cleanup` },
        async () => {
          return;
        },
      );
      const fn = client.createFunction(
        { id: `mw-register-${name}`, triggers: [{ event: event(name) }] },
        async () => {
          return name;
        },
      );

      registerFunctions(client, [cleanup, shared]);

      return fn;
    };

    return [agent("a"), agent("b")];
  },
  run: async (ctx) => {
    const served = async () => {
      const res = await fetch(`${ctx.devUrl}/v0/gql`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "{ functions { slug } }" }),
      });
      const body = (await res.json()) as {
        data?: { functions: { slug: string }[] };
      };

      return (body.data?.functions ?? [])
        .map((fn) => {
          return fn.slug;
        })
        .filter((slug) => {
          return slug.includes("mw-register");
        });
    };

    const slugs = await ctx.eventually(
      "the app serves both agents, both cleanups and the shared function once",
      served,
      (found) => {
        return found.length >= registeredIds.length;
      },
    );

    ctx.check(
      "exactly the expected functions",
      slugs.length === registeredIds.length &&
        registeredIds.every((id) => {
          return slugs.some((slug) => {
            return slug.endsWith(id);
          });
        }),
      slugs,
    );

    const run = await ctx.finished(await ctx.send("a"));
    ctx.expect.run(run).toComplete();
    ctx.expect.run(run).toOutput("a");
  },
});
