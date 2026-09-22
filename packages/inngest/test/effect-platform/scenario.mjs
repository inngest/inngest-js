import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { serve } from "../../dist/edge.js";
import { EffectMiddleware } from "../../dist/effect.js";
import {
  Inngest,
  NonRetriableError,
  RetryAfterError,
} from "../../dist/index.js";

// This drives the SDK's executor HTTP protocol, not an Inngest server/scheduler.
// Sleep completion is supplied as executor state; no wall-clock durability,
// scheduler retries, remote registration, or real event ingestion is claimed.
class Greeting extends Context.Service()("effect-platform/Greeting") {}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function deadline(work, label) {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label}: timed out`)),
          10000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function onlyOp(result, expected) {
  assert(
    result.status === 206,
    `${expected}: expected HTTP 206, got ${result.status}: ${JSON.stringify(result.body)}`,
  );
  assert(
    Array.isArray(result.body) && result.body.length === 1,
    `${expected}: expected exactly one opcode`,
  );
  const op = result.body[0];
  assert(op.op === expected, `Expected ${expected}, got ${JSON.stringify(op)}`);
  assert(
    typeof op.id === "string" && op.id.length > 0,
    `${expected}: missing step ID`,
  );
  return op;
}

export async function runPlatformSmoke(createHandler = serve) {
  const resources = { acquired: 0, released: 0, active: 0, bodies: 0 };
  const withScope = (program) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            resources.acquired++;
            resources.active++;
          }),
          () =>
            Effect.promise(async () => {
              // A genuinely asynchronous finalizer: response completion must await it.
              await new Promise((resolve) => setTimeout(resolve, 5));
              resources.active--;
              resources.released++;
            }),
        );
        return yield* program;
      }),
    );
  const client = new Inngest({
    id: "effect-platform",
    isDev: true,
    middleware: [EffectMiddleware],
  });
  const durable = client.createFunction(
    { id: "durable", triggers: [{ event: "effect/platform" }] },
    ({ effect, step }) =>
      effect.run(
        withScope(
          Effect.gen(function* () {
            const value = yield* effect.step(
              () =>
                Effect.map(Greeting, ({ message }) => {
                  resources.bodies++;
                  return { message, at: new Date("2026-01-01T00:00:00.000Z") };
                }),
              (run) => step.run("load", run),
            );
            yield* effect.promise(() => step.sleep("pause", "1s"));
            return { ...value, atType: typeof value.at };
          }),
        ).pipe(
          Effect.provide(
            Layer.succeed(Greeting)({ message: "provided by Effect" }),
          ),
        ),
      ),
  );
  const failures = [
    {
      id: "stop",
      makeError: () => new NonRetriableError("stop now"),
      status: 400,
      noRetry: "true",
    },
    {
      id: "later",
      makeError: () => new RetryAfterError("try later", "5s"),
      status: 500,
      noRetry: "false",
      retryAfter: "5",
    },
  ];
  const functions = [durable];
  for (const policy of failures) {
    functions.push(
      client.createFunction(
        { id: policy.id, triggers: [{ event: "effect/platform" }] },
        ({ effect }) => effect.run(withScope(Effect.fail(policy.makeError()))),
      ),
    );
    functions.push(
      client.createFunction(
        { id: `${policy.id}-step`, triggers: [{ event: "effect/platform" }] },
        ({ effect, step }) =>
          effect.run(
            withScope(
              effect.step(
                () => Effect.fail(policy.makeError()),
                (run) => step.run("fail", run),
              ),
            ),
          ),
      ),
    );
  }
  const handler = createHandler({ client, functions, streaming: false });
  const event = {
    name: "effect/platform",
    data: {},
    id: "platform-event",
    ts: 1767225600000,
  };
  let invocations = 0;
  const trace = [];
  async function execute(
    id,
    { steps = {}, stepId = "step", discover = true } = {},
  ) {
    invocations++;
    const fnId = `effect-platform-${id}`;
    const url = new URL("http://localhost/api/inngest");
    url.searchParams.set("fnId", fnId);
    url.searchParams.set("stepId", stepId);
    const response = await deadline(
      handler(
        new Request(url, {
          method: "POST",
          headers: {
            host: "localhost",
            "content-type": "application/json",
            "x-inngest-run-id": `platform-${id}`,
          },
          body: JSON.stringify({
            version: 2,
            event,
            events: [event],
            steps,
            ctx: {
              fn_id: fnId,
              run_id: `platform-${id}`,
              step_id: stepId,
              attempt: 0,
              disable_immediate_execution: discover,
              use_api: false,
              stack: { stack: Object.keys(steps), current: 0 },
            },
          }),
        }),
      ),
      `${id}/${stepId}`,
    );
    assert(
      response instanceof Response,
      "Serve adapter must return a real Web Response",
    );
    const body = await response.json();
    assert(resources.active === 0, `${id}: invocation leaked an Effect scope`);
    assert(
      resources.acquired === invocations,
      `${id}: handler did not acquire its scope exactly once`,
    );
    assert(
      resources.released === resources.acquired,
      `${id}: HTTP response did not await finalizer completion`,
    );
    trace.push({
      function: id,
      status: response.status,
      ops: Array.isArray(body) ? body.map((op) => op.op) : undefined,
    });
    return { status: response.status, headers: response.headers, body };
  }

  const introspection = await deadline(
    handler(
      new Request("http://localhost/api/inngest", {
        headers: { host: "localhost" },
      }),
    ),
    "introspection",
  );
  assert(
    introspection.status === 200,
    `Introspection failed: HTTP ${introspection.status}`,
  );
  await introspection.json();

  const planned = onlyOp(await execute("durable"), "StepPlanned");
  assert(resources.bodies === 0, "Discovery eagerly ran an Effect step body");
  const loaded = onlyOp(
    await execute("durable", { stepId: planned.id }),
    "StepRun",
  );
  assert(loaded.id === planned.id, "Executor-selected step ID changed");
  assert(
    loaded.data.message === "provided by Effect",
    "Step lost its provided Effect service",
  );
  assert(
    loaded.data.at === "2026-01-01T00:00:00.000Z",
    "Step result did not cross JSON serialization boundary",
  );
  const steps = { [loaded.id]: { type: "data", data: loaded.data } };
  const sleeping = onlyOp(await execute("durable", { steps }), "Sleep");
  assert(
    sleeping.name === "1s",
    `Unexpected durable sleep duration: ${sleeping.name}`,
  );
  assert(resources.bodies === 1, "Replay reran the completed Effect step");
  steps[sleeping.id] = { type: "data", data: null };
  const completed = await execute("durable", { steps });
  assert(
    completed.status === 200,
    `Expected terminal HTTP 200, got ${completed.status}: ${JSON.stringify(completed.body)}`,
  );
  assert(
    JSON.stringify(completed.body) ===
      JSON.stringify({
        message: "provided by Effect",
        at: "2026-01-01T00:00:00.000Z",
        atType: "string",
      }),
    "Replay returned an unexpected result",
  );
  assert(
    resources.bodies === 1,
    "Final replay reran the completed Effect step",
  );

  for (const policy of failures) {
    const failed = await execute(policy.id);
    assert(
      failed.status === policy.status,
      `${policy.id}: retry-control status lost: ${failed.status}`,
    );
    assert(
      failed.headers.get("x-inngest-no-retry") === policy.noRetry,
      `${policy.id}: retry-control header lost`,
    );
    assert(
      failed.headers.get("retry-after") === (policy.retryAfter ?? null),
      `${policy.id}: retry delay changed`,
    );
    assert(
      failed.body.name === policy.makeError().name,
      `${policy.id}: Effect wrapped the original error`,
    );
    const stepFailed = await execute(`${policy.id}-step`, { discover: false });
    const op = onlyOp(
      stepFailed,
      policy.noRetry === "true" ? "StepFailed" : "StepError",
    );
    assert(
      op.error.name === policy.makeError().name,
      `${policy.id}: step error identity lost`,
    );
    assert(
      stepFailed.headers.get("x-inngest-no-retry") === policy.noRetry,
      `${policy.id}: step retry policy lost`,
    );
    assert(
      stepFailed.headers.get("retry-after") === (policy.retryAfter ?? null),
      `${policy.id}: step retry delay changed`,
    );
  }
  return {
    ok: true,
    adapterProtocol: "Web Request/Response executor HTTP v2",
    scheduler: false,
    invocations,
    resources,
    trace,
  };
}
