import { Agent, run } from "@openai/agents";
import { z } from "zod";
import { inngest } from "../client";

const DEFAULT_LANGUAGES = [
  "Bengali",
  "French",
  "German",
  "Pig Latin",
  "Portuguese",
  "Spanish",
  "Sindarin",
];

const Translation = z.object({
  language: z.string().describe("The language the greeting was rendered in"),
  greeting: z.string().describe("'Hello, world!' in that language"),
  notes: z
    .string()
    .describe("A sentence on how the greeting was arrived at, in English"),
});

const conlangTranslator = new Agent({
  name: "Constructed language translator",
  model: "gpt-5.6-luna",
  handoffDescription:
    "Handles constructed, fictional, and play languages such as Pig Latin, Sindarin, Quenya, Klingon, or Esperanto.",
  instructions: [
    "You render greetings in constructed, fictional, and play languages.",
    "Apply the language's documented rules literally rather than guessing at a phrase, and say which rules you applied in the notes.",
    "If the language has no documented word for 'world', use the closest attested term and say so in the notes.",
  ].join(" "),
  outputType: Translation,
});

const translator = Agent.create({
  name: "Translator",
  model: "gpt-5-nano",
  instructions: [
    "You translate short greetings into natural human languages.",
    "If the requested language is constructed, fictional, or a word game rather than a natural human language, hand off to the constructed language translator instead of attempting it yourself.",
  ].join(" "),
  handoffs: [conlangTranslator],
  outputType: Translation,
});

export const helloWorld = inngest.createFunction(
  { id: "hello-world", triggers: [{ event: "test/hello.world" }] },
  async ({ event, greet, step, tracer }) => {
    greet("world");

    const language = await step.run("select-language", (): string =>
      typeof event.data?.language === "string"
        ? event.data.language
        : DEFAULT_LANGUAGES[
            Math.floor(Math.random() * DEFAULT_LANGUAGES.length)
          ],
    );

    const translation = await step.run("run-translator-agent", () =>
      tracer.startActiveSpan(`translate-to-${language}`, async (span) => {
        try {
          const result = await run(
            translator,
            `Translate "Hello, world!" into ${language}.`,
          );

          if (!result.finalOutput) {
            throw new Error(
              `The ${result.lastAgent?.name ?? "translator"} agent finished without producing a translation`,
            );
          }

          span.setAttribute("agent", result.lastAgent?.name ?? "translator");

          return result.finalOutput;
        } finally {
          span.end();
        }
      }),
    );

    await step.metadata("record-language").run().update({ language });
    await step.score("answered-in-requested-language", {
      name: "answered_in_requested_language",
      value:
        translation.language.toLowerCase().trim() ===
        language.toLowerCase().trim(),
    });

    return translation.greeting;
  },
);
