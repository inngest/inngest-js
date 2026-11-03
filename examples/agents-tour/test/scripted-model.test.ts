/**
 * @module
 * The scripted model answers from its script by turn, can call a tool, and
 * echoes the last user message once the script runs out.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentModelRequest } from "inngest/experimental/agents";
import { script } from "../runtime/scripted-model.ts";

const request = (turn: number, text = "hi") => {
  return {
    messages: [{ role: "user", content: text }],
    turn,
    maxTurns: 5,
  } as unknown as AgentModelRequest;
};

describe("the scripted model", () => {
  it("says the step for the turn, then echoes the last user message", async () => {
    const model = script([{ say: "one" }, { say: "two" }]);

    assert.equal((await model(request(1))).text, "one");
    assert.equal((await model(request(2))).text, "two");
    assert.equal((await model(request(3, "again"))).text, "echo: again");
  });

  it("asks for a tool call, which ends no conversation", async () => {
    const model = script([{ call: { name: "run", input: { n: 1 } } }]);
    const answer = await model(request(1));

    assert.deepEqual(
      answer.toolCalls.map((call) => {
        return [call.name, call.input];
      }),
      [["run", { n: 1 }]],
    );
  });

  it("answers a request a step matches, wherever it is in the script", async () => {
    const model = script([
      { say: "plain" },
      {
        say: "matched",
        when: (r) => {
          return r.turn === 2;
        },
      },
    ]);

    assert.equal((await model(request(2))).text, "matched");
  });
});
