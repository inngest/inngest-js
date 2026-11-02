import { agents } from "./setup";

export const idle = agents.agent({ id: "idle" }, async () => {
  return "done";
});
