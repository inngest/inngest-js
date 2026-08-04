/**
 * GET /api/booking/events?bookingId=...&cursor=0
 *
 * Polling endpoint that returns events since the given cursor.
 * Client should poll every 500-1000ms until status is "complete" or "error".
 */

import { NextRequest } from "next/server";
import { getEventsSinceCursor } from "@/inngest/event-store";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const bookingId = url.searchParams.get("bookingId");
  const cursor = parseInt(url.searchParams.get("cursor") || "0", 10);

  if (!bookingId) {
    return new Response(JSON.stringify({ error: "bookingId is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const result = getEventsSinceCursor(bookingId, cursor);

  if (!result) {
    return new Response(
      JSON.stringify({
        events: [],
        cursor: 0,
        status: "pending",
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
