import { NextResponse } from "next/server";
import { inngest } from "@/lib/inngest";
import { FAILING_EVENT } from "../../../../inngest/failing-step";

export async function POST() {
  // Send an event to trigger the failing function
  const { ids } = await inngest.send({
    name: FAILING_EVENT,
    data: {},
  });
  // Return the run ID (first, since only one function is triggered)
  return NextResponse.json({ eventId: ids[0] });
}
