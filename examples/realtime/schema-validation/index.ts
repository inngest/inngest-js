import crypto from "node:crypto";
import { createServer } from "node:http";
import { Inngest } from "inngest";
import { serve } from "inngest/node";
import { pipeline } from "./channels.js";

const inngest = new Inngest({ id: "schema-validation-example" });

// ---------------------------------------------------------------------------
// Inngest function that demonstrates both schema types
// ---------------------------------------------------------------------------
const processData = inngest.createFunction(
  {
    id: "process-data",
    retries: 0,
    triggers: [{ event: "app/process" }],
  },
  async ({ event, step }) => {
    const runId = event.data.runId as string;
    const ch = pipeline({ runId });

    // -----------------------------------------------------------------------
    // 1. Publish to the Zod-validated "status" topic — valid data
    // -----------------------------------------------------------------------
    console.log("\n--- Publishing valid status (Zod schema) ---");
    await inngest.publish(ch.status, { message: "Starting", step: "init" });
    console.log("✓ Valid status published successfully");

    // -----------------------------------------------------------------------
    // 2. Publish to the Zod-validated "status" topic — INVALID data
    //    This will THROW because Zod validates at publish time.
    // -----------------------------------------------------------------------
    console.log("\n--- Publishing invalid status (Zod schema) ---");
    try {
      // @ts-expect-error — deliberately passing wrong type to show runtime validation
      await inngest.publish(ch.status, { message: 42 });
      console.log("✗ Should not reach here");
    } catch (err) {
      console.log(`✓ Correctly rejected: ${(err as Error).message}`);
    }

    // -----------------------------------------------------------------------
    // 3. Publish to the staticSchema "tokens" topic — valid data
    // -----------------------------------------------------------------------
    console.log("\n--- Publishing valid tokens (staticSchema) ---");
    await inngest.publish(ch.tokens, { token: "Hello" });
    console.log("✓ Valid tokens published successfully");

    // -----------------------------------------------------------------------
    // 4. Publish to the staticSchema "tokens" topic — INVALID data
    //    This will NOT throw. staticSchema is a passthrough: it provides
    //    compile-time types but no runtime validation.
    //    (The @ts-expect-error suppresses the compile-time error so we can
    //    demonstrate the runtime behavior.)
    // -----------------------------------------------------------------------
    console.log("\n--- Publishing invalid tokens (staticSchema) ---");
    try {
      // @ts-expect-error — deliberately passing wrong type to show NO runtime validation
      await inngest.publish(ch.tokens, { token: 999 });
      console.log("✓ Published without error (staticSchema is a passthrough)");
    } catch (err) {
      console.log(`✗ Unexpected rejection: ${(err as Error).message}`);
    }

    // -----------------------------------------------------------------------
    // 5. Durable publish follows the same rules
    // -----------------------------------------------------------------------
    console.log("\n--- Durable publish (step.realtime.publish) ---");
    await step.realtime.publish("final-status", ch.status, {
      message: "Done",
      step: "complete",
    });
    console.log("✓ Durable publish succeeded");

    console.log("\n=== Summary ===");
    console.log("• Zod schema topics: TypeScript types + runtime validation");
    console.log("• staticSchema topics: TypeScript types only, zero runtime cost");
    console.log(
      "• Both types provide identical compile-time safety (try removing the @ts-expect-error comments!)",
    );

    return { ok: true };
  },
);

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const startServer = () => {
  createServer(
    serve({
      client: inngest,
      functions: [processData],
    }),
  ).listen(3000, () => {
    console.log("Inngest serve handler listening on http://localhost:3000");
  });
};

// ---------------------------------------------------------------------------
// Trigger the function after the dev server syncs
// ---------------------------------------------------------------------------
const run = async () => {
  console.log("Waiting for app to sync with the Inngest dev server...");
  await new Promise((resolve) => setTimeout(resolve, 10_000));

  const runId = crypto.randomUUID();

  console.log(`\nTriggering process-data with runId: ${runId}\n`);
  await inngest.send({
    name: "app/process",
    data: { runId },
  });
};

void Promise.all([startServer(), run()]);
