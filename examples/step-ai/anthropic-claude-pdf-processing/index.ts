import "dotenv/config";

import express from "express";
import { anthropic, Inngest } from "inngest";
import { serve } from "inngest/express";

const inngest = new Inngest({ id: "anthropic-claude-pdf-processing" });

const pdfFunction = inngest.createFunction(
  { id: "pdf-function", triggers: [{ event: "pdf-function/event" }] },
  async ({ step }) => {
    const result = await step.ai.infer("parse-pdf", {
      model: anthropic({
        model: "claude-3-5-sonnet-latest",
        defaultParameters: { max_tokens: 3094 },
      }),
      body: {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: {
                  type: "url",
                  url: "https://assets.anthropic.com/m/1cd9d098ac3e6467/original/Claude-3-Model-Card-October-Addendum.pdf",
                },
              },
              {
                type: "text",
                text: "What are the key findings in this document?",
              },
            ],
          },
        ],
      },
    });

    return result.content[0].type === "text"
      ? result.content[0].text
      : result.content[0];
  }
);

const app = express();

// Important:  ensure you add JSON middleware to process incoming JSON POST payloads.
app.use(express.json());
app.use(
  // Expose the middleware on our recommended path at `/api/inngest`.
  "/api/inngest",
  serve({ client: inngest, functions: [pdfFunction] })
);

app.listen(3000, () => {
  console.log("Server is running on port 3000");
});
