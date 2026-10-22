/**
 * Live Tap Pull, replay mode: run a recorded run on the current code and diff
 * each step result against the recording.
 *
 * @module
 */

import {
  GatewayExecutorRequestData,
  SDKResponseStatus,
} from "../../proto/src/components/connect/protobuf/connect.ts";
import type { RecordedRun, RecordedStep, StepDiff } from "./pull.ts";
import type { RequestHandler } from "./strategies/index.ts";

const diffStatus = (
  ran: boolean,
  replayed: unknown,
  rec: RecordedStep | undefined,
): StepDiff["status"] => {
  if (!rec) {
    return "new";
  }

  if (rec.failed) {
    return ran ? "fixed" : "failed";
  }

  if (!ran) {
    return "unsupported";
  }

  return JSON.stringify(replayed) === JSON.stringify(rec.data)
    ? "same"
    : "changed";
};

/**
 * Replay the recorded run on the current code. Each step result is compared to
 * the recorded one, then the recorded one is fed forward so a difference does
 * not cascade into later steps. Stops at the first step that was not recorded
 * as completed, without running it again.
 */
export const replayRun = async (opts: {
  recorded: RecordedRun;
  handler: RequestHandler;
  appName: string;
  functionSlug: string;
  stopAfter?: string;
}): Promise<StepDiff[]> => {
  const { recorded } = opts;
  const byHash = new Map(
    recorded.steps.map((step) => {
      return [step.hashed, step];
    }),
  );
  const memo: Record<string, { data: unknown }> = {};
  const stack: string[] = [];
  const diffs: StepDiff[] = [];
  const queue: Array<string | undefined> = [undefined];
  let requests = 0;

  const request = (stepId: string | undefined) => {
    requests += 1;

    return GatewayExecutorRequestData.create({
      requestId: `pull-${requests}`,
      appName: opts.appName,
      functionSlug: opts.functionSlug,
      stepId,
      runId: recorded.runId,
      leaseId: "pull",
      requestPayload: new TextEncoder().encode(
        JSON.stringify({
          event: recorded.events[0] ?? {},
          events: recorded.events,
          steps: memo,
          ctx: {
            run_id: recorded.runId,
            attempt: 0,
            stack: { stack, current: stack.length - 1 },
          },
          version: 1,
        }),
      ),
    });
  };

  while (queue.length > 0) {
    const response = await opts.handler(request(queue.shift()));

    if (response.status === SDKResponseStatus.ERROR) {
      diffs.push({
        id: opts.functionSlug,
        status: "failed",
        replayed: new TextDecoder().decode(response.body),
      });

      return diffs;
    }

    if (response.status !== SDKResponseStatus.NOT_COMPLETED) {
      break;
    }

    const ops = JSON.parse(new TextDecoder().decode(response.body)) as Array<
      Record<string, unknown>
    >;
    for (const op of ops) {
      const id = String(op.id);
      const rec = byHash.get(id);

      if (op.op === "StepPlanned") {
        queue.push(id);
        continue;
      }

      const replayed = op.op === "StepRun" ? op.data : (op.error ?? op.op);
      const status = diffStatus(op.op === "StepRun", replayed, rec);
      diffs.push({
        id: rec?.id ?? String(op.displayName ?? op.name ?? id),
        status,
        recorded: rec?.data,
        replayed,
      });

      if (!rec || (rec.failed && status !== "fixed")) {
        return diffs;
      }

      memo[id] = { data: rec.failed ? replayed : (rec.data ?? null) };
      stack.push(id);

      if (opts.stopAfter === rec.id) {
        return diffs;
      }
    }

    if (queue.length === 0 && ops.length > 0) {
      queue.push(undefined);
    }
  }

  if (!opts.stopAfter) {
    for (const rec of recorded.steps) {
      if (!diffs.some((diff) => diff.id === rec.id)) {
        diffs.push({ id: rec.id, status: "missing", recorded: rec.data });
      }
    }
  }

  return diffs;
};
