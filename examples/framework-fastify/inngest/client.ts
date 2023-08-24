import { Inngest } from "inngest";
import { schemas } from "./types";

export const inngest = new Inngest({ name: "My Fastify app", schemas });
