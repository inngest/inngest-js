/**
 * @module
 * Read-only. The Inngest client for the tour and the place agents are made.
 * Every page imports `agents` from here.
 */
import { Inngest } from "inngest";
import { createAgents, memoryKvAdapter } from "inngest/experimental/agents";

export const client = new Inngest({ id: "tour", isDev: true });

export const agents = createAgents(client, { store: memoryKvAdapter() });

declare const process: { env: Record<string, string | undefined> };

export const slackApi = `${process.env.TOUR_URL}/slack/api`;

export const githubApi = `${process.env.TOUR_URL}/github`;
