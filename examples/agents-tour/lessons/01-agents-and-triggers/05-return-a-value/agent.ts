import { agents } from "./setup";

export const blank = agents.agent({ id: "blank" }, async () => {
  return "I ran.";
});
