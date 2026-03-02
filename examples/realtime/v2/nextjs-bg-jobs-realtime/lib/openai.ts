import { GetStepTools, models } from "inngest";
import OpenAI from "openai";
import { inngest } from "./inngest";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function segmentContacts(
  contacts: any[],
  step: GetStepTools<typeof inngest>
): Promise<{
  segments: { name: string; description?: string }[];
  assignments: { contactId: number; segmentName: string }[];
}> {
  // Prepare a summary of contacts for the prompt
  const contactSummaries = contacts
    .map(
      (c) =>
        `ID: ${c.id}, Name: ${c.firstname} ${c.lastname}, Role: ${c.position || c.role || ""}, Industry: ${c.industry || ""}`
    )
    .join("\n");

  const prompt = `You are an expert CRM assistant. Group the following contacts into segments based on their role or industry. 

For each segment, provide a name and a short description. Then, assign each contact to one segment. 

Contacts:\n${contactSummaries}

Respond in JSON with this format:
{
  "segments": [
    { "name": "Segment Name", "description": "..." },
    ...
  ],
  "assignments": [
    { "contactId": 1, "segmentName": "Segment Name" },
    ...
  ]
}`;

  const completion = await step.ai.infer("generate-segments", {
    model: models.openai({ model: "gpt-4.1" }),
    body: {
      messages: [
        {
          role: "system",
          content: "You are a helpful assistant for CRM segmentation.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
    },
  });

  // Parse the response
  return await step.run("assign-segments", async () => {
    let segments: { name: string; description?: string }[] = [];
    let assignments: { contactId: number; segmentName: string }[] = [];
    try {
      const json = completion.choices[0]?.message?.content;
      if (json) {
        const parsed = JSON.parse(json);
        segments = parsed.segments || [];
        assignments = parsed.assignments || [];
      }
    } catch (err) {
      // fallback: everyone in Default Segment
      segments = [{ name: "Default Segment", description: "All contacts" }];
      assignments = contacts.map((c) => ({
        contactId: c.id,
        segmentName: "Default Segment",
      }));
    }
    return { segments, assignments };
  });
}
