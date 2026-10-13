/**
 * Tests for the choice and text prompts' state.
 *
 * @module
 */

import type { Key } from "node:readline";
import { describe, expect, test } from "vitest";

import { choiceLines, createChoice, reduceChoice } from "./choice.ts";
import { createText, reduceText, textLines } from "./text.ts";

const paint = (_: string, text: string) => {
  return text;
};

const type = (text: string): Key[] => {
  return [...text].map((sequence) => {
    return { sequence, name: sequence === " " ? "space" : sequence };
  });
};

describe("choice", () => {
  const options = [
    { label: "all", value: 1 },
    { label: "node:22", value: 2 },
  ];

  test("moves, stays in range and submits the highlighted value", () => {
    let state = createChoice("Which?", options);

    state = reduceChoice(state, { name: "up" });
    expect(state.cursor).toBe(0);

    state = reduceChoice(reduceChoice(state, { name: "down" }), {
      name: "down",
    });
    expect(state.cursor).toBe(1);

    expect(reduceChoice(state, { name: "return" }).outcome).toEqual({
      kind: "submit",
      value: 2,
    });
  });

  test("cancels on q, esc and Ctrl-C", () => {
    for (const key of [
      { name: "q" },
      { name: "escape" },
      { name: "c", ctrl: true },
    ]) {
      expect(reduceChoice(createChoice("?", options), key).outcome).toEqual({
        kind: "cancel",
      });
    }
  });

  test("draws the question and an arrow on the highlighted option", () => {
    expect(
      choiceLines(
        reduceChoice(createChoice("Which?", options), { name: "down" }),
        {
          width: 40,
          paint,
        },
      ),
    ).toEqual(["  Which?", "  all", "› node:22"]);
  });
});

describe("text", () => {
  const enter = (state: ReturnType<typeof createText>, text: string) => {
    return type(text).reduce(reduceText, state);
  };

  test("types, treating q and spaces as letters, and backspaces", () => {
    const state = enter(createText("Name"), "q a");

    expect(state.text).toBe("q a");
    expect(reduceText(state, { name: "backspace" }).text).toBe("q ");
    expect(
      reduceText(state, { ctrl: true, name: "u", sequence: "\x15" }).text,
    ).toBe("");
  });

  test("ignores control keys", () => {
    const state = enter(createText("Name"), "a");

    expect(reduceText(state, { name: "left", sequence: "\x1b[D" })).toEqual(
      state,
    );
  });

  test("submits what was typed", () => {
    expect(
      reduceText(enter(createText("Name"), "hi"), { name: "return" }).outcome,
    ).toEqual({ kind: "submit", value: "hi" });
  });

  test("refuses text the check finds fault with, and clears the fault on typing", () => {
    const check = (text: string) => {
      return text.startsWith("{") ? undefined : "Not JSON.";
    };
    const refused = reduceText(enter(createText("JSON", check), "x"), {
      name: "return",
    });

    expect(refused.outcome).toBeUndefined();
    expect(refused.error).toBe("Not JSON.");
    expect(textLines(refused, { width: 40, paint })).toEqual([
      "  JSON",
      "› x▏",
      "  Not JSON.",
    ]);
    expect(reduceText(refused, type("y")[0] as Key).error).toBeUndefined();
  });

  test("cancels on esc and Ctrl-C only", () => {
    expect(reduceText(createText("?"), { name: "escape" }).outcome).toEqual({
      kind: "cancel",
    });
    expect(
      reduceText(createText("?"), { name: "c", ctrl: true }).outcome,
    ).toEqual({ kind: "cancel" });
  });
});
