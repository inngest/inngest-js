import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const { segmentId } = await req.json();
  // For demo, use a simple prompt. In production, fetch segment/campaign details for context.
  const prompt = `Generate a catchy email subject and a short body for a marketing campaign targeting segment ID ${segmentId}. Return JSON: { "subject": "...", "content": "..." }`;
  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: "You are a helpful marketing assistant." },
      { role: "user", content: prompt },
    ],
    response_format: { type: "json_object" },
    max_tokens: 256,
    temperature: 0.7,
  });
  let subject = "[Draft Subject]";
  let content = "[Draft Content]";
  try {
    const json = completion.choices[0]?.message?.content;
    if (json) {
      const parsed = JSON.parse(json);
      subject = parsed.subject || subject;
      content = parsed.content || content;
    }
  } catch {}
  return NextResponse.json({ subject, content });
}
