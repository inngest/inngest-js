import { encryptionMiddleware } from "@inngest/middleware-encryption";
import { Inngest } from "inngest";
import { schemas } from "./types";

const mw = encryptionMiddleware({
  key: "your-encryption-key",
});

export const inngest = new Inngest({
  id: "my-bun-app",
  schemas,
  middleware: [mw],
});
