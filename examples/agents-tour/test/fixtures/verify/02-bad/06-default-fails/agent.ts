import { NonRetriableError } from "inngest";
import { agents } from "./setup";

export const boom = agents.agent({ id: "boom" }, async ({ inbox }) => {
  await inbox.next();

  throw new NonRetriableError("boom");
});
