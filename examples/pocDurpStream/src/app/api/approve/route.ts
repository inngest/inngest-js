import { inngest } from "@/inngest";
import { NextRequest, NextResponse } from "next/server";
import z from "zod";

const languageSchema = z.object({
  language: z.string(),
  runId: z.string(),
});

export async function POST(req: NextRequest) {
  const parsed = languageSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }

  await inngest.send({
    name: "language-chosen",
    data: parsed.data,
  });

  return NextResponse.json({ ok: true });
}
