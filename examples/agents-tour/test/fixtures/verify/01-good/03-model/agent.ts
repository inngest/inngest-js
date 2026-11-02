import { agents } from "./setup";

export const which = agents.agent({ id: "which" }, async ({ inbox }) => {
  await inbox.next();

  return process.env.TOUR_MODEL ?? "none";
});
