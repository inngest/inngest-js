/**
 * @module
 * Type tests for the handles of a thread: the three handle types, and the
 * promise-with-methods that `start()` and `message()` return.
 */
import { z } from "zod";
import { invoke } from "../../../components/triggers/triggers.ts";
import { agents, typesOnly } from "../agent/typeFixtures.ts";
import type * as entry from "../index.ts";
import type { RunHandle, StartedThread, ThreadHandle } from "../index.ts";

describe("messaging types", () => {
  test("messaging: the three handle types have the members of lead's call L66", () => {
    expectTypeOf<ThreadHandle<string>>().toHaveProperty("key");
    expectTypeOf<ThreadHandle<string>>().toHaveProperty("message");
    expectTypeOf<ThreadHandle<string>>().toHaveProperty("ask");
    expectTypeOf<ThreadHandle<string>>().toHaveProperty("stop");
    expectTypeOf<ThreadHandle<string>>().not.toHaveProperty("result");
    expectTypeOf<StartedThread<string>>().toExtend<ThreadHandle<string>>();
    expectTypeOf<StartedThread<string>>().toHaveProperty("result");
    expectTypeOf<RunHandle<string>["result"]>().returns.toEqualTypeOf<
      Promise<string>
    >();
    expectTypeOf<RunHandle<string>>().not.toHaveProperty("message");
  });

  test("messaging: the promise forms have no exported alias", () => {
    expectTypeOf<keyof typeof entry>().not.toEqualTypeOf<"MessageCall">();
    expectTypeOf<typeof entry>().not.toHaveProperty("StartedThreadPromise");
    expectTypeOf<typeof entry>().not.toHaveProperty("MessageCall");
  });

  test("messaging: start and message each return a promise that carries the handle's methods", () => {
    const worker = agents.agent(
      { id: "msg-types", triggers: invoke(z.object({ q: z.string() })) },
      async (): Promise<{ answer: string }> => {
        return { answer: "x" };
      },
    );

    typesOnly(async () => {
      const started = await worker.start({ q: "1" });

      expectTypeOf(started).toEqualTypeOf<StartedThread<{ answer: string }>>();
      expectTypeOf(started).not.toHaveProperty("then");
      expectTypeOf(await worker.start({ q: "1" }).result()).toEqualTypeOf<{
        answer: string;
      }>();
      expectTypeOf(await worker.start({ q: "1" }).ask("why?")).toEqualTypeOf<
        string | null
      >();

      const call = await started.message("y");

      expectTypeOf(call).toEqualTypeOf<RunHandle<{ answer: string }>>();
      expectTypeOf(call).not.toHaveProperty("then");
      expectTypeOf(await started.message("y").result()).toEqualTypeOf<{
        answer: string;
      }>();

      const rebuilt = worker.thread("k");

      expectTypeOf(await rebuilt.message("y").result()).toEqualTypeOf<{
        answer: string;
      }>();
      expectTypeOf(rebuilt).not.toHaveProperty("result");

      // result takes a timeout
      await started.result({ timeout: "5m" });
      await started.message("z").result({ timeout: 1000 });
    });
  });
});
