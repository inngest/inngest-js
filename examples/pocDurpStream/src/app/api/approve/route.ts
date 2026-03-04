import { inngest } from "@/inngest";
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const runId = body.runId;

  if (!runId || typeof runId !== "string") {
    return NextResponse.json({ error: "runId is required" }, { status: 400 });
  }

  await inngest.send({
    name: "approved",
    data: { runId },
  });

  return NextResponse.json({ ok: true });
}
