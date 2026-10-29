/**
 * @module
 * EXPERIMENTAL: `inngest/experimental/agents/testing`. What a test of an agent
 * needs and an app would otherwise copy: a scripted model that needs no API
 * key, a fake Sandboxes API, fake Slack and GitHub servers that keep every
 * call, a git remote that wants a token, and a thread handle that returns the
 * keys the agent set. These run in Node and are for tests, never for
 * production code. `fakeSandbox` runs nothing on the host unless you set
 * `execute: "local"`; do that only with a scripted model (`script()`), because
 * a real model's commands would run on your machine.
 *
 * ```ts
 * import { fakeSandbox, script, startFakes } from "inngest/experimental/agents/testing";
 *
 * const fakes = await startFakes();
 * const client = new Inngest({
 *   id: "app",
 *   fetch: fakeSandbox({ fakes, commands: { "npm test": { stdout: "ok" }, "": {} } }).fetch,
 * });
 * // agent.loop({ model: script([{ call: { name: "run", input: {} } }, { say: "done" }]), ... })
 * // expect(fakes.posts({ channel: "sandbox", method: "sandbox.exec" })).toHaveLength(1);
 * ```
 */
export type {
  Call,
  CallFilter,
  Fakes,
} from "../../components/agent/testing/fakes.ts";
export { startFakes } from "../../components/agent/testing/fakes.ts";
export type { FakeGitDataApi } from "../../components/agent/testing/gitDataApi.ts";
export { fakeGitDataApi } from "../../components/agent/testing/gitDataApi.ts";
export type {
  GitFiles,
  GitRemote,
  GitRemoteOptions,
  GitRepo,
  GitSeed,
} from "../../components/agent/testing/gitRemote.ts";
export { startGitRemote } from "../../components/agent/testing/gitRemote.ts";
export type { ScriptStep } from "../../components/agent/testing/model.ts";
export { script } from "../../components/agent/testing/model.ts";
export type {
  FakeSandbox,
  FakeSandboxOptions,
} from "../../components/agent/testing/sandbox.ts";
export { fakeSandbox } from "../../components/agent/testing/sandbox.ts";
export type { ThreadHandleWithKeys } from "../../components/agent/testing/threads.ts";
export { withKeys } from "../../components/agent/testing/threads.ts";
