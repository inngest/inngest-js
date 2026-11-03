import { hello } from "./agent";

// Run calls this.
export const run = async () => {
  await hello.start("Hi");
};
