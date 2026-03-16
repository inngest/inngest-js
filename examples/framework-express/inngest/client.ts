import { Inngest } from "inngest";
import { schemas } from "./types";

export const inngest = new Inngest({
  id: process.env.INNGEST_APP_ID ?? "my-express-app",
  schemas,
  baseUrl: process.env.INNGEST_BASE_URL,
  version: process.env.INNGEST_APP_VERSION,
});
