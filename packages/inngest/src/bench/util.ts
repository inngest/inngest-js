import {
  createTestApp,
  randomSuffix,
  sleep,
  type TestApp,
} from "@inngest/test-harness";
import { bench, describe } from "vitest";
import { Inngest, type InngestFunction, Middleware } from "../index.ts";
import { ConsoleLogger } from "../middleware/logger.ts";

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

interface CreateBenchOptions {
  checkpointing?: boolean;

  /** Name shown in the benchmark table and describe block. */
  name: string;

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
export function createBench(options: CreateBenchOptions) {
  const runs = 1;

  describe(options.name, () => {
    let completed = 0;
    const client = new Inngest({
      checkpointing: options.checkpointing,
      id: randomSuffix("app"),
      isDev: true,
      logger: new ConsoleLogger({ level: "silent" }),
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

export function createMiddleware() {
  return class MW extends Middleware.BaseMiddleware {
    readonly id = "bench";
    override onMemoizationEnd() {}
    override onStepStart() {}
    override onStepComplete() {}
    override onStepError() {}
    override onRunStart() {}
    override onRunComplete() {}
    override onRunError() {}

    override transformSendEvent(
      arg: Middleware.TransformSendEventArgs,
    ): Middleware.TransformSendEventArgs {
      return arg;
    }

    override transformStepInput(
      arg: Middleware.TransformStepInputArgs,
    ): Middleware.TransformStepInputArgs {
      return arg;
    }

    override transformFunctionInput(
      arg: Middleware.TransformFunctionInputArgs,
    ): Middleware.TransformFunctionInputArgs {
      return arg;
    }

    override async wrapFunctionHandler({
      next,
    }: Middleware.WrapFunctionHandlerArgs) {
      return next();
    }

    override async wrapRequest({ next }: Middleware.WrapRequestArgs) {
      return next();
    }

    override async wrapSendEvent({ next }: Middleware.WrapSendEventArgs) {
      return next();
    }

    override async wrapStep({ next }: Middleware.WrapStepArgs) {
      return next();
    }
  };
}
