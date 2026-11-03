import { agents } from "./setup";

export const greeter = agents.agent({ id: "greeter" }, async ({ inbox }) => {
  await inbox.next();
});
