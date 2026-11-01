/**
 * @module
 * Panels and fakes: the fake Slack and GitHub and the routes the play pane's
 * buttons call. The fakes answer their own REST routes, tell the browser
 * when they change, and are emptied whenever a page is opened or run.
 */
import type { Area, AreaFactory } from "../area.ts";
import { createFakes } from "../fakes/index.ts";

export const area: AreaFactory = (ctx) => {
  const fakes = createFakes({
    devServerUrl: ctx.devServer.url,
    changed: (topic) => {
      ctx.hub.broadcast({ type: "fakes", topic });
    },
  });

  const result: Area = {
    name: "panels",
    raw: (req, res) => {
      return fakes.handle(req, res);
    },
    reset: () => {
      fakes.reset();
    },
    send: async (start) => {
      if (!("slack" in start)) {
        return false;
      }

      await fakes.say(start.slack.channel, start.slack.text);
      ctx.hub.info(`said "${start.slack.text}" in Slack`);

      return true;
    },
    routes: [
      {
        method: "POST",
        path: "/api/send",
        handle: async ({ body }) => {
          const agent = String(body.agent);
          const text = String(body.message);

          try {
            await ctx.worker.send(agent, String(body.thread), text);
            ctx.hub.info(`sent "${text}" to ${agent}`);

            return { ok: true };
          } catch (error) {
            ctx.hub.emit({ type: "log", kind: "err", text: String(error) });

            throw error;
          }
        },
      },
    ],
  };

  return result;
};
