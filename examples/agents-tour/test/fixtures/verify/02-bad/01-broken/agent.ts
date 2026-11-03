import { agents } from "./setup";

throw new Error("this page is broken");

export const echo = agents.agent({ id: "echo" }, async ({ inbox }) => {
  await inbox.next();
});
