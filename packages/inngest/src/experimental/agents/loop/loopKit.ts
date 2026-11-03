/**
 * @module
 * Helpers for the loop's tests: a model function typed as one, and a loop run
 * in a single call on a prompt.
 */
import {
  getAsyncCtxSync,
  runWithAsyncCtx,
} from "../../../components/execution/als.ts";
import type { SandboxTools } from "../../../components/sandbox/tools.ts";
import {
  type AgentLoopInput,
  type AgentLoopOptions,
  type AgentLoopResult,
  type AgentLoopWiring,
  type AgentModel,
  agent,
  agentModel,
  type ModelValue,
} from "./loop.ts";

/**
 * Types a model function.
 */
export const model = (fn: AgentModel): AgentModel & ModelValue => {
  return agentModel(fn);
};

/**
 * Runs `fn` as if it were inside an agent that gives its loops `wiring`.
 */
export const withWiring = <T>(
  wiring: AgentLoopWiring,
  fn: () => Promise<T>,
): Promise<T> => {
  const als = getAsyncCtxSync();

  if (!als?.execution) {
    return fn();
  }

  return runWithAsyncCtx(
    { ...als, execution: { ...als.execution, agentBridge: { wiring } } },
    fn,
  );
};

/**
 * Makes a loop from `options` and runs it on `prompt`, inside an agent's
 * wiring when `wiring` is given.
 */
export const runLoop = <TTools extends SandboxTools>(
  options: AgentLoopOptions<TTools> & {
    prompt: AgentLoopInput;
    wiring?: AgentLoopWiring;
  },
): Promise<AgentLoopResult<TTools>> => {
  const { prompt, wiring, ...rest } = options;
  const loop = agent.loop(rest as AgentLoopOptions<TTools>);

  return wiring
    ? withWiring(wiring, () => {
        return loop(prompt);
      })
    : loop(prompt);
};

/**
 * A model that fails its first call with a rate limit that names a wait
 * (`retry-after`, in seconds) and answers every later call from `answer`.
 */
export const failsOnceWithRetryAfter = (
  answer: AgentModel,
  seconds = 2,
): AgentModel & ModelValue => {
  let failed = false;

  return model(async (request) => {
    if (!failed) {
      failed = true;

      throw Object.assign(new Error("rate limited"), {
        status: 429,
        headers: { "retry-after": String(seconds) },
      });
    }

    return answer(request);
  });
};
