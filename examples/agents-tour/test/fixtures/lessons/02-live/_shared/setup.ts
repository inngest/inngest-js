import { Inngest } from "inngest";
import { createAgents, memoryKvAdapter } from "inngest/experimental/agents";

export const client = new Inngest({ id: "tour-test", isDev: true });

export const agents = createAgents(client, { store: memoryKvAdapter() });
