import { inngest } from "@/inngest";
import { NextRequest, NextResponse } from "next/server";
import z from "zod";

const approveSchema = z.object({
  approved: z.boolean(),
  runId: z.string(),
});

export async function POST(req: NextRequest) {
  const parsed = approveSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }

  await inngest.send({
    name: "approved",
    data: parsed.data,
  });

  return NextResponse.json({ ok: true });
}

