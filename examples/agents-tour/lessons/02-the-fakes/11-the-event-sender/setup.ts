/**
 * @module
 * Read-only. The Inngest client for the tour, the place agents are made, and
 * the options that point the Slack and GitHub channels at the tour's fakes.
 */
import { Inngest } from "inngest";
import { createAgents, memoryKvAdapter } from "inngest/experimental/agents";

export const client = new Inngest({ id: "tour", isDev: true });

export const agents = createAgents(client, { store: memoryKvAdapter() });

declare const process: { env: Record<string, string | undefined> };

export const slackOptions = {
  in: ["C02ENG"],
  apiUrl: `${process.env.TOUR_URL}/slack/api`,
};

export const githubOptions = {
  repos: ["acme/web"],
  apiUrl: `${process.env.TOUR_URL}/github`,
  token: "tour",
};
