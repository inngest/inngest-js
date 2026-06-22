/**
 * GET /api/research/events?researchId=...&cursor=0
 *
 * Polling endpoint that returns events since the given cursor.
 * Client should poll every 500-1000ms until status is "complete" or "error".
 *
 * Returns:
 * - events: Array of new events since cursor
 * - cursor: Next cursor value to use
 * - status: "pending" | "running" | "complete" | "error"
 */

import { NextRequest } from "next/server";
import { getEventsSinceCursor } from "@/inngest/event-store";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const researchId = url.searchParams.get("researchId");
  const cursor = parseInt(url.searchParams.get("cursor") || "0", 10);

  if (!researchId) {
    return new Response(JSON.stringify({ error: "researchId is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const result = getEventsSinceCursor(researchId, cursor);

  // If no store exists yet, return empty with "pending" status
  if (!result) {
    return new Response(
      JSON.stringify({
        events: [],
        cursor: 0,
        status: "pending",
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
