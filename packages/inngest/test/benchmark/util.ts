import path from "node:path";
import callsites from "callsites";
import { bench } from "mitata";

interface BenchmarkRef {
  name: string;
  fn: () => Promise<any>;
}

class BenchmarkRefs {
  constructor(private refs: BenchmarkRef[]) {}

  public register() {
    for (const ref of this.refs) {
      bench(ref.name, ref.fn);
    }
  }
}

export const loadBenchmarks = async (
  benchmarkNames: string[],
): Promise<BenchmarkRefs> => {
  let caller = getCallerDir();
  if (caller.startsWith("file://")) {
    caller = caller.replace("file://", "");
  }

  const rawBenchmarkPromises: Promise<BenchmarkRef | BenchmarkRef[]>[] = [];

  for (const benchmark of benchmarkNames) {
    rawBenchmarkPromises.push(
      (async () => {
        const p = path.resolve(caller, `./${benchmark}`);
        const fn = (await import(p)).default;

        if (typeof fn === "function") {
          return { name: benchmark, fn };
        }

        // Blindly assume it's an obj
        const benchmarkObj = fn as Record<string, () => Promise<any>>;

        return Object.entries(benchmarkObj).map<BenchmarkRef>(
          ([key, value]) => {
            return { name: `${benchmark}/${key}`, fn: value };
          },
        );
      })(),
    );
  }

  const benchmarks = (await Promise.all(rawBenchmarkPromises)).flat();

  return new BenchmarkRefs(benchmarks);
};

const getCallerDir = () => {
  const stack = callsites();
  let targetStack = stack[2];
  if ("Bun" in globalThis) {
    targetStack = stack[3];
  }

  return targetStack ? path.dirname(targetStack.getFileName()) : undefined;
};
