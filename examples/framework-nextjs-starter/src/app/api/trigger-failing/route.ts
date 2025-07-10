import { NextResponse } from "next/server";
import { inngest } from "@/lib/inngest";

export async function POST() {
  // Send an event to trigger the failing function
  const { ids } = await inngest.send({
    name: "demo/failing.function",
    data: {},
  });
  // Return the run ID (first, since only one function is triggered)
  return NextResponse.json({ eventId: ids[0] });
}
