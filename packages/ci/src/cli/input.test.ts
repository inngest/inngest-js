/**
 * Tests for working out a run's input: flags beat fixtures, which beat asking.
 *
 * @module
 */

import { describe, expect, test } from "vitest";

import { flagInput, resolveInput } from "./input.ts";
import type { Prompter } from "./prompter.ts";
import type { SetupError } from "./setupError.ts";
import type { Target } from "./target.ts";

const pr: Target = {
  kind: "pipeline",
  id: "pr",
  triggers: [{ event: "github/pull_request.opened" }, { event: "github/push" }],
};

const deploy: Target = {
  kind: "pipeline",
  id: "deploy",
  triggers: [{ event: "ci/manual.deploy" }],
};

const prerelease: Target = {
  kind: "pipeline",
  id: "prerelease",
  triggers: [{ event: "github/issue_comment.created" }],
};

const build: Target = { kind: "job", id: "build", takesInput: true };
const lint: Target = { kind: "job", id: "lint", takesInput: false };

const compat: Target = {
  kind: "job",
  id: "compat",
  takesInput: false,
  axes: { os: ["linux", "mac"], node: [20, 22] },
};

/** A prompter that answers from a script and records what it was asked. */
const scripted = (answers: unknown[]) => {
  const asked: string[] = [];
  const next = async (question: string) => {
    asked.push(question);

    return answers.shift();
  };
  const prompter = {
    choose: next,
    line: next,
  } as unknown as Prompter;

  return { prompter, asked };
};

const noFlags = {};

describe("flagInput", () => {
  const args = { combo: {} };

  test("reads the trigger and data for a pipeline", () => {
    expect(flagInput({ ...args, event: "push", data: '{"a":1}' }, pr)).toEqual({
      trigger: "github/push",
      data: { a: 1 },
    });
  });

  test("reads the input and combination for a job", () => {
    expect(
      flagInput(
        {
          ...args,
          input: '{"target":"web"}',
          combo: { os: "mac", node: "22" },
        },
        compat,
      ),
    ).toEqual({ input: { target: "web" }, combo: { os: "mac", node: 22 } });
  });

  test("rejects JSON that doesn't parse, naming the flag", () => {
    expect(() => flagInput({ ...args, data: "{" }, pr)).toThrow(
      "--data is not valid JSON.",
    );
    expect(() => flagInput({ ...args, input: "{" }, build)).toThrow(
      "--input is not valid JSON.",
    );
  });

  test("is empty when no flag applies", () => {
    expect(flagInput(args, pr)).toEqual({
      trigger: undefined,
      data: undefined,
    });
  });
});

describe("resolveInput without a prompter", () => {
  test("uses the only trigger, and needs --event for several", async () => {
    expect(
      (await resolveInput({ target: deploy, flags: noFlags, saved: {} })).input
        .trigger,
    ).toBe("ci/manual.deploy");

    await expect(
      resolveInput({ target: pr, flags: noFlags, saved: {} }),
    ).rejects.toThrow(/several triggers/);
  });

  test("takes flags first, then the fixture", async () => {
    const result = await resolveInput({
      target: deploy,
      flags: { data: { env: "flag" } },
      fixture: { trigger: "ci/manual.deploy", data: { env: "fixture" } },
      saved: {},
    });

    expect(result).toEqual({
      input: { trigger: "ci/manual.deploy", data: { env: "flag" } },
      entered: false,
    });
  });

  test("fills what flags leave out from the fixture", async () => {
    const result = await resolveInput({
      target: pr,
      flags: { data: { a: 1 } },
      fixture: { trigger: "github/push" },
      saved: {},
    });

    expect(result.input).toEqual({ trigger: "github/push", data: { a: 1 } });
  });

  test("leaves a job without input or combination alone", async () => {
    expect(
      await resolveInput({ target: build, flags: noFlags, saved: {} }),
    ).toEqual({
      input: { input: undefined, combo: undefined },
      entered: false,
    });
  });

  test("lists the triggers when there are several", async () => {
    expect.assertions(1);

    try {
      await resolveInput({ target: pr, flags: noFlags, saved: {} });
    } catch (error) {
      expect((error as SetupError).fix).toContain("github/push");
    }
  });
});

describe("resolveInput asking", () => {
  test("asks which trigger when there are several, and says it was entered", async () => {
    const { prompter, asked } = scripted(["github/push"]);

    const result = await resolveInput({
      target: pr,
      flags: noFlags,
      saved: {},
      ask: prompter,
    });

    expect(result).toEqual({
      input: { trigger: "github/push", data: undefined },
      entered: true,
    });
    expect(asked).toEqual(["Which trigger?"]);
  });

  test("asks for a manual trigger's data as JSON, empty meaning none", async () => {
    expect(
      (
        await resolveInput({
          target: deploy,
          flags: noFlags,
          saved: {},
          ask: scripted(['{"target":"api"}']).prompter,
        })
      ).input.data,
    ).toEqual({ target: "api" });
    expect(
      (
        await resolveInput({
          target: deploy,
          flags: noFlags,
          saved: {},
          ask: scripted([""]).prompter,
        })
      ).input.data,
    ).toEqual({});
  });

  test("asks for a comment's body", async () => {
    const result = await resolveInput({
      target: prerelease,
      flags: noFlags,
      saved: {},
      ask: scripted(["/prerelease next"]).prompter,
    });

    expect(result.input.data).toEqual({ body: "/prerelease next" });
  });

  test("asks for the input of a job that takes one, not of one that doesn't", async () => {
    const asking = scripted(['{"target":"web"}']);

    expect(
      (
        await resolveInput({
          target: build,
          flags: noFlags,
          saved: {},
          ask: asking.prompter,
        })
      ).input.input,
    ).toEqual({ target: "web" });

    const none = scripted([]);

    expect(
      (
        await resolveInput({
          target: lint,
          flags: noFlags,
          saved: {},
          ask: none.prompter,
        })
      ).entered,
    ).toBe(false);
    expect(none.asked).toEqual([]);
  });

  test("asks for a matrix combination, with all first", async () => {
    const choices: unknown[][] = [];
    const prompter = {
      choose: async (
        _: string,
        options: { label: string; value: unknown }[],
      ) => {
        choices.push(
          options.map((option) => {
            return option.label;
          }),
        );

        return options[3]?.value;
      },
    } as unknown as Prompter;

    const result = await resolveInput({
      target: compat,
      flags: noFlags,
      saved: {},
      ask: prompter,
    });

    expect(choices[0]).toEqual([
      "all",
      "os:linux, node:20",
      "os:linux, node:22",
      "os:mac, node:20",
      "os:mac, node:22",
    ]);
    expect(result.input.combo).toEqual({ os: "mac", node: 20 });
  });

  test("skips every question a flag answers", async () => {
    const { prompter, asked } = scripted([]);

    const result = await resolveInput({
      target: compat,
      flags: { combo: {} },
      saved: { old: { combo: { os: "mac", node: 20 } } },
      ask: prompter,
    });

    expect(asked).toEqual([]);
    expect(result).toEqual({
      input: { input: undefined, combo: {} },
      entered: false,
    });
  });
});

describe("resolveInput with saved fixtures", () => {
  const saved = {
    "nightly-api": { trigger: "ci/manual.deploy", data: { target: "api" } },
  };

  test("offers them first, then entering new data", async () => {
    let labels: string[] = [];
    const prompter = {
      choose: async (
        _: string,
        options: { label: string; value: unknown }[],
      ) => {
        labels = options.map((option) => {
          return option.label;
        });

        return options[0]?.value;
      },
    } as unknown as Prompter;

    const result = await resolveInput({
      target: deploy,
      flags: noFlags,
      saved,
      ask: prompter,
    });

    expect(labels).toEqual(["use fixture: nightly-api", "enter new"]);
    expect(result).toEqual({
      input: { trigger: "ci/manual.deploy", data: { target: "api" } },
      entered: false,
    });
  });

  test("asks as usual when entering new", async () => {
    const { prompter, asked } = scripted([undefined, '{"target":"web"}']);

    const result = await resolveInput({
      target: deploy,
      flags: noFlags,
      saved,
      ask: prompter,
    });

    expect(asked).toEqual([
      "Use saved data?",
      "Event data, as JSON (empty for none)",
    ]);
    expect(result.input.data).toEqual({ target: "web" });
    expect(result.entered).toBe(true);
  });

  test("doesn't offer them when a flag was given or one was named", async () => {
    const withFlag = scripted([]);

    await resolveInput({
      target: deploy,
      flags: { data: {} },
      saved,
      ask: withFlag.prompter,
    });

    const named = scripted([]);

    await resolveInput({
      target: deploy,
      flags: noFlags,
      fixture: saved["nightly-api"],
      saved,
      ask: named.prompter,
    });

    expect(withFlag.asked).toEqual([]);
    expect(named.asked).toEqual([]);
  });
});
