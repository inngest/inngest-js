/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from "next/server";

const INNGEST_SERVER_URL =
  process.env.INNGEST_DEV_SERVER_URL || "http://127.0.0.1:8288";

async function fetchEvents(receivedAfter: string): Promise<
  {
    name: string;
    receivedAt: number;
    id: string;
    data: any;
  }[]
> {
  const result = await fetch(
    `${INNGEST_SERVER_URL}/v1/events?received_after=${receivedAfter}&limit=100`,
    { cache: "no-store" }
  );
  return (await result.json()).data.map((item: any) => ({
    name: item.name,
    id: item.internal_id,
    receivedAt: new Date(item.received_at).getTime(),
    data: item.data,
  }));
}

async function getRuns(eventId: string) {
  const response = await fetch(
    `${INNGEST_SERVER_URL}/v1/events/${eventId}/runs`,
    {
      headers: {
        Authorization: `Bearer ${process.env.INNGEST_SIGNING_KEY}`,
      },
    }
  );
  const json = await response.json();
  return json.data[0];
}

export async function GET(req: NextRequest) {
  const receivedAfter = req.nextUrl.searchParams.get("receivedAfter");
  if (!receivedAfter) {
    return NextResponse.json(
      { error: "Missing receivedAfter" },
      { status: 400 }
    );
  }

  const events = await fetchEvents(receivedAfter);

  if (!events) {
    return NextResponse.json({ error: "Events not found" }, { status: 404 });
  }

  const runs = await Promise.all(
    events.map(async (event) => {
      const run = await getRuns(event.id);
      return run
        ? {
            eventId: event.id,
            eventReceivedAt: event.receivedAt,
            runId: run.id,
            status: run.status,
            output: run.output,
            error: run.error,
          }
        : {};
    })
  );

  return NextResponse.json({
    runs,
  });
}
