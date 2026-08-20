import { inngest } from "./client";

export const retrieveTextFile = inngest.createFunction(
  { id: "retrieveTextFile", triggers: [{ event: "textFile/retrieve" }] },
  async ({ step }) => {
    const response = await step.fetch(
      "https://example-files.online-convert.com/document/txt/example.txt"
    );

    await step.run("extract-text", async () => {
      const text = await response.text();
      const exampleOccurences = text.match(/example/g);
      return exampleOccurences?.length;
    });
  }
);
