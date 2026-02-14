import { bench, describe } from "vitest";
import { Inngest, type InngestFunction } from "../index.ts";
import { createTestApp, type TestApp } from "../test/devServerTestHarness.ts";

export function randomSuffix(value: string): string {
  return `${value}-${Math.random().toString(36).substring(2, 15)}`;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Common step return value used across benchmarks. */
export function stepPayload() {
  return {
    deeply: {
      nested: {
        object: {
          with: {
            message: "A".repeat(1024),
          },
        },
      },
    },
  };
}

// -- Bench scaffolding --------------------------------------------------

interface MakeBenchOptions {
  checkpointing?: boolean;
  /** Name shown in the benchmark table and describe block. */
  name: string;
  /** Number of concurrent function runs per iteration (default 10). */
  runs?: number;
  /**
   * Create and return the Inngest function under test.
   * Call `onDone()` at the end of your handler to signal completion.
   */
  setup: (
    client: Inngest.Any,
    eventName: string,
    onDone: () => void,
  ) => InngestFunction.Any;
}

/**
 * Define a benchmark that sends events through a Dev Server and waits for
 * all function runs to complete. Handles lazy app init and the
 * send-then-poll loop.
 */
export function makeBench(options: MakeBenchOptions) {
  const runs = options.runs ?? 1;

  describe(options.name, () => {
    let completed = 0;
    const client = new Inngest({
      checkpointing: options.checkpointing,
      id: randomSuffix("app"),
      isDev: true,
      logLevel: "silent",
    });
    const eventName = randomSuffix("evt");
    const fn = options.setup(client, eventName, () => {
      completed++;
    });

    let app: TestApp | undefined;

    bench(
      options.name,
      async () => {
        if (!app) {
          app = await createTestApp({ client, functions: [fn] });
        }

        completed = 0;

        const events: Array<{ name: string }> = [];
        for (let i = 0; i < runs; i++) {
          events.push({ name: eventName });
        }
        await client.send(events);

        const deadline = Date.now() + 60_000;
        while (completed < runs) {
          if (Date.now() > deadline) {
            throw new Error(`Timeout: ${completed}/${runs} runs completed`);
          }
          await sleep(50);
        }
      },
      { iterations: 5, warmupIterations: 1, warmupTime: 0, time: 0 },
    );
  });
}
