import { NextRequest, NextResponse } from "next/server";

const DEV_SERVER_URL =
  process.env.INNGEST_DEV_SERVER_URL || "http://127.0.0.1:8288";

async function getRuns(eventId: string) {
  const response = await fetch(`${DEV_SERVER_URL}/v1/events/${eventId}/runs`, {
    headers: {
      Authorization: `Bearer ${process.env.INNGEST_SIGNING_KEY}`,
    },
  });
  const json = await response.json();
  return json.data;
}

export async function GET(req: NextRequest) {
  const eventId = req.nextUrl.searchParams.get("eventId");
  if (!eventId) {
    return NextResponse.json({ error: "Missing eventId" }, { status: 400 });
  }
  // Proxy to the local Inngest Dev Server
  const runs = await getRuns(eventId);
  const run = runs[0];

  if (!run) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  return NextResponse.json({
    status: run.status,
    output: run.output,
    error: run.error,
  });
}
