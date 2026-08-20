import "dotenv/config";

import express from "express";
import { Inngest, GetStepTools } from "inngest";
import { azureOpenai } from "../../../packages/ai/src"; // TODO: update to use the remote package once live
import { serve } from "inngest/express";

const inngest = new Inngest({ id: "azure-openai" });

const azureTestFunction = inngest.createFunction(
  { id: "azure-test-function", triggers: [{ event: "azure-test-function/event" }] },
  async ({ step }: { step: GetStepTools<typeof inngest> }) => {
    // Validate required environment variables
    if (!process.env.AZURE_OPENAI_ENDPOINT) {
      throw new Error("AZURE_OPENAI_ENDPOINT environment variable is required");
    }
    if (!process.env.AZURE_OPENAI_DEPLOYMENT) {
      throw new Error(
        "AZURE_OPENAI_DEPLOYMENT environment variable is required"
      );
    }

    console.log("Starting Azure OpenAI test...");

    const result = await step.ai.infer("azure-test-prompt", {
      model: azureOpenai({
        model: "gpt-4o", // Make sure this model is deployed in your Azure OpenAI resource
        endpoint: process.env.AZURE_OPENAI_ENDPOINT!, // e.g., "https://your-resource.openai.azure.com/"
        deployment: process.env.AZURE_OPENAI_DEPLOYMENT!, // your deployment name
        apiVersion: "2024-02-01", // Azure OpenAI API version
        defaultParameters: { max_completion_tokens: 2000 },
      }),
      body: {
        messages: [
          {
            role: "user",
            content:
              "Hello! Can you tell me a fun fact about artificial intelligence?",
          },
        ],
      },
    });

    console.log("Azure OpenAI test completed successfully");

    // OpenAI response format: result.choices[0].message.content
    return result.choices[0].message.content;
  }
);

const app = express();

// Important: ensure you add JSON middleware to process incoming JSON POST payloads.
app.use(express.json());

// Serve the Inngest API at the recommended path
app.use(
  "/api/inngest",
  serve({ client: inngest, functions: [azureTestFunction] })
);

app.listen(3000, () => {
  console.log("Server is running on port 3000");
  console.log("Azure OpenAI example ready!");
  console.log(
    'Test with: curl -X POST http://localhost:3000/api/inngest -H \'Content-Type: application/json\' -d \'{"name": "azure-test-function/event", "data": {}}\''
  );
});
