import { Inngest } from "inngest";
import { schemas } from "./types";
// Create a client to send and receive events
export const inngest = new Inngest({ id: "my-app", schemas });