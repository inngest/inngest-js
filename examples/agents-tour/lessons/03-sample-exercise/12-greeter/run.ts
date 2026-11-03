import { greeter } from "./agent";

// Run calls this.
export const run = async () => {
  await greeter.start("Ada");
};
