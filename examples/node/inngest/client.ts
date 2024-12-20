import { Inngest } from "inngest";
import { schemas } from "./types";

export const inngest = new Inngest({ id: "my-express-app", schemas });
