import { agents } from "./setup";

export const idle = agents.agent({ id: "idle" }, async ({ inbox }) => {
  await inbox.next();
  await inbox.next();
});
