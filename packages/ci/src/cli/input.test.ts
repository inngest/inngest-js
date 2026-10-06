/**
 * Tests for working out a run's input: flags beat fixtures, which beat asking.
 *
 * @module
 */

import { describe, expect, test } from "vitest";

import type { JsonSchema } from "../local/jsonSchema.ts";
import { flagInput, type RunInput, resolveInput } from "./input.ts";
import type { Prompter } from "./prompter.ts";
import type { SetupError } from "./setupError.ts";
import type { Target } from "./target.ts";

const deploySchema: JsonSchema = {
  type: "object",
  properties: {
    target: { type: "string", enum: ["web", "api"] },
    dryRun: { type: "boolean", default: true },
  },
  required: ["target"],
};

const pr: Target = {
  kind: "pipeline",
  id: "pr",
  triggers: [{ event: "github/pull_request.opened" }, { event: "github/push" }],
};

const deploy: Target = {
  kind: "pipeline",
  id: "deploy",
  triggers: [{ event: "ci/manual.deploy", schema: deploySchema }],
};

const unreadable: Target = {
  kind: "pipeline",
  id: "unreadable",
  triggers: [{ event: "ci/manual.unreadable" }],
};

const prerelease: Target = {
  kind: "pipeline",
  id: "prerelease",
  triggers: [{ event: "github/issue_comment.created" }],
};

const build: Target = {
  kind: "job",
  id: "build",
  takesInput: true,
  input: {
    type: "object",
    properties: { target: { type: "string", enum: ["web", "api"] } },
    required: ["target"],
  },
};

const schemaless: Target = { kind: "job", id: "legacy", takesInput: true };
const lint: Target = { kind: "job", id: "lint", takesInput: false };

const compat: Target = {
  kind: "job",
  id: "compat",
  takesInput: false,
  axes: { os: ["linux", "mac"], node: [20, 22] },
  combos: [
    { os: "linux", node: 20 },
    { os: "linux", node: 22 },
    { os: "mac", node: 20 },
    { os: "mac", node: 22 },
  ],
};

interface Asked {
  kind: "choose" | "line" | "form";
  question: string;
  options?: string[];
  form?: Parameters<Prompter["form"]>[0];
  initial?: string;
}

/** A prompter that answers from a script and records what it was asked. */
const scripted = (answers: unknown[]) => {
  const asked: Asked[] = [];

  const prompter = {
    choose: async (
      question: string,
      options: { label: string; value: unknown }[],
    ) => {
      asked.push({
        kind: "choose",
        question,
        options: options.map((option) => {
          return option.label;
        }),
      });

      const answer = answers.shift();

      return typeof answer === "number" ? options[answer]?.value : answer;
    },
    line: async (question: string, _: unknown, initial?: string) => {
      asked.push({ kind: "line", question, initial });

      return answers.shift();
    },
    form: async (form: Parameters<Prompter["form"]>[0]) => {
      asked.push({ kind: "form", question: form.title, form });

      return answers.shift();
    },
  } as unknown as Prompter;

  return { prompter, asked };
};

const noFlags = {};

describe("flagInput", () => {
  const args = { axes: {} };

  test("reads the trigger and data for a pipeline", () => {
    expect(flagInput({ ...args, event: "push", data: '{"a":1}' }, pr)).toEqual({
      trigger: "github/push",
      data: { a: 1 },
    });
  });

  test("reads the input and the combinations the axis flags pick for a job", () => {
    expect(
      flagInput(
        {
          ...args,
          input: '{"target":"web"}',
          axes: { os: ["mac"], node: ["20", "22"] },
        },
        compat,
      ),
    ).toEqual({
      input: { target: "web" },
      combos: [
        { os: "mac", node: 20 },
        { os: "mac", node: 22 },
      ],
    });
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
      (
        await resolveInput({
          target: deploy,
          flags: { data: { target: "web" } },
          saved: {},
        })
      ).input.trigger,
    ).toBe("ci/manual.deploy");

    await expect(
      resolveInput({ target: pr, flags: noFlags, saved: {} }),
    ).rejects.toThrow(/several triggers/);
  });

  test("takes flags first, then the fixture", async () => {
    const result = await resolveInput({
      target: deploy,
      flags: { data: { target: "api" } },
      fixture: { trigger: "ci/manual.deploy", data: { target: "web" } },
      saved: {},
    });

    expect(result).toEqual({
      input: { trigger: "ci/manual.deploy", data: { target: "api" } },
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

  test("leaves a job without input or combinations alone", async () => {
    expect(
      await resolveInput({ target: lint, flags: noFlags, saved: {} }),
    ).toEqual({
      input: { input: undefined, combos: undefined },
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

describe("resolveInput checking against the schema", () => {
  test("lists the fields and types when manual data lacks a required one", async () => {
    expect.assertions(3);

    try {
      await resolveInput({ target: deploy, flags: noFlags, saved: {} });
    } catch (error) {
      expect((error as SetupError).message).toContain("target: Required.");
      expect((error as SetupError).fix).toContain(
        "target (web | api), dryRun (yes or no, optional)",
      );
      expect((error as SetupError).fix).toContain("--data");
    }
  });

  test("names what is wrong with data that is given", async () => {
    await expect(
      resolveInput({
        target: deploy,
        flags: { data: { target: "mars" } },
        saved: {},
      }),
    ).rejects.toThrow("target: Must be one of web, api.");
  });

  test("checks a fixture the same way", async () => {
    await expect(
      resolveInput({
        target: deploy,
        flags: noFlags,
        fixture: { data: { target: 3 } },
        saved: {},
      }),
    ).rejects.toThrow(/target: Must be one of/);
  });

  test("checks a job's input against its schema", async () => {
    await expect(
      resolveInput({ target: build, flags: noFlags, saved: {} }),
    ).rejects.toThrow(/target: Required\./);
    await expect(
      resolveInput({
        target: build,
        flags: { input: { target: "web" } },
        saved: {},
      }),
    ).resolves.toMatchObject({ input: { input: { target: "web" } } });
  });

  test("lets through what has no schema, or needs nothing", async () => {
    await expect(
      resolveInput({ target: schemaless, flags: noFlags, saved: {} }),
    ).resolves.toBeDefined();
    await expect(
      resolveInput({ target: unreadable, flags: noFlags, saved: {} }),
    ).resolves.toBeDefined();
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
    expect(asked.map((item) => item.question)).toEqual(["Which trigger?"]);
  });

  test("builds a manual trigger's data with a form of its schema", async () => {
    const { prompter, asked } = scripted([{ target: "api" }]);

    const result = await resolveInput({
      target: deploy,
      flags: noFlags,
      saved: {},
      ask: prompter,
    });

    expect(result.input.data).toEqual({ target: "api" });
    expect(result.entered).toBe(true);
    expect(asked).toEqual([
      {
        kind: "form",
        question: "deploy · event data",
        form: {
          title: "deploy · event data",
          schema: deploySchema,
          initial: undefined,
        },
      },
    ]);
  });

  test("a form that answers nothing sends empty data", async () => {
    const result = await resolveInput({
      target: deploy,
      flags: noFlags,
      saved: {},
      ask: scripted([undefined]).prompter,
    });

    expect(result.input.data).toEqual({});
  });

  test("asks for JSON, saying why, when a manual trigger's schema can't be shown", async () => {
    const { prompter, asked } = scripted([{ any: 1 }]);

    const result = await resolveInput({
      target: unreadable,
      flags: noFlags,
      saved: {},
      ask: prompter,
    });

    expect(result.input.data).toEqual({ any: 1 });
    expect(asked[0]?.form).toMatchObject({
      schema: { type: "object" },
      note: "unreadable's data schema can't be shown as a form, so enter its data as JSON.",
    });
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

  test("builds a job's input with a form of its input schema", async () => {
    const { prompter, asked } = scripted([{ target: "web" }]);

    const result = await resolveInput({
      target: build,
      flags: noFlags,
      saved: {},
      ask: prompter,
    });

    expect(result.input.input).toEqual({ target: "web" });
    expect(asked[0]?.form).toMatchObject({
      title: "build · input",
      schema: build.kind === "job" ? build.input : undefined,
    });
  });

  test("says how to get a form when a job takes input but has no schema", async () => {
    const { prompter, asked } = scripted([{ a: 1 }]);

    await resolveInput({
      target: schemaless,
      flags: noFlags,
      saved: {},
      ask: prompter,
    });

    expect(asked[0]?.form).toMatchObject({
      note: "legacy takes input but has no schema. Add `input: <schema>` to `ci.job` to get a form.",
      schema: {},
      initial: undefined,
    });
  });

  test("starts a schemaless job's JSON from the last input saved for it", async () => {
    const { prompter, asked } = scripted([
      // "New" is the last of the offered options.
      4,
      { a: 2 },
    ]);

    await resolveInput({
      target: schemaless,
      flags: noFlags,
      saved: {
        older: { input: { a: 0 } },
        newer: { input: { a: 1 } },
      },
      ask: prompter,
    });

    expect(asked[1]?.form?.initial).toEqual({ a: 1 });
  });

  test("doesn't ask for a job that takes no input, or for a matrix", async () => {
    const none = scripted([]);

    for (const target of [lint, compat]) {
      expect(
        (
          await resolveInput({
            target,
            flags: noFlags,
            saved: {},
            ask: none.prompter,
          })
        ).entered,
      ).toBe(false);
    }

    expect(none.asked).toEqual([]);
  });

  test("skips every question a flag answers", async () => {
    const { prompter, asked } = scripted([]);

    const result = await resolveInput({
      target: compat,
      flags: { combos: [{ os: "mac", node: 20 }] },
      saved: { old: { combos: [{ os: "linux", node: 22 }] } },
      ask: prompter,
    });

    expect(asked).toEqual([]);
    expect(result).toEqual({
      input: { input: undefined, combos: [{ os: "mac", node: 20 }] },
      entered: false,
    });
  });
});

describe("resolveInput with saved fixtures", () => {
  const saved: Record<string, RunInput> = {
    "nightly-api": { trigger: "ci/manual.deploy", data: { target: "api" } },
    "quick-web": { trigger: "ci/manual.deploy", data: { target: "web" } },
  };

  test("offers using or starting from each, then new", async () => {
    const { prompter, asked } = scripted([0]);

    const result = await resolveInput({
      target: deploy,
      flags: noFlags,
      saved,
      ask: prompter,
    });

    expect(asked).toEqual([
      {
        kind: "choose",
        question: "Saved data for deploy",
        options: [
          "Use nightly-api",
          "Start from nightly-api",
          "Use quick-web",
          "Start from quick-web",
          "New",
        ],
      },
    ]);
    expect(result).toEqual({
      input: { trigger: "ci/manual.deploy", data: { target: "api" } },
      entered: false,
    });
  });

  test("starts the form from a fixture's data", async () => {
    const { prompter, asked } = scripted([3, { target: "api", dryRun: false }]);

    const result = await resolveInput({
      target: deploy,
      flags: noFlags,
      saved,
      ask: prompter,
    });

    expect(asked[1]?.form).toMatchObject({ initial: { target: "web" } });
    expect(result.input.data).toEqual({ target: "api", dryRun: false });
    expect(result.entered).toBe(true);
  });

  test("asks as usual when entering new", async () => {
    const { prompter, asked } = scripted([4, { target: "web" }]);

    const result = await resolveInput({
      target: deploy,
      flags: noFlags,
      saved,
      ask: prompter,
    });

    expect(asked[1]?.form).toMatchObject({ initial: undefined });
    expect(result.input.data).toEqual({ target: "web" });
    expect(result.entered).toBe(true);
  });

  test("doesn't offer them when a flag was given or one was named", async () => {
    const withFlag = scripted([]);

    await resolveInput({
      target: deploy,
      flags: { data: { target: "web" } },
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
