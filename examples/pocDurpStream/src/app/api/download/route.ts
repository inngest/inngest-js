import { step } from "inngest";
import { inngest } from "@/inngest";

export const GET = inngest.endpoint(async (req: Request) => {
  const text = new URL(req.url).searchParams.get("text") ?? "";

  const formatted = await step.run("format-transcript", () => {
    const timestamp = new Date().toISOString();

    if (Math.random() < 0.5) {
      throw new Error("Simulated file download issue!");
    }

    return `Durable Endpoint Chat Transcript\nExported: ${timestamp}\n${"=".repeat(40)}\n\n${text}`;
  });

  return new Response(formatted, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": 'attachment; filename="transcript.txt"',
    },
  });
});
