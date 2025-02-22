import { group } from "mitata";
import { loadBenchmarks } from "../util";

// Give me Bun
export const register = async () => {
  const benchmarks = await loadBenchmarks(["memoized-steps-v1", "memoized-steps-v2"]);

  group("execution", () => {
    benchmarks.register();
  });
};
