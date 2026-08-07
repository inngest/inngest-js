import { inngest } from "../client";
import OpenAI from "openai";

const DEFAULT_LANGUAGES = [
  "Bengali",
  "French",
  "German",
  "Pig Latin",
  "Portuguese",
  "Spanish",
  "Sindarin",
];

export const helloWorld = inngest.createFunction(
  { id: "hello-world", triggers: [{ event: "test/hello.world" }] },
  async ({ event, step }) => {
    const client = new OpenAI(); // relies on OPENAI_API_KEY being set in your env

    const language = await step.run("select-language", () => {
      let language = null;

      if (event.data?.language !== undefined) {
        language = event.data.language;
      } else {
        language =
          DEFAULT_LANGUAGES[
            Math.floor(Math.random() * DEFAULT_LANGUAGES.length)
          ];
      }

      return language;
    });

    const helloWorldMessage = await step.run("fetch-llm-response", async () => {
      const response = await client.responses.create({
        model: "gpt-5-nano",
        input: `Translate 'Hello, world!' into ${language}`,
      });

      return response;
    });

    return helloWorldMessage.output_text;
  },
);
