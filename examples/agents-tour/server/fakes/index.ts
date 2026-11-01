/**
 * @module
 * The fakes the lessons talk to: a Slack and a GitHub, in the tour server's
 * process, with their data in memory. They send events to the Dev Server as
 * the real services would, and tell the browser when they change.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { Inngest } from "inngest";
import { openDb } from "./db.ts";
import { setupGithub } from "./github.ts";
import { createRouter } from "./http.ts";
import { setupSlack } from "./slack.ts";

export interface FakesOptions {
  // The Dev Server the fakes send their events and signals to.
  devServerUrl: string;
  // Called with `slack` or `github` when that fake's data changed.
  changed: (topic: "slack" | "github") => void;
}

export const createFakes = (options: FakesOptions) => {
  const db = openDb();
  const router = createRouter();
  const inngest = new Inngest({
    id: "tour-fakes",
    isDev: true,
    baseUrl: options.devServerUrl,
  });
  const slack = setupSlack({
    db,
    router,
    inngest,
    changed: () => {
      options.changed("slack");
    },
  });
  const github = setupGithub({
    db,
    router,
    inngest,
    changed: () => {
      options.changed("github");
    },
  });

  router.route("POST", "/api/event", async ({ body }) => {
    const name = String(body.name ?? "").trim();

    if (!name) {
      return { error: "An event needs a name" };
    }

    await inngest.send({
      name,
      data: (body.data ?? {}) as Record<string, unknown>,
    });

    return { ok: true };
  });

  return {
    /**
     * Answers the fakes' own routes; false for any other request.
     */
    handle: (req: IncomingMessage, res: ServerResponse) => {
      return router.dispatch(req, res);
    },
    say: slack.say,
    reset: () => {
      slack.reset();
      github.reset();
    },
  };
};

export type Fakes = ReturnType<typeof createFakes>;
