import path from "path";
import { Middleware } from "../../../src/index.ts";
import { StepError } from "../../components/StepError";
import { DEV_SERVER_URL } from "../devServerTestHarness.ts";

export function randomSuffix(value: string): string {
  return `${value}-${Math.random().toString(36).substring(2, 15)}`;
}

export function testNameFromFileUrl(fileUrl: string): string {
  const basename = path.basename(fileUrl).split(".")[0];
  if (!basename) {
    throw new Error("unreachable");
  }
  return basename;
}

export function assertStepError(
  actual: unknown,
  expected: {
    cause?: {
      message: string;
      name: string;
    };
    message: string;
    name: string;
  },
): void {
  expect(actual).toBeInstanceOf(StepError);
  const stepError = actual as StepError;
  expect(stepError.message).toBe(expected.message);
  expect(stepError.name).toBe(expected.name);

  if (expected.cause) {
    expect(stepError.cause).toBeInstanceOf(Error);
    const cause = stepError.cause as Error;
    expect(cause.message).toBe(expected.cause.message);
    expect(cause.name).toBe(expected.cause.name);
  }
}

export abstract class BaseSerializerMiddleware<
  TSerialized,
> extends Middleware.BaseMiddleware {
  protected abstract deserialize(value: TSerialized): unknown;
  protected abstract isSerialized(value: unknown): value is TSerialized;
  protected abstract needsSerialize(value: unknown): boolean;
  protected abstract serialize(value: unknown): TSerialized;

  protected readonly recursive: boolean = true;

  private _deserialize(value: unknown): unknown {
    if (this.isSerialized(value)) {
      return this.deserialize(value);
    }

    if (!this.recursive) {
      return value;
    }

    if (isRecord(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, value]) => [
          key,
          this._deserialize(value),
        ]),
      );
    }

    if (Array.isArray(value)) {
      return value.map(this._deserialize);
    }

    return value;
  }

  private _serialize(value: unknown): unknown {
    if (this.needsSerialize(value)) {
      return this.serialize(value);
    }

    if (!this.recursive) {
      return value;
    }

    if (isRecord(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, value]) => {
          return [key, this._serialize(value)];
        }),
      );
    }

    if (Array.isArray(value)) {
      return value.map(this._serialize);
    }

    return value;
  }

  override transformFunctionInput(
    arg: Middleware.TransformFunctionInputArgs,
  ): Middleware.TransformFunctionInputArgs {
    return {
      ...arg,
      ctx: {
        ...arg.ctx,
        event: {
          ...arg.ctx.event,
          data: this._deserialize(arg.ctx.event.data),
        },
        // @ts-expect-error - It's OK
        events: arg.ctx.events.map((event) => ({
          ...event,
          data: this._deserialize(event.data),
        })),
      },
    };
  }

  override async wrapFunctionHandler({
    next,
  }: Middleware.WrapFunctionHandlerArgs) {
    const output = await next();
    return this._serialize(output);
  }

  override transformStepInput(
    arg: Middleware.TransformStepInputArgs,
  ): Middleware.TransformStepInputArgs {
    // For invoke steps, serialize input so it's available before the handler
    // chain runs (invoke steps are reported to the server before execution).
    if (arg.stepInfo.stepKind === "invoke") {
      arg.input = arg.input.map((i) => this._serialize(i));
    }
    return arg;
  }

  override async wrapStep({ next, stepInfo }: Middleware.WrapStepArgs) {
    const result = await next();
    if (stepInfo.memoized) {
      return this._deserialize(result);
    }
    return this._serialize(result);
  }

  override transformSendEvent(arg: Middleware.TransformSendEventArgs) {
    return arg.events.map((event) => {
      let data = undefined;
      if (event.data) {
        data = this._serialize(event.data) as Record<string, unknown>;
      }

      return {
        ...event,
        data,
      };
    });
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const anyEvent = {
  data: expect.any(Object),
  id: expect.any(String),
  name: expect.any(String),
  ts: expect.any(Number),
  user: expect.any(Object),
};

export const anyContext = {
  attempt: expect.any(Number),
  event: anyEvent,
  events: [anyEvent],
  group: expect.any(Object),
  logger: expect.any(Object),
  maxAttempts: expect.any(Number),
  runId: expect.any(String),
  step: expect.any(Object),
};

export async function sleep(ms: number = 1000): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wrapper around `vitest.waitFor` with a 10-second default timeout.
 */
export const waitFor: typeof vitest.waitFor = (callback, timeout = 10_000) => {
  return vitest.waitFor(callback, timeout);
};

type RunResult =
  | { data: unknown; error?: undefined }
  | { data?: undefined; error: unknown };

async function fetchRunResult(
  runId: string,
  timeout = 10_000,
): Promise<RunResult> {
  const deadline = Date.now() + timeout;

  // Poll for a FINALIZATION span with an outputID.
  let outputID: string | undefined;
  while (Date.now() < deadline) {
    const res = await fetch(`${DEV_SERVER_URL}/v0/gql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `query ($runId: String!) {
          run(runID: $runId) {
            trace(preview: true) {
              stepType outputID status
              childrenSpans {
                stepType outputID status
                childrenSpans { stepType outputID status }
              }
            }
          }
        }`,
        variables: { runId },
      }),
    });
    if (!res.ok) throw new Error(await res.text());

    const json = await res.json();
    const find = (span: Record<string, unknown>): string | undefined => {
      if (span.stepType === "FINALIZATION" && span.outputID) {
        return span.outputID as string;
      }
      if (Array.isArray(span.childrenSpans)) {
        for (const child of span.childrenSpans) {
          const id = find(child as Record<string, unknown>);
          if (id) return id;
        }
      }
      return undefined;
    };

    const trace = json?.data?.run?.trace;
    if (trace) outputID = find(trace);
    if (outputID) break;
    await sleep(400);
  }
  if (!outputID) {
    throw new Error(`Timed out waiting for finalization of run ${runId}`);
  }

  // Fetch the output blob.
  const res = await fetch(`${DEV_SERVER_URL}/v0/gql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `query ($outputId: String!) {
        runTraceSpanOutputByID(outputID: $outputId) {
          data
          error { name message stack cause }
        }
      }`,
      variables: { outputId: outputID },
    }),
  });
  if (!res.ok) throw new Error(await res.text());

  const json = await res.json();
  const payload = json?.data?.runTraceSpanOutputByID;
  if (payload.error) {
    return { error: payload.error };
  }
  return { data: JSON.parse(payload.data) };
}

export class BaseState {
  runId: string | null = null;

  async waitForRunId(): Promise<string> {
    return waitFor(async () => {
      expect(this.runId).not.toBeNull();
      return this.runId!;
    });
  }

  async waitForRunComplete(): Promise<unknown> {
    const runId = await this.waitForRunId();
    const result = await fetchRunResult(runId);
    if (result.error) {
      throw new Error(
        `Expected run ${runId} to complete, but it errored: ${JSON.stringify(result.error)}`,
      );
    }
    return result.data;
  }

  async waitForRunFailed(): Promise<void> {
    const runId = await this.waitForRunId();
    const result = await fetchRunResult(runId);
    if (!result.error) {
      throw new Error(
        `Expected run ${runId} to fail, but it completed with: ${JSON.stringify(result.data)}`,
      );
    }
  }
}

export function createState<T extends Record<string, unknown>>(
  initial: T,
): BaseState & T {
  return Object.assign(new BaseState(), initial);
}
